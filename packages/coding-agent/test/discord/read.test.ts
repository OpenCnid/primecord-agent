import { describe, expect, it, vi } from "vitest";
import { createDiscordGatewayReadTool } from "../../src/core/tools/discord-gateway-read.js";
import {
	type DiscordReadAdapter,
	DiscordReadAdapterError,
	type DiscordReadChannel,
	type DiscordReadLimits,
	type DiscordReadMessageSource,
	type DiscordReadScope,
	DiscordReadService,
	parseDiscordMessageUrl,
} from "../../src/gateway/discord/read.js";
import type { DiscordRoutingPolicy } from "../../src/gateway/discord/routing.js";

const GUILD = "100000000000000001";
const OTHER_GUILD = "200000000000000001";
const CHANNEL = "300000000000000001";
const OTHER_CHANNEL = "400000000000000001";
const THREAD = "500000000000000001";
const MESSAGE = "600000000000000001";
const USER = "700000000000000001";

function policy(overrides: Partial<DiscordRoutingPolicy> = {}): DiscordRoutingPolicy {
	return {
		allowedUsers: [USER],
		allowedRoles: [],
		allowAllUsers: false,
		allowedChannels: [],
		ignoredChannels: [],
		freeResponseChannels: [],
		noThreadChannels: [],
		requireMention: true,
		threadRequireMention: false,
		ignoreNoMention: true,
		autoThread: true,
		botMessageMode: "none",
		...overrides,
	};
}

function limits(overrides: Partial<DiscordReadLimits> = {}): DiscordReadLimits {
	return {
		maxMessages: 20,
		maxContentChars: 10,
		maxTotalContentChars: 15,
		maxAttachments: 1,
		...overrides,
	};
}

function source(overrides: Partial<DiscordReadMessageSource> = {}): DiscordReadMessageSource {
	return {
		id: MESSAGE,
		channelId: CHANNEL,
		guildId: GUILD,
		createdTimestamp: 1_700_000_000_000,
		author: { id: USER, username: "member", displayName: "Member" },
		content: "hello",
		attachments: [],
		...overrides,
	};
}

function channel(overrides: Partial<DiscordReadChannel> = {}): DiscordReadChannel {
	return {
		id: CHANNEL,
		kind: "guild",
		guildId: GUILD,
		canUserView: async () => true,
		getMessage: async () => source(),
		getRecentMessages: async () => [source()],
		...overrides,
	};
}

function scope(overrides: Partial<DiscordReadScope> = {}): DiscordReadScope {
	return { userId: USER, kind: "guild", guildId: GUILD, channelId: CHANNEL, ...overrides };
}

function service(
	channels: ReadonlyMap<string, DiscordReadChannel>,
	options: { policy?: DiscordRoutingPolicy; limits?: DiscordReadLimits; roles?: readonly string[] } = {},
): DiscordReadService {
	const adapter: DiscordReadAdapter = { getChannel: async (id) => channels.get(id) };
	return new DiscordReadService(
		adapter,
		options.policy ?? policy(),
		options.limits ?? limits(),
		async () => options.roles,
	);
}

describe("discord_read tool", () => {
	it("forwards only action-compatible requests and returns safe failures", async () => {
		const request = vi.fn().mockResolvedValue({ ok: true, untrusted: true });
		const tool = createDiscordGatewayReadTool({ request });
		const success = await tool.execute(
			"call-1",
			{ action: "history", limit: 4 },
			new AbortController().signal,
			undefined,
			{} as never,
		);
		expect(request).toHaveBeenCalledWith({ action: "history", limit: 4 }, expect.any(AbortSignal));
		expect(JSON.stringify(success)).toContain('"ok":true');

		const invalid = await tool.execute(
			"call-2",
			{ action: "message", messageUrl: "https://discord.com/channels/x", limit: 4 },
			new AbortController().signal,
			undefined,
			{} as never,
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(invalid)).toContain('"code":"INVALID_REQUEST"');
	});
});

describe("parseDiscordMessageUrl", () => {
	it("accepts canonical guild and current-DM message URLs", () => {
		expect(parseDiscordMessageUrl(`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`)).toEqual({
			kind: "guild",
			guildId: GUILD,
			channelId: CHANNEL,
			messageId: MESSAGE,
		});
		expect(parseDiscordMessageUrl(`https://discord.com/channels/@me/${CHANNEL}/${MESSAGE}`)).toEqual({
			kind: "dm",
			channelId: CHANNEL,
			messageId: MESSAGE,
		});
	});

	it("rejects malformed, credentialed, cross-origin, and non-canonical URLs", () => {
		for (const url of [
			"not a url",
			` https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			`http://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			`https://discord.com@evil.example/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			`https://discord.com:444/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			`https://www.discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			`https://evil.example/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}?token=secret`,
			`https://discord.com/channels/${GUILD}/${CHANNEL}/not-a-snowflake`,
			`https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}/extra`,
		]) {
			expect(() => parseDiscordMessageUrl(url)).toThrow(DiscordReadAdapterError);
		}
	});
});

