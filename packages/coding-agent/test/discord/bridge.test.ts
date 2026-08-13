import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, MessageType, Status } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { DiscordAgentConnectionFactory } from "../../src/gateway/discord/agent-registry.js";
import { DiscordBridge } from "../../src/gateway/discord/bridge.js";
import type { DiscordBridgeConfig } from "../../src/gateway/discord/config.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionPromptOptions,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "../../src/modes/agent-connection/types.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class FakeDiscordClient extends EventEmitter {
	readonly user = { id: "bot-1", tag: "Prime Agent#0001" };
	readonly application = null;
	readonly ws = {
		status: Status.Ready,
		shards: new Map([[0, { status: Status.Ready, ping: 10 }]]),
	};
	readonly guilds = {
		cache: new Map<
			string,
			{
				members: {
					cache: Map<string, { roles: { cache: Map<string, unknown> } }>;
					fetch: (userId: string) => Promise<{ roles: { cache: Map<string, unknown> } }>;
				};
			}
		>(),
	};
	readonly loginTokens: string[] = [];
	destroyCalls = 0;

	constructor(
		private readonly loginGate: Promise<string> = Promise.resolve("token"),
		private readonly destroyGate: Promise<void> = Promise.resolve(),
	) {
		super();
	}

	isReady(): boolean {
		return this.ws.status === Status.Ready;
	}

	async login(token: string): Promise<string> {
		this.loginTokens.push(token);
		return this.loginGate;
	}

	async destroy(): Promise<void> {
		this.destroyCalls++;
		await this.destroyGate;
	}

	asClient(): Client {
		return this as unknown as Client;
	}
}

function config(overrides: Partial<DiscordBridgeConfig> = {}): DiscordBridgeConfig {
	const stateRoot = join(tmpdir(), `prime-discord-bridge-test-${process.pid}`);
	return {
		botToken: "secret-token",
		allowedUsers: ["user-1"],
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
		readMaxMessages: 50,
		readMaxContentChars: 4_000,
		readMaxTotalContentChars: 12_000,
		readMaxAttachments: 10,
		maxAttachmentBytes: 32 * 1024 * 1024,
		maxAttachments: 5,
		maxOutboundAttachmentBytes: 25 * 1024 * 1024,
		maxOutboundAttachments: 5,
		attachmentTimeoutMs: 30_000,
		streamUpdateIntervalMs: 1_000,
		progressUpdateIntervalMs: 30_000,
		gatewayHealthCheckIntervalMs: 0,
		gatewayHealthFailureThreshold: 3,
		gatewayMaxPingMs: 30_000,
		registerCommands: false,
		toolProgress: true,
		extensionUiTimeoutMs: 300_000,
		cwd: stateRoot,
		sessionDir: join(stateRoot, "sessions"),
		cacheDir: join(stateRoot, "cache"),
		...overrides,
	};
}

function createBridge(
	client: FakeDiscordClient,
	overrides: Partial<DiscordBridgeConfig> = {},
	connectionFactory?: DiscordAgentConnectionFactory,
): DiscordBridge {
	return new DiscordBridge(config(overrides), {
		agentDir: join(tmpdir(), "prime-discord-bridge-agent"),
		socketPath: join(tmpdir(), "prime-discord-bridge-daemon.sock"),
		client: client.asClient(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		...(connectionFactory ? { connectionFactory } : {}),
	});
}

function bridgeState(sessionFile: string): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/project",
		model: undefined,
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile,
		sessionId: "active-1",
		sessionDir: "/sessions",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
		scopedModels: [],
		activeToolNames: ["ipython"],
		contextUsage: undefined,
	};
}

class FakeBridgeConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private readonly responseGate = deferred<void>();
	readonly prompts: string[] = [];
	readonly promptOptions: Array<AgentConnectionPromptOptions | undefined> = [];
	readonly toolEvents: AgentConnectionEvent[] = [];
	readonly promptGates: Promise<void>[] = [];
	readonly extensionResponses: Array<{ id: string; response: Record<string, unknown> }> = [];
	extensionRequest: AgentConnectionEvent | undefined;
	toolEventDelayMs = 0;
	lastAssistantText = "resource response";
	responseFailures = 0;
	rejectBusyPrompt: string | undefined;

	constructor(
		private readonly state: AgentConnectionState,
		private readonly commands: readonly AgentConnectionSlashCommand[],
	) {}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getState(): Promise<AgentConnectionState> {
		return this.state;
	}

	async getCommands(): Promise<readonly AgentConnectionSlashCommand[]> {
		return this.commands;
	}

	async promptAndWait(prompt: string, options?: AgentConnectionPromptOptions): Promise<void> {
		this.prompts.push(prompt);
		this.promptOptions.push(options);
		if (this.rejectBusyPrompt) throw new Error(this.rejectBusyPrompt);
		for (const event of this.toolEvents) {
			for (const listener of this.listeners) void listener(event);
		}
		if (this.toolEventDelayMs > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, this.toolEventDelayMs));
		}
		const gate = this.promptGates.shift();
		if (gate) await gate;
		if (!this.extensionRequest) return;
		for (const listener of this.listeners) void listener(this.extensionRequest);
		await this.responseGate.promise;
	}

	async waitForIdle(): Promise<void> {}

	async getLastAssistantText(): Promise<string> {
		return this.lastAssistantText;
	}

	async respondToExtensionUiRequest(id: string, response: Record<string, unknown>): Promise<void> {
		if (this.responseFailures > 0) {
			this.responseFailures--;
			throw new Error("temporary response failure");
		}
		this.extensionResponses.push({ id, response });
		this.responseGate.resolve();
	}

	async abortAndClearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return { steering: [], followUp: [] };
	}

	async dispose(): Promise<void> {}

	asAgentConnection(): AgentConnection {
		return this as unknown as AgentConnection;
	}
}

function resourceCommand(name: string, source: AgentConnectionSlashCommand["source"]): AgentConnectionSlashCommand {
	return {
		name,
		registeredName: name.replaceAll(":", "-"),
		source,
		sourceInfo: { path: `/resources/${name}`, source: "test", scope: "project", origin: "top-level" },
	};
}

function createRunInteraction(
	channel: object,
	command: string,
	guildId: string | null = null,
): {
	interaction: object;
	deferReply: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
} {
	const deferReply = vi.fn(async (_payload: unknown) => undefined);
	const editReply = vi.fn(async (_payload: unknown) => undefined);
	return {
		interaction: {
			isChatInputCommand: () => true,
			channel,
			channelId: "dm-1",
			guildId,
			member: null,
			user: { id: "user-1", bot: false },
			commandName: "run",
			inGuild: () => guildId !== null,
			options: { getString: (_name: string, _required: boolean) => command },
			deferReply,
			editReply,
		},
		deferReply,
		editReply,
	};
}

function createThreadInteraction(channel: object): {
	interaction: object;
	deferReply: ReturnType<typeof vi.fn>;
	editReply: ReturnType<typeof vi.fn>;
} {
	const deferReply = vi.fn(async (_payload: unknown) => undefined);
	const editReply = vi.fn(async (_payload: unknown) => undefined);
	return {
		interaction: {
			isChatInputCommand: () => true,
			channel,
			channelId: "guild-channel-1",
			guildId: "guild-1",
			member: null,
			user: { id: "user-1", bot: false },
			commandName: "thread",
			inGuild: () => true,
			options: { getString: (_name: string, _required: boolean) => "Design review" },
			deferReply,
			editReply,
		},
		deferReply,
		editReply,
	};
}

