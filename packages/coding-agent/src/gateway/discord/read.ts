import {
	type DiscordGatewayReadAttachment,
	type DiscordGatewayReadErrorCode,
	type DiscordGatewayReadMessage,
	type DiscordGatewayReadRequest,
	type DiscordGatewayReadResponse,
	discordGatewayReadFailure,
} from "../../core/discord-gateway-read.js";
import type { DiscordRoutingPolicy } from "./routing.js";

const DISCORD_MESSAGE_URL_HOSTS = new Set(["discord.com"]);
const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MAX_AUTHOR_TEXT_CHARS = 200;
const MAX_ATTACHMENT_NAME_CHARS = 160;
const MAX_ATTACHMENT_TYPE_CHARS = 120;

export interface DiscordReadLimits {
	maxMessages: number;
	maxContentChars: number;
	maxTotalContentChars: number;
	maxAttachments: number;
}

export interface DiscordReadScope {
	userId: string;
	kind: "dm" | "guild" | "thread";
	channelId: string;
	guildId?: string;
}

export interface ParsedDiscordMessageUrl {
	kind: "dm" | "guild";
	guildId?: string;
	channelId: string;
	messageId: string;
}

export interface DiscordReadAttachmentSource {
	id: string;
	name: string;
	contentType?: string;
	size: number;
}

export interface DiscordReadMessageSource {
	id: string;
	channelId: string;
	guildId?: string;
	createdTimestamp: number;
	author: {
		id: string;
		username: string;
		displayName?: string;
	};
	content: string;
	attachments: readonly DiscordReadAttachmentSource[];
}

export interface DiscordReadChannel {
	id: string;
	kind: "dm" | "guild" | "thread";
	guildId?: string;
	parentChannelId?: string;
	canUserView?: (userId: string) => Promise<boolean>;
	getMessage(messageId: string): Promise<DiscordReadMessageSource | undefined>;
	getRecentMessages(limit: number): Promise<readonly DiscordReadMessageSource[]>;
}

export interface DiscordReadAdapter {
	getChannel(channelId: string): Promise<DiscordReadChannel | undefined>;
}

export class DiscordReadAdapterError extends Error {
	constructor(
		readonly code: DiscordGatewayReadErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DiscordReadAdapterError";
	}
}

export function parseDiscordMessageUrl(value: string): ParsedDiscordMessageUrl {
	if (value.trim() !== value) throw new DiscordReadAdapterError("INVALID_REQUEST", "Discord message URL is invalid.");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new DiscordReadAdapterError("INVALID_REQUEST", "Discord message URL is invalid.");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		!DISCORD_MESSAGE_URL_HOSTS.has(url.hostname) ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new DiscordReadAdapterError("INVALID_REQUEST", "Discord message URL is invalid.");
	}
	const parts = url.pathname.split("/");
	if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "channels") {
		throw new DiscordReadAdapterError("INVALID_REQUEST", "Discord message URL is invalid.");
	}
	const [, , guildId, channelId, messageId] = parts;
	if (
		!guildId ||
		!channelId ||
		!messageId ||
		!DISCORD_SNOWFLAKE_PATTERN.test(channelId) ||
		!DISCORD_SNOWFLAKE_PATTERN.test(messageId)
	) {
		throw new DiscordReadAdapterError("INVALID_REQUEST", "Discord message URL is invalid.");
	}
	if (guildId === "@me") return { kind: "dm", channelId, messageId };
	if (!DISCORD_SNOWFLAKE_PATTERN.test(guildId)) {
		throw new DiscordReadAdapterError("INVALID_REQUEST", "Discord message URL is invalid.");
	}
	return { kind: "guild", guildId, channelId, messageId };
}

export class DiscordReadService {
	constructor(
		private readonly adapter: DiscordReadAdapter,
		private readonly policy: DiscordRoutingPolicy,
		private readonly limits: DiscordReadLimits,
		private readonly resolveRoleIds: (userId: string, guildId?: string) => Promise<readonly string[] | undefined>,
	) {
		assertLimits(limits);
	}

