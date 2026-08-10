import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type ChatInputCommandInteraction,
	Client,
	type ClientOptions,
	GatewayIntentBits,
	type Guild,
	type GuildMember,
	type Interaction,
	type Message,
	MessageType,
	Partials,
	type SendableChannels,
	SlashCommandBuilder,
	ThreadAutoArchiveDuration,
} from "discord.js";
import type { AgentConnectionEvent } from "../../modes/agent-connection/types.js";
import { DiscordAgentRegistry } from "./agent-registry.js";
import {
	type DiscordAttachmentDescriptor,
	type ProcessedDiscordAttachments,
	processDiscordAttachments,
} from "./attachments.js";
import type { DiscordBridgeConfig } from "./config.js";
import { DiscordDispatchQueue, DiscordMessageDedupe } from "./dispatch-queue.js";
import {
	createDiscordResponseWriter,
	DISCORD_ALLOWED_MENTIONS,
	type DiscordResponseChannelPort,
	type DiscordResponseWriter,
	splitDiscordMessage,
} from "./response.js";
import {
	type DiscordChannelKind,
	type DiscordMessageRouteInput,
	type DiscordRouteDecision,
	routeMessage,
	stripBotMention,
} from "./routing.js";
import { createDiscordSessionKey } from "./session-key.js";

export interface DiscordBridgeOptions {
	agentDir: string;
	socketPath: string;
	client?: Client;
	shutdownTimeoutMs?: number;
	logger?: Pick<Console, "info" | "warn" | "error">;
}

const COMMANDS = [
	new SlashCommandBuilder().setName("help").setDescription("Show Prime Agent Discord commands"),
	new SlashCommandBuilder().setName("new").setDescription("Start a new Prime Agent session here"),
	new SlashCommandBuilder().setName("abort").setDescription("Abort the active run and clear queued messages"),
	new SlashCommandBuilder().setName("status").setDescription("Show the active Prime Agent session status"),
	new SlashCommandBuilder()
		.setName("compact")
		.setDescription("Compact the active Prime Agent session")
		.addStringOption((option) =>
			option.setName("instructions").setDescription("Optional compaction instructions").setRequired(false),
		),
	new SlashCommandBuilder()
		.setName("effort")
		.setDescription("Set the Prime Agent reasoning effort")
		.addStringOption((option) =>
			option
				.setName("level")
				.setDescription("Reasoning effort")
				.setRequired(true)
				.addChoices(
					...(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) => ({
						name: level,
						value: level,
					})),
				),
		),
	new SlashCommandBuilder()
		.setName("model")
		.setDescription("Set the model for this Prime Agent session")
		.addStringOption((option) => option.setName("provider").setDescription("Model provider").setRequired(true))
		.addStringOption((option) => option.setName("model").setDescription("Model ID").setRequired(true)),
];

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_HISTORY_CONTEXT_CHARS = 8_000;
const ROLE_LOOKUP_CACHE_MS = 60_000;
const MAX_ROLE_LOOKUP_CACHE_ENTRIES = 10_000;

export class DiscordBridge {
	private readonly client: Client;
	private readonly logger: Pick<Console, "info" | "warn" | "error">;
	private readonly registry: DiscordAgentRegistry;
	private readonly dispatchQueue = new DiscordDispatchQueue();
	private readonly dedupe = new DiscordMessageDedupe();
	private readonly roleLookups = new Map<
		string,
		{ expiresAt: number; result: Promise<readonly string[] | undefined> }
	>();
	private readonly shutdownTimeoutMs: number;
	private accepting = false;
	private stopRequested = false;
	private startPromise: Promise<string> | undefined;
	private stopPromise: Promise<void> | undefined;
	private fatalError: Error | undefined;
	private resolveStopped!: () => void;
	private readonly stopped = new Promise<void>((resolve) => {
		this.resolveStopped = resolve;
	});

	constructor(
		private readonly config: DiscordBridgeConfig,
		private readonly options: DiscordBridgeOptions,
	) {
		this.logger = options.logger ?? console;
		this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
		this.client = options.client ?? new Client(discordClientOptions(config));
		this.registry = new DiscordAgentRegistry({
			cwd: config.cwd,
			agentDir: options.agentDir,
			sessionRoot: config.sessionDir,
			socketPath: options.socketPath,
		});
	}

	start(): Promise<string> {
		if (this.accepting) return Promise.reject(new Error("Discord gateway is already running"));
		if (this.stopRequested) return Promise.reject(new Error("Discord gateway has already been stopped"));
		this.startPromise ??= this.startInternal();
		return this.startPromise;
	}

