import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getAgentDir } from "../../src/config.js";
import { loadDiscordConfig, redactDiscordConfig } from "../../src/gateway/discord/config.js";

describe("loadDiscordConfig", () => {
	it("requires a bot token without disclosing secret values", () => {
		expect(() => loadDiscordConfig({})).toThrow("PRIME_DISCORD_BOT_TOKEN is required");
		expect(() => loadDiscordConfig({ PRIME_DISCORD_BOT_TOKEN: "  " })).toThrow("PRIME_DISCORD_BOT_TOKEN is required");
	});

	it("uses fail-closed Hermes-like defaults", () => {
		const cwd = resolve("discord-config-test");
		const stateDir = join(getAgentDir(), "discord");
		const config = loadDiscordConfig({ PRIME_DISCORD_BOT_TOKEN: "secret", PRIME_DISCORD_CWD: cwd });

		expect(config).toMatchObject({
			botToken: "secret",
			allowedUsers: [],
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
			reactions: true,
			botMessageMode: "none",
			groupSessionsPerUser: true,
			historyBackfill: true,
			historyBackfillLimit: 50,
			maxAttachmentBytes: 33_554_432,
			maxAttachments: 5,
			attachmentTimeoutMs: 30_000,
			streamUpdateIntervalMs: 1_000,
			registerCommands: true,
			toolProgress: true,
			extensionUiTimeoutMs: 300_000,
			cwd,
			sessionDir: join(stateDir, "sessions"),
			cacheDir: join(stateDir, "cache"),
		});
	});

	it("parses booleans, integers, lists, enums, and paths", () => {
		const config = loadDiscordConfig({
			PRIME_DISCORD_BOT_TOKEN: " token ",
			PRIME_DISCORD_ALLOWED_USERS: "100, 200,100,",
			PRIME_DISCORD_ALLOWED_ROLES: "300",
			PRIME_DISCORD_ALLOW_ALL_USERS: "YES",
			PRIME_DISCORD_ALLOWED_CHANNELS: "400, 500",
			PRIME_DISCORD_IGNORED_CHANNELS: "600",
			PRIME_DISCORD_FREE_RESPONSE_CHANNELS: "700",
			PRIME_DISCORD_NO_THREAD_CHANNELS: "800",
			PRIME_DISCORD_REQUIRE_MENTION: "off",
			PRIME_DISCORD_THREAD_REQUIRE_MENTION: "1",
			PRIME_DISCORD_IGNORE_NO_MENTION: "false",
			PRIME_DISCORD_AUTO_THREAD: "0",
			PRIME_DISCORD_REACTIONS: "no",
			PRIME_DISCORD_ALLOW_BOTS: "ALL",
			PRIME_DISCORD_GROUP_SESSIONS_PER_USER: "false",
			PRIME_DISCORD_HISTORY_BACKFILL: "false",
			PRIME_DISCORD_HISTORY_BACKFILL_LIMIT: "75",
			PRIME_DISCORD_MAX_ATTACHMENT_BYTES: "0",
			PRIME_DISCORD_MAX_ATTACHMENTS: "7",
			PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS: "1234",
			PRIME_DISCORD_STREAM_UPDATE_INTERVAL_MS: "250",
			PRIME_DISCORD_REGISTER_COMMANDS: "false",
			PRIME_DISCORD_TOOL_PROGRESS: "false",
			PRIME_DISCORD_EXTENSION_UI_TIMEOUT_MS: "4321",
			PRIME_DISCORD_CWD: "./workspace",
			PRIME_DISCORD_SESSION_DIR: "./state/sessions",
			PRIME_DISCORD_CACHE_DIR: "./state/cache",
		});

		expect(config).toMatchObject({
			botToken: "token",
			allowedUsers: ["100", "200"],
			allowedRoles: ["300"],
			allowAllUsers: true,
			allowedChannels: ["400", "500"],
			ignoredChannels: ["600"],
			freeResponseChannels: ["700"],
			noThreadChannels: ["800"],
			requireMention: false,
			threadRequireMention: true,
			ignoreNoMention: false,
			autoThread: false,
			reactions: false,
			botMessageMode: "all",
			groupSessionsPerUser: false,
			historyBackfill: false,
			historyBackfillLimit: 75,
			maxAttachmentBytes: 0,
			maxAttachments: 7,
			attachmentTimeoutMs: 1_234,
			streamUpdateIntervalMs: 250,
			registerCommands: false,
			toolProgress: false,
			extensionUiTimeoutMs: 4_321,
			cwd: resolve("./workspace"),
			sessionDir: resolve("./state/sessions"),
			cacheDir: resolve("./state/cache"),
		});
	});

	it("rejects invalid scalar settings", () => {
		const token = { PRIME_DISCORD_BOT_TOKEN: "secret" };
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_REACTIONS: "sometimes" })).toThrow(
			"PRIME_DISCORD_REACTIONS must be a boolean",
		);
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_HISTORY_BACKFILL_LIMIT: "-1" })).toThrow(
			"PRIME_DISCORD_HISTORY_BACKFILL_LIMIT must be a non-negative integer",
		);
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_MAX_ATTACHMENT_BYTES: "1.5" })).toThrow(
			"PRIME_DISCORD_MAX_ATTACHMENT_BYTES must be a non-negative integer",
		);
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS: "0" })).toThrow(
			"PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS must be a positive integer",
		);
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_EXTENSION_UI_TIMEOUT_MS: "0" })).toThrow(
			"PRIME_DISCORD_EXTENSION_UI_TIMEOUT_MS must be a positive integer",
		);
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_ALLOWED_USERS: "123,not-an-id" })).toThrow(
			"PRIME_DISCORD_ALLOWED_USERS must contain comma-separated Discord IDs",
		);
		expect(() => loadDiscordConfig({ ...token, PRIME_DISCORD_ALLOW_BOTS: "trusted" })).toThrow(
			"PRIME_DISCORD_ALLOW_BOTS must be one of: none, mentions, all",
		);
	});

	it("returns an explicitly redacted logging view", () => {
		const config = loadDiscordConfig({ PRIME_DISCORD_BOT_TOKEN: "never-log-this" });
		const redacted = redactDiscordConfig(config);

		expect(redacted.botToken).toBe("[REDACTED]");
		expect(JSON.stringify(redacted)).not.toContain("never-log-this");
		expect(config.botToken).toBe("never-log-this");
	});
});
