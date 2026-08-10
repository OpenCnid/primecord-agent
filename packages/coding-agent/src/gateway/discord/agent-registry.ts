import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	ensureInteractiveDaemonRunning,
	isDaemonSessionSummary,
	listActiveDaemonSessionSummaries,
} from "../../cli/daemon-launch.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import { DaemonAgentConnection } from "../../modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnection, AgentConnectionEvent } from "../../modes/agent-connection/types.js";
import { DaemonClient } from "../../modes/daemon/daemon-client.js";
import { collectDaemonClientEnv } from "../../modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../modes/daemon/daemon-session-list.js";

interface PersistedSessionMapping {
	activeSessionId?: string;
	sessionFile?: string;
}

interface PersistedRegistryState {
	version: 1;
	sessions: Record<string, PersistedSessionMapping>;
}

export interface DiscordAgentRegistryOptions {
	cwd: string;
	agentDir: string;
	sessionRoot: string;
	socketPath: string;
	runtimeConfig?: AgentSessionRuntimeConfig;
	statePath?: string;
	connectionFactory?: DiscordAgentConnectionFactory;
}

export interface DiscordAgentConnectionRequest {
	key: string;
	sessionDir: string;
	mapping?: PersistedSessionMapping;
}

export type DiscordAgentConnectionFactory = (request: DiscordAgentConnectionRequest) => Promise<AgentConnection>;

const EMPTY_STATE: PersistedRegistryState = { version: 1, sessions: {} };

export class DiscordAgentRegistry {
	private readonly connections = new Map<string, AgentConnection>();
	private readonly pendingConnections = new Map<string, Promise<AgentConnection>>();
	private readonly unsubscribes = new Map<string, () => void>();
	private readonly statePath: string;
	private readonly statePromise: Promise<PersistedRegistryState>;
	private readonly connectionFactory: DiscordAgentConnectionFactory;
	private writeTail: Promise<void> = Promise.resolve();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(private readonly options: DiscordAgentRegistryOptions) {
		this.statePath = options.statePath ?? join(options.sessionRoot, "discord-sessions.json");
		this.statePromise = this.readState();
		this.connectionFactory = options.connectionFactory ?? ((request) => this.createDaemonConnection(request));
	}

	async getOrCreate(key: string): Promise<AgentConnection> {
		if (this.disposed) {
			throw new Error("Discord agent registry is shutting down");
		}
		const existing = this.connections.get(key);
		if (existing) return existing;
		const pending = this.pendingConnections.get(key);
		if (pending) return pending;

		const creation = this.createConnection(key);
		this.pendingConnections.set(key, creation);
		try {
			return await creation;
		} finally {
			if (this.pendingConnections.get(key) === creation) {
				this.pendingConnections.delete(key);
			}
		}
	}

	getExisting(key: string): AgentConnection | undefined {
		return this.connections.get(key);
	}

	async abortAll(): Promise<void> {
		await Promise.allSettled([...this.connections.values()].map((connection) => connection.abortAndClearQueue()));
	}

	async newSession(key: string): Promise<{ cancelled: boolean }> {
		const connection = await this.getOrCreate(key);
		const result = await connection.newSession();
		if (!result.cancelled) {
			await this.refreshMapping(key, connection);
		}
		return result;
	}

	dispose(): Promise<void> {
		this.disposePromise ??= this.disposeInternal();
		return this.disposePromise;
	}

	private async disposeInternal(): Promise<void> {
		this.disposed = true;
		await Promise.allSettled(this.pendingConnections.values());
		for (const unsubscribe of this.unsubscribes.values()) unsubscribe();
		this.unsubscribes.clear();
		await Promise.allSettled([...this.connections.values()].map((connection) => connection.dispose()));
		this.connections.clear();
		await this.writeTail;
	}

	private async createConnection(key: string): Promise<AgentConnection> {
		const state = await this.statePromise;
		const sessionDir = join(this.options.sessionRoot, hashSessionKey(key));
		const connection = await this.connectionFactory({ key, sessionDir, mapping: state.sessions[key] });
		if (this.disposed) {
			await connection.dispose();
			throw new Error("Discord agent registry shut down while creating a session");
		}
		this.connections.set(key, connection);
		this.unsubscribes.set(
			key,
			connection.subscribe((event) => this.onConnectionEvent(key, connection, event)),
		);
		await this.refreshMapping(key, connection);
		return connection;
	}

	private async onConnectionEvent(
		key: string,
		connection: AgentConnection,
		event: AgentConnectionEvent,
	): Promise<void> {
		if (event.type === "session_replaced" || event.type === "session_resynced") {
			await this.refreshMapping(key, connection);
		}
	}