	waitUntilStopped(): Promise<void> {
		return this.stopped.then(() => {
			if (this.fatalError) throw this.fatalError;
		});
	}

	private async startInternal(): Promise<string> {
		this.client.on("messageCreate", this.onMessage);
		this.client.on("interactionCreate", this.onInteraction);
		this.client.on("error", this.onClientError);
		this.client.on("invalidated", this.onInvalidated);
		await this.client.login(this.config.botToken);
		if (this.stopRequested) throw new Error("Discord gateway stopped during startup");
		if (!this.client.user) throw new Error("Discord client became ready without a bot user");
		if (this.config.registerCommands) {
			if (!this.client.application) throw new Error("Discord client became ready without an application");
			const registered = await this.client.application.commands.fetch();
			for (const command of COMMANDS) {
				const data = command.toJSON();
				const existing = registered.find((candidate) => candidate.name === data.name);
				if (existing) await this.client.application.commands.edit(existing.id, data);
				else await this.client.application.commands.create(data);
			}
		}
		if (this.stopRequested) throw new Error("Discord gateway stopped during startup");
		this.accepting = true;
		return this.client.user.tag;
	}

	stop(): Promise<void> {
		this.stopRequested = true;
		this.stopPromise ??= this.stopInternal();
		return this.stopPromise;
	}

	private readonly onMessage = (message: Message): void => {
		void this.handleMessage(message).catch((error: unknown) => {
			this.logger.error(`Discord message handling failed: ${safeErrorMessage(error, this.config.botToken)}`);
		});
	};

	private readonly onInteraction = (interaction: Interaction): void => {
		if (!interaction.isChatInputCommand()) return;
		void this.handleInteraction(interaction).catch((error: unknown) => {
			this.logger.error(`Discord command failed: ${safeErrorMessage(error, this.config.botToken)}`);
		});
	};

	private readonly onClientError = (error: Error): void => {
		this.logger.error(`Discord client error: ${safeErrorMessage(error, this.config.botToken)}`);
	};

	private readonly onInvalidated = (): void => {
		this.fatalError = new Error("Discord gateway session was invalidated and cannot reconnect");
		this.logger.error(this.fatalError.message);
		void this.stop().catch((error: unknown) => {
			this.logger.error(`Discord shutdown failed: ${safeErrorMessage(error, this.config.botToken)}`);
		});
	};

	private async handleMessage(message: Message): Promise<void> {
		if (!this.accepting || message.webhookId || message.system) return;
		if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;
		const sourceChannel = message.channel;
		if (!sourceChannel.isSendable()) return;
		const botUser = this.client.user;
		if (!botUser) return;

		const routeInput = messageRouteInput(
			message,
			botUser.id,
			await this.resolveAuthorRoleIds(message.author.id, message.member, message.guildId),
		);
		const decision = routeMessage(routeInput, this.config);
		if (decision.action === "ignore" || !this.dedupe.add(message.id)) return;

		const targetChannel = decision.createThread ? await this.createThread(message, sourceChannel) : sourceChannel;
		const targetKind: DiscordChannelKind = targetChannel.isThread() ? "thread" : message.inGuild() ? "guild" : "dm";
		const sessionKey = createDiscordSessionKey(
			{
				kind: targetKind,
				channelId: targetChannel.id,
				guildId: message.guildId ?? undefined,
				userId: message.author.id,
			},
			{ groupSessionsPerUser: this.config.groupSessionsPerUser },
		);

		await this.dispatchQueue.enqueue(sessionKey, async () => {
			await this.processMessage(message, targetChannel, sessionKey, decision);
		});
	}

