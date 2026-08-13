import { describe, expect, it } from "vitest";
import type { DiscordMessageRouteInput, DiscordRoutingPolicy } from "../../src/gateway/discord/routing.js";
import { routeMessage, stripBotMention } from "../../src/gateway/discord/routing.js";

function policy(overrides: Partial<DiscordRoutingPolicy> = {}): DiscordRoutingPolicy {
	return {
		allowedUsers: ["user-1"],
		allowedRoles: [],
		allowAllUsers: false,
		allowedGuilds: [],
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

function message(overrides: Partial<DiscordMessageRouteInput> = {}): DiscordMessageRouteInput {
	return {
		kind: "guild",
		channelId: "channel-1",
		guildId: "guild-1",
		authorId: "user-1",
		authorIsBot: false,
		mentionsBot: true,
		...overrides,
	};
}

describe("routeMessage", () => {
	it("fails closed without an identity or channel authorization rule", () => {
		const closed = policy({ allowedUsers: [] });

		expect(routeMessage(message(), closed)).toEqual({ action: "ignore", reason: "unauthorized" });
		expect(routeMessage(message({ kind: "dm", mentionsBot: false }), closed)).toEqual({
			action: "ignore",
			reason: "unauthorized",
		});
	});

	it("allows authorized DMs without a mention", () => {
		expect(routeMessage(message({ kind: "dm", mentionsBot: false }), policy())).toEqual({
			action: "respond",
			reason: "direct_message",
			createThread: false,
		});
	});

	it("filters guild traffic before channel policy without restricting DMs", () => {
		const guildRestricted = policy({ allowedGuilds: ["guild-1"], allowedChannels: ["channel-1"] });
		expect(routeMessage(message(), guildRestricted)).toMatchObject({ action: "respond" });
		expect(routeMessage(message({ guildId: "guild-2" }), guildRestricted)).toEqual({
			action: "ignore",
			reason: "guild_not_allowed",
		});
		expect(routeMessage(message({ kind: "dm", guildId: undefined, mentionsBot: false }), guildRestricted)).toEqual({
			action: "respond",
			reason: "direct_message",
			createThread: false,
		});
	});

	it("applies guild, ignored, channel, and authorization policy before mention policy", () => {
		const guildRestricted = policy({ allowedGuilds: ["guild-2"], ignoredChannels: ["channel-1"] });
		expect(routeMessage(message(), guildRestricted)).toEqual({
			action: "ignore",
			reason: "guild_not_allowed",
		});
		expect(routeMessage(message({ guildId: undefined }), guildRestricted)).toEqual({
			action: "ignore",
			reason: "guild_not_allowed",
		});

		const ignored = policy({ ignoredChannels: ["channel-1"], allowedUsers: [] });
		expect(routeMessage(message({ mentionsBot: true }), ignored)).toEqual({
			action: "ignore",
			reason: "ignored_channel",
		});

		const restricted = policy({ allowedChannels: ["channel-2"] });
		expect(routeMessage(message({ mentionsBot: true }), restricted)).toEqual({
			action: "ignore",
			reason: "channel_not_allowed",
		});

		expect(routeMessage(message({ authorId: "unknown", mentionsBot: false }), policy())).toEqual({
			action: "ignore",
			reason: "unauthorized",
		});
	});

	it("uses an allowed guild channel as the sole authorization rule", () => {
		const channelScoped = policy({ allowedUsers: [], allowedChannels: ["channel-1"] });
		expect(routeMessage(message({ authorId: "unknown" }), channelScoped)).toEqual({
			action: "respond",
			reason: "mentioned",
			createThread: true,
		});
	});

	it("does not let an allowed channel bypass a configured identity allowlist", () => {
		const channelAndIdentityScoped = policy({ allowedUsers: ["user-2"], allowedChannels: ["channel-1"] });
		expect(routeMessage(message({ authorId: "unknown" }), channelAndIdentityScoped)).toEqual({
			action: "ignore",
			reason: "unauthorized",
		});
	});

	it("authorizes matching roles", () => {
		const roleScoped = policy({ allowedUsers: [], allowedRoles: ["role-1"] });
		expect(routeMessage(message({ authorId: "unknown", authorRoleIds: ["role-1"] }), roleScoped)).toEqual({
			action: "respond",
			reason: "mentioned",
			createThread: true,
		});
	});

	it("inherits ignored, allowed, and free-response policy from a thread parent", () => {
		const thread = message({
			kind: "thread",
			channelId: "thread-1",
			parentChannelId: "parent-1",
			mentionsBot: false,
		});
		expect(routeMessage(thread, policy({ ignoredChannels: ["parent-1"] }))).toEqual({
			action: "ignore",
			reason: "ignored_channel",
		});
		expect(routeMessage(thread, policy({ allowedChannels: ["parent-1"] }))).toEqual({
			action: "ignore",
			reason: "mention_required",
		});
		expect(routeMessage(thread, policy({ freeResponseChannels: ["parent-1"] }))).toEqual({
			action: "respond",
			reason: "free_response_channel",
			createThread: false,
		});
	});

	it("continues a participated thread unless thread mentions are required", () => {
		const thread = message({ kind: "thread", mentionsBot: false, botParticipatedInThread: true });
		expect(routeMessage(thread, policy())).toMatchObject({ action: "respond", reason: "thread_continuation" });
		expect(routeMessage(thread, policy({ threadRequireMention: true }))).toEqual({
			action: "ignore",
			reason: "mention_required",
		});
	});

	it("supports none, mentions, and all bot-message modes after authorization", () => {
		const bot = message({ authorIsBot: true, mentionsBot: false });
		expect(routeMessage(bot, policy())).toEqual({ action: "ignore", reason: "bot_messages_disabled" });
		expect(routeMessage(bot, policy({ botMessageMode: "mentions" }))).toEqual({
			action: "ignore",
			reason: "bot_mention_required",
		});
		expect(routeMessage({ ...bot, mentionsBot: true }, policy({ botMessageMode: "mentions" }))).toMatchObject({
			action: "respond",
			reason: "mentioned",
		});
		expect(routeMessage(bot, policy({ botMessageMode: "all" }))).toEqual({
			action: "respond",
			reason: "bot_messages_allowed",
			createThread: false,
		});
	});

	it("ignores messages directed at other users when a bot mention is required", () => {
		expect(routeMessage(message({ mentionsBot: false, mentionsOtherUsers: true }), policy())).toEqual({
			action: "ignore",
			reason: "other_user_mentioned",
		});
	});

	it("creates a daughter thread for every admitted parent-channel message", () => {
		expect(routeMessage(message(), policy())).toMatchObject({ action: "respond", createThread: true });
		expect(routeMessage(message({ mentionsBot: false }), policy({ freeResponseChannels: ["channel-1"] }))).toEqual({
			action: "respond",
			reason: "free_response_channel",
			createThread: true,
		});
		expect(routeMessage(message({ mentionsBot: false }), policy({ requireMention: false }))).toEqual({
			action: "respond",
			reason: "mention_not_required",
			createThread: true,
		});
		expect(
			routeMessage(message({ kind: "thread", mentionsBot: false, botParticipatedInThread: true }), policy()),
		).toEqual({
			action: "respond",
			reason: "thread_continuation",
			createThread: false,
		});
		expect(routeMessage(message({ kind: "dm", mentionsBot: false }), policy())).toEqual({
			action: "respond",
			reason: "direct_message",
			createThread: false,
		});
		expect(routeMessage(message(), policy({ autoThread: false }))).toMatchObject({
			action: "respond",
			createThread: false,
		});
		expect(routeMessage(message(), policy({ noThreadChannels: ["channel-1"] }))).toMatchObject({
			action: "respond",
			createThread: false,
		});
	});
});

describe("stripBotMention", () => {
	it("strips both Discord user mention forms", () => {
		expect(stripBotMention("<@123>, run the check", "123")).toBe("run the check");
		expect(stripBotMention("<@!123>: run the check", "123")).toBe("run the check");
		expect(stripBotMention("please ask <@123> now", "123")).toBe("please ask  now");
	});

	it("does not strip mentions of other users", () => {
		expect(stripBotMention("<@456> ask <@123>", "123")).toBe("<@456> ask");
	});
});
