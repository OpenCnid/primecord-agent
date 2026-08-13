import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type ChatInputCommandInteraction,
	Client,
	type ClientOptions,
	GatewayIntentBits,
	type Guild,
	type GuildMember,
	type GuildTextBasedChannel,
	type Interaction,
	type Message,
	MessageType,
	type NewsChannel,
	Partials,
	PermissionFlagsBits,
	type SendableChannels,
	SlashCommandBuilder,
	type TextChannel,
	ThreadAutoArchiveDuration,
} from "discord.js";
import { type DiscordGatewayReadResponse, discordGatewayReadFailure } from "../../core/discord-gateway-read.js";
import {
	type DiscordGatewayThreadCreationResponse,
	discordGatewayThreadCreationFailure,
} from "../../core/discord-gateway-thread.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
} from "../../modes/agent-connection/types.js";
import { type DiscordAgentConnectionFactory, DiscordAgentRegistry } from "./agent-registry.js";
import {
	type DiscordAttachmentDescriptor,
	type ProcessedDiscordAttachments,
	processDiscordAttachments,
} from "./attachments.js";
import {
	formatDiscordCapabilities,
	parseDiscordTextControl,
	resolveDiscordResourceInvocation,
} from "./capabilities.js";
import type { DiscordBridgeConfig } from "./config.js";
import { DiscordDispatchQueue, DiscordMessageDedupe } from "./dispatch-queue.js";
import {
	type DiscordExtensionDialogMethod,
	parseDiscordExtensionReplyControl,
	parseDiscordExtensionUiInput,
	presentDiscordExtensionUi,
} from "./extension-ui.js";
import { type DiscordOutboundMedia, extractDiscordMedia, loadDiscordOutboundMedia } from "./outbound-media.js";
import { buildDiscordTurnPrompt, DISCORD_WORKER_SYSTEM_SCAFFOLD } from "./prompt.js";
import {
	DiscordReadAdapterError,
	type DiscordReadChannel,
	type DiscordReadMessageSource,
	type DiscordReadScope,
	DiscordReadService,
} from "./read.js";
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
import {
	DiscordThreadCreationAdapterError,
	type DiscordThreadCreationParentChannel,
	type DiscordThreadCreationScope,
	DiscordThreadCreationService,
} from "./thread.js";

export interface DiscordBridgeOptions {
	agentDir: string;
	socketPath: string;
	client?: Client;
	connectionFactory?: DiscordAgentConnectionFactory;
	shutdownTimeoutMs?: number;
	logger?: Pick<Console, "info" | "warn" | "error">;
}

const COMMANDS = [
	new SlashCommandBuilder().setName("help").setDescription("Show Prime Agent Discord commands"),
	new SlashCommandBuilder().setName("new").setDescription("Start a new Prime Agent session here"),
	new SlashCommandBuilder()
		.setName("thread")
		.setDescription("Create a new Prime Agent conversation thread")
		.addStringOption((option) => option.setName("title").setDescription("Thread title").setRequired(true)),
	new SlashCommandBuilder().setName("abort").setDescription("Abort the active run and clear queued messages"),
	new SlashCommandBuilder().setName("status").setDescription("Show the active Prime Agent session status"),
	new SlashCommandBuilder().setName("capabilities").setDescription("List discovered Prime Agent capabilities"),
	new SlashCommandBuilder()
		.setName("run")
		.setDescription("Run a discovered extension, prompt, or skill command")
		.addStringOption((option) =>
			option
				.setName("command")
				.setDescription("Command and arguments, for example: skill:websearch query")
				.setRequired(true),
		),
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

interface ActiveExtensionUiOwner {
	userId: string;
	channel: SendableChannels;
	connection: AgentConnection;
}

interface PendingExtensionDialog {
	requestId: string;
	connection: AgentConnection;
	userId: string;
	method: DiscordExtensionDialogMethod;
	options: readonly string[];
	messages: Message[];
	responding: boolean;
	timeout?: ReturnType<typeof setTimeout>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const MAX_HISTORY_CONTEXT_CHARS = 8_000;
const MAX_INTERACTION_RESPONSE_CHARS = 1_900;
const EXTENSION_UI_RETRY_MS = 5_000;
const ROLE_LOOKUP_CACHE_MS = 60_000;
const MAX_ROLE_LOOKUP_CACHE_ENTRIES = 10_000;

class DiscordProgressReporter {
	private readonly activeToolLabels = new Map<string, string>();
	private readonly startedAt = Date.now();
	private connectionActivity: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly writer: DiscordResponseWriter,
		updateIntervalMs: number,
	) {
		this.publish(true);
		if (updateIntervalMs > 0) {
			this.timer = setInterval(() => this.publish(true), updateIntervalMs);
		}
	}

	observeConnection(event: AgentConnectionEvent): void {
		if (event.type !== "connection_status") return;
		this.connectionActivity = event.status === "reconnecting" ? "Reconnecting to Prime Agent." : undefined;
		this.publish(false);
	}

	observeTool(event: AgentConnectionEvent): void {
		if (event.type !== "session_event") return;
		if (event.event.type === "tool_execution_start") {
			this.activeToolLabels.set(event.event.toolCallId, progressLabel(event.event.toolName));
			this.publish(false);
			return;
		}
		if (event.event.type === "tool_execution_end") {
			this.activeToolLabels.delete(event.event.toolCallId);
			this.publish(false);
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.writer.setProgress(undefined);
	}

	private publish(includeHeartbeat: boolean): void {
		const activity =
			this.connectionActivity ?? [...this.activeToolLabels.values()].at(-1) ?? "Prime Agent is working.";
		const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1_000));
		const message = includeHeartbeat ? `${activity} Still working (${elapsedSeconds}s elapsed).` : activity;
		this.writer.setProgress(`_${message}_`);
	}
}

