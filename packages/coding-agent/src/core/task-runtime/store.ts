import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DurableTaskRuntimeState, TaskRuntimeSnapshot } from "./types.js";

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
		let state = createEmptyTaskRuntimeState();
		try {
			const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
			if (!isDurableTaskRuntimeState(parsed)) {
				throw new Error(`Invalid task runtime store: ${statePath}`);
			}
			state = parsed;
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
		}
		return new FileTaskRuntimeStore(statePath, state);
	}

	transaction<T>(mutate: (state: DurableTaskRuntimeState) => Promise<T> | T): Promise<T> {
		const operation = this.writeTail.then(async () => {
			const nextState = structuredClone(this.state);
			const result = await mutate(nextState);
			await this.write(nextState);
			this.state = nextState;
			return result;
		});
		this.writeTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	async snapshot(): Promise<TaskRuntimeSnapshot> {
		await this.writeTail;
		return structuredClone(this.state);
	}

	private async write(state: DurableTaskRuntimeState): Promise<void> {
		await mkdir(dirname(this.statePath), { recursive: true });
		const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, this.statePath);
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
