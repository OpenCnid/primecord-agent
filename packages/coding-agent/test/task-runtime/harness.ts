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
	type TaskRuntimeArtifactManifestEntry,
	type TaskRuntimeCapabilityBinding,
	type TaskRuntimeExecutionResult,
	TaskRuntimeHost,
	type TaskRuntimeKernelBinding,
	type TaskRuntimePolicy,
	type TaskRuntimeRecord,
	type TaskRuntimeRouteBinding,
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

export class FakeTaskRuntimeKernelAdapter {
	readonly inputs: Array<{ taskId: string; sessionRef: string; artifactRef: string; routeId: string }> = [];

	bind = async (input: {
		task: { taskId: string; sessionRef: string; artifactRef: string };
		route: { routeId: string };
	}): Promise<{
		kernelId: string;
		capabilityId: string;
		permittedOperationClasses: readonly ["pure", "idempotent-external"];
	}> => {
		this.inputs.push({
			taskId: input.task.taskId,
			sessionRef: input.task.sessionRef,
			artifactRef: input.task.artifactRef,
			routeId: input.route.routeId,
		});
		return {
			kernelId: `kernel:${input.task.taskId}`,
			capabilityId: `capability:${input.task.taskId}`,
			permittedOperationClasses: ["pure", "idempotent-external"],
		};
	};
}

export class FakeTaskRuntimeProviderAdapter {
	readonly inputs: Array<{ taskId: string; operationId: string; idempotencyKey: string }> = [];

	invoke = async (input: {
		binding: TaskRuntimeKernelBinding;
		operation: { operationId: string; idempotencyKey: string };
	}) => {
		this.inputs.push({
			taskId: input.binding.taskId,
			operationId: input.operation.operationId,
			idempotencyKey: input.operation.idempotencyKey,
		});
		return { receiptRef: `provider-receipt:${input.operation.operationId}` };
	};

	get callCount(): number {
		return this.inputs.length;
	}
}

export class FakeTaskRuntimeEffectAdapter {
	readonly inputs: Array<{ taskId: string; operationId: string; providerReceiptRef: string }> = [];

	execute = async (input: {
		binding: TaskRuntimeKernelBinding;
		operation: { operationId: string };
		providerReceipt: { receiptRef: string };
	}) => {
		this.inputs.push({
			taskId: input.binding.taskId,
			operationId: input.operation.operationId,
			providerReceiptRef: input.providerReceipt.receiptRef,
		});
		return { receiptRef: `effect-receipt:${input.operation.operationId}` };
	};

	get callCount(): number {
		return this.inputs.length;
	}
}

export class FakeTaskRuntimeDeliveryAdapter {
	readonly inputs: Array<{ taskId: string; operationId: string; effectReceiptRef: string }> = [];

	deliver = async (input: {
		binding: TaskRuntimeKernelBinding;
		operation: { operationId: string };
		effectReceipt: { receiptRef: string };
	}) => {
		this.inputs.push({
			taskId: input.binding.taskId,
			operationId: input.operation.operationId,
			effectReceiptRef: input.effectReceipt.receiptRef,
		});
		return { receiptRef: `delivery-receipt:${input.operation.operationId}` };
	};

	get callCount(): number {
		return this.inputs.length;
	}
}

export interface TaskRuntimeHarness {
	clock: ControlledClock;
	transport: FakeNormalizedAdapter;
	kernel: FakeTaskRuntimeKernelAdapter;
	provider: FakeTaskRuntimeProviderAdapter;
	effect: FakeTaskRuntimeEffectAdapter;
	delivery: FakeTaskRuntimeDeliveryAdapter;
	startOperation(input: StartOperationInput): Promise<StartOperationResult>;
	startAndExecute(input: StartOperationInput): Promise<TaskRuntimeExecutionResult>;
	activeTurnExpectation(taskId: string): Promise<ActiveTurnExpectation>;
	snapshot(): Promise<TaskRuntimeSnapshot>;
	records(): Promise<readonly TaskRuntimeRecord[]>;
	kernelBindings(): readonly TaskRuntimeKernelBinding[];
	capabilityBindings(): readonly TaskRuntimeCapabilityBinding[];
	artifactManifest(): readonly TaskRuntimeArtifactManifestEntry[];
	routeBindings(): readonly TaskRuntimeRouteBinding[];
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
	const kernel = new FakeTaskRuntimeKernelAdapter();
	const provider = new FakeTaskRuntimeProviderAdapter();
	const effect = new FakeTaskRuntimeEffectAdapter();
	const delivery = new FakeTaskRuntimeDeliveryAdapter();
	const host = new TaskRuntimeHost({
		runtime,
		adapters: { kernel, provider, effect, delivery },
		bindingIdGenerator: ids.next.bind(ids, "record"),
	});
	const transport = new FakeNormalizedAdapter(() => runtime);

	return {
		clock,
		transport,
		kernel,
		provider,
		effect,
		delivery,
		startOperation(input) {
			return runtime.startOperation(input);
		},
		startAndExecute(input) {
			return host.startAndExecute(input);
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
		kernelBindings() {
			return host.kernelBindings();
		},
		capabilityBindings() {
			return host.capabilityBindings();
		},
		artifactManifest() {
			return host.artifactManifest();
		},
		routeBindings() {
			return host.routeBindings();
		},
		cleanup() {
			return rm(tempDir, { recursive: true, force: true });
		},
	};
}