	async read(scope: DiscordReadScope, input: DiscordGatewayReadRequest): Promise<DiscordGatewayReadResponse> {
		try {
			const target = await this.resolveTarget(scope, input);
			await this.authorize(scope, target);
			if (input.action === "message") {
				const messageId = parseDiscordMessageUrl(input.messageUrl ?? "").messageId;
				const message = await target.getMessage(messageId);
				if (!message || message.id !== messageId || message.channelId !== target.id) {
					return discordGatewayReadFailure(
						"UNAVAILABLE",
						"The requested Discord message is unavailable or was deleted.",
					);
				}
				return { ok: true, untrusted: true, message: normalizeMessage(message, this.limits) };
			}

			const limit = resolveHistoryLimit(input.limit, this.limits.maxMessages);
			const messages = await target.getRecentMessages(limit);
			return {
				ok: true,
				untrusted: true,
				messages: normalizeHistory(messages, target, limit, this.limits),
			};
		} catch (error) {
			return readFailure(error);
		}
	}

	private async resolveTarget(scope: DiscordReadScope, input: DiscordGatewayReadRequest): Promise<DiscordReadChannel> {
		let channelId: string;
		if (input.action === "message") {
			const parsed = parseDiscordMessageUrl(input.messageUrl ?? "");
			if (scope.kind === "dm") {
				if (parsed.kind !== "dm" || parsed.channelId !== scope.channelId) {
					throw forbidden("Discord reads are limited to the current direct message.");
				}
			} else if (parsed.kind !== "guild" || parsed.guildId !== scope.guildId) {
				throw forbidden("Discord reads are limited to the initiating guild.");
			}
			channelId = parsed.channelId;
		} else {
			if (input.messageUrl !== undefined) {
				throw invalidRequest("A Discord message URL can only be used with action=message.");
			}
			if (input.channelId !== undefined && !DISCORD_SNOWFLAKE_PATTERN.test(input.channelId)) {
				throw invalidRequest("Discord channel ID is invalid.");
			}
			if (scope.kind === "dm" && input.channelId && input.channelId !== scope.channelId) {
				throw forbidden("Discord reads are limited to the current direct message.");
			}
			channelId = input.channelId ?? scope.channelId;
		}

		const channel = await this.adapter.getChannel(channelId);
		if (!channel || channel.id !== channelId) {
			throw unavailable("The requested Discord channel is unavailable.");
		}
		if (scope.kind === "dm") {
			if (channel.kind !== "dm" || channel.id !== scope.channelId) {
				throw forbidden("Discord reads are limited to the current direct message.");
			}
			return channel;
		}
		if (channel.kind === "dm" || channel.guildId !== scope.guildId) {
			throw forbidden("Discord reads are limited to the initiating guild.");
		}
		return channel;
	}

	private async authorize(scope: DiscordReadScope, channel: DiscordReadChannel): Promise<void> {
		if (scope.kind === "dm") {
			const roleIds = await this.resolveRoleIds(scope.userId);
			const authorized =
				this.policy.allowAllUsers ||
				this.policy.allowedUsers.includes(scope.userId) ||
				roleIds?.some((roleId) => this.policy.allowedRoles.includes(roleId));
			if (!authorized) throw forbidden("The initiating Discord user is no longer authorized.");
			return;
		}
		const parentChannelId = channel.kind === "thread" ? channel.parentChannelId : channel.id;
		if (!parentChannelId) {
			throw forbidden("The Discord thread parent is unavailable.");
		}
		if (this.policy.ignoredChannels.includes(channel.id) || this.policy.ignoredChannels.includes(parentChannelId)) {
			throw forbidden("This Discord channel is forbidden by gateway policy.");
		}
		const parentAllowed = this.policy.allowedChannels.includes(parentChannelId);
		if (this.policy.allowedChannels.length > 0 && !parentAllowed) {
			throw forbidden("This Discord channel is not authorized by gateway policy.");
		}
		const isCurrentChannel = channel.id === scope.channelId;
		if (!isCurrentChannel && !parentAllowed) {
			throw forbidden("Reading another Discord channel requires its parent channel to be explicitly allowed.");
		}
		const roleIds = await this.resolveRoleIds(scope.userId, scope.guildId!);
		const hasExplicitIdentity =
			this.policy.allowAllUsers ||
			this.policy.allowedUsers.includes(scope.userId) ||
			roleIds?.some((roleId) => this.policy.allowedRoles.includes(roleId));
		if (!hasExplicitIdentity && !parentAllowed) {
			throw forbidden("The initiating Discord user is no longer authorized.");
		}
		if (channel.canUserView && !(await channel.canUserView(scope.userId))) {
			throw forbidden("The initiating Discord user cannot view this Discord channel.");
		}
	}
}

