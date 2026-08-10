import { join, resolve } from "node:path";
import { getAgentDir } from "../../config.js";

export type DiscordBotMessageMode = "none" | "mentions" | "all";

export interface DiscordBridgeConfig {
	botToken: string;
	allowedUsers: readonly string[];
	allowedRoles: readonly string[];
	allowAllUsers: boolean;
	allowedChannels: readonly string[];
	ignoredChannels: readonly string[];
	freeResponseChannels: readonly string[];
	noThreadChannels: readonly string[];
	requireMention: boolean;
	threadRequireMention: boolean;
	ignoreNoMention: boolean;
	autoThread: boolean;
	reactions: boolean;
	botMessageMode: DiscordBotMessageMode;
	groupSessionsPerUser: boolean;
	historyBackfill: boolean;
	historyBackfillLimit: number;
	maxAttachmentBytes: number;
	maxAttachments: number;
	attachmentTimeoutMs: number;
	streamUpdateIntervalMs: number;
	registerCommands: boolean;
	toolProgress: boolean;
	cwd: string;
	sessionDir: string;
	cacheDir: string;
}

export type RedactedDiscordBridgeConfig = Omit<DiscordBridgeConfig, "botToken"> & {
	botToken: "[REDACTED]";
};

export type DiscordEnvironment = Readonly<Record<string, string | undefined>>;

const BOT_MESSAGE_MODES = ["none", "mentions", "all"] as const;
const REDACTED_TOKEN = "[REDACTED]" as const;

function readRequired(env: DiscordEnvironment, name: string): string {
	const value = env[name]?.trim();
	if (!value) {
		throw new Error(`${name} is required`);
	}
	return value;
}

function readBoolean(env: DiscordEnvironment, name: string, defaultValue: boolean): boolean {
	const value = env[name]?.trim().toLowerCase();
	if (!value) return defaultValue;

	if (["true", "1", "yes", "on"].includes(value)) return true;
	if (["false", "0", "no", "off"].includes(value)) return false;
	throw new Error(`${name} must be a boolean (true/false, yes/no, on/off, or 1/0)`);
}

function readNonNegativeInteger(env: DiscordEnvironment, name: string, defaultValue: number): number {
	const value = env[name]?.trim();
	if (!value) return defaultValue;
	if (!/^\d+$/.test(value)) {
		throw new Error(`${name} must be a non-negative integer`);
	}

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new Error(`${name} must be a safe non-negative integer`);
	}
	return parsed;
}

function readPositiveInteger(env: DiscordEnvironment, name: string, defaultValue: number): number {
	const parsed = readNonNegativeInteger(env, name, defaultValue);
	if (parsed === 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function readIdList(env: DiscordEnvironment, name: string): readonly string[] {
	const value = env[name]?.trim();
	if (!value) return [];

	const ids = value
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	const invalid = ids.find((id) => !/^\d+$/.test(id));
	if (invalid) throw new Error(`${name} must contain comma-separated Discord IDs`);
	return [...new Set(ids)];
}

function readEnum<const T extends readonly string[]>(
	env: DiscordEnvironment,
	name: string,
	values: T,
	defaultValue: T[number],
): T[number] {
	const value = env[name]?.trim().toLowerCase();
	if (!value) return defaultValue;
	if (values.includes(value as T[number])) return value as T[number];
	throw new Error(`${name} must be one of: ${values.join(", ")}`);
}

function readPath(env: DiscordEnvironment, name: string, defaultValue: string): string {
	const value = env[name]?.trim();
	return resolve(value || defaultValue);
}

export function loadDiscordConfig(env: DiscordEnvironment = process.env): DiscordBridgeConfig {
	const cwd = readPath(env, "PRIME_DISCORD_CWD", process.cwd());
	const discordStateDir = join(getAgentDir(), "discord");
	return {
		botToken: readRequired(env, "PRIME_DISCORD_BOT_TOKEN"),
		allowedUsers: readIdList(env, "PRIME_DISCORD_ALLOWED_USERS"),
		allowedRoles: readIdList(env, "PRIME_DISCORD_ALLOWED_ROLES"),
		allowAllUsers: readBoolean(env, "PRIME_DISCORD_ALLOW_ALL_USERS", false),
		allowedChannels: readIdList(env, "PRIME_DISCORD_ALLOWED_CHANNELS"),
		ignoredChannels: readIdList(env, "PRIME_DISCORD_IGNORED_CHANNELS"),
		freeResponseChannels: readIdList(env, "PRIME_DISCORD_FREE_RESPONSE_CHANNELS"),
		noThreadChannels: readIdList(env, "PRIME_DISCORD_NO_THREAD_CHANNELS"),
		requireMention: readBoolean(env, "PRIME_DISCORD_REQUIRE_MENTION", true),
		threadRequireMention: readBoolean(env, "PRIME_DISCORD_THREAD_REQUIRE_MENTION", false),
		ignoreNoMention: readBoolean(env, "PRIME_DISCORD_IGNORE_NO_MENTION", true),
		autoThread: readBoolean(env, "PRIME_DISCORD_AUTO_THREAD", true),
		reactions: readBoolean(env, "PRIME_DISCORD_REACTIONS", true),
		botMessageMode: readEnum(env, "PRIME_DISCORD_ALLOW_BOTS", BOT_MESSAGE_MODES, "none"),
		groupSessionsPerUser: readBoolean(env, "PRIME_DISCORD_GROUP_SESSIONS_PER_USER", true),
		historyBackfill: readBoolean(env, "PRIME_DISCORD_HISTORY_BACKFILL", true),
		historyBackfillLimit: readNonNegativeInteger(env, "PRIME_DISCORD_HISTORY_BACKFILL_LIMIT", 50),
		maxAttachmentBytes: readNonNegativeInteger(env, "PRIME_DISCORD_MAX_ATTACHMENT_BYTES", 32 * 1024 * 1024),
		maxAttachments: readNonNegativeInteger(env, "PRIME_DISCORD_MAX_ATTACHMENTS", 5),
		attachmentTimeoutMs: readPositiveInteger(env, "PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS", 30_000),
		streamUpdateIntervalMs: readNonNegativeInteger(env, "PRIME_DISCORD_STREAM_UPDATE_INTERVAL_MS", 1_000),
		registerCommands: readBoolean(env, "PRIME_DISCORD_REGISTER_COMMANDS", true),
		toolProgress: readBoolean(env, "PRIME_DISCORD_TOOL_PROGRESS", true),
		cwd,
		sessionDir: readPath(env, "PRIME_DISCORD_SESSION_DIR", join(discordStateDir, "sessions")),
		cacheDir: readPath(env, "PRIME_DISCORD_CACHE_DIR", join(discordStateDir, "cache")),
	};
}

export function redactDiscordConfig(config: DiscordBridgeConfig): RedactedDiscordBridgeConfig {
	return { ...config, botToken: REDACTED_TOKEN };
}
