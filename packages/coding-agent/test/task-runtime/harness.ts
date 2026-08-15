import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ActiveTurnExpectation,
	type AdmissionResult,
	FileTaskRuntimeStore,
	type NormalizedInboundEvent,
	type StartOperationInput,
	type StartOperationResult,
	TaskRuntime,
	type TaskRuntimePolicy,
	type TaskRuntimeRecord,
	type TaskRuntimeSnapshot,
} from "../../src/core/task-runtime/index.js";

export class ControlledClock {
	constructor(private current: number) {}

	now = (): number => this.current;

	advance(milliseconds: number): void {
		this.current += milliseconds;
	}
}

class DeterministicIds {
	private sequence = 0;

	next = (kind: "decision" | "operation" | "record" | "route" | "task"): string => {
		this.sequence++;
		return `${kind}-${this.sequence}`;
	};
}

export class FakeNormalizedAdapter {
	readonly acknowledgements: string[] = [];
	readonly deliveredEvents: NormalizedInboundEvent[] = [];

	constructor(private readonly runtime: () => TaskRuntime) {}

	async deliver(event: NormalizedInboundEvent, expectation?: ActiveTurnExpectation): Promise<AdmissionResult> {
		this.deliveredEvents.push(structuredClone(event));
		const result = await this.runtime().admit(event, expectation);
		this.acknowledgements.push(event.inboundEventId);
		return result;
	}
}

export interface TaskRuntimeHarness {
	clock: ControlledClock;
	transport: FakeNormalizedAdapter;
	startOperation(input: StartOperationInput): Promise<StartOperationResult>;
	activeTurnExpectation(taskId: string): Promise<ActiveTurnExpectation>;
	snapshot(): Promise<TaskRuntimeSnapshot>;
	records(): Promise<readonly TaskRuntimeRecord[]>;
	cleanup(): Promise<void>;
}

export interface CreateTaskRuntimeHarnessOptions {
	authorizedActors?: readonly string[];
	initialTime?: number;
	policy?: Partial<Omit<TaskRuntimePolicy, "isAdmissionAuthorized">>;
}

export async function createTaskRuntimeHarness(
	options: CreateTaskRuntimeHarnessOptions = {},
): Promise<TaskRuntimeHarness> {
	const tempDir = await mkdtemp(join(tmpdir(), "prime-task-runtime-"));
	const statePath = join(tempDir, "task-runtime.json");
	const authorizedActors = new Set(options.authorizedActors ?? ["principal"]);
	const clock = new ControlledClock(options.initialTime ?? 1_700_000_000_000);
	const ids = new DeterministicIds();
	const runtime = new TaskRuntime({
		store: await FileTaskRuntimeStore.open(statePath),
		clock,
		idGenerator: ids.next,
		workerId: "worker-1",
		policy: {
			...options.policy,
			isAdmissionAuthorized: (event) => authorizedActors.has(event.actorRef),
		},
	});
	const transport = new FakeNormalizedAdapter(() => runtime);

	return {
		clock,
		transport,
		startOperation(input) {
			return runtime.startOperation(input);
		},
		activeTurnExpectation(taskId) {
			return runtime.activeTurnExpectation(taskId);
		},
		snapshot() {
			return runtime.snapshot();
		},
		async records() {
			return (await runtime.snapshot()).records;
		},
		cleanup() {
			return rm(tempDir, { recursive: true, force: true });
		},
	};
}