describe("DiscordBridge lifecycle", () => {
	it("waits for asynchronous Discord client destruction before stop resolves", async () => {
		const destroyGate = deferred<void>();
		const client = new FakeDiscordClient(Promise.resolve("token"), destroyGate.promise);
		const bridge = createBridge(client);
		await expect(bridge.start()).resolves.toBe("Prime Agent#0001");

		let stopped = false;
		const stoppedSignal = bridge.waitUntilStopped().then(() => {
			stopped = true;
		});
		const stop = bridge.stop().then(() => {
			stopped = true;
		});
		await vi.waitFor(() => expect(client.destroyCalls).toBe(1));
		expect(stopped).toBe(false);

		destroyGate.resolve();
		await Promise.all([stop, stoppedSignal]);
		expect(stopped).toBe(true);
		expect(client.listenerCount("messageCreate")).toBe(0);
		expect(client.listenerCount("interactionCreate")).toBe(0);
		await expect(bridge.stop()).resolves.toBeUndefined();
		expect(client.destroyCalls).toBe(1);
	});

	it("does not become accepting when stopped during login", async () => {
		const loginGate = deferred<string>();
		const client = new FakeDiscordClient(loginGate.promise);
		const bridge = createBridge(client);
		const start = bridge.start();
		await vi.waitFor(() => expect(client.loginTokens).toEqual(["secret-token"]));

		await bridge.stop();
		loginGate.resolve("token");
		await expect(start).rejects.toThrow("Discord gateway stopped during startup");
		await expect(bridge.start()).rejects.toThrow("Discord gateway has already been stopped");
		expect(client.listenerCount("messageCreate")).toBe(0);
		expect(client.listenerCount("interactionCreate")).toBe(0);
	});

	it("coalesces concurrent starts while login is in progress", async () => {
		const loginGate = deferred<string>();
		const client = new FakeDiscordClient(loginGate.promise);
		const bridge = createBridge(client);

		const first = bridge.start();
		const second = bridge.start();
		expect(second).toBe(first);
		await vi.waitFor(() => expect(client.loginTokens).toEqual(["secret-token"]));
		loginGate.resolve("token");

		await expect(Promise.all([first, second])).resolves.toEqual(["Prime Agent#0001", "Prime Agent#0001"]);
		await bridge.stop();
		expect(client.destroyCalls).toBe(1);
	});

	it("surfaces an invalidated Discord session after asynchronous shutdown", async () => {
		const destroyGate = deferred<void>();
		const client = new FakeDiscordClient(Promise.resolve("token"), destroyGate.promise);
		const bridge = createBridge(client);
		await bridge.start();

		let waitSettled = false;
		const stopped = bridge.waitUntilStopped().finally(() => {
			waitSettled = true;
		});
		client.emit("invalidated");
		await vi.waitFor(() => expect(client.destroyCalls).toBe(1));
		expect(waitSettled).toBe(false);

		destroyGate.resolve();
		await expect(stopped).rejects.toThrow("Discord gateway session was invalidated and cannot reconnect");
		expect(client.listenerCount("invalidated")).toBe(0);
	});

	it("stops for supervised recovery after sustained unhealthy Gateway heartbeat latency", async () => {
		const client = new FakeDiscordClient();
		const bridge = createBridge(client, {
			gatewayHealthCheckIntervalMs: 5,
			gatewayHealthFailureThreshold: 2,
			gatewayMaxPingMs: 50,
		});
		await bridge.start();

		client.ws.shards.get(0)!.ping = 51;
		await expect(bridge.waitUntilStopped()).rejects.toThrow(
			"Discord Gateway WebSocket remained unhealthy: heartbeat_latency",
		);
		expect(client.destroyCalls).toBe(1);
		expect(client.listenerCount("shardDisconnect")).toBe(0);
	});

	it("acknowledges a role-authorized DM command before mutual-guild lookup completes", async () => {
		const client = new FakeDiscordClient();
		const memberLookup = deferred<{ roles: { cache: Map<string, unknown> } }>();
		client.guilds.cache.set("guild-1", {
			members: {
				cache: new Map(),
				fetch: () => memberLookup.promise,
			},
		});
		const bridge = createBridge(client, { allowedUsers: [], allowedRoles: ["role-1"] });
		await bridge.start();
		const deferReply = vi.fn(async (_payload: unknown) => undefined);
		const editReply = vi.fn(async (_payload: unknown) => undefined);
		const interaction = {
			isChatInputCommand: () => true,
			channel: { isThread: () => false },
			channelId: "dm-1",
			guildId: null,
			member: null,
			user: { id: "user-1", bot: false },
			commandName: "help",
			inGuild: () => false,
			deferReply,
			editReply,
		};

		client.emit("interactionCreate", interaction);
		await vi.waitFor(() => expect(deferReply).toHaveBeenCalledWith({ ephemeral: true }));
		expect(editReply).not.toHaveBeenCalled();

		memberLookup.resolve({ roles: { cache: new Map([["role-1", {}]]) } });
		await vi.waitFor(() => expect(editReply).toHaveBeenCalledOnce());
		expect(editReply.mock.calls[0]?.[0]).toMatchObject({ content: expect.stringContaining("/new") });
		await bridge.stop();
	});

	it("creates an isolated Prime Agent thread with the /thread command", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-thread-session.jsonl")),
			[],
		);
		const threadSends: Array<{ content?: string }> = [];
		const thread = {
			id: "thread-1",
			isSendable: () => true,
			isThread: () => true,
			send: vi.fn(async (payload: { content?: string }) => {
				threadSends.push(payload);
				return { edit: vi.fn(), delete: vi.fn() };
			}),
		};
		const create = vi.fn(async () => thread);
		const channel = {
			id: "guild-channel-1",
			isTextBased: () => true,
			isDMBased: () => false,
			isThread: () => false,
			isThreadOnly: () => false,
			threads: { create },
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, {}, factory);
		const { interaction, deferReply, editReply } = createThreadInteraction(channel);
		await bridge.start();

		client.emit("interactionCreate", interaction);
		await vi.waitFor(() => expect(editReply).toHaveBeenCalledOnce());

		expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
		expect(create).toHaveBeenCalledWith({
			name: "Design review",
			autoArchiveDuration: 60,
			reason: "Prime Agent conversation requested with /thread",
		});
		expect(threadSends).toEqual([
			{
				content: "Started a new Prime Agent session. Send a message in this thread to begin.",
				allowedMentions: { parse: [], repliedUser: false },
			},
		]);
		expect(editReply.mock.calls[0]?.[0]).toEqual({
			content: "Created a new Prime Agent conversation in <#thread-1>.",
			allowedMentions: { parse: [], repliedUser: false },
		});
		await bridge.stop();
	});

	it("uploads workspace media requested by a final agent response", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "prime-discord-media-workspace-"));
		try {
			await writeFile(join(workspace, "chart.png"), "chart bytes");
			const client = new FakeDiscordClient();
			const connection = new FakeBridgeConnection(
				bridgeState(join(tmpdir(), "prime-discord-media-session.jsonl")),
				[],
			);
			connection.lastAssistantText = "Here is the chart.\nMEDIA:chart.png";
			const sends: Array<Record<string, unknown>> = [];
			const edits: Array<{ content?: string }> = [];
			const channel = {
				id: "dm-1",
				isThread: () => false,
				isSendable: () => true,
				sendTyping: vi.fn(async () => undefined),
				send: vi.fn(async (payload: Record<string, unknown>) => {
					sends.push(payload);
					return {
						edit: vi.fn(async (editPayload: { content?: string }) => edits.push(editPayload)),
						delete: vi.fn(),
					};
				}),
			};
			const message = {
				id: "message-1",
				content: "make a chart",
				webhookId: null,
				system: false,
				type: MessageType.Default,
				channel,
				channelId: "dm-1",
				guildId: null,
				member: null,
				author: { id: "user-1", bot: false, username: "user" },
				mentions: { users: { has: () => false, some: () => false } },
				attachments: { map: () => [] },
				inGuild: () => false,
			};
			const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
			const bridge = createBridge(client, { cwd: workspace, reactions: false, streamUpdateIntervalMs: 0 }, factory);
			await bridge.start();

			client.emit("messageCreate", message);
			await vi.waitFor(() => expect(sends).toHaveLength(2));

			expect(edits.at(-1)).toEqual({
				content: "Here is the chart.\n\nAttached 1 file.",
				allowedMentions: { parse: [], repliedUser: false },
			});
			expect(sends[0]).toMatchObject({ content: "Prime Agent is working…" });
			expect(sends[1]).toMatchObject({
				files: [{ attachment: Buffer.from("chart bytes"), name: "chart.png" }],
				allowedMentions: { parse: [], repliedUser: false },
			});
			await bridge.stop();
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("shows a sanitized generic update for an IPython step", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-progress-session.jsonl")),
			[],
		);
		connection.lastAssistantText = "Completed the requested work.";
		connection.toolEvents.push({
			type: "session_event",
			event: {
				type: "tool_execution_start",
				toolCallId: "ipython-1",
				toolName: "ipython",
				args: { code: "secret workspace command" },
			},
		});
		connection.toolEventDelayMs = 25;
		const edits: Array<{ content?: string }> = [];
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			sendTyping: vi.fn(async () => undefined),
			send: vi.fn(async () => ({ edit: vi.fn(async (payload: { content?: string }) => edits.push(payload)) })),
		};
		const message = {
			id: "message-1",
			content: "inspect the workspace",
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel,
			channelId: "dm-1",
			guildId: null,
			member: null,
			author: { id: "user-1", bot: false, username: "user" },
			mentions: { users: { has: () => false, some: () => false } },
			attachments: { map: () => [], first: () => undefined },
			inGuild: () => false,
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(
			client,
			{ reactions: false, streamUpdateIntervalMs: 0, progressUpdateIntervalMs: 5 },
			factory,
		);
		await bridge.start();

		client.emit("messageCreate", message);
		await vi.waitFor(() => expect(edits.at(-1)?.content).toBe("Completed the requested work."));

		expect(
			edits.some((edit) => edit.content?.includes("Inspecting the workspace and carrying out the next step.")),
		).toBe(true);
		expect(edits.some((edit) => edit.content?.includes("Still working"))).toBe(true);
		expect(edits.map((edit) => edit.content).join("\n")).not.toContain("secret workspace command");
		await bridge.stop();
	});

	it("serializes same-session messages while showing bridge-owned liveness", async () => {
		const client = new FakeDiscordClient();
		const firstTurn = deferred<void>();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-same-session-queue.jsonl")),
			[],
		);
		connection.promptGates.push(firstTurn.promise);
		connection.lastAssistantText = "Completed the queued work.";
		const responses: Array<{ edits: Array<{ content?: string }> }> = [];
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			sendTyping: vi.fn(async () => undefined),
			send: vi.fn(async () => {
				const response = { edits: [] as Array<{ content?: string }> };
				responses.push(response);
				return { edit: vi.fn(async (edit: { content?: string }) => response.edits.push(edit)) };
			}),
		};
		const message = (id: string, content: string) => ({
			id,
			content,
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel,
			channelId: "dm-1",
			guildId: null,
			member: null,
			author: { id: "user-1", bot: false, username: "user" },
			mentions: { users: { has: () => false, some: () => false } },
			attachments: { map: () => [], first: () => undefined },
			inGuild: () => false,
		});
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(
			client,
			{ reactions: false, streamUpdateIntervalMs: 0, progressUpdateIntervalMs: 5 },
			factory,
		);
		await bridge.start();

		client.emit("messageCreate", message("message-1", "first request"));
		await vi.waitFor(() => expect(connection.prompts).toHaveLength(1));
		await vi.waitFor(() =>
			expect(responses[0]?.edits.some((edit) => edit.content?.includes("Still working"))).toBe(true),
		);

		client.emit("messageCreate", message("message-2", "second request"));
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(connection.prompts).toHaveLength(1);
		expect(responses).toHaveLength(1);

		firstTurn.resolve();
		await vi.waitFor(() => expect(connection.prompts).toHaveLength(2));
		expect(connection.prompts[0]).toContain("first request");
		expect(connection.prompts[1]).toContain("second request");
		await vi.waitFor(() => expect(responses).toHaveLength(2));
		await vi.waitFor(() =>
			expect(responses.every((response) => response.edits.at(-1)?.content === "Completed the queued work.")).toBe(
				true,
			),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(responses.every((response) => response.edits.at(-1)?.content === "Completed the queued work.")).toBe(true);
		await bridge.stop();
	});

	it.each([
		"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		"Agent has queued work. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
	])("reports an unsubmitted shared-session busy request without exposing the scheduler error", async (busyPrompt) => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(bridgeState(join(tmpdir(), "prime-discord-busy-session.jsonl")), []);
		connection.rejectBusyPrompt = busyPrompt;
		const edits: Array<{ content?: string }> = [];
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			sendTyping: vi.fn(async () => undefined),
			send: vi.fn(async () => ({ edit: vi.fn(async (payload: { content?: string }) => edits.push(payload)) })),
		};
		const message = {
			id: "message-1",
			content: "continue after current work",
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel,
			channelId: "dm-1",
			guildId: null,
			member: null,
			author: { id: "user-1", bot: false, username: "user" },
			mentions: { users: { has: () => false, some: () => false } },
			attachments: { map: () => [], first: () => undefined },
			inGuild: () => false,
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, { reactions: false, streamUpdateIntervalMs: 0 }, factory);
		await bridge.start();

		client.emit("messageCreate", message);
		await vi.waitFor(() => expect(edits.at(-1)?.content).toContain("This message was not submitted"));

		expect(connection.promptOptions[0]?.streamingBehavior).toBeUndefined();
		expect(edits.map((edit) => edit.content).join("\n")).not.toContain("Specify streamingBehavior");
		await bridge.stop();
	});

	it("does not expose worker error details in a public terminal failure", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-private-failure.jsonl")),
			[],
		);
		connection.rejectBusyPrompt = "Authorization: Bearer private-worker-secret";
		const edits: Array<{ content?: string }> = [];
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			sendTyping: vi.fn(async () => undefined),
			send: vi.fn(async () => ({ edit: vi.fn(async (payload: { content?: string }) => edits.push(payload)) })),
		};
		const message = {
			id: "message-1",
			content: "inspect the workspace",
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel,
			channelId: "dm-1",
			guildId: null,
			member: null,
			author: { id: "user-1", bot: false, username: "user" },
			mentions: { users: { has: () => false, some: () => false } },
			attachments: { map: () => [], first: () => undefined },
			inGuild: () => false,
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, { reactions: false, streamUpdateIntervalMs: 0 }, factory);
		await bridge.start();

		client.emit("messageCreate", message);
		await vi.waitFor(() =>
			expect(edits.at(-1)?.content).toBe(
				"Prime Agent could not complete this request. Please try again or use /status.",
			),
		);
		expect(edits.map((edit) => edit.content).join("\n")).not.toContain("private-worker-secret");
		await bridge.stop();
	});

	it("submits discovered commands as raw Prime Agent slash invocations", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(bridgeState(join(tmpdir(), "prime-discord-resource-session.jsonl")), [
			resourceCommand("skill:websearch", "skill"),
		]);
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, {}, factory);
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			send: vi.fn(async () => ({ edit: vi.fn(), delete: vi.fn() })),
		};
		const { interaction, editReply } = createRunInteraction(channel, "skill:websearch current weather");
		await bridge.start();

		client.emit("interactionCreate", interaction);
		await vi.waitFor(() => expect(editReply).toHaveBeenCalledOnce());

		expect(connection.prompts).toEqual(["/skill:websearch current weather"]);
		expect(editReply.mock.calls[0]?.[0]).toEqual({
			content: "resource response",
			allowedMentions: { parse: [], repliedUser: false },
		});
		await bridge.stop();
	});

	it("keeps extension dialogs private to DMs and recovers a failed response submission", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-extension-session.jsonl")),
			[resourceCommand("choose", "extension")],
		);
		connection.extensionRequest = {
			type: "extension_ui_request",
			request: {
				id: "dialog-1",
				method: "confirm",
				payload: { title: "Continue", message: "Proceed?" },
			},
		};
		connection.responseFailures = 1;
		const sends: Array<{ content?: string }> = [];
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			isDMBased: () => true,
			send: vi.fn(async (payload: { content?: string }) => {
				sends.push(payload);
				return { edit: vi.fn(), delete: vi.fn() };
			}),
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, {}, factory);
		const { interaction, editReply } = createRunInteraction(channel, "choose");
		const responseMessage = (id: string, content: string) => ({
			id,
			content,
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel,
			channelId: "dm-1",
			guildId: null,
			member: null,
			author: { id: "user-1", bot: false },
			mentions: { users: { has: () => false, some: () => false } },
			inGuild: () => false,
		});
		await bridge.start();

		client.emit("interactionCreate", interaction);
		await vi.waitFor(() =>
			expect(sends.some((payload) => payload.content?.includes("!prime respond yes"))).toBe(true),
		);
		expect(editReply).not.toHaveBeenCalled();

		client.emit("messageCreate", responseMessage("unrelated", "yes"));
		await vi.waitFor(() =>
			expect(sends.some((payload) => payload.content?.includes("Use `!prime respond <value>`"))).toBe(true),
		);
		expect(connection.extensionResponses).toEqual([]);

		client.emit("messageCreate", responseMessage("first-response", "!prime respond yes"));
		await vi.waitFor(() => expect(sends.some((payload) => payload.content?.includes("Could not submit"))).toBe(true));
		expect(connection.extensionResponses).toEqual([]);
		expect(editReply).not.toHaveBeenCalled();

		client.emit("messageCreate", responseMessage("retry-response", "!prime respond yes"));
		await vi.waitFor(() => expect(connection.extensionResponses).toHaveLength(1));
		await vi.waitFor(() => expect(editReply).toHaveBeenCalledOnce());
		expect(connection.extensionResponses).toEqual([{ id: "dialog-1", response: { confirmed: true } }]);
		expect(editReply.mock.calls[0]?.[0]).toMatchObject({
			content: "Prime Agent extension command completed.",
		});
		await bridge.stop();
	});

	it("cancels guild extension dialogs without publishing their private payload", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-guild-extension-session.jsonl")),
			[resourceCommand("secret-input", "extension")],
		);
		connection.extensionRequest = {
			type: "extension_ui_request",
			request: {
				id: "guild-dialog-1",
				method: "input",
				payload: { title: "Private credential", placeholder: "sensitive-prefill" },
			},
		};
		const sends: Array<{ content?: string }> = [];
		const channel = {
			id: "guild-channel-1",
			isThread: () => false,
			isSendable: () => true,
			isDMBased: () => false,
			send: vi.fn(async (payload: { content?: string }) => {
				sends.push(payload);
				return { edit: vi.fn(), delete: vi.fn() };
			}),
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, {}, factory);
		const { interaction, editReply } = createRunInteraction(channel, "secret-input", "guild-1");
		await bridge.start();

		client.emit("interactionCreate", interaction);
		await vi.waitFor(() => expect(connection.extensionResponses).toHaveLength(1));
		await vi.waitFor(() => expect(editReply).toHaveBeenCalledOnce());

		expect(connection.extensionResponses).toEqual([{ id: "guild-dialog-1", response: { cancelled: true } }]);
		expect(sends.map((payload) => payload.content).join("\n")).toContain("Run this command in a bot DM");
		expect(sends.map((payload) => payload.content).join("\n")).not.toContain("Private credential");
		expect(sends.map((payload) => payload.content).join("\n")).not.toContain("sensitive-prefill");
		await bridge.stop();
	});

	it("reports a missing terminal report as a generic failed Discord result instead of '(No response)'", async () => {
		const client = new FakeDiscordClient();
		const connection = new FakeBridgeConnection(
			bridgeState(join(tmpdir(), "prime-discord-empty-terminal-session.jsonl")),
			[],
		);
		connection.lastAssistantText = "";
		const edits: Array<{ content?: string }> = [];
		const channel = {
			id: "dm-1",
			isThread: () => false,
			isSendable: () => true,
			sendTyping: vi.fn(async () => undefined),
			send: vi.fn(async () => ({ edit: vi.fn(async (payload: { content?: string }) => edits.push(payload)) })),
		};
		const message = {
			id: "message-1",
			content: "inspect the workspace",
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel,
			channelId: "dm-1",
			guildId: null,
			member: null,
			author: { id: "user-1", bot: false, username: "user" },
			mentions: { users: { has: () => false, some: () => false } },
			attachments: { map: () => [] },
			inGuild: () => false,
		};
		const factory: DiscordAgentConnectionFactory = async () => connection.asAgentConnection();
		const bridge = createBridge(client, { reactions: false, streamUpdateIntervalMs: 0 }, factory);
		await bridge.start();

		client.emit("messageCreate", message);
		await vi.waitFor(() =>
			expect(edits.at(-1)?.content).toBe(
				"Prime Agent could not complete this request. Please try again or use /status.",
			),
		);

		expect(connection.prompts[0]).toContain('<discord_task_envelope version="2">');
		expect(connection.prompts[0]).toContain("<completion_checkpoint");
		expect(edits.map((edit) => edit.content).join("\n")).not.toContain("(No response)");
		await bridge.stop();
	});

	it("does not process a parent message when daughter-thread creation fails", async () => {
		const client = new FakeDiscordClient();
		const parentSends: Array<Record<string, unknown>> = [];
		const parent = {
			id: "parent-1",
			isSendable: () => true,
			isThread: () => false,
			send: vi.fn(async (payload: Record<string, unknown>) => {
				parentSends.push(payload);
				return { edit: vi.fn() };
			}),
		};
		const startThread = vi.fn(async () => {
			throw new Error("Discord denied thread creation");
		});
		const message = {
			id: "message-1",
			content: "start a focused task",
			webhookId: null,
			system: false,
			type: MessageType.Default,
			channel: parent,
			channelId: "parent-1",
			guildId: "guild-1",
			member: null,
			author: { id: "user-1", bot: false, username: "user" },
			mentions: { users: { has: () => true, some: () => false } },
			attachments: { map: () => [], first: () => undefined },
			inGuild: () => true,
			startThread,
		};
		const bridge = createBridge(client, { reactions: false });
		await bridge.start();

		client.emit("messageCreate", message);
		await vi.waitFor(() => expect(startThread).toHaveBeenCalledOnce());

		expect(parentSends).toEqual([]);
		await bridge.stop();
	});
});
