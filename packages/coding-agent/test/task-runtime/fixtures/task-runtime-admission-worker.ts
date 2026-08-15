import {
	FileTaskRuntimeStore,
	type NormalizedInboundEvent,
	TaskRuntime,
} from "../../../src/core/task-runtime/index.js";

type WorkerMode = "admit" | "commit-barrier" | "coordinated";

interface WorkerObservation {
	processId: number;
	workerId: string;
	taskId?: string;
	sessionRef?: string;
	artifactRef?: string;
	leaseWorkerId?: string;
	fenceEpoch?: number;
	routeId?: string;
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
const observation = await observe(runtime, result, workerId);
if (mode === "commit-barrier") {
	await send({ type: "committed", result, observation });
	await new Promise<void>(() => undefined);
}
await send({ type: "result", result, observation });

async function observe(runtime: TaskRuntime, result: unknown, workerId: string): Promise<WorkerObservation> {
	if (!result || typeof result !== "object" || !("taskId" in result) || typeof result.taskId !== "string") {
		return { processId: process.pid, workerId };
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
	};
}

function isWorkerMode(value: string | undefined): value is WorkerMode {
	return value === "admit" || value === "commit-barrier" || value === "coordinated";
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
