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

export type FaultBarrierAction = "release" | "throw" | "killProcess";

export class SimulatedTaskRuntimeProcessKill extends Error {
	constructor() {
		super("Simulated task runtime process kill");
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: resolvePromise, reject: rejectPromise };
}

interface ArmedBarrier {
	reached: Deferred<void>;
	gate: Deferred<void>;
}

class FaultBarriers {
	private readonly barriers = new Map<string, ArmedBarrier>();

	arm(name: string): void {
		if (this.barriers.has(name)) throw new Error(`Fault barrier is already armed: ${name}`);
		this.barriers.set(name, { reached: deferred<void>(), gate: deferred<void>() });
	}

	waitUntilReached(name: string): Promise<void> {
		const barrier = this.barriers.get(name);
		if (!barrier) throw new Error(`Fault barrier is not armed: ${name}`);
		return barrier.reached.promise;
	}

	acknowledge(name: string, action: FaultBarrierAction): void {
		const barrier = this.barriers.get(name);
		if (!barrier) throw new Error(`Fault barrier is not armed: ${name}`);
		this.barriers.delete(name);
		if (action === "release") {
			barrier.gate.resolve();
			return;
		}
		barrier.gate.reject(
			action === "killProcess" ? new SimulatedTaskRuntimeProcessKill() : new Error(`Fault barrier threw: ${name}`),
		);
	}

	async hit(name: string): Promise<void> {
		const barrier = this.barriers.get(name);
		if (!barrier) return;
		barrier.reached.resolve();
		await barrier.gate.promise;
	}
}

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

class FakeNormalizedAdapter {
	readonly acknowledgements: string[] = [];
	readonly deliveredEvents: NormalizedInboundEvent[] = [];

	constructor(
		private readonly runtime: () => TaskRuntime,
		private readonly barriers: FaultBarriers,
	) {}

	async deliver(event: NormalizedInboundEvent, expectation?: ActiveTurnExpectation): Promise<AdmissionResult> {
		this.deliveredEvents.push(structuredClone(event));
		const result = await this.runtime().admit(event, expectation);
		if (result.kind === "AdmissionCommitted") {
			await this.barriers.hit("after_AdmissionCommitted_before_ack");
		}
		this.acknowledgements.push(event.inboundEventId);
		return result;
	}
}

export interface TaskRuntimeHarness {
	clock: ControlledClock;
	transport: FakeNormalizedAdapter;
	provider: { callCount: number };
	effect: { callCount: number };
	delivery: { callCount: number };
	arm(name: string): void;
	waitUntilReached(name: string): Promise<void>;
	acknowledge(name: string, action: FaultBarrierAction): void;
	startOperation(input: StartOperationInput): Promise<StartOperationResult>;
	activeTurnExpectation(taskId: string): Promise<ActiveTurnExpectation>;
	restart(): Promise<void>;
	snapshot(): Promise<TaskRuntimeSnapshot>;
	records(): Promise<readonly TaskRuntimeRecord[]>;
	kernelBindings(): readonly [];
	routeBindings(): Promise<TaskRuntimeSnapshot["routes"]>;
	capabilityBindings(): readonly [];
	artifactManifest(): Promise<readonly { taskId: string; artifactRef: string }[]>;
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
	const barriers = new FaultBarriers();
	let workerSequence = 0;
	let runtime = await createRuntime();
	const transport = new FakeNormalizedAdapter(() => runtime, barriers);

	async function createRuntime(): Promise<TaskRuntime> {
		workerSequence++;
		return new TaskRuntime({
			store: await FileTaskRuntimeStore.open(statePath),
			clock,
			idGenerator: ids.next,
			workerId: `worker-${workerSequence}`,
			policy: {
				...options.policy,
				isAdmissionAuthorized: (event) => authorizedActors.has(event.actorRef),
			},
		});
	}

	return {
		clock,
		transport,
		provider: { callCount: 0 },
		effect: { callCount: 0 },
		delivery: { callCount: 0 },
		arm(name) {
			barriers.arm(name);
		},
		waitUntilReached(name) {
			return barriers.waitUntilReached(name);
		},
		acknowledge(name, action) {
			barriers.acknowledge(name, action);
		},
		startOperation(input) {
			return runtime.startOperation(input);
		},
		activeTurnExpectation(taskId) {
			return runtime.activeTurnExpectation(taskId);
		},
		async restart() {
			const beforeRestart = await runtime.snapshot();
			runtime = await createRuntime();
			for (const lease of Object.values(beforeRestart.leases)) {
				await runtime.takeOverLease(lease.taskId, lease.fenceEpoch);
			}
		},
		snapshot() {
			return runtime.snapshot();
		},
		async records() {
			return (await runtime.snapshot()).records;
		},
		kernelBindings() {
			return [];
		},
		async routeBindings() {
			return (await runtime.snapshot()).routes;
		},
		capabilityBindings() {
			return [];
		},
		async artifactManifest() {
			return Object.values((await runtime.snapshot()).tasks).map((task) => ({
				taskId: task.taskId,
				artifactRef: task.artifactRef,
			}));
		},
		cleanup() {
			return rm(tempDir, { recursive: true, force: true });
		},
	};
}
