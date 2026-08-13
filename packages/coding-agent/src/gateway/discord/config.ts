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
	readMaxMessages: number;
	readMaxContentChars: number;
	readMaxTotalContentChars: number;
	readMaxAttachments: number;
	maxAttachmentBytes: number;
	maxAttachments: number;
	maxOutboundAttachmentBytes: number;
	maxOutboundAttachments: number;
	attachmentTimeoutMs: number;
	streamUpdateIntervalMs: number;
	progressUpdateIntervalMs: number;
	/** Periodic Gateway WebSocket health sampling; 0 disables the watchdog. */
	gatewayHealthCheckIntervalMs: number;
	/** Consecutive unhealthy samples required before the bridge exits for supervised recovery. */
	gatewayHealthFailureThreshold: number;
	/** Maximum accepted Gateway heartbeat round-trip time; 0 disables the latency threshold. */
	gatewayMaxPingMs: number;
	registerCommands: boolean;
	toolProgress: boolean;
	extensionUiTimeoutMs: number;
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
export const DEFAULT_DISCORD_READ_MAX_MESSAGES = 50;
export const DEFAULT_DISCORD_READ_MAX_CONTENT_CHARS = 4_000;
export const DEFAULT_DISCORD_READ_MAX_TOTAL_CONTENT_CHARS = 12_000;
export const DEFAULT_DISCORD_READ_MAX_ATTACHMENTS = 10;
const MAX_DISCORD_READ_MESSAGES = 100;
const MAX_DISCORD_READ_CONTENT_CHARS = 10_000;
const MAX_DISCORD_READ_TOTAL_CONTENT_CHARS = 50_000;
const MAX_DISCORD_READ_ATTACHMENTS = 25;

// Gateway WebSocket checks are deliberately conservative: discord.js handles short
// reconnects itself; only a sustained unhealthy state asks the process supervisor
// for a clean replacement.
export const DEFAULT_DISCORD_GATEWAY_HEALTH_CHECK_INTERVAL_MS = 30_000;
export const DEFAULT_DISCORD_GATEWAY_HEALTH_FAILURE_THRESHOLD = 3;
export const DEFAULT_DISCORD_GATEWAY_MAX_PING_MS = 30_000;
const MAX_DISCORD_GATEWAY_HEALTH_CHECK_INTERVAL_MS = 10 * 60_000;
const MAX_DISCORD_GATEWAY_HEALTH_FAILURE_THRESHOLD = 100;
const MAX_DISCORD_GATEWAY_MAX_PING_MS = 10 * 60_000;

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

function readBoundedPositiveInteger(
	env: DiscordEnvironment,
	name: string,
	defaultValue: number,
	maximum: number,
): number {
	const parsed = readPositiveInteger(env, name, defaultValue);
	if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
	return parsed;
}

function readBoundedNonNegativeInteger(
	env: DiscordEnvironment,
	name: string,
	defaultValue: number,
	maximum: number,
): number {
	const parsed = readNonNegativeInteger(env, name, defaultValue);
	if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`);
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
		readMaxMessages: readBoundedPositiveInteger(
			env,
			"PRIME_DISCORD_READ_MAX_MESSAGES",
			DEFAULT_DISCORD_READ_MAX_MESSAGES,
			MAX_DISCORD_READ_MESSAGES,
		),
		readMaxContentChars: readBoundedPositiveInteger(
			env,
			"PRIME_DISCORD_READ_MAX_CONTENT_CHARS",
			DEFAULT_DISCORD_READ_MAX_CONTENT_CHARS,
			MAX_DISCORD_READ_CONTENT_CHARS,
		),
		readMaxTotalContentChars: readBoundedPositiveInteger(
			env,
			"PRIME_DISCORD_READ_MAX_TOTAL_CONTENT_CHARS",
			DEFAULT_DISCORD_READ_MAX_TOTAL_CONTENT_CHARS,
			MAX_DISCORD_READ_TOTAL_CONTENT_CHARS,
		),
		readMaxAttachments: readBoundedPositiveInteger(
			env,
			"PRIME_DISCORD_READ_MAX_ATTACHMENTS",
			DEFAULT_DISCORD_READ_MAX_ATTACHMENTS,
			MAX_DISCORD_READ_ATTACHMENTS,
		),
		maxAttachmentBytes: readNonNegativeInteger(env, "PRIME_DISCORD_MAX_ATTACHMENT_BYTES", 32 * 1024 * 1024),
		maxAttachments: readNonNegativeInteger(env, "PRIME_DISCORD_MAX_ATTACHMENTS", 5),
		maxOutboundAttachmentBytes: readNonNegativeInteger(
			env,
			"PRIME_DISCORD_MAX_OUTBOUND_ATTACHMENT_BYTES",
			25 * 1024 * 1024,
		),
		maxOutboundAttachments: readNonNegativeInteger(env, "PRIME_DISCORD_MAX_OUTBOUND_ATTACHMENTS", 5),
		attachmentTimeoutMs: readPositiveInteger(env, "PRIME_DISCORD_ATTACHMENT_TIMEOUT_MS", 30_000),
		streamUpdateIntervalMs: readNonNegativeInteger(env, "PRIME_DISCORD_STREAM_UPDATE_INTERVAL_MS", 1_000),
		progressUpdateIntervalMs: readNonNegativeInteger(env, "PRIME_DISCORD_PROGRESS_UPDATE_INTERVAL_MS", 30_000),
		gatewayHealthCheckIntervalMs: readBoundedNonNegativeInteger(
			env,
			"PRIME_DISCORD_GATEWAY_HEALTH_CHECK_INTERVAL_MS",
			DEFAULT_DISCORD_GATEWAY_HEALTH_CHECK_INTERVAL_MS,
			MAX_DISCORD_GATEWAY_HEALTH_CHECK_INTERVAL_MS,
		),
		gatewayHealthFailureThreshold: readBoundedPositiveInteger(
			env,
			"PRIME_DISCORD_GATEWAY_HEALTH_FAILURE_THRESHOLD",
			DEFAULT_DISCORD_GATEWAY_HEALTH_FAILURE_THRESHOLD,
			MAX_DISCORD_GATEWAY_HEALTH_FAILURE_THRESHOLD,
		),
		gatewayMaxPingMs: readBoundedNonNegativeInteger(
			env,
			"PRIME_DISCORD_GATEWAY_MAX_PING_MS",
			DEFAULT_DISCORD_GATEWAY_MAX_PING_MS,
			MAX_DISCORD_GATEWAY_MAX_PING_MS,
		),
		registerCommands: readBoolean(env, "PRIME_DISCORD_REGISTER_COMMANDS", true),
		toolProgress: readBoolean(env, "PRIME_DISCORD_TOOL_PROGRESS", true),
		extensionUiTimeoutMs: readPositiveInteger(env, "PRIME_DISCORD_EXTENSION_UI_TIMEOUT_MS", 300_000),
		cwd,
		sessionDir: readPath(env, "PRIME_DISCORD_SESSION_DIR", join(discordStateDir, "sessions")),
		cacheDir: readPath(env, "PRIME_DISCORD_CACHE_DIR", join(discordStateDir, "cache")),
	};
}

export function redactDiscordConfig(config: DiscordBridgeConfig): RedactedDiscordBridgeConfig {
	return { ...config, botToken: REDACTED_TOKEN };
}