	private async processMessage(
		message: Message,
		targetChannel: SendableChannels,
		sessionKey: string,
		decision: Extract<DiscordRouteDecision, { action: "respond" }>,
	): Promise<void> {
		const botUser = this.client.user;
		if (!botUser) return;
		await safeTyping(targetChannel);
		if (this.config.reactions) await safeReaction(message, "👀");

		let attachments: ProcessedDiscordAttachments | undefined;
		let writer: DiscordResponseWriter | undefined;
		let writerFinalized = false;
		let unsubscribe: (() => void) | undefined;
		try {
			const descriptors = attachmentDescriptors(message);
			if (descriptors.length > 0 && this.config.maxAttachments === 0) {
				throw new Error("Discord attachments are disabled for this gateway");
			}
			attachments = await processDiscordAttachments(descriptors, {
				cacheRoot: this.config.cacheDir,
				messageDirectory: message.id,
				timeoutMs: this.config.attachmentTimeoutMs,
				maxAttachments: Math.max(1, this.config.maxAttachments),
				maxBytesPerAttachment: unlimitedAsSafeInteger(this.config.maxAttachmentBytes),
				maxTotalBytes: attachmentTotalLimit(this.config.maxAttachmentBytes, this.config.maxAttachments),
				inlineTextMaxBytes: 100 * 1024,
			});
			const connection = await this.registry.getOrCreate(sessionKey);
			writer = await createDiscordResponseWriter(responseChannel(targetChannel, message), {
				updateIntervalMs: this.config.streamUpdateIntervalMs,
				placeholderText: "Prime Agent is working…",
				onDeliveryError: (error) =>
					this.logger.warn(`Discord response delivery failed: ${safeErrorMessage(error, this.config.botToken)}`),
			});
			if (writer.deliveryErrors.length > 0) {
				throw new Error("Discord rejected the initial response message");
			}

			let streamedText = "";
			unsubscribe = connection.subscribe((event) => {
				const delta = textDelta(event);
				if (delta) {
					streamedText += delta;
					writer?.append(delta);
					return;
				}
				if (this.config.toolProgress) {
					const progress = toolProgress(event);
					if (progress) writer?.append(progress);
				}
			});
			const prompt = await this.buildPrompt(message, botUser.id, decision, attachments.promptNotes);
			await connection.promptAndWait(prompt, { images: attachments.images, source: "rpc" });
			const finalText = streamedText || (await connection.getLastAssistantText());
			const deliveryErrorsBeforeFinish = writer.deliveryErrors.length;
			const result = await writer.finish(finalText);
			writerFinalized = true;
			if (result.deliveryErrors.length > deliveryErrorsBeforeFinish) {
				throw new Error("Discord could not deliver the complete response");
			}
			if (this.config.reactions) await safeReaction(message, "✅");
		} catch (error) {
			const messageText = safeErrorMessage(error, this.config.botToken);
			if (writer && !writerFinalized) {
				await writer
					.fail(`Prime Agent failed: ${messageText}`)
					.catch(() => safeSend(targetChannel, `Prime Agent failed: ${messageText}`));
			} else {
				await safeSend(targetChannel, `Prime Agent failed: ${messageText}`);
			}
			if (this.config.reactions) await safeReaction(message, "❌");
		} finally {
			unsubscribe?.();
			await attachments?.cleanup().catch((error: unknown) => {
				this.logger.warn(`Discord attachment cleanup failed: ${safeErrorMessage(error, this.config.botToken)}`);
			});
		}
	}

	private async buildPrompt(
		message: Message,
		botUserId: string,
		decision: Extract<DiscordRouteDecision, { action: "respond" }>,
		attachmentNotes: readonly string[],
	): Promise<string> {
		const content = stripBotMention(message.content, botUserId);
		const history = await this.historyContext(message, botUserId, decision);
		const authorName = message.member?.displayName ?? message.author.username;
		const sections = [
			`[Discord message from ${authorName} (${message.author.id})]`,
			history,
			content || (attachmentNotes.length > 0 ? "Please inspect the attached files." : "Please respond."),
			...attachmentNotes,
		].filter((section): section is string => Boolean(section));
		return sections.join("\n\n");
	}

	private async historyContext(
		message: Message,
		botUserId: string,
		decision: Extract<DiscordRouteDecision, { action: "respond" }>,
	): Promise<string | undefined> {
		if (
			!this.config.historyBackfill ||
			this.config.historyBackfillLimit === 0 ||
			!message.inGuild() ||
			decision.reason !== "mentioned"
		) {
			return undefined;
		}
		try {
			const fetched = await message.channel.messages.fetch({
				before: message.id,
				limit: Math.min(100, this.config.historyBackfillLimit),
			});
			const earlier = [...fetched.values()]
				.filter((entry) => entry.id !== message.id && entry.createdTimestamp < message.createdTimestamp)
				.sort((left, right) => right.createdTimestamp - left.createdTimestamp);
			const context: Message<true>[] = [];
			for (const entry of earlier) {
				if (entry.author.id === botUserId) break;
				if (!entry.author.bot && entry.content.trim()) context.push(entry);
			}
			const lines = context.reverse().map((entry) => {
				const name = entry.member?.displayName ?? entry.author.username;
				return `${name}: ${entry.content}`;
			});
			if (lines.length === 0) return undefined;
			return `[Recent Discord channel context]\n${truncateText(lines.join("\n"), MAX_HISTORY_CONTEXT_CHARS)}`;
		} catch (error) {
			this.logger.warn(`Discord history backfill failed: ${safeErrorMessage(error, this.config.botToken)}`);
			return undefined;
		}
	}

