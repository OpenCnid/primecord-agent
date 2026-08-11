import {
	type DiscordGatewayThreadCreationErrorCode,
	type DiscordGatewayThreadCreationRequest,
	type DiscordGatewayThreadCreationResponse,
	discordGatewayThreadCreationFailure,
} from "../../core/discord-gateway-thread.js";
import type { DiscordRoutingPolicy } from "./routing.js";

const MAX_THREAD_TITLE_CHARS = 100;

export interface DiscordThreadCreationScope {
	userId: string;
	kind: "dm" | "guild" | "thread";
	channelId: string;
	guildId?: string;
}

export interface DiscordThreadCreationSourceChannel {
	id: string;
	kind: "dm" | "guild" | "thread";
	guildId?: string;
	parentChannelId?: string;
}

export interface DiscordThreadCreationParentChannel extends DiscordThreadCreationSourceChannel {
	kind: "guild";
	canUserCreateThread(userId: string): Promise<boolean>;
	createThread(title: string): Promise<{ id: string }>;
}

export interface DiscordThreadCreationAdapter {
	getChannel(channelId: string): Promise<DiscordThreadCreationSourceChannel | undefined>;
}

export class DiscordThreadCreationAdapterError extends Error {
	constructor(
		readonly code: DiscordGatewayThreadCreationErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DiscordThreadCreationAdapterError";
	}
}

export class DiscordThreadCreationService {
	constructor(
		private readonly adapter: DiscordThreadCreationAdapter,
		private readonly policy: DiscordRoutingPolicy,
		private readonly resolveRoleIds: (userId: string, guildId?: string) => Promise<readonly string[] | undefined>,
	) {}

	async create(
		scope: DiscordThreadCreationScope,
		input: DiscordGatewayThreadCreationRequest,
	): Promise<DiscordGatewayThreadCreationResponse> {
		try {
			const title = normalizeThreadTitle(input.title);
			const { source, parent } = await this.resolveParent(scope);
			await this.authorize(scope, source, parent);
			const thread = await parent.createThread(title);
			if (!DISCORD_SNOWFLAKE_PATTERN.test(thread.id)) {
				throw unavailable("Discord did not return a valid created thread.");
			}
			return {
				ok: true,
				thread: {
					id: thread.id,
					name: title,
					url: `https://discord.com/channels/${scope.guildId}/${thread.id}`,
				},
			};
		} catch (error) {
			return threadCreationFailure(error);
		}
	}

	private async resolveParent(scope: DiscordThreadCreationScope): Promise<{
		source: DiscordThreadCreationSourceChannel;
		parent: DiscordThreadCreationParentChannel;
	}> {
		if (scope.kind === "dm" || !scope.guildId) {
			throw forbidden("Discord threads can only be created from a server channel.");
		}
		const source = await this.adapter.getChannel(scope.channelId);
		if (!source || source.id !== scope.channelId || source.guildId !== scope.guildId || source.kind === "dm") {
			throw forbidden("Discord thread creation is limited to the initiating server channel.");
		}
		const parentId = source.kind === "thread" ? source.parentChannelId : source.id;
		if (!parentId) throw forbidden("The current Discord thread parent is unavailable.");
		const parent = await this.adapter.getChannel(parentId);
		if (!isThreadCreationParent(parent) || parent.guildId !== scope.guildId) {
			throw forbidden("Discord threads can only be created in a server text or announcement channel.");
		}
		return { source, parent };
	}

	private async authorize(
		scope: DiscordThreadCreationScope,
		source: DiscordThreadCreationSourceChannel,
		parent: DiscordThreadCreationParentChannel,
	): Promise<void> {
		if (this.policy.ignoredChannels.includes(source.id) || this.policy.ignoredChannels.includes(parent.id)) {
			throw forbidden("This Discord channel is forbidden by gateway policy.");
		}
		const parentAllowed = this.policy.allowedChannels.includes(parent.id);
		if (this.policy.allowedChannels.length > 0 && !parentAllowed) {
			throw forbidden("This Discord channel is not authorized by gateway policy.");
		}
		const roleIds = await this.resolveRoleIds(scope.userId, scope.guildId);
		const hasExplicitIdentity =
			this.policy.allowAllUsers ||
			this.policy.allowedUsers.includes(scope.userId) ||
			roleIds?.some((roleId) => this.policy.allowedRoles.includes(roleId));
		if (!hasExplicitIdentity && !parentAllowed) {
			throw forbidden("The initiating Discord user is no longer authorized.");
		}
		if (!(await parent.canUserCreateThread(scope.userId))) {
			throw forbidden("The initiating Discord user cannot create a thread in this channel.");
		}
	}
}

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/;

function isThreadCreationParent(
	channel: DiscordThreadCreationSourceChannel | undefined,
): channel is DiscordThreadCreationParentChannel {
	return channel?.kind === "guild" && "canUserCreateThread" in channel && "createThread" in channel;
}

function normalizeThreadTitle(value: string): string {
	const title = value.trim().replace(/\s+/g, " ");
	if (!title) throw invalidRequest("Discord thread titles cannot be empty.");
	if (title.length > MAX_THREAD_TITLE_CHARS) {
		throw invalidRequest(`Discord thread titles must not exceed ${MAX_THREAD_TITLE_CHARS} characters.`);
	}
	return title;
}

function invalidRequest(message: string): DiscordThreadCreationAdapterError {
	return new DiscordThreadCreationAdapterError("INVALID_REQUEST", message);
}

function forbidden(message: string): DiscordThreadCreationAdapterError {
	return new DiscordThreadCreationAdapterError("FORBIDDEN", message);
}

function unavailable(message: string): DiscordThreadCreationAdapterError {
	return new DiscordThreadCreationAdapterError("UNAVAILABLE", message);
}

function threadCreationFailure(error: unknown): DiscordGatewayThreadCreationResponse {
	if (error instanceof DiscordThreadCreationAdapterError) {
		if (error.code === "MISSING_PERMISSION") {
			return discordGatewayThreadCreationFailure(
				"MISSING_PERMISSION",
				"Discord denied permission to create a thread in that channel.",
			);
		}
		return discordGatewayThreadCreationFailure(error.code, error.message);
	}
	return discordGatewayThreadCreationFailure("UNAVAILABLE", "Discord thread creation is currently unavailable.");
}