function normalizeHistory(
	messages: readonly DiscordReadMessageSource[],
	channel: DiscordReadChannel,
	limit: number,
	limits: DiscordReadLimits,
): readonly DiscordGatewayReadMessage[] {
	const ordered = [...messages]
		.filter((message) => message.channelId === channel.id)
		.sort((left, right) => right.createdTimestamp - left.createdTimestamp || right.id.localeCompare(left.id))
		.slice(0, limit);
	let remainingContent = limits.maxTotalContentChars;
	return ordered.map((message) => {
		const normalized = normalizeMessage(message, limits, remainingContent);
		remainingContent -= normalized.content.length;
		return normalized;
	});
}

function normalizeMessage(
	message: DiscordReadMessageSource,
	limits: DiscordReadLimits,
	contentLimit = limits.maxContentChars,
): DiscordGatewayReadMessage {
	const cappedContent = Math.min(limits.maxContentChars, Math.max(0, contentLimit));
	const content = truncateText(message.content, cappedContent);
	const visibleAttachments = message.attachments.slice(0, limits.maxAttachments).map(normalizeAttachment);
	const createdAt = new Date(message.createdTimestamp);
	return {
		id: message.id,
		channelId: message.channelId,
		...(message.guildId ? { guildId: message.guildId } : {}),
		url: `https://discord.com/channels/${message.guildId ?? "@me"}/${message.channelId}/${message.id}`,
		createdAt: Number.isFinite(createdAt.getTime()) ? createdAt.toISOString() : new Date(0).toISOString(),
		author: {
			id: message.author.id,
			username: truncateText(message.author.username, MAX_AUTHOR_TEXT_CHARS).text,
			...(message.author.displayName
				? { displayName: truncateText(message.author.displayName, MAX_AUTHOR_TEXT_CHARS).text }
				: {}),
		},
		content: content.text,
		contentTruncated: content.truncated,
		attachments: visibleAttachments,
		attachmentsTruncated: message.attachments.length > visibleAttachments.length,
	};
}

function normalizeAttachment(source: DiscordReadAttachmentSource): DiscordGatewayReadAttachment {
	return {
		id: source.id,
		name: truncateText(source.name, MAX_ATTACHMENT_NAME_CHARS).text,
		...(source.contentType ? { contentType: truncateText(source.contentType, MAX_ATTACHMENT_TYPE_CHARS).text } : {}),
		size: Number.isSafeInteger(source.size) && source.size >= 0 ? source.size : 0,
	};
}

function resolveHistoryLimit(value: number | undefined, maximum: number): number {
	if (value === undefined) return maximum;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw invalidRequest("Discord history limit must be a positive integer.");
	}
	return Math.min(value, maximum);
}

function truncateText(value: string, maximum: number): { text: string; truncated: boolean } {
	if (value.length <= maximum) return { text: value, truncated: false };
	let end = maximum;
	if (end > 0 && /^[\uD800-\uDBFF]$/.test(value[end - 1] ?? "") && /^[\uDC00-\uDFFF]$/.test(value[end] ?? "")) {
		end--;
	}
	return { text: value.slice(0, end), truncated: true };
}

function assertLimits(limits: DiscordReadLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value < 0 || (name !== "maxAttachments" && value === 0)) {
			throw new Error(`Discord read ${name} must be a valid bounded integer.`);
		}
	}
}

function invalidRequest(message: string): DiscordReadAdapterError {
	return new DiscordReadAdapterError("INVALID_REQUEST", message);
}

function forbidden(message: string): DiscordReadAdapterError {
	return new DiscordReadAdapterError("FORBIDDEN", message);
}

function unavailable(message: string): DiscordReadAdapterError {
	return new DiscordReadAdapterError("UNAVAILABLE", message);
}

function readFailure(error: unknown): DiscordGatewayReadResponse {
	if (error instanceof DiscordReadAdapterError) {
		if (error.code === "MISSING_PERMISSION") {
			return discordGatewayReadFailure(
				"MISSING_PERMISSION",
				"Discord denied permission to read that message or channel.",
			);
		}
		return discordGatewayReadFailure(error.code, error.message);
	}
	return discordGatewayReadFailure("UNAVAILABLE", "Discord data is currently unavailable.");
}