	private async createThread(message: Message, fallback: SendableChannels): Promise<SendableChannels> {
		if (!message.inGuild()) return fallback;
		try {
			return await message.startThread({
				name: threadName(message),
				autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
				reason: "Prime Agent Discord conversation",
			});
		} catch (error) {
			this.logger.warn(`Discord auto-thread creation failed: ${safeErrorMessage(error, this.config.botToken)}`);
			return fallback;
		}
	}

	private async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
		if (!this.accepting) return;
		const botUser = this.client.user;
		if (!botUser || !interaction.channel) return;
		await interaction.deferReply({ ephemeral: true });
		const routeInput = interactionRouteInput(
			interaction,
			await this.resolveAuthorRoleIds(interaction.user.id, interaction.member, interaction.guildId),
		);
		const decision = routeMessage(routeInput, this.config);
		if (decision.action === "ignore") {
			await interaction.editReply({
				content: "You are not authorized to use this Prime Agent gateway here.",
				allowedMentions: DISCORD_ALLOWED_MENTIONS,
			});
			return;
		}

		const kind: DiscordChannelKind = interaction.channel.isThread()
			? "thread"
			: interaction.inGuild()
				? "guild"
				: "dm";
		const key = createDiscordSessionKey(
			{
				kind,
				channelId: interaction.channelId,
				guildId: interaction.guildId ?? undefined,
				userId: interaction.user.id,
			},
			{ groupSessionsPerUser: this.config.groupSessionsPerUser },
		);