	private async refreshMapping(key: string, connection: AgentConnection): Promise<void> {
		const connectionState = await connection.getState();
		const state = await this.statePromise;
		state.sessions[key] = {
			activeSessionId: connectionState.activeSessionId,
			sessionFile: connectionState.sessionFile,
		};
		this.queueStateWrite(state);
		await this.writeTail;
	}

	private async readState(): Promise<PersistedRegistryState> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
			if (!isPersistedRegistryState(parsed)) {
				throw new Error(`Invalid Discord session registry: ${this.statePath}`);
			}
			return parsed;
		} catch (error) {
			if (isMissingFileError(error)) return { ...EMPTY_STATE, sessions: {} };
			throw error;
		}
	}

	private queueStateWrite(state: PersistedRegistryState): void {
		const snapshot = JSON.stringify(state, null, 2);
		this.writeTail = this.writeTail
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.statePath), { recursive: true });
				const temporaryPath = `${this.statePath}.${process.pid}.tmp`;
				await writeFile(temporaryPath, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
				await rename(temporaryPath, this.statePath);
			});
	}

	private async createDaemonConnection(request: DiscordAgentConnectionRequest): Promise<AgentConnection> {
		await ensureInteractiveDaemonRunning(this.options.socketPath, this.options.cwd);

		const mappedConnection = await this.tryMappedConnection(request.mapping);
		if (mappedConnection) return mappedConnection;

		const activeConnection = await this.tryActiveSessionFileConnection(request.mapping?.sessionFile);
		if (activeConnection) return activeConnection;

		const client = await this.connectClient();
		try {
			const sessionPath = await existingFile(request.mapping?.sessionFile);
			const response = await client.request({
				type: "create",
				config: {
					...(this.options.runtimeConfig ?? {}),
					cwd: this.options.cwd,
					agentDir: this.options.agentDir,
					sessionDir: request.sessionDir,
				},
				sessionPath,
				continueRecent: sessionPath === undefined,
				env: collectDaemonClientEnv(),
				lifecycle: "resident",
			});
			if (!response.success) throw new Error(response.error);
			if (!isDaemonSessionSummary(response.data)) {
				throw new Error("Daemon returned an invalid create response");
			}
			return await this.attach(client, response.data);
		} catch (error) {
			client.close();
			throw error;
		}
	}

	private async tryMappedConnection(
		mapping: PersistedSessionMapping | undefined,
	): Promise<AgentConnection | undefined> {
		if (!mapping?.activeSessionId) return undefined;
		const client = await this.connectClient();
		try {
			const response = await client.request({ type: "get_state", activeSessionId: mapping.activeSessionId });
			if (!response.success || !isDaemonSessionSummary(response.data)) {
				client.close();
				return undefined;
			}
			return await this.attach(client, response.data);
		} catch {
			client.close();
			return undefined;
		}
	}

	private async tryActiveSessionFileConnection(sessionFile: string | undefined): Promise<AgentConnection | undefined> {
		if (!(await existingFile(sessionFile))) return undefined;
		const client = await this.connectClient();
		try {
			const summaries = await listActiveDaemonSessionSummaries(client);
			const wanted = canonicalPath(sessionFile!);
			const summary = summaries.find(
				(candidate) => candidate.sessionFile !== undefined && canonicalPath(candidate.sessionFile) === wanted,
			);
			if (!summary) {
				client.close();
				return undefined;
			}
			return await this.attach(client, summary);
		} catch {
			client.close();
			return undefined;
		}
	}

	private async connectClient(): Promise<DaemonClient> {
		const client = new DaemonClient(this.options.socketPath);
		await client.connect();
		return client;
	}

	private attach(client: DaemonClient, summary: SessionSummary): Promise<DaemonAgentConnection> {
		const activeSessionId = summary.activeSessionId ?? summary.id;
		return DaemonAgentConnection.attach(client, activeSessionId, {
			closeClientOnDispose: true,
			sendClientEnv: false,
			supportsExtensionUi: false,
			recoverDaemon: () => ensureInteractiveDaemonRunning(this.options.socketPath, this.options.cwd),
		});
	}
}

export function hashSessionKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

function canonicalPath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function existingFile(path: string | undefined): Promise<string | undefined> {
	if (!path) return undefined;
	try {
		return (await stat(path)).isFile() ? path : undefined;
	} catch {
		return undefined;
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPersistedRegistryState(value: unknown): value is PersistedRegistryState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { version?: unknown; sessions?: unknown };
	if (candidate.version !== 1 || !candidate.sessions || typeof candidate.sessions !== "object") return false;
	return Object.values(candidate.sessions).every((mapping) => {
		if (!mapping || typeof mapping !== "object") return false;
		const entry = mapping as { activeSessionId?: unknown; sessionFile?: unknown };
		return (
			(entry.activeSessionId === undefined || typeof entry.activeSessionId === "string") &&
			(entry.sessionFile === undefined || typeof entry.sessionFile === "string")
		);
	});
}
