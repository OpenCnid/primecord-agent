import type { DiscordBotMessageMode } from "./config.js";

export type DiscordChannelKind = "dm" | "guild" | "thread";

export interface DiscordRoutingPolicy {
	allowedUsers: readonly string[];
	allowedRoles: readonly string[];
	allowAllUsers: boolean;
	/** Restricts server traffic before any channel or identity policy is evaluated. */
	allowedGuilds: readonly string[];
	allowedChannels: readonly string[];
	ignoredChannels: readonly string[];
	freeResponseChannels: readonly string[];
	noThreadChannels: readonly string[];
	requireMention: boolean;
	threadRequireMention: boolean;
	ignoreNoMention: boolean;
	autoThread: boolean;
	botMessageMode: DiscordBotMessageMode;
}

export interface DiscordMessageRouteInput {
	kind: DiscordChannelKind;
	channelId: string;
	guildId?: string;
	parentChannelId?: string;
	authorId: string;
	authorRoleIds?: readonly string[];
	authorIsBot: boolean;
	authorIsSelf?: boolean;
	mentionsBot: boolean;
	mentionsOtherUsers?: boolean;
	botParticipatedInThread?: boolean;
}

export type DiscordIgnoreReason =
	| "self_message"
	| "guild_not_allowed"
	| "ignored_channel"
	| "channel_not_allowed"
	| "unauthorized"
	| "bot_messages_disabled"
	| "bot_mention_required"
	| "other_user_mentioned"
	| "mention_required";

export type DiscordRespondReason =
	| "direct_message"
	| "bot_messages_allowed"
	| "free_response_channel"
	| "thread_continuation"
	| "mention_not_required"
	| "mentioned";

export type DiscordRouteDecision =
	| { action: "ignore"; reason: DiscordIgnoreReason }
	| { action: "respond"; reason: DiscordRespondReason; createThread: boolean };

function includesChannel(channels: readonly string[], input: DiscordMessageRouteInput): boolean {
	return (
		channels.includes(input.channelId) ||
		(input.parentChannelId !== undefined && channels.includes(input.parentChannelId))
	);
}

/**
 * An empty allowlist keeps the backwards-compatible behavior of accepting any guild.
 * A missing guild ID never satisfies a non-empty allowlist, so malformed server events fail closed.
 */
export function isAllowedGuild(
	policy: Pick<DiscordRoutingPolicy, "allowedGuilds">,
	guildId: string | undefined,
): boolean {
	return policy.allowedGuilds.length === 0 || (guildId !== undefined && policy.allowedGuilds.includes(guildId));
}

function isAuthorized(input: DiscordMessageRouteInput, policy: DiscordRoutingPolicy, channelAllowed: boolean): boolean {
	if (policy.allowAllUsers) return true;
	if (policy.allowedUsers.includes(input.authorId)) return true;
	if (input.authorRoleIds?.some((roleId) => policy.allowedRoles.includes(roleId))) return true;

	const hasIdentityAllowlist = policy.allowedUsers.length > 0 || policy.allowedRoles.length > 0;
	return input.kind !== "dm" && !hasIdentityAllowlist && policy.allowedChannels.length > 0 && channelAllowed;
}

function shouldCreateParentThread(input: DiscordMessageRouteInput, policy: DiscordRoutingPolicy): boolean {
	return policy.autoThread && input.kind === "guild" && !includesChannel(policy.noThreadChannels, input);
}

function respond(reason: DiscordRespondReason, createThread = false): DiscordRouteDecision {
	return { action: "respond", reason, createThread };
}

export function routeMessage(input: DiscordMessageRouteInput, policy: DiscordRoutingPolicy): DiscordRouteDecision {
	if (input.authorIsSelf) return { action: "ignore", reason: "self_message" };

	if (input.kind !== "dm" && !isAllowedGuild(policy, input.guildId)) {
		return { action: "ignore", reason: "guild_not_allowed" };
	}

	if (input.kind !== "dm" && includesChannel(policy.ignoredChannels, input)) {
		return { action: "ignore", reason: "ignored_channel" };
	}

	const channelAllowed = includesChannel(policy.allowedChannels, input);
	if (input.kind !== "dm" && policy.allowedChannels.length > 0 && !channelAllowed) {
		return { action: "ignore", reason: "channel_not_allowed" };
	}

	if (!isAuthorized(input, policy, channelAllowed)) {
		return { action: "ignore", reason: "unauthorized" };
	}

	if (input.authorIsBot) {
		if (policy.botMessageMode === "none") {
			return { action: "ignore", reason: "bot_messages_disabled" };
		}
		if (policy.botMessageMode === "mentions" && !input.mentionsBot) {
			return { action: "ignore", reason: "bot_mention_required" };
		}
		if (policy.botMessageMode === "all") return respond("bot_messages_allowed");
	}

	if (input.kind === "dm") return respond("direct_message");
	if (policy.ignoreNoMention && input.mentionsOtherUsers && !input.mentionsBot) {
		return { action: "ignore", reason: "other_user_mentioned" };
	}

	const freeResponse = includesChannel(policy.freeResponseChannels, input);
	if (freeResponse) return respond("free_response_channel", shouldCreateParentThread(input, policy));

	if (input.kind === "thread" && !policy.threadRequireMention && input.botParticipatedInThread) {
		return respond("thread_continuation");
	}

	if (!policy.requireMention) return respond("mention_not_required", shouldCreateParentThread(input, policy));

	if (input.mentionsBot) return respond("mentioned", shouldCreateParentThread(input, policy));

	return { action: "ignore", reason: "mention_required" };
}

function escapeRegularExpression(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripBotMention(content: string, botUserId: string): string {
	const escapedId = escapeRegularExpression(botUserId);
	const leadingMention = new RegExp(`^\\s*<@!?${escapedId}>\\s*[,;:]?\\s*`);
	const remainingMentions = new RegExp(`<@!?${escapedId}>`, "g");
	return content.replace(leadingMention, "").replace(remainingMentions, "").trim();
}