		if (interaction.commandName === "help") {
			await interaction.editReply({
				content: commandHelp(),
				allowedMentions: DISCORD_ALLOWED_MENTIONS,
			});
			return;
		}
		try {
			const content = await this.runCommand(interaction, key);
			await interaction.editReply({ content, allowedMentions: DISCORD_ALLOWED_MENTIONS });
		} catch (error) {
			await interaction.editReply({
				content: `Prime Agent command failed: ${safeErrorMessage(error, this.config.botToken)}`,
				allowedMentions: DISCORD_ALLOWED_MENTIONS,
			});
		}
	}

	private async runCommand(interaction: ChatInputCommandInteraction, key: string): Promise<string> {
		switch (interaction.commandName) {
			case "new": {
				this.dispatchQueue.clear(key);
				const existing = this.registry.getExisting(key);
				if (existing) await existing.abortAndClearQueue();
				const result = await this.registry.newSession(key);
				return result.cancelled ? "New session cancelled." : "Started a new Prime Agent session.";
			}
			case "abort": {
				this.dispatchQueue.clear(key);
				const connection = this.registry.getExisting(key);
				if (!connection) return "There is no active Prime Agent session here.";
				await connection.abortAndClearQueue();
				return "Abort requested and queued messages cleared.";
			}
			case "status": {
				const connection = this.registry.getExisting(key);
				if (!connection) return "There is no active Prime Agent session here.";
				const state = await connection.getState();
				return [
					`Session: ${state.sessionName ?? state.sessionId}`,
					`State: ${state.isStreaming ? "working" : "idle"}`,
					`Model: ${state.model ? `${state.model.provider}/${state.model.id}` : "not configured"}`,
					`Effort: ${state.thinkingLevel}`,
				].join("\n");
			}
			case "compact": {
				const connection = await this.registry.getOrCreate(key);
				await connection.compact(interaction.options.getString("instructions") ?? undefined);
				return "Prime Agent session compacted.";
			}
			case "effort": {
				const level = interaction.options.getString("level", true) as ThinkingLevel;
				const connection = await this.registry.getOrCreate(key);
				await connection.setThinkingLevel(level);
				return `Reasoning effort set to ${level}.`;
			}
			case "model": {
				const provider = interaction.options.getString("provider", true);
				const modelId = interaction.options.getString("model", true);
				const connection = await this.registry.getOrCreate(key);
				const model = await connection.setModel(provider, modelId);
				return `Model set to ${model.provider}/${model.id}.`;
			}
			default:
				throw new Error(`Unknown Discord command: ${interaction.commandName}`);
		}
	}

	private async resolveAuthorRoleIds(
		authorId: string,
		member: ChatInputCommandInteraction["member"] | GuildMember | null,
		guildId: string | null,
	): Promise<readonly string[] | undefined> {
		const direct = interactionRoleIds(member);
		if (direct || this.config.allowedRoles.length === 0) return direct;
		if (this.config.allowAllUsers || this.config.allowedUsers.includes(authorId)) return undefined;
		const now = Date.now();
		const cacheKey = `${guildId ?? "dm"}:${authorId}`;
		const cached = this.roleLookups.get(cacheKey);
		if (cached && cached.expiresAt > now) return cached.result;

		const result = guildId ? this.lookupGuildRoleIds(authorId, guildId) : this.lookupMutualGuildRoleIds(authorId);
		this.roleLookups.set(cacheKey, { expiresAt: now + ROLE_LOOKUP_CACHE_MS, result });
		while (this.roleLookups.size > MAX_ROLE_LOOKUP_CACHE_ENTRIES) {
			const oldest = this.roleLookups.keys().next().value;
			if (oldest === undefined) break;
			this.roleLookups.delete(oldest);
		}
		return result;
	}

	private async lookupGuildRoleIds(authorId: string, guildId: string): Promise<readonly string[] | undefined> {
		const guild = this.client.guilds.cache.get(guildId);
		const guildMember =
			guild?.members.cache.get(authorId) ?? (await guild?.members.fetch(authorId).catch(() => undefined));
		return guildMember ? [...guildMember.roles.cache.keys()] : undefined;
	}

	private async lookupMutualGuildRoleIds(authorId: string): Promise<readonly string[] | undefined> {
		const guildsWithoutCachedMember: Guild[] = [];
		for (const guild of this.client.guilds.cache.values()) {
			const guildMember = guild.members.cache.get(authorId);
			if (!guildMember) {
				guildsWithoutCachedMember.push(guild);
				continue;
			}
			const roleIds = [...guildMember.roles.cache.keys()];
			if (roleIds.some((roleId) => this.config.allowedRoles.includes(roleId))) return roleIds;
		}
		for (const guild of guildsWithoutCachedMember) {
			const guildMember = await guild.members.fetch(authorId).catch(() => undefined);
			if (!guildMember) continue;
			const roleIds = [...guildMember.roles.cache.keys()];
			if (roleIds.some((roleId) => this.config.allowedRoles.includes(roleId))) return roleIds;
		}
		return undefined;
	}

	private async stopInternal(): Promise<void> {
		try {
			this.accepting = false;
			this.client.off("messageCreate", this.onMessage);
			this.client.off("interactionCreate", this.onInteraction);
			this.client.off("error", this.onClientError);
			this.client.off("invalidated", this.onInvalidated);
			const drain = this.dispatchQueue.stopAcceptingAndDrain();
			const drained = await settlesBefore(drain, this.shutdownTimeoutMs);
			if (!drained) {
				await this.registry.abortAll();
				await settlesBefore(drain, Math.min(5_000, this.shutdownTimeoutMs));
			}
			await this.registry.dispose();
			await this.client.destroy();
		} finally {
			this.resolveStopped();
		}
	}
}

function discordClientOptions(config: DiscordBridgeConfig): ClientOptions {
	const intents = [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.MessageContent,
	];
	if (config.allowedRoles.length > 0) intents.push(GatewayIntentBits.GuildMembers);
	return {
		intents,
		partials: [Partials.Channel],
		allowedMentions: { parse: [], repliedUser: false },
	};
}

function messageRouteInput(
	message: Message,
	botUserId: string,
	authorRoleIds: readonly string[] | undefined,
): DiscordMessageRouteInput {
	const kind: DiscordChannelKind = message.channel.isThread() ? "thread" : message.inGuild() ? "guild" : "dm";
	const botParticipatedInThread = message.channel.isThread()
		? message.channel.ownerId === botUserId || message.channel.members.cache.has(botUserId)
		: false;
	return {
		kind,
		channelId: message.channelId,
		parentChannelId: message.channel.isThread() ? (message.channel.parentId ?? undefined) : undefined,
		authorId: message.author.id,
		authorRoleIds,
		authorIsBot: message.author.bot,
		authorIsSelf: message.author.id === botUserId,
		mentionsBot: message.mentions.users.has(botUserId),
		mentionsOtherUsers: message.mentions.users.some((_user, id) => id !== botUserId),
		botParticipatedInThread,
	};
}

