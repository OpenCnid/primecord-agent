export type DiscordSessionKind = "dm" | "guild" | "thread";

export interface DiscordSessionKeyInput {
	kind: DiscordSessionKind;
	channelId: string;
	guildId?: string;
	userId: string;
}

export interface DiscordSessionKeyOptions {
	groupSessionsPerUser?: boolean;
	shared?: boolean;
}

function requireValue(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is required to create a Discord session key`);
	return value;
}

export function createSessionKey(input: DiscordSessionKeyInput, options: DiscordSessionKeyOptions = {}): string {
	const channelId = requireValue(input.channelId, "channelId");
	const userId = requireValue(input.userId, "userId");
	const perUser = options.shared === undefined ? (options.groupSessionsPerUser ?? true) : !options.shared;
	const parts: readonly string[] =
		input.kind === "dm"
			? ["discord", "v1", "dm", channelId, userId]
			: [
					"discord",
					"v1",
					input.kind,
					requireValue(input.guildId, "guildId"),
					channelId,
					perUser ? userId : "shared",
				];

	return `discord:v1:${Buffer.from(JSON.stringify(parts), "utf8").toString("base64url")}`;
}

export const createDiscordSessionKey = createSessionKey;
