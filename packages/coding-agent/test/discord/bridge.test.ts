import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordBridge } from "../../src/gateway/discord/bridge.js";
import type { DiscordBridgeConfig } from "../../src/gateway/discord/config.js";

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
		maxAttachmentBytes: 32 * 1024 * 1024,
		maxAttachments: 5,
		attachmentTimeoutMs: 30_000,
		streamUpdateIntervalMs: 1_000,
		registerCommands: false,
		toolProgress: true,
		cwd: stateRoot,
		sessionDir: join(stateRoot, "sessions"),
		cacheDir: join(stateRoot, "cache"),
		...overrides,
	};
}

function createBridge(client: FakeDiscordClient, overrides: Partial<DiscordBridgeConfig> = {}): DiscordBridge {
	return new DiscordBridge(config(overrides), {
		agentDir: join(tmpdir(), "prime-discord-bridge-agent"),
		socketPath: join(tmpdir(), "prime-discord-bridge-daemon.sock"),
		client: client.asClient(),
		logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	});
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
});
