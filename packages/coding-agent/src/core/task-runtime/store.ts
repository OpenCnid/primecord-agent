import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { DurableTaskRuntimeState, TaskRuntimeSnapshot } from "./types.js";

const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_UPDATE_MS = 10_000;
const STORE_LOCK_RETRIES = 500;
const STORE_LOCK_RETRY_MS = 10;

export interface TaskRuntimeStore {
	transaction<T>(mutate: (state: DurableTaskRuntimeState) => Promise<T> | T): Promise<T>;
	snapshot(): Promise<TaskRuntimeSnapshot>;
}

export function createEmptyTaskRuntimeState(): DurableTaskRuntimeState {
	return {
		version: 1,
		inbox: {},
		tasks: {},
		leases: {},
		routes: {},
		operations: {},
		records: [],
	};
}

export class FileTaskRuntimeStore implements TaskRuntimeStore {
	private writeTail: Promise<void> = Promise.resolve();

	private constructor(
		private readonly statePath: string,
		private state: DurableTaskRuntimeState,
	) {}

	static async open(statePath: string): Promise<FileTaskRuntimeStore> {
		const store = new FileTaskRuntimeStore(statePath, createEmptyTaskRuntimeState());
		store.state = await store.readState();
		return store;
	}

	transaction<T>(mutate: (state: DurableTaskRuntimeState) => Promise<T> | T): Promise<T> {
		const operation = this.writeTail.then(() =>
			this.withLock(async () => {
				const nextState = structuredClone(await this.readState());
				const result = await mutate(nextState);
				await this.write(nextState);
				this.state = nextState;
				return result;
			}),
		);
		this.writeTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async snapshot(): Promise<TaskRuntimeSnapshot> {
		await this.writeTail;
		return this.withLock(async () => {
			this.state = await this.readState();
			return structuredClone(this.state);
		});
	}

	private async withLock<T>(action: () => Promise<T>): Promise<T> {
		const parentDirectory = dirname(this.statePath);
		await mkdir(parentDirectory, { recursive: true });
		let compromised: Error | undefined;
		const release = await lockfile.lock(this.statePath, {
			realpath: false,
			lockfilePath: `${this.statePath}.lock`,
			stale: STORE_LOCK_STALE_MS,
			update: STORE_LOCK_UPDATE_MS,
			retries: {
				retries: STORE_LOCK_RETRIES,
				factor: 1,
				minTimeout: STORE_LOCK_RETRY_MS,
				maxTimeout: STORE_LOCK_RETRY_MS,
			},
			onCompromised: (error) => {
				compromised = error;
			},
		});
		try {
			if (compromised) throw compromised;
			const result = await action();
			if (compromised) throw compromised;
			return result;
		} finally {
			try {
				await release();
			} catch {
				// A compromised lock has already failed the caller's transaction.
			}
		}
	}

	private async readState(): Promise<DurableTaskRuntimeState> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
			if (!isDurableTaskRuntimeState(parsed)) {
				throw new Error(`Invalid task runtime store: ${this.statePath}`);
			}
			return parsed;
		} catch (error) {
			if (isMissingFileError(error)) return createEmptyTaskRuntimeState();
			throw error;
		}
	}

	private async write(state: DurableTaskRuntimeState): Promise<void> {
		const parentDirectory = dirname(this.statePath);
		const temporaryPath = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let committed = false;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporaryPath, this.statePath);
			await syncDirectory(parentDirectory);
			committed = true;
		} finally {
			await handle?.close().catch(() => undefined);
			if (!committed) await rm(temporaryPath, { force: true });
		}
	}
}

async function syncDirectory(path: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isMissingFileError(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDurableTaskRuntimeState(value: unknown): value is DurableTaskRuntimeState {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) return false;
	return ["inbox", "tasks", "leases", "routes", "operations"].every((key) => isRecord(value[key]));
}
