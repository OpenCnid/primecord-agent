import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type DiscordAgentConnectionFactory, DiscordAgentRegistry } from "../../src/gateway/discord/agent-registry.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
	AgentConnectionState,
} from "../../src/modes/agent-connection/types.js";

type RegistryConnection = Pick<
	AgentConnection,
	"subscribe" | "getState" | "newSession" | "abortAndClearQueue" | "dispose"
>;

class FakeAgentConnection implements RegistryConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();
	private nextSessionState: AgentConnectionState | undefined;
	disposeCalls = 0;
	disposeGate: Promise<void> = Promise.resolve();
	unsubscribeCalls = 0;
	newSessionCalls = 0;

	constructor(private state: AgentConnectionState) {}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			if (this.listeners.delete(listener)) this.unsubscribeCalls++;
		};
	}

	async getState(): Promise<AgentConnectionState> {
		return this.state;
	}

	setNextSessionState(state: AgentConnectionState): void {
		this.nextSessionState = state;
	}

	async newSession(): Promise<{ cancelled: boolean }> {
		this.newSessionCalls++;
		if (this.nextSessionState) this.state = this.nextSessionState;
		return { cancelled: false };
	}

	async abortAndClearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return { steering: [], followUp: [] };
	}

	async dispose(): Promise<void> {
		this.disposeCalls++;
		await this.disposeGate;
	}

	async emit(event: AgentConnectionEvent): Promise<void> {
		await Promise.all([...this.listeners].map((listener) => listener(event)));
	}

	asAgentConnection(): AgentConnection {
		return this as unknown as AgentConnection;
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createState(activeSessionId: string, sessionFile: string): AgentConnectionState {
	return {
		activeSessionId,
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
		sessionId: activeSessionId,
		sessionDir: "/sessions",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: {
			active: false,
			status: "idle",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		},
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
	};
}

function createRegistry(root: string, connectionFactory: DiscordAgentConnectionFactory): DiscordAgentRegistry {
	return new DiscordAgentRegistry({
		cwd: root,
		agentDir: join(root, "agent"),
		sessionRoot: join(root, "sessions"),
		socketPath: join(root, "daemon.sock"),
		statePath: join(root, "discord-sessions.json"),
		connectionFactory,
	});
}

async function withTemporaryDirectory(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "prime-discord-registry-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("DiscordAgentRegistry", () => {
	it("uses a single in-flight connection creation for concurrent requests", async () => {
		await withTemporaryDirectory(async (root) => {
			const connection = new FakeAgentConnection(createState("active-1", join(root, "session-1.jsonl")));
			const creation = deferred<AgentConnection>();
			let factoryCalls = 0;
			const registry = createRegistry(root, async () => {
				factoryCalls++;
				return creation.promise;
			});

			const first = registry.getOrCreate("shared-key");
			const second = registry.getOrCreate("shared-key");
			await vi.waitFor(() => expect(factoryCalls).toBe(1));
			creation.resolve(connection.asAgentConnection());

			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(firstResult).toBe(connection);
			expect(secondResult).toBe(connection);
			expect(registry.getExisting("shared-key")).toBe(connection);
			await registry.dispose();
		});
	});

	it("creates independent connections and session directories for different keys", async () => {
		await withTemporaryDirectory(async (root) => {
			const connections = new Map<string, FakeAgentConnection>();
			const sessionDirectories = new Map<string, string>();
			const registry = createRegistry(root, async (request) => {
				const connection = new FakeAgentConnection(
					createState(`active-${request.key}`, join(root, `${request.key}.jsonl`)),
				);
				connections.set(request.key, connection);
				sessionDirectories.set(request.key, request.sessionDir);
				return connection.asAgentConnection();
			});

			const [alpha, beta] = await Promise.all([registry.getOrCreate("alpha"), registry.getOrCreate("beta")]);

			expect(alpha).toBe(connections.get("alpha"));
			expect(beta).toBe(connections.get("beta"));
			expect(alpha).not.toBe(beta);
			expect(sessionDirectories.get("alpha")).not.toBe(sessionDirectories.get("beta"));
			await registry.dispose();
		});
	});

	it("evicts a terminally closed connection so the next Discord message can reattach", async () => {
		await withTemporaryDirectory(async (root) => {
			const first = new FakeAgentConnection(createState("active-1", join(root, "session-1.jsonl")));
			const second = new FakeAgentConnection(createState("active-2", join(root, "session-2.jsonl")));
			const connections = [first, second];
			let factoryCalls = 0;
			const registry = createRegistry(root, async () => {
				const connection = connections[factoryCalls++];
				if (!connection) throw new Error("Unexpected connection request");
				return connection.asAgentConnection();
			});

			await registry.getOrCreate("thread-key");
			await first.emit({ type: "closed", error: "Daemon reconnection failed" });

			expect(first.disposeCalls).toBe(1);
			expect(registry.getExisting("thread-key")).toBeUndefined();
			await expect(registry.getOrCreate("thread-key")).resolves.toBe(second);
			expect(factoryCalls).toBe(2);
			await registry.dispose();
		});
	});

	it("loads persisted mappings and refreshes them after a new session", async () => {
		await withTemporaryDirectory(async (root) => {
			const statePath = join(root, "discord-sessions.json");
			await writeFile(
				statePath,
				`${JSON.stringify({
					version: 1,
					sessions: { alpha: { activeSessionId: "active-old", sessionFile: "/sessions/old.jsonl" } },
				})}\n`,
				"utf8",
			);
			const connection = new FakeAgentConnection(createState("active-current", "/sessions/current.jsonl"));
			let receivedMapping: { activeSessionId?: string; sessionFile?: string } | undefined;
			const registry = createRegistry(root, async (request) => {
				receivedMapping = request.mapping;
				return connection.asAgentConnection();
			});

			await registry.getOrCreate("alpha");
			expect(receivedMapping).toEqual({ activeSessionId: "active-old", sessionFile: "/sessions/old.jsonl" });
			const initialPersisted: unknown = JSON.parse(await readFile(statePath, "utf8"));
			expect(initialPersisted).toEqual({
				version: 1,
				sessions: { alpha: { activeSessionId: "active-current", sessionFile: "/sessions/current.jsonl" } },
			});

			connection.setNextSessionState(createState("active-new", "/sessions/new.jsonl"));
			await expect(registry.newSession("alpha")).resolves.toEqual({ cancelled: false });
			expect(connection.newSessionCalls).toBe(1);
			const refreshedPersisted: unknown = JSON.parse(await readFile(statePath, "utf8"));
			expect(refreshedPersisted).toEqual({
				version: 1,
				sessions: { alpha: { activeSessionId: "active-new", sessionFile: "/sessions/new.jsonl" } },
			});
			await registry.dispose();
		});
	});

	it("shares concurrent disposal and disposes connections and subscriptions only once", async () => {
		await withTemporaryDirectory(async (root) => {
			const connection = new FakeAgentConnection(createState("active-1", join(root, "session-1.jsonl")));
			const registry = createRegistry(root, async () => connection.asAgentConnection());
			await registry.getOrCreate("alpha");
			const disposal = deferred<void>();
			connection.disposeGate = disposal.promise;

			const first = registry.dispose();
			const second = registry.dispose();
			expect(second).toBe(first);
			await vi.waitFor(() => expect(connection.disposeCalls).toBe(1));
			disposal.resolve();
			await Promise.all([first, second]);

			expect(connection.unsubscribeCalls).toBe(1);
			expect(connection.disposeCalls).toBe(1);
			await expect(registry.getOrCreate("alpha")).rejects.toThrow("registry is shutting down");
		});
	});

	it("recovers persistence after an earlier state write fails", async () => {
		await withTemporaryDirectory(async (root) => {
			const statePath = join(root, "discord-sessions.json");
			await writeFile(statePath, `${JSON.stringify({ version: 1, sessions: {} })}\n`, "utf8");
			const connection = new FakeAgentConnection(createState("active-1", join(root, "session-1.jsonl")));
			const registry = createRegistry(root, async () => {
				await rm(statePath, { force: true });
				await mkdir(statePath);
				return connection.asAgentConnection();
			});

			await expect(registry.getOrCreate("alpha")).rejects.toThrow();
			await rm(statePath, { recursive: true, force: true });
			connection.setNextSessionState(createState("active-2", join(root, "session-2.jsonl")));
			await expect(registry.newSession("alpha")).resolves.toEqual({ cancelled: false });

			const persisted: unknown = JSON.parse(await readFile(statePath, "utf8"));
			expect(persisted).toEqual({
				version: 1,
				sessions: {
					alpha: { activeSessionId: "active-2", sessionFile: join(root, "session-2.jsonl") },
				},
			});
			await registry.dispose();
		});
	});
});