export class DiscordBridge {
	private readonly client: Client;
	private readonly logger: Pick<Console, "info" | "warn" | "error">;
	private readonly registry: DiscordAgentRegistry;
	private readonly dispatchQueue = new DiscordDispatchQueue();
	private readonly dedupe = new DiscordMessageDedupe();
	private readonly activeExtensionUiOwners = new Map<string, ActiveExtensionUiOwner>();
	private readonly activeDiscordReadScopes = new Map<AgentConnection, DiscordReadScope>();
	private readonly activeDiscordThreadCreationScopes = new Map<AgentConnection, DiscordThreadCreationScope>();
	private readonly discordReadService: DiscordReadService;
	private readonly discordThreadCreationService: DiscordThreadCreationService;
	private readonly pendingExtensionDialogs = new Map<string, PendingExtensionDialog>();
	private readonly extensionUiMessages = new Map<string, Message>();
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
		this.discordReadService = new DiscordReadService(
			{ getChannel: (channelId) => this.getDiscordReadChannel(channelId) },
			config,
			{
				maxMessages: config.readMaxMessages,
				maxContentChars: config.readMaxContentChars,
				maxTotalContentChars: config.readMaxTotalContentChars,
				maxAttachments: config.readMaxAttachments,
			},
			(userId, guildId) => this.resolveAuthorRoleIds(userId, null, guildId ?? null),
		);
		this.discordThreadCreationService = new DiscordThreadCreationService(
			{ getChannel: (channelId) => this.getDiscordThreadCreationChannel(channelId) },
			config,
			(userId, guildId) => this.resolveAuthorRoleIds(userId, null, guildId ?? null),
		);
		this.registry = new DiscordAgentRegistry({
			cwd: config.cwd,
			agentDir: options.agentDir,
			sessionRoot: config.sessionDir,
			socketPath: options.socketPath,
			runtimeConfig: {
				discordGatewayRead: true,
				discordGatewayThreadCreation: true,
				appendSystemPrompt: [DISCORD_WORKER_SYSTEM_SCAFFOLD],
			},
			connectionFactory: options.connectionFactory,
			eventListener: this.onRegistryConnectionEvent,
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

	private readonly onRegistryConnectionEvent = (
		key: string,
		connection: AgentConnection,
		event: AgentConnectionEvent,
	): void => {
		if (event.type === "extension_error") {
			this.logger.warn(
				`Prime Agent extension failed (${event.extensionPath}, ${event.event}): ${safeErrorMessage(event.error, this.config.botToken)}`,
			);
			return;
		}
		if (event.type === "discord_gateway_read_request") {
			void this.handleDiscordGatewayReadRequest(connection, event.request).catch((error: unknown) => {
				this.logger.warn(`Discord gateway read failed: ${safeErrorMessage(error, this.config.botToken)}`);
			});
			return;
		}
		if (event.type === "discord_gateway_thread_creation_request") {
			void this.handleDiscordGatewayThreadCreationRequest(connection, event.request).catch((error: unknown) => {
				this.logger.warn(
					`Discord gateway thread creation failed: ${safeErrorMessage(error, this.config.botToken)}`,
				);
			});
			return;
		}
		if (event.type !== "extension_ui_request") return;
		const owner = this.activeExtensionUiOwners.get(key);
		if (!owner || owner.connection !== connection) return;
		void this.handleExtensionUiRequest(key, owner.userId, owner.channel, connection, event.request).catch(
			(error: unknown) => {
				this.logger.warn(`Discord extension UI failed: ${safeErrorMessage(error, this.config.botToken)}`);
			},
		);
	};

	private async handleDiscordGatewayReadRequest(
		connection: AgentConnection,
		request: Extract<AgentConnectionEvent, { type: "discord_gateway_read_request" }>["request"],
	): Promise<void> {
		const respond = connection.respondToDiscordGatewayReadRequest;
		if (!respond) return;
		const scope = this.activeDiscordReadScopes.get(connection);
		const response: DiscordGatewayReadResponse = scope
			? await this.discordReadService.read(scope, request.request)
			: discordGatewayReadFailure(
					"UNAVAILABLE",
					"Discord gateway read is unavailable outside an active Discord request.",
				);
		await respond.call(connection, request.id, response);
	}

	private async withDiscordReadScope<T>(
		connection: AgentConnection,
		scope: DiscordReadScope,
		run: () => Promise<T>,
	): Promise<T> {
		this.activeDiscordReadScopes.set(connection, scope);
		try {
			return await run();
		} finally {
			if (this.activeDiscordReadScopes.get(connection) === scope) {
				this.activeDiscordReadScopes.delete(connection);
			}
		}
	}

	private async handleDiscordGatewayThreadCreationRequest(
		connection: AgentConnection,
		request: Extract<AgentConnectionEvent, { type: "discord_gateway_thread_creation_request" }>["request"],
	): Promise<void> {
		const respond = connection.respondToDiscordGatewayThreadCreationRequest;
		if (!respond) return;
		const scope = this.activeDiscordThreadCreationScopes.get(connection);
		const response: DiscordGatewayThreadCreationResponse = scope
			? await this.discordThreadCreationService.create(scope, request.request)
			: discordGatewayThreadCreationFailure(
					"UNAVAILABLE",
					"Discord thread creation is unavailable outside an active Discord request.",
				);
		await respond.call(connection, request.id, response);
	}

	private async withDiscordThreadCreationScope<T>(
		connection: AgentConnection,
		scope: DiscordThreadCreationScope,
		run: () => Promise<T>,
	): Promise<T> {
		this.activeDiscordThreadCreationScopes.set(connection, scope);
		try {
			return await run();
		} finally {
			if (this.activeDiscordThreadCreationScopes.get(connection) === scope) {
				this.activeDiscordThreadCreationScopes.delete(connection);
			}
		}
	}

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
		const sourceKey = createDiscordMessageSessionKey(message, sourceChannel, this.config.groupSessionsPerUser);
		if (this.pendingExtensionDialogs.has(sourceKey)) {
			const inputDecision = routeMessage({ ...routeInput, mentionsBot: true }, this.config);
			if (inputDecision.action === "respond" && this.dedupe.add(message.id)) {
				await this.consumeExtensionDialog(message, sourceChannel, sourceKey);
			}
			return;
		}

		const decision = routeMessage(routeInput, this.config);
		if (decision.action === "ignore" || !this.dedupe.add(message.id)) return;

		const targetChannel = decision.createThread ? await this.createThread(message) : sourceChannel;
		if (!targetChannel) {
			if (this.config.reactions) await safeReaction(message, "❌");
			return;
		}
		const sessionKey = createDiscordMessageSessionKey(message, targetChannel, this.config.groupSessionsPerUser);

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
		let progressReporter: DiscordProgressReporter | undefined;
		let writerFinalized = false;
		let unsubscribe: (() => void) | undefined;
		try {
			const connection = await this.registry.getOrCreate(sessionKey);
			const strippedContent = stripBotMention(message.content, botUser.id);
			const textControl = parseDiscordTextControl(strippedContent);
			if (textControl?.type === "capabilities") {
				const [state, resources, commands] = await Promise.all([
					connection.getState(),
					connection.getResourceSnapshot(),
					connection.getCommands(),
				]);
				await safeSend(targetChannel, formatDiscordCapabilities(state, resources, commands));
				if (this.config.reactions) await safeReaction(message, "✅");
				return;
			}

			const resourceInput =
				textControl?.type === "run"
					? textControl.input
					: strippedContent.startsWith("/")
						? strippedContent
						: undefined;
			const invocation = resourceInput
				? resolveDiscordResourceInvocation(resourceInput, await connection.getCommands())
				: undefined;
			if (textControl?.type === "run" && !invocation) {
				throw new Error(
					"Unknown Prime Agent extension, prompt, or skill command. Use /capabilities to list commands.",
				);
			}

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

			writer = await createDiscordResponseWriter(responseChannel(targetChannel, message), {
				updateIntervalMs: this.config.streamUpdateIntervalMs,
				placeholderText: "Prime Agent is working…",
				onDeliveryError: (error) =>
					this.logger.warn(`Discord response delivery failed: ${safeErrorMessage(error, this.config.botToken)}`),
			});
			if (writer.deliveryErrors.length > 0) {
				throw new Error("Discord rejected the initial response message");
			}
			progressReporter = new DiscordProgressReporter(writer, this.config.progressUpdateIntervalMs);

			let streamedText = "";
			unsubscribe = connection.subscribe((event) => {
				const delta = textDelta(event);
				if (delta) {
					streamedText += delta;
					writer?.append(delta);
					return;
				}
				progressReporter?.observeConnection(event);
				if (this.config.toolProgress) progressReporter?.observeTool(event);
			});
			const prompt = invocation
				? [invocation.prompt, ...attachments.promptNotes].join("\n\n")
				: await this.buildPrompt(message, botUser.id, decision, attachments.promptNotes);
			const promptImages = attachments.images;
			const readScope = createDiscordReadScope(message.author.id, message.guildId, targetChannel);
			const threadCreationScope = createDiscordThreadCreationScope(
				message.author.id,
				message.guildId,
				targetChannel,
				targetChannel.id === message.channelId ? message.id : undefined,
			);
			await this.withExtensionUiOwner(sessionKey, message.author.id, targetChannel, connection, () =>
				this.withDiscordReadScope(connection, readScope, () =>
					this.withDiscordThreadCreationScope(connection, threadCreationScope, async () => {
						await connection.promptAndWait(prompt, { images: promptImages, source: "rpc" });
						if (invocation?.command.source === "extension") await connection.waitForIdle();
					}),
				),
			);
			const finalText =
				nonEmptyText(streamedText) ??
				(invocation?.command.source === "extension"
					? "Prime Agent extension command completed."
					: await connection.getLastAssistantText());
			const terminalReport = requireTerminalReport(finalText);
			const extractedMedia = extractDiscordMedia(terminalReport);
			const outboundMedia = await loadDiscordOutboundMedia(extractedMedia.paths, {
				cwd: this.config.cwd,
				maxAttachments: this.config.maxOutboundAttachments,
				maxBytesPerAttachment: unlimitedAsSafeInteger(this.config.maxOutboundAttachmentBytes),
			});
			const responseText = formatDiscordMediaResponse(
				extractedMedia.text,
				outboundMedia.attachments.length,
				outboundMedia.errors,
			);
			// Clear the bridge-owned status before replacing the receipt with the terminal response.
			progressReporter?.stop();
			progressReporter = undefined;
			const result = await writer.finish(responseText);
			writerFinalized = true;
			if (!result.terminalDelivered) {
				throw new Error("Discord could not deliver the complete response");
			}
			await sendDiscordMedia(targetChannel, outboundMedia.attachments);

			if (this.config.reactions) await safeReaction(message, "✅");
		} catch (error) {
			const failureText = isUnsubmittedBusyPromptError(error)
				? "Prime Agent already has work in progress or queued. This message was not submitted; please send it again once the session is idle."
				: `Prime Agent failed: ${safeErrorMessage(error, this.config.botToken)}`;
			if (writer && !writerFinalized) {
				const delivered = await writer
					.fail(failureText)
					.then((result) => result.terminalDelivered)
					.catch(() => false);
				writerFinalized = true;
				if (!delivered) await safeSend(targetChannel, failureText);
			} else {
				await safeSend(targetChannel, failureText);
			}
			if (this.config.reactions) await safeReaction(message, "❌");
		} finally {
			unsubscribe?.();
			progressReporter?.stop();
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
		return buildDiscordTurnPrompt({
			authorName,
			authorId: message.author.id,
			request: content || (attachmentNotes.length > 0 ? "Please inspect the attached files." : "Please respond."),
			history,
			attachmentNotes,
		});
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

	private async createThread(message: Message): Promise<SendableChannels | undefined> {
		if (!message.inGuild()) return undefined;
		try {
			return await message.startThread({
				name: threadName(message),
				autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
				reason: "Prime Agent Discord conversation",
			});
		} catch (error) {
			this.logger.warn(`Discord auto-thread creation failed: ${safeErrorMessage(error, this.config.botToken)}`);
			return undefined;
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
			case "thread":
				return this.createConversationThread(interaction);
			case "new": {
				this.dispatchQueue.clear(key);
				await this.cancelPendingExtensionDialog(key);
				await this.clearExtensionUiMessages(key);
				const existing = this.registry.getExisting(key);
				if (existing) await existing.abortAndClearQueue();
				await this.discardPendingExtensionDialogForKey(key);
				const result = await this.registry.newSession(key);
				return result.cancelled ? "New session cancelled." : "Started a new Prime Agent session.";
			}
			case "abort": {
				this.dispatchQueue.clear(key);
				await this.cancelPendingExtensionDialog(key);
				await this.clearExtensionUiMessages(key);
				const connection = this.registry.getExisting(key);
				if (!connection) return "There is no active Prime Agent session here.";
				await connection.abortAndClearQueue();
				await this.discardPendingExtensionDialogForKey(key);
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
			case "capabilities": {
				const connection = await this.registry.getOrCreate(key);
				const [state, resources, commands] = await Promise.all([
					connection.getState(),
					connection.getResourceSnapshot(),
					connection.getCommands(),
				]);
				return truncateText(formatDiscordCapabilities(state, resources, commands), MAX_INTERACTION_RESPONSE_CHARS);
			}
			case "run": {
				const channel = interaction.channel;
				if (!channel?.isSendable()) throw new Error("Discord command channel is unavailable");
				let result = "Prime Agent command was cleared before it ran.";
				await this.dispatchQueue.enqueue(key, async () => {
					const connection = await this.registry.getOrCreate(key);
					const invocation = resolveDiscordResourceInvocation(
						interaction.options.getString("command", true),
						await connection.getCommands(),
					);
					if (!invocation) {
						throw new Error(
							"Unknown Prime Agent extension, prompt, or skill command. Use /capabilities to list commands.",
						);
					}
					let streamedText = "";
					const unsubscribe = connection.subscribe((event) => {
						const delta = textDelta(event);
						if (delta) streamedText += delta;
					});
					try {
						const readScope = createDiscordReadScope(interaction.user.id, interaction.guildId, channel);
						const threadCreationScope = createDiscordThreadCreationScope(
							interaction.user.id,
							interaction.guildId,
							channel,
						);
						await this.withExtensionUiOwner(key, interaction.user.id, channel, connection, () =>
							this.withDiscordReadScope(connection, readScope, () =>
								this.withDiscordThreadCreationScope(connection, threadCreationScope, async () => {
									await connection.promptAndWait(invocation.prompt, { source: "rpc" });
									if (invocation.command.source === "extension") await connection.waitForIdle();
								}),
							),
						);
						const text =
							streamedText ||
							(invocation.command.source === "extension"
								? "Prime Agent extension command completed."
								: await connection.getLastAssistantText());
						result = truncateText(
							text || "Prime Agent command completed without a text response.",
							MAX_INTERACTION_RESPONSE_CHARS,
						);
					} finally {
						unsubscribe();
					}
				});
				return result;
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

	private async createConversationThread(interaction: ChatInputCommandInteraction): Promise<string> {
		const channel = interaction.channel;
		if (!isDiscordThreadParentChannel(channel)) {
			throw new Error("The /thread command must be used in a server text or announcement channel");
		}
		const requestedTitle = interaction.options.getString("title", true).trim();
		if (!requestedTitle) throw new Error("Thread title cannot be empty");
		const thread = await channel.threads.create({
			name: truncateText(requestedTitle, 100),
			autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
			reason: "Prime Agent conversation requested with /thread",
		});
		if (!thread.isSendable()) throw new Error("Discord created a thread that cannot receive messages");
		const key = createDiscordSessionKey(
			{
				kind: "thread",
				channelId: thread.id,
				guildId: interaction.guildId ?? undefined,
				userId: interaction.user.id,
			},
			{ groupSessionsPerUser: this.config.groupSessionsPerUser },
		);
		await this.registry.getOrCreate(key);
		await safeSend(thread, "Started a new Prime Agent session. Send a message in this thread to begin.");
		return `Created a new Prime Agent conversation in <#${thread.id}>.`;
	}

	private deferExtensionUiCancellation(connection: AgentConnection, requestId: string): void {
		setTimeout(() => {
			void connection.respondToExtensionUiRequest(requestId, { cancelled: true }).catch((error: unknown) => {
				this.logger.warn(`Discord extension cancellation failed: ${safeErrorMessage(error, this.config.botToken)}`);
			});
		}, 0);
	}

	private async withExtensionUiOwner<T>(
		sessionKey: string,
		userId: string,
		channel: SendableChannels,
		connection: AgentConnection,
		run: () => Promise<T>,
	): Promise<T> {
		const owner: ActiveExtensionUiOwner = { userId, channel, connection };
		this.activeExtensionUiOwners.set(sessionKey, owner);
		let completed = false;
		try {
			const result = await run();
			completed = true;
			return result;
		} finally {
			await this.cancelPendingExtensionDialog(sessionKey);
			const pending = this.pendingExtensionDialogs.get(sessionKey);
			if (completed && pending?.connection === connection) {
				await this.discardPendingExtensionDialog(sessionKey, pending);
			}
			if (this.activeExtensionUiOwners.get(sessionKey) === owner) {
				this.activeExtensionUiOwners.delete(sessionKey);
			}
		}
	}

	private async handleExtensionUiRequest(
		sessionKey: string,
		userId: string,
		channel: SendableChannels,
		connection: AgentConnection,
		request: AgentConnectionExtensionUiRequest,
	): Promise<void> {
		const presentation = presentDiscordExtensionUi(request);
		if (presentation.kind === "unsupported") {
			if (presentation.dialog) this.deferExtensionUiCancellation(connection, request.id);
			return;
		}
		if (!channel.isDMBased()) {
			if (presentation.kind === "dialog") {
				this.deferExtensionUiCancellation(connection, request.id);
				await safeSend(channel, "Prime Agent cancelled a private extension dialog. Run this command in a bot DM.");
			}
			return;
		}
		if (presentation.kind === "notification") {
			await safeSend(channel, presentation.content);
			return;
		}
		if (presentation.kind === "state") {
			await this.updateExtensionUiMessage(sessionKey, channel, presentation.key, presentation.content);
			return;
		}

		await this.cancelPendingExtensionDialog(sessionKey);
		const requestedTimeout = presentation.timeoutMs ?? this.config.extensionUiTimeoutMs;
		const timeoutMs = Math.min(requestedTimeout, this.config.extensionUiTimeoutMs);
		const pending: PendingExtensionDialog = {
			requestId: request.id,
			connection,
			userId,
			method: presentation.method,
			options: presentation.options,
			messages: [],
			responding: false,
		};
		this.pendingExtensionDialogs.set(sessionKey, pending);
		this.scheduleExtensionDialogTimeout(sessionKey, pending, channel, timeoutMs);
		try {
			for (const content of splitDiscordMessage(presentation.content)) {
				if (this.pendingExtensionDialogs.get(sessionKey) !== pending) break;
				const message = await channel.send({ content, allowedMentions: DISCORD_ALLOWED_MENTIONS });
				if (this.pendingExtensionDialogs.get(sessionKey) !== pending) {
					await message.delete().catch(() => undefined);
					break;
				}
				pending.messages.push(message);
			}
		} catch (error) {
			try {
				await this.finishExtensionDialog(sessionKey, pending, { cancelled: true });
			} catch {
				this.scheduleExtensionDialogTimeout(sessionKey, pending, channel, EXTENSION_UI_RETRY_MS);
			}
			throw error;
		}
	}

	private scheduleExtensionDialogTimeout(
		sessionKey: string,
		pending: PendingExtensionDialog,
		channel: SendableChannels,
		delayMs: number,
	): void {
		if (this.pendingExtensionDialogs.get(sessionKey) !== pending) return;
		if (pending.timeout) clearTimeout(pending.timeout);
		pending.timeout = setTimeout(() => {
			pending.timeout = undefined;
			void this.finishExtensionDialog(sessionKey, pending, { cancelled: true })
				.then((finished) => {
					if (finished) return safeSend(channel, "Prime Agent extension request timed out.");
					if (this.pendingExtensionDialogs.get(sessionKey) === pending) {
						this.scheduleExtensionDialogTimeout(sessionKey, pending, channel, EXTENSION_UI_RETRY_MS);
					}
				})
				.catch((error: unknown) => {
					this.logger.warn(
						`Discord extension timeout cleanup failed: ${safeErrorMessage(error, this.config.botToken)}`,
					);
					if (this.pendingExtensionDialogs.get(sessionKey) === pending) {
						this.scheduleExtensionDialogTimeout(sessionKey, pending, channel, EXTENSION_UI_RETRY_MS);
					}
				});
		}, delayMs);
	}

	private async updateExtensionUiMessage(
		sessionKey: string,
		channel: SendableChannels,
		key: string,
		content: string | undefined,
	): Promise<void> {
		const messageKey = `${sessionKey}:${key}`;
		const existing = this.extensionUiMessages.get(messageKey);
		if (!content) {
			this.extensionUiMessages.delete(messageKey);
			await existing?.delete().catch(() => undefined);
			return;
		}
		const payload = {
			content: truncateText(content, MAX_INTERACTION_RESPONSE_CHARS),
			allowedMentions: DISCORD_ALLOWED_MENTIONS,
		};
		if (existing) {
			try {
				await existing.edit(payload);
				return;
			} catch {
				this.extensionUiMessages.delete(messageKey);
			}
		}
		const sent = await channel.send(payload);
		this.extensionUiMessages.set(messageKey, sent);
	}

	private async clearExtensionUiMessages(sessionKey?: string): Promise<void> {
		const prefix = sessionKey ? `${sessionKey}:` : undefined;
		const messages: Message[] = [];
		for (const [key, message] of this.extensionUiMessages) {
			if (prefix && !key.startsWith(prefix)) continue;
			this.extensionUiMessages.delete(key);
			messages.push(message);
		}
		await Promise.allSettled(messages.map((message) => message.delete()));
	}

	private async consumeExtensionDialog(
		message: Message,
		channel: SendableChannels,
		sessionKey: string,
	): Promise<void> {
		const pending = this.pendingExtensionDialogs.get(sessionKey);
		if (!pending) return;
		if (pending.userId !== message.author.id) {
			await safeSend(channel, "That extension request is waiting for the user who started it.");
			return;
		}
		const content = this.client.user ? stripBotMention(message.content, this.client.user.id) : message.content.trim();
		if (/^!prime\s+status$/i.test(content)) {
			const state = await pending.connection.getState();
			await safeSend(
				channel,
				`Prime Agent is ${state.isStreaming ? "working" : "idle"}; an extension response is still pending.`,
			);
			return;
		}
		const abortRequested = /^!prime\s+abort$/i.test(content);
		const control = abortRequested ? { type: "cancel" as const } : parseDiscordExtensionReplyControl(content);
		if (!control) {
			await safeSend(
				channel,
				"An extension response is pending. Use `!prime respond <value>`, `!prime cancel`, or `!prime abort`.",
			);
			return;
		}
		const parsed = parseDiscordExtensionUiInput(
			pending.method,
			pending.options,
			control.type === "cancel" ? "cancel" : control.value,
		);
		if (!parsed.accepted) {
			await safeSend(channel, parsed.error);
			return;
		}
		let finished = false;
		try {
			finished = await this.finishExtensionDialog(sessionKey, pending, parsed.response);
		} catch (error) {
			this.logger.warn(`Discord extension response failed: ${safeErrorMessage(error, this.config.botToken)}`);
			if (!abortRequested) {
				await safeSend(channel, "Could not submit the extension response. Retry it or use `!prime abort`.");
				return;
			}
		}
		if (abortRequested) {
			await pending.connection.abortAndClearQueue();
			await this.discardPendingExtensionDialog(sessionKey, pending);
			await this.clearExtensionUiMessages(sessionKey);
			await safeSend(channel, "Extension request cancelled and abort requested.");
			return;
		}
		if (!finished) {
			await safeSend(channel, "The extension response is already being submitted.");
			return;
		}
		await safeSend(channel, "Extension response accepted.");
	}

	private async finishExtensionDialog(
		sessionKey: string,
		pending: PendingExtensionDialog,
		response: AgentConnectionExtensionUiResponse,
	): Promise<boolean> {
		if (this.pendingExtensionDialogs.get(sessionKey) !== pending || pending.responding) return false;
		pending.responding = true;
		try {
			await pending.connection.respondToExtensionUiRequest(pending.requestId, response);
		} catch (error) {
			pending.responding = false;
			throw error;
		}
		pending.responding = false;
		if (this.pendingExtensionDialogs.get(sessionKey) !== pending) return false;
		this.pendingExtensionDialogs.delete(sessionKey);
		if (pending.timeout) clearTimeout(pending.timeout);
		await Promise.allSettled(pending.messages.map((message) => message.delete()));
		return true;
	}

	private async discardPendingExtensionDialogForKey(sessionKey: string): Promise<void> {
		const pending = this.pendingExtensionDialogs.get(sessionKey);
		if (pending) await this.discardPendingExtensionDialog(sessionKey, pending);
	}

	private async discardPendingExtensionDialog(sessionKey: string, pending: PendingExtensionDialog): Promise<void> {
		if (this.pendingExtensionDialogs.get(sessionKey) !== pending) return;
		this.pendingExtensionDialogs.delete(sessionKey);
		if (pending.timeout) clearTimeout(pending.timeout);
		await Promise.allSettled(pending.messages.map((message) => message.delete()));
	}

	private async cancelPendingExtensionDialog(sessionKey: string): Promise<void> {
		const pending = this.pendingExtensionDialogs.get(sessionKey);
		if (!pending) return;
		try {
			await this.finishExtensionDialog(sessionKey, pending, { cancelled: true });
		} catch (error) {
			this.logger.warn(`Discord extension cancellation failed: ${safeErrorMessage(error, this.config.botToken)}`);
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

	private async getDiscordReadChannel(channelId: string): Promise<DiscordReadChannel | undefined> {
		let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
		try {
			channel = await this.client.channels.fetch(channelId);
		} catch (error) {
			throw discordReadAdapterError(error, "channel");
		}
		if (!channel || !channel.isTextBased()) return undefined;
		if (channel.isDMBased()) {
			return {
				id: channel.id,
				kind: "dm",
				getMessage: async (messageId) => {
					try {
						const message = await channel.messages.fetch(messageId);
						return message ? discordReadMessageSource(message) : undefined;
					} catch (error) {
						throw discordReadAdapterError(error, "message");
					}
				},
				getRecentMessages: async (limit) => {
					try {
						const messages = await channel.messages.fetch({ limit });
						return [...messages.values()].map(discordReadMessageSource);
					} catch (error) {
						throw discordReadAdapterError(error, "channel");
					}
				},
			};
		}
		if (!isDiscordReadGuildChannel(channel)) return undefined;
		if (!channel.viewable) {
			throw new DiscordReadAdapterError("MISSING_PERMISSION", "Discord denied channel access.");
		}
		return {
			id: channel.id,
			kind: channel.isThread() ? "thread" : "guild",
			guildId: channel.guildId,
			...(channel.isThread() && channel.parentId ? { parentChannelId: channel.parentId } : {}),
			canUserView: (userId) => this.canDiscordReadUserView(channel, userId),
			getMessage: async (messageId) => {
				try {
					const message = await channel.messages.fetch(messageId);
					return message ? discordReadMessageSource(message) : undefined;
				} catch (error) {
					throw discordReadAdapterError(error, "message");
				}
			},
			getRecentMessages: async (limit) => {
				try {
					const messages = await channel.messages.fetch({ limit });
					return [...messages.values()].map(discordReadMessageSource);
				} catch (error) {
					throw discordReadAdapterError(error, "channel");
				}
			},
		};
	}

	private async getDiscordThreadCreationChannel(channelId: string) {
		let channel: Awaited<ReturnType<Client["channels"]["fetch"]>>;
		try {
			channel = await this.client.channels.fetch(channelId);
		} catch (error) {
			throw discordThreadCreationAdapterError(error);
		}
		if (!channel) return undefined;
		if (channel.isDMBased()) return { id: channel.id, kind: "dm" } as const;
		if (!isDiscordReadGuildChannel(channel)) return undefined;
		if (!channel.viewable) {
			throw new DiscordThreadCreationAdapterError("MISSING_PERMISSION", "Discord denied channel access.");
		}
		if (channel.isThread()) {
			return {
				id: channel.id,
				kind: "thread",
				guildId: channel.guildId,
				...(channel.parentId ? { parentChannelId: channel.parentId } : {}),
			} as const;
		}
		if (!isDiscordThreadCreationParentChannel(channel)) {
			return { id: channel.id, kind: "guild", guildId: channel.guildId } as const;
		}
		const parent: DiscordThreadCreationParentChannel = {
			id: channel.id,
			kind: "guild",
			guildId: channel.guildId,
			canUserCreateThread: (userId) => this.canDiscordUserCreateThread(channel, userId),
			createThread: async (title, startMessageId) => {
				try {
					const thread = await channel.threads.create({
						name: title,
						autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
						reason: "Prime Agent thread requested by the initiating Discord user",
						...(startMessageId ? { startMessage: startMessageId } : {}),
					});
					return { id: thread.id };
				} catch (error) {
					throw discordThreadCreationAdapterError(error);
				}
			},
		};
		return parent;
	}

	private async canDiscordReadUserView(channel: GuildTextBasedChannel, userId: string): Promise<boolean> {
		const member =
			channel.guild.members.cache.get(userId) ?? (await channel.guild.members.fetch(userId).catch(() => undefined));
		return member ? (channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) ?? false) : false;
	}

	private async canDiscordUserCreateThread(channel: TextChannel | NewsChannel, userId: string): Promise<boolean> {
		const member =
			channel.guild.members.cache.get(userId) ?? (await channel.guild.members.fetch(userId).catch(() => undefined));
		const permissions = member ? channel.permissionsFor(member) : undefined;
		return Boolean(
			permissions?.has(PermissionFlagsBits.ViewChannel) &&
				permissions.has(PermissionFlagsBits.SendMessages) &&
				permissions.has(PermissionFlagsBits.CreatePublicThreads),
		);
	}

	private async stopInternal(): Promise<void> {
		try {
			this.accepting = false;
			this.activeDiscordReadScopes.clear();
			this.activeDiscordThreadCreationScopes.clear();
			await Promise.allSettled(
				[...this.pendingExtensionDialogs.keys()].map((key) => this.cancelPendingExtensionDialog(key)),
			);
			this.activeExtensionUiOwners.clear();
			await this.clearExtensionUiMessages();
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
			if (this.pendingExtensionDialogs.size > 0) await this.registry.abortAll();
			await Promise.allSettled(
				[...this.pendingExtensionDialogs.keys()].map((key) => this.discardPendingExtensionDialogForKey(key)),
			);
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

function isDiscordThreadParentChannel(
	channel: ChatInputCommandInteraction["channel"],
): channel is TextChannel | NewsChannel {
	return Boolean(channel?.isTextBased() && !channel.isDMBased() && !channel.isThread() && !channel.isThreadOnly());
}

function isDiscordThreadCreationParentChannel(
	channel: Exclude<Awaited<ReturnType<Client["channels"]["fetch"]>>, null>,
): channel is TextChannel | NewsChannel {
	return channel.isTextBased() && !channel.isDMBased() && !channel.isThread() && !channel.isThreadOnly();
}

function createDiscordMessageSessionKey(
	message: Message,
	channel: SendableChannels,
	groupSessionsPerUser: boolean,
): string {
	const kind: DiscordChannelKind = channel.isThread() ? "thread" : message.inGuild() ? "guild" : "dm";
	return createDiscordSessionKey(
		{
			kind,
			channelId: channel.id,
			guildId: message.guildId ?? undefined,
			userId: message.author.id,
		},
		{ groupSessionsPerUser },
	);
}

function createDiscordReadScope(userId: string, guildId: string | null, channel: SendableChannels): DiscordReadScope {
	if (!guildId) {
		return { userId, kind: "dm", channelId: channel.id };
	}
	return {
		userId,
		kind: channel.isThread() ? "thread" : "guild",
		guildId,
		channelId: channel.id,
	};
}

function createDiscordThreadCreationScope(
	userId: string,
	guildId: string | null,
	channel: SendableChannels,
	messageId?: string,
): DiscordThreadCreationScope {
	if (!guildId) {
		return { userId, kind: "dm", channelId: channel.id };
	}
	return {
		userId,
		kind: channel.isThread() ? "thread" : "guild",
		guildId,
		channelId: channel.id,
		...(messageId ? { messageId } : {}),
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

function isDiscordReadGuildChannel(
	channel: Exclude<Awaited<ReturnType<Client["channels"]["fetch"]>>, null>,
): channel is GuildTextBasedChannel {
	return channel.isTextBased() && !channel.isDMBased() && "guildId" in channel;
}

function discordReadMessageSource(message: Message): DiscordReadMessageSource {
	return {
		id: message.id,
		channelId: message.channelId,
		...(message.guildId ? { guildId: message.guildId } : {}),
		createdTimestamp: message.createdTimestamp,
		author: {
			id: message.author.id,
			username: message.author.username,
			...(message.member?.displayName ? { displayName: message.member.displayName } : {}),
		},
		content: message.content,
		attachments: message.attachments.map((attachment) => ({
			id: attachment.id,
			name: attachment.name ?? "attachment",
			...(attachment.contentType ? { contentType: attachment.contentType } : {}),
			size: attachment.size,
		})),
	};
}

function discordReadAdapterError(error: unknown, target: "channel" | "message"): DiscordReadAdapterError {
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : undefined;
	if (code === 50_001 || code === 50_013) {
		return new DiscordReadAdapterError("MISSING_PERMISSION", "Discord denied message access.");
	}
	if (target === "message" && code === 10_008) {
		return new DiscordReadAdapterError("UNAVAILABLE", "The requested Discord message is unavailable or was deleted.");
	}
	return new DiscordReadAdapterError("UNAVAILABLE", "Discord data is unavailable.");
}

function discordThreadCreationAdapterError(error: unknown): DiscordThreadCreationAdapterError {
	const code =
		error && typeof error === "object" && "code" in error && typeof error.code === "number" ? error.code : undefined;
	if (code === 50_001 || code === 50_013) {
		return new DiscordThreadCreationAdapterError("MISSING_PERMISSION", "Discord denied thread creation.");
	}
	return new DiscordThreadCreationAdapterError("UNAVAILABLE", "Discord thread creation is unavailable.");
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

function isUnsubmittedBusyPromptError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return /^(?:Agent is already processing|Agent has queued work)\. Specify streamingBehavior \('steer' or 'followUp'\) to queue the message\.$/.test(
		error.message,
	);
}

function textDelta(event: AgentConnectionEvent): string | undefined {
	if (event.type !== "session_event" || event.event.type !== "message_update") return undefined;
	return event.event.assistantMessageEvent.type === "text_delta" ? event.event.assistantMessageEvent.delta : undefined;
}

function nonEmptyText(value: string | undefined): string | undefined {
	return value?.trim() ? value : undefined;
}

function requireTerminalReport(value: string | undefined): string {
	const report = nonEmptyText(value);
	if (!report) throw new Error("Prime Agent completed without a user-facing terminal report");
	return report;
}

function progressLabel(toolName: string): string {
	return toolName === "ipython"
		? "Inspecting the workspace and carrying out the next step."
		: "Using a tool to continue the task.";
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

function formatDiscordMediaResponse(text: string, attachmentCount: number, errors: readonly string[]): string {
	const status =
		attachmentCount > 0
			? `Attached ${attachmentCount} file${attachmentCount === 1 ? "" : "s"}.`
			: errors.length > 0
				? "Prime Agent could not attach the requested media."
				: undefined;
	const failureNote =
		errors.length > 0 && attachmentCount > 0 ? "Some requested media could not be attached." : undefined;
	return [text, status, failureNote].filter((section): section is string => Boolean(section)).join("\n\n");
}

async function sendDiscordMedia(
	channel: SendableChannels,
	attachments: readonly DiscordOutboundMedia[],
): Promise<void> {
	for (const attachment of attachments) {
		await channel.send({
			files: [{ attachment: attachment.content, name: attachment.name }],
			allowedMentions: { parse: [], repliedUser: false },
		});
	}
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
		"/thread — create a new conversation thread in this channel",
		"/abort — stop the active run and clear queued messages",
		"/status — show session, model, and effort",
		"/capabilities — list discovered tools and resources",
		"/run — invoke a discovered extension, prompt, or skill command",
		"/compact — compact session context",
		"/effort — set reasoning effort",
		"/model — set provider and model ID",
	].join("\n");
}
