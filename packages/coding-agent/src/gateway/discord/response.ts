export const DISCORD_MESSAGE_LIMIT = 2_000;

export interface DiscordAllowedMentions {
	parse: readonly [];
	repliedUser: false;
}

export const DISCORD_ALLOWED_MENTIONS: DiscordAllowedMentions = Object.freeze({
	parse: Object.freeze([] as const),
	repliedUser: false,
});

export interface DiscordResponsePayload {
	content: string;
	allowedMentions: DiscordAllowedMentions;
}

export interface DiscordResponseMessagePort {
	edit(payload: DiscordResponsePayload): Promise<unknown>;
}

export interface DiscordResponseChannelPort {
	send(payload: DiscordResponsePayload): Promise<DiscordResponseMessagePort>;
}

export interface DiscordResponseWriterOptions {
	updateIntervalMs: number;
	placeholderText?: string;
	emptyText?: string;
	errorText?: string;
	onDeliveryError?: (error: unknown) => void;
}

export interface DiscordResponseWriteResult {
	chunks: readonly string[];
	deliveryErrors: readonly unknown[];
}

interface MarkdownFence {
	marker: string;
	opener: string;
}

interface FenceTransition {
	index: number;
	fence: MarkdownFence | undefined;
}

const DEFAULT_PLACEHOLDER = "…";
const DEFAULT_EMPTY_RESPONSE = "(No response)";
const DEFAULT_ERROR_RESPONSE = "The agent failed before producing a response.";
const MAX_TRACKED_FENCE_MARKER = 64;

function messagePayload(content: string): DiscordResponsePayload {
	return { content, allowedMentions: DISCORD_ALLOWED_MENTIONS };
}

function readFenceTransitions(text: string): readonly FenceTransition[] {
	const transitions: FenceTransition[] = [];
	let fence: MarkdownFence | undefined;
	let lineStart = 0;

	while (lineStart < text.length) {
		const newline = text.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? text.length : newline + 1;
		const contentEnd =
			newline === -1 ? lineEnd : newline > lineStart && text[newline - 1] === "\r" ? newline - 1 : newline;
		const line = text.slice(lineStart, contentEnd);
		const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);

		if (match) {
			const marker = match[2];
			const remainder = match[3];
			if (marker.length <= MAX_TRACKED_FENCE_MARKER) {
				if (!fence) {
					const validBacktickInfo = marker[0] !== "`" || !remainder.includes("`");
					if (validBacktickInfo) {
						fence = { marker, opener: `${marker}${remainder}`.trimEnd() };
						transitions.push({ index: lineEnd, fence });
					}
				} else if (
					marker[0] === fence.marker[0] &&
					marker.length >= fence.marker.length &&
					remainder.trim().length === 0
				) {
					fence = undefined;
					transitions.push({ index: lineEnd, fence });
				}
			}
		}

		lineStart = lineEnd;
	}

	return transitions;
}

function safeHardLimit(text: string, start: number, capacity: number): number {
	let end = Math.min(start + capacity, text.length);
	if (end < text.length) {
		const previous = text.charCodeAt(end - 1);
		const next = text.charCodeAt(end);
		if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
			end -= 1;
		}
	}
	return end;
}

function preferredBreak(text: string, start: number, capacity: number): number {
	const hardEnd = safeHardLimit(text, start, capacity);
	if (hardEnd >= text.length) return hardEnd;

	const newline = text.lastIndexOf("\n", hardEnd - 1);
	if (newline >= start) return newline + 1;

	const space = Math.max(text.lastIndexOf(" ", hardEnd - 1), text.lastIndexOf("\t", hardEnd - 1));
	if (space >= start) return space + 1;
	return hardEnd;
}

function fenceAt(
	transitions: readonly FenceTransition[],
	index: number,
	transitionIndex: number,
): { fence: MarkdownFence | undefined; transitionIndex: number } {
	let nextTransition = transitionIndex;
	let fence = nextTransition === 0 ? undefined : transitions[nextTransition - 1]?.fence;
	while (nextTransition < transitions.length && transitions[nextTransition].index <= index) {
		fence = transitions[nextTransition].fence;
		nextTransition += 1;
	}
	return { fence, transitionIndex: nextTransition };
}

function continuationOpener(fence: MarkdownFence, maxLength: number): string {
	const opener = `${fence.opener}\n`;
	const closeLength = fence.marker.length + 1;
	return opener.length + closeLength < maxLength ? opener : `${fence.marker}\n`;
}

export function splitDiscordMessage(text: string, maxLength = DISCORD_MESSAGE_LIMIT): readonly string[] {
	if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
		throw new Error("maxLength must be a positive safe integer");
	}
	if (text.length === 0) return [];

	const transitions = readFenceTransitions(text);
	const chunks: string[] = [];
	let start = 0;
	let transitionIndex = 0;

	while (start < text.length) {
		const startState = fenceAt(transitions, start, transitionIndex);
		transitionIndex = startState.transitionIndex;
		const prefix = startState.fence ? continuationOpener(startState.fence, maxLength) : "";
		let bodyCapacity = maxLength - prefix.length;
		if (bodyCapacity < 1) {
			throw new Error("maxLength is too small to balance the active Markdown fence");
		}

		let end = preferredBreak(text, start, bodyCapacity);
		let endState = fenceAt(transitions, end, transitionIndex);
		let suffix = endState.fence ? `\n${endState.fence.marker}` : "";

		while (end - start + suffix.length > maxLength - prefix.length) {
			bodyCapacity = maxLength - prefix.length - suffix.length;
			if (bodyCapacity < 1) {
				throw new Error("maxLength is too small to balance the active Markdown fence");
			}
			end = preferredBreak(text, start, bodyCapacity);
			endState = fenceAt(transitions, end, transitionIndex);
			suffix = endState.fence ? `\n${endState.fence.marker}` : "";
		}

		if (end <= start) {
			throw new Error("Unable to split Discord message within maxLength");
		}

		chunks.push(`${prefix}${text.slice(start, end)}${suffix}`);
		start = end;
	}

	return chunks;
}

