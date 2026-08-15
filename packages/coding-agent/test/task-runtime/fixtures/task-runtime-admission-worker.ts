import {
	FileTaskRuntimeStore,
	type NormalizedInboundEvent,
	TaskRuntime,
	TaskRuntimeHost,
	type TaskRuntimeHostAdapters,
} from "../../../src/core/task-runtime/index.js";

type WorkerMode = "admit" | "commit-barrier" | "coordinated" | "execute";

interface WorkerObservation {
	processId: number;
	workerId: string;
	taskId?: string;
	sessionRef?: string;
	artifactRef?: string;
	leaseWorkerId?: string;
	fenceEpoch?: number;
	routeId?: string;
	bindingId?: string;
	adapterCalls?: readonly string[];
}

interface WorkerMessage {
	type: "ready" | "committed" | "result";
	result?: unknown;
	observation?: WorkerObservation;
}

const [statePath, serializedEvent, workerId, mode] = process.argv.slice(2);
if (!statePath || !serializedEvent || !workerId || !isWorkerMode(mode)) {
	throw new Error("Expected state path, serialized event, worker ID, and mode");
}

const event = JSON.parse(serializedEvent) as NormalizedInboundEvent;
const runtime = new TaskRuntime({
	store: await FileTaskRuntimeStore.open(statePath),
	workerId,
});

if (mode === "coordinated") {
	await send({ type: "ready" });
	await waitForGo();
}

const result = await runtime.admit(event);
const executionObservation = mode === "execute" ? await execute(runtime, result) : undefined;
const observation = await observe(runtime, result, workerId, executionObservation);
if (mode === "commit-barrier") {
	await send({ type: "committed", result, observation });
	await new Promise<void>(() => undefined);
}
await send({ type: "result", result, observation });

async function observe(
	runtime: TaskRuntime,
	result: unknown,
	workerId: string,
	executionObservation?: Pick<WorkerObservation, "bindingId" | "adapterCalls">,
): Promise<WorkerObservation> {
	if (!result || typeof result !== "object" || !("taskId" in result) || typeof result.taskId !== "string") {
		return { processId: process.pid, workerId, ...executionObservation };
	}
	const snapshot = await runtime.snapshot();
	const task = snapshot.tasks[result.taskId];
	const lease = snapshot.leases[result.taskId];
	const route = Object.values(snapshot.routes).find((candidate) => candidate.taskId === result.taskId);
	return {
		processId: process.pid,
		workerId,
		taskId: result.taskId,
		sessionRef: task?.sessionRef,
		artifactRef: task?.artifactRef,
		leaseWorkerId: lease?.workerId,
		fenceEpoch: lease?.fenceEpoch,
		routeId: route?.routeId,
		...executionObservation,
	};
}

async function execute(
	runtime: TaskRuntime,
	result: unknown,
): Promise<Pick<WorkerObservation, "bindingId" | "adapterCalls">> {
	if (!result || typeof result !== "object" || !("taskId" in result) || typeof result.taskId !== "string") return {};
	if (!("transitionSeq" in result) || typeof result.transitionSeq !== "number") return {};
	const snapshot = await runtime.snapshot();
	const lease = snapshot.leases[result.taskId];
	if (!lease) throw new Error(`Missing lease for ${result.taskId}`);
	const adapterCalls: string[] = [];
	const adapters: TaskRuntimeHostAdapters = {
		kernel: {
			bind: async ({ task }) => {
				adapterCalls.push("kernel");
				return {
					kernelId: `kernel:${task.taskId}`,
					capabilityId: `capability:${task.taskId}`,
					permittedOperationClasses: ["pure", "idempotent-external", "non-idempotent-external"],
				};
			},
		},
		provider: {
			invoke: async ({ operation }) => {
				adapterCalls.push("provider");
				return { receiptRef: `provider-receipt:${operation.operationId}` };
			},
		},
		effect: {
			execute: async ({ operation }) => {
				adapterCalls.push("effect");
				return { receiptRef: `effect-receipt:${operation.operationId}` };
			},
		},
		delivery: {
			deliver: async ({ operation }) => {
				adapterCalls.push("delivery");
				return { receiptRef: `delivery-receipt:${operation.operationId}` };
			},
		},
	};
	const host = new TaskRuntimeHost({ runtime, adapters });
	const execution = await host.startAndExecute({
		taskId: result.taskId,
		expectedTransitionSeq: result.transitionSeq,
		expectedFenceEpoch: lease.fenceEpoch,
		requestDigest: "worker-execute",
	});
	return { bindingId: execution.binding.bindingId, adapterCalls };
}

function isWorkerMode(value: string | undefined): value is WorkerMode {
	return value === "admit" || value === "commit-barrier" || value === "coordinated" || value === "execute";
}

function waitForGo(): Promise<void> {
	return new Promise((resolve) => {
		process.once("message", (message: unknown) => {
			if (message === "go") resolve();
		});
	});
}

function send(message: WorkerMessage): Promise<void> {
	if (!process.send) throw new Error("Task runtime worker requires an IPC channel");
	return new Promise((resolve, reject) => {
		process.send!(message, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