function interactionRouteInput(
	interaction: ChatInputCommandInteraction,
	authorRoleIds: readonly string[] | undefined,
): DiscordMessageRouteInput {
	const kind: DiscordChannelKind = interaction.channel?.isThread() ? "thread" : interaction.inGuild() ? "guild" : "dm";
	return {
		kind,
		channelId: interaction.channelId,
		parentChannelId: interaction.channel?.isThread() ? (interaction.channel.parentId ?? undefined) : undefined,
		authorId: interaction.user.id,
		authorRoleIds,
		authorIsBot: interaction.user.bot,
		mentionsBot: true,
		mentionsOtherUsers: false,
		botParticipatedInThread: true,
	};
}

function interactionRoleIds(
	member: ChatInputCommandInteraction["member"] | GuildMember | null,
): readonly string[] | undefined {
	if (!member) return undefined;
	const roles = member.roles;
	if (Array.isArray(roles)) return roles;
	return [...(member as GuildMember).roles.cache.keys()];
}

function attachmentDescriptors(message: Message): DiscordAttachmentDescriptor[] {
	return message.attachments.map((attachment) => ({
		id: attachment.id,
		name: attachment.name,
		url: attachment.url,
		contentType: attachment.contentType ?? undefined,
		size: attachment.size,
	}));
}

function responseChannel(channel: SendableChannels, source: Message): DiscordResponseChannelPort {
	let first = true;
	return {
		send: async (payload) => {
			const reply =
				first && channel.id === source.channelId
					? { messageReference: source.id, failIfNotExists: false }
					: undefined;
			first = false;
			return channel.send({
				content: payload.content,
				allowedMentions: { parse: [], repliedUser: false },
				reply,
			});
		},
	};
}

function textDelta(event: AgentConnectionEvent): string | undefined {
	if (event.type !== "session_event" || event.event.type !== "message_update") return undefined;
	return event.event.assistantMessageEvent.type === "text_delta" ? event.event.assistantMessageEvent.delta : undefined;
}

function toolProgress(event: AgentConnectionEvent): string | undefined {
	if (event.type !== "session_event" || event.event.type !== "tool_execution_start") return undefined;
	const toolName = truncateText(event.event.toolName.replaceAll("`", "'"), 80);
	return `\n\n_Using \`${toolName}\`…_\n\n`;
}

function threadName(message: Message): string {
	const firstLine = message.content
		.split(/\r?\n/, 1)[0]
		?.replace(/^\s*#{1,6}\s*/, "")
		.trim();
	const fallback = message.attachments.first()?.name ?? "Prime Agent";
	return truncateText(firstLine || fallback, 100);
}

function truncateText(value: string, maximum: number): string {
	if (value.length <= maximum) return value;
	let end = maximum - 1;
	if (/^[\uD800-\uDBFF]$/.test(value[end - 1] ?? "") && /^[\uDC00-\uDFFF]$/.test(value[end] ?? "")) end--;
	return `${value.slice(0, end)}…`;
}

function unlimitedAsSafeInteger(value: number): number {
	return value === 0 ? Number.MAX_SAFE_INTEGER : value;
}

function attachmentTotalLimit(perAttachment: number, count: number): number {
	if (perAttachment === 0) return Number.MAX_SAFE_INTEGER;
	const total = perAttachment * Math.max(1, count);
	return Number.isSafeInteger(total) ? total : Number.MAX_SAFE_INTEGER;
}

async function safeTyping(channel: SendableChannels): Promise<void> {
	await channel.sendTyping().catch(() => undefined);
}

async function safeReaction(message: Message, emoji: string): Promise<void> {
	await message.react(emoji).catch(() => undefined);
}

async function safeSend(channel: SendableChannels, content: string): Promise<void> {
	const chunks = splitDiscordMessage(content);
	for (const chunk of chunks) {
		await channel.send({ content: chunk, allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined);
	}
}

function safeErrorMessage(error: unknown, token: string): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.replaceAll(token, "[REDACTED]").replace(/(https:\/\/[^\s?]+)\?[^\s)]+/g, "$1?[REDACTED]");
}

async function settlesBefore(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise<false>((resolve) => {
				timeout = setTimeout(() => resolve(false), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function commandHelp(): string {
	return [
		"Prime Agent Discord commands:",
		"/new — start a new session",
		"/abort — stop the active run and clear queued messages",
		"/status — show session, model, and effort",
		"/compact — compact session context",
		"/effort — set reasoning effort",
		"/model — set provider and model ID",
	].join("\n");
}
