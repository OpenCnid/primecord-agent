export const DISCORD_GATEWAY_THREAD_CREATION_TOOL_NAME = "discord_create_thread";

export interface DiscordGatewayThreadCreationRequest {
	title: string;
}

export type DiscordGatewayThreadCreationErrorCode =
	| "INVALID_REQUEST"
	| "FORBIDDEN"
	| "UNAVAILABLE"
	| "MISSING_PERMISSION";

export interface DiscordGatewayCreatedThread {
	id: string;
	name: string;
	url: string;
}

export interface DiscordGatewayThreadCreationSuccess {
	ok: true;
	thread: DiscordGatewayCreatedThread;
}

export interface DiscordGatewayThreadCreationFailure {
	ok: false;
	code: DiscordGatewayThreadCreationErrorCode;
	message: string;
}

export type DiscordGatewayThreadCreationResponse =
	| DiscordGatewayThreadCreationSuccess
	| DiscordGatewayThreadCreationFailure;

export interface DiscordGatewayThreadCreationController {
	request(
		input: DiscordGatewayThreadCreationRequest,
		signal?: AbortSignal,
	): Promise<DiscordGatewayThreadCreationResponse>;
}

export function discordGatewayThreadCreationFailure(
	code: DiscordGatewayThreadCreationErrorCode,
	message: string,
): DiscordGatewayThreadCreationFailure {
	return { ok: false, code, message };
}

export function isDiscordGatewayThreadCreationResponse(value: unknown): value is DiscordGatewayThreadCreationResponse {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		ok?: unknown;
		code?: unknown;
		message?: unknown;
		thread?: { id?: unknown; name?: unknown; url?: unknown };
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
	return (
		candidate.ok === true &&
		typeof candidate.thread?.id === "string" &&
		typeof candidate.thread.name === "string" &&
		typeof candidate.thread.url === "string"
	);
}