describe("DiscordReadService", () => {
	it("reads a linked message and returns normalized bounded untrusted data", async () => {
		const longContent = `123456789${String.fromCodePoint(0x1f642)}rest`;
		const result = await service(
			new Map([
				[
					CHANNEL,
					channel({
						getMessage: async () =>
							source({
								content: longContent,
								attachments: [
									{ id: "a", name: "first.txt", contentType: "text/plain", size: 1 },
									{ id: "b", name: "second.txt", size: 2 },
								],
							}),
					}),
				],
			]),
		).read(scope(), { action: "message", messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}` });

		expect(result).toMatchObject({ ok: true, untrusted: true });
		if (!result.ok) throw new Error("expected success");
		expect(result.message).toMatchObject({
			id: MESSAGE,
			channelId: CHANNEL,
			guildId: GUILD,
			content: "123456789",
			contentTruncated: true,
			attachments: [{ id: "a", name: "first.txt", contentType: "text/plain", size: 1 }],
			attachmentsTruncated: true,
		});
		expect(JSON.stringify(result)).not.toContain("second.txt");
	});

	it("rejects other guilds, ignored targets, identity loss, and a DM escape before a message read", async () => {
		let reads = 0;
		const guarded = channel({
			getMessage: async () => {
				reads++;
				return source();
			},
		});
		const adapter = new Map([[CHANNEL, guarded]]);
		const basic = service(adapter);
		await expect(
			basic.read(scope(), {
				action: "message",
				messageUrl: `https://discord.com/channels/${OTHER_GUILD}/${CHANNEL}/${MESSAGE}`,
			}),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(adapter, { policy: policy({ ignoredChannels: [CHANNEL] }) }).read(scope(), {
				action: "message",
				messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			}),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(adapter, { policy: policy({ allowedUsers: ["another-user"] }) }).read(scope(), {
				action: "message",
				messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			}),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(adapter).read(
				{ userId: USER, kind: "dm", channelId: CHANNEL },
				{
					action: "message",
					messageUrl: `https://discord.com/channels/@me/${OTHER_CHANNEL}/${MESSAGE}`,
				},
			),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(
				new Map([
					[
						CHANNEL,
						channel({
							canUserView: async () => false,
							getMessage: async () => {
								reads++;
								return source();
							},
						}),
					],
				]),
			).read(scope(), {
				action: "message",
				messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			}),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		expect(reads).toBe(0);
	});

	it("requires an explicitly allowed parent for cross-channel reads and inherits parent policy for threads", async () => {
		let historyLimit: number | undefined;
		const thread = channel({
			id: THREAD,
			kind: "thread",
			parentChannelId: OTHER_CHANNEL,
			getRecentMessages: async (limit) => {
				historyLimit = limit;
				return [source({ channelId: THREAD })];
			},
		});
		const channels = new Map([[THREAD, thread]]);
		const permitted = service(channels, { policy: policy({ allowedChannels: [OTHER_CHANNEL] }) });
		await expect(permitted.read(scope(), { action: "history", channelId: THREAD, limit: 99 })).resolves.toMatchObject(
			{
				ok: true,
				untrusted: true,
			},
		);
		expect(historyLimit).toBe(20);
		await expect(
			service(channels, { policy: policy({ allowedChannels: [THREAD] }) }).read(scope(), {
				action: "history",
				channelId: THREAD,
			}),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(channels, {
				policy: policy({ allowedChannels: [OTHER_CHANNEL], ignoredChannels: [OTHER_CHANNEL] }),
			}).read(scope(), {
				action: "history",
				channelId: THREAD,
			}),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
	});

	it("bounds recent history, aggregate content, and unavailable or permission failures", async () => {
		const messages = [
			source({ id: "600000000000000002", content: "abcdefghij" }),
			source({ id: "600000000000000003", content: "klmnopqrst", createdTimestamp: 1_700_000_000_001 }),
		];
		const history = channel({ getRecentMessages: async () => messages });
		const result = await service(new Map([[CHANNEL, history]])).read(scope(), { action: "history", limit: 20 });
		expect(result).toMatchObject({ ok: true, untrusted: true });
		if (!result.ok) throw new Error("expected success");
		expect(result.messages?.map((message) => message.content)).toEqual(["klmnopqrst", "abcde"]);
		await expect(
			service(new Map([[CHANNEL, channel({ getMessage: async () => undefined })]])).read(scope(), {
				action: "message",
				messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			}),
		).resolves.toMatchObject({ ok: false, code: "UNAVAILABLE" });
		await expect(
			service(
				new Map([
					[
						CHANNEL,
						channel({
							getMessage: async () => {
								throw new DiscordReadAdapterError("MISSING_PERMISSION", "ignored");
							},
						}),
					],
				]),
			).read(scope(), {
				action: "message",
				messageUrl: `https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE}`,
			}),
		).resolves.toMatchObject({ ok: false, code: "MISSING_PERMISSION" });
	});
});
