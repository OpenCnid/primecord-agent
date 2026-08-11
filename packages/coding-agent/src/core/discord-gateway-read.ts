export const DISCORD_GATEWAY_READ_TOOL_NAME = "discord_read";

export type DiscordGatewayReadAction = "message" | "history";

export interface DiscordGatewayReadRequest {
	action: DiscordGatewayReadAction;
	messageUrl?: string;
	channelId?: string;
	limit?: number;
}

export type DiscordGatewayReadErrorCode = "INVALID_REQUEST" | "FORBIDDEN" | "UNAVAILABLE" | "MISSING_PERMISSION";

export interface DiscordGatewayReadAttachment {
	id: string;
	name: string;
	contentType?: string;
	size: number;
}

export interface DiscordGatewayReadAuthor {
	id: string;
	username: string;
	displayName?: string;
}

export interface DiscordGatewayReadMessage {
	id: string;
	channelId: string;
	guildId?: string;
	url: string;
	createdAt: string;
	author: DiscordGatewayReadAuthor;
	content: string;
	contentTruncated: boolean;
	attachments: readonly DiscordGatewayReadAttachment[];
	attachmentsTruncated: boolean;
}

export interface DiscordGatewayReadSuccess {
	ok: true;
	untrusted: true;
	message?: DiscordGatewayReadMessage;
	messages?: readonly DiscordGatewayReadMessage[];
}

export interface DiscordGatewayReadFailure {
	ok: false;
	code: DiscordGatewayReadErrorCode;
	message: string;
}

export type DiscordGatewayReadResponse = DiscordGatewayReadSuccess | DiscordGatewayReadFailure;

export interface DiscordGatewayReadController {
	request(input: DiscordGatewayReadRequest, signal?: AbortSignal): Promise<DiscordGatewayReadResponse>;
}

export function discordGatewayReadFailure(
	code: DiscordGatewayReadErrorCode,
	message: string,
): DiscordGatewayReadFailure {
	return { ok: false, code, message };
}

export function isDiscordGatewayReadResponse(value: unknown): value is DiscordGatewayReadResponse {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		ok?: unknown;
		code?: unknown;
		message?: unknown;
		untrusted?: unknown;
	};
	if (candidate.ok === false) {
		return (
			(candidate.code === "INVALID_REQUEST" ||
				candidate.code === "FORBIDDEN" ||
				candidate.code === "UNAVAILABLE" ||
				candidate.code === "MISSING_PERMISSION") &&
			typeof candidate.message === "string"
		);
	}
	return candidate.ok === true && candidate.untrusted === true;
}
