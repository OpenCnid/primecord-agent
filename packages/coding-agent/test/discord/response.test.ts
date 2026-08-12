import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDiscordResponseWriter,
	DISCORD_ALLOWED_MENTIONS,
	DISCORD_MESSAGE_LIMIT,
	type DiscordResponseChannelPort,
	type DiscordResponseMessagePort,
	type DiscordResponsePayload,
	splitDiscordMessage,
} from "../../src/gateway/discord/response.js";

class FakeMessage implements DiscordResponseMessagePort {
	readonly edits: DiscordResponsePayload[] = [];
	editError: unknown;

	async edit(payload: DiscordResponsePayload): Promise<void> {
		this.edits.push(payload);
		if (this.editError !== undefined) throw this.editError;
	}
}

class FakeChannel implements DiscordResponseChannelPort {
	readonly sends: DiscordResponsePayload[] = [];
	readonly messages: FakeMessage[] = [];
	sendError: unknown;

	async send(payload: DiscordResponsePayload): Promise<FakeMessage> {
		this.sends.push(payload);
		if (this.sendError !== undefined) throw this.sendError;
		const message = new FakeMessage();
		this.messages.push(message);
		return message;
	}
}

function hasBrokenSurrogate(value: string): boolean {
	if (value.length === 0) return false;
	const first = value.charCodeAt(0);
	const last = value.charCodeAt(value.length - 1);
	return (first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff);
}

function hasBalancedFences(value: string): boolean {
	let marker: string | undefined;
	for (const line of value.split(/\r?\n/)) {
		const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
		if (!match) continue;
		if (!marker) {
			marker = match[1];
		} else if (match[1][0] === marker[0] && match[1].length >= marker.length && match[2].trim() === "") {
			marker = undefined;
		}
	}
	return marker === undefined;
}

describe("splitDiscordMessage", () => {
	it("splits on UTF-16 limits without breaking surrogate pairs", () => {
		const text = "😀".repeat(1_501);
		const chunks = splitDiscordMessage(text);

		expect(chunks.length).toBe(2);
		expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
		expect(chunks.every((chunk) => !hasBrokenSurrogate(chunk))).toBe(true);
		expect(chunks.join("")).toBe(text);
	});

	it("prefers newline and then space boundaries", () => {
		const newlineText = `${"a".repeat(1_998)}\nnext`;
		const spaceText = `${"a".repeat(1_998)} next`;

		expect(splitDiscordMessage(newlineText)[0]).toBe(`${"a".repeat(1_998)}\n`);
		expect(splitDiscordMessage(spaceText)[0]).toBe(`${"a".repeat(1_998)} `);
	});

	it("closes and reopens Markdown fences across chunks", () => {
		const text = `Before\n\`\`\`ts\n${"const value = 1; ".repeat(180)}\n\`\`\`\nAfter`;
		const chunks = splitDiscordMessage(text);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_LIMIT)).toBe(true);
		expect(chunks.every(hasBalancedFences)).toBe(true);
		expect(chunks.some((chunk, index) => index > 0 && chunk.startsWith("```ts\n"))).toBe(true);
	});

	it("rejects invalid limits", () => {
		expect(() => splitDiscordMessage("text", 0)).toThrow("positive safe integer");
	});
});