export class DiscordResponseWriter {
	readonly #channel: DiscordResponseChannelPort;
	readonly #message: DiscordResponseMessagePort | undefined;
	readonly #options: Required<
		Pick<DiscordResponseWriterOptions, "updateIntervalMs" | "placeholderText" | "emptyText" | "errorText">
	> &
		Pick<DiscordResponseWriterOptions, "onDeliveryError">;
	readonly #errors: unknown[];
	#text = "";
	#lastStreamedText = "";
	#lastEditAt: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#operations: Promise<void> = Promise.resolve();
	#finished = false;

	constructor(
		channel: DiscordResponseChannelPort,
		message: DiscordResponseMessagePort | undefined,
		options: DiscordResponseWriterOptions,
		initialErrors: readonly unknown[] = [],
	) {
		this.#channel = channel;
		this.#message = message;
		this.#errors = [...initialErrors];
		this.#options = {
			updateIntervalMs: options.updateIntervalMs,
			placeholderText: options.placeholderText ?? DEFAULT_PLACEHOLDER,
			emptyText: options.emptyText ?? DEFAULT_EMPTY_RESPONSE,
			errorText: options.errorText ?? DEFAULT_ERROR_RESPONSE,
			onDeliveryError: options.onDeliveryError,
		};
	}

	append(delta: string): void {
		if (this.#finished) throw new Error("Cannot append to a finished Discord response");
		if (delta.length === 0) return;
		this.#text += delta;
		this.#scheduleUpdate();
	}

	async finish(finalText?: string): Promise<DiscordResponseWriteResult> {
		const content = finalText ?? this.#text;
		return this.#finalize(content || this.#options.emptyText);
	}

	async fail(errorText = this.#options.errorText): Promise<DiscordResponseWriteResult> {
		return this.#finalize(errorText || this.#options.errorText);
	}

	get deliveryErrors(): readonly unknown[] {
		return [...this.#errors];
	}

	#scheduleUpdate(): void {
		if (this.#timer || !this.#message) return;
		const elapsed = this.#lastEditAt === undefined ? 0 : Date.now() - this.#lastEditAt;
		const delay =
			this.#lastEditAt === undefined
				? this.#options.updateIntervalMs
				: Math.max(0, this.#options.updateIntervalMs - elapsed);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			const snapshot = this.#text;
			this.#queue(async () => {
				if (!this.#message || snapshot === this.#lastStreamedText) return;
				const chunks = splitDiscordMessage(snapshot);
				const preview = chunks[chunks.length - 1];
				if (!preview) return;
				if (await this.#edit(preview)) this.#lastStreamedText = snapshot;
			});
		}, delay);
	}

	#queue(operation: () => Promise<void>): void {
		this.#operations = this.#operations.then(operation, operation);
	}

	async #waitForEditWindow(): Promise<void> {
		if (this.#lastEditAt === undefined) return;
		const delay = this.#options.updateIntervalMs - (Date.now() - this.#lastEditAt);
		if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
	}

	async #edit(content: string): Promise<boolean> {
		if (!this.#message) return false;
		await this.#waitForEditWindow();
		this.#lastEditAt = Date.now();
		try {
			await this.#message.edit(messagePayload(content));
			return true;
		} catch (error) {
			this.#recordDeliveryError(error);
			return false;
		}
	}

	async #send(content: string): Promise<void> {
		try {
			await this.#channel.send(messagePayload(content));
		} catch (error) {
			this.#recordDeliveryError(error);
		}
	}

	#recordDeliveryError(error: unknown): void {
		this.#errors.push(error);
		try {
			this.#options.onDeliveryError?.(error);
		} catch {
			// Delivery reporting must not affect agent execution or response finalization.
		}
	}

	async #finalize(content: string): Promise<DiscordResponseWriteResult> {
		if (this.#finished) throw new Error("Discord response has already been finalized");
		this.#finished = true;
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}

		await this.#operations;
		const chunks = splitDiscordMessage(content);
		const first = chunks[0] ?? this.#options.emptyText;
		if (!this.#message) {
			await this.#send(first);
		} else if (chunks.length > 1 || this.#lastStreamedText !== content) {
			await this.#edit(first);
		}
		for (const chunk of chunks.slice(1)) await this.#send(chunk);
		return { chunks, deliveryErrors: [...this.#errors] };
	}
}

export async function createDiscordResponseWriter(
	channel: DiscordResponseChannelPort,
	options: DiscordResponseWriterOptions,
): Promise<DiscordResponseWriter> {
	if (!Number.isSafeInteger(options.updateIntervalMs) || options.updateIntervalMs < 0) {
		throw new Error("updateIntervalMs must be a non-negative safe integer");
	}

	const placeholder = options.placeholderText ?? DEFAULT_PLACEHOLDER;
	let message: DiscordResponseMessagePort | undefined;
	let initialErrors: readonly unknown[] = [];
	try {
		message = await channel.send(messagePayload(placeholder));
	} catch (error) {
		initialErrors = [error];
		try {
			options.onDeliveryError?.(error);
		} catch {
			// Delivery reporting must not affect agent execution.
		}
	}

	return new DiscordResponseWriter(channel, message, options, initialErrors);
}