describe("DiscordResponseWriter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("creates one placeholder and batches streamed edits", async () => {
		const channel = new FakeChannel();
		const writer = await createDiscordResponseWriter(channel, {
			updateIntervalMs: 1_000,
			placeholderText: "Working",
		});

		expect(channel.sends).toEqual([{ content: "Working", allowedMentions: DISCORD_ALLOWED_MENTIONS }]);
		writer.append("hello");
		writer.append(" world");
		await vi.advanceTimersByTimeAsync(999);
		expect(channel.messages[0].edits).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(channel.messages[0].edits.map((edit) => edit.content)).toEqual(["hello world"]);

		writer.append(" again");
		await vi.advanceTimersByTimeAsync(999);
		expect(channel.messages[0].edits).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(channel.messages[0].edits.map((edit) => edit.content)).toEqual(["hello world", "hello world again"]);
		await expect(writer.finish()).resolves.toMatchObject({ chunks: ["hello world again"], deliveryErrors: [] });
	});

	it("shows transient progress without including it in the final response", async () => {
		const channel = new FakeChannel();
		const writer = await createDiscordResponseWriter(channel, { updateIntervalMs: 1_000 });

		writer.setProgress("Inspecting the workspace and carrying out the next step.");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channel.messages[0].edits.map((edit) => edit.content)).toEqual([
			"Inspecting the workspace and carrying out the next step.",
		]);

		writer.append("Partial response");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(channel.messages[0].edits.map((edit) => edit.content)).toEqual([
			"Inspecting the workspace and carrying out the next step.",
			"Partial response\n\nInspecting the workspace and carrying out the next step.",
		]);

		const finalization = writer.finish("Final response");
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(finalization).resolves.toMatchObject({ chunks: ["Final response"] });
		expect(channel.messages[0].edits.at(-1)?.content).toBe("Final response");
	});

	it("finalizes long output into one edit and additional messages", async () => {
		const channel = new FakeChannel();
		const writer = await createDiscordResponseWriter(channel, { updateIntervalMs: 1_000 });
		const output = `${"word ".repeat(900)}done`;

		const result = await writer.finish(output);

		expect(result.chunks.length).toBeGreaterThan(1);
		expect(channel.messages[0].edits[0].content).toBe(result.chunks[0]);
		expect(channel.sends.slice(1).map((send) => send.content)).toEqual(result.chunks.slice(1));
		expect(
			[...channel.messages[0].edits, ...channel.sends].every(
				(payload) => payload.allowedMentions === DISCORD_ALLOWED_MENTIONS,
			),
		).toBe(true);
	});

	it("uses safe empty and error responses", async () => {
		const emptyChannel = new FakeChannel();
		const emptyWriter = await createDiscordResponseWriter(emptyChannel, {
			updateIntervalMs: 0,
			emptyText: "Nothing returned",
		});
		await expect(emptyWriter.finish()).resolves.toMatchObject({ chunks: ["Nothing returned"] });
		expect(emptyChannel.messages[0].edits[0].content).toBe("Nothing returned");

		const errorChannel = new FakeChannel();
		const errorWriter = await createDiscordResponseWriter(errorChannel, {
			updateIntervalMs: 0,
			errorText: "Agent error",
		});
		await expect(errorWriter.fail()).resolves.toMatchObject({ chunks: ["Agent error"] });
		expect(errorChannel.messages[0].edits[0].content).toBe("Agent error");
	});

	it("contains delivery failures instead of rejecting or invoking work", async () => {
		const channel = new FakeChannel();
		const deliveryError = new Error("Discord unavailable");
		const reported: unknown[] = [];
		channel.sendError = deliveryError;

		const writer = await createDiscordResponseWriter(channel, {
			updateIntervalMs: 0,
			onDeliveryError: (error) => reported.push(error),
		});
		channel.sendError = undefined;
		writer.append("completed agent output");
		const result = await writer.finish();

		expect(result.chunks).toEqual(["completed agent output"]);
		expect(result.deliveryErrors).toEqual([deliveryError]);
		expect(reported).toEqual([deliveryError]);
		expect(channel.sends).toHaveLength(2);
	});

	it("contains edit and follow-up send failures while continuing finalization", async () => {
		const channel = new FakeChannel();
		const writer = await createDiscordResponseWriter(channel, { updateIntervalMs: 0 });
		const editError = new Error("edit failed");
		const sendError = new Error("send failed");
		channel.messages[0].editError = editError;
		channel.sendError = sendError;

		const result = await writer.finish("x".repeat(DISCORD_MESSAGE_LIMIT + 1));

		expect(result.deliveryErrors).toEqual([editError, sendError]);
		expect(channel.messages[0].edits).toHaveLength(1);
		expect(channel.sends).toHaveLength(2);
	});

	it("retries the final output after a streamed edit fails", async () => {
		const channel = new FakeChannel();
		const writer = await createDiscordResponseWriter(channel, { updateIntervalMs: 0 });
		const editError = new Error("temporary edit failure");
		channel.messages[0].editError = editError;

		writer.append("completed output");
		await vi.advanceTimersByTimeAsync(0);
		expect(channel.messages[0].edits.map((edit) => edit.content)).toEqual(["completed output"]);

		channel.messages[0].editError = undefined;
		const result = await writer.finish();

		expect(channel.messages[0].edits.map((edit) => edit.content)).toEqual(["completed output", "completed output"]);
		expect(result.deliveryErrors).toEqual([editError]);
	});
});
