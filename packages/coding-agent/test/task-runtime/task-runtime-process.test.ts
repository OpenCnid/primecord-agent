import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ActiveTurnExpectation,
	type AdmissionResult,
	FileTaskRuntimeStore,
	type NormalizedInboundEvent,
	TaskRuntime,
} from "../../src/core/task-runtime/index.js";

const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");
const workerPath = resolve(__dirname, "fixtures/task-runtime-admission-worker.ts");
const tempDirectories: string[] = [];
const children = new Set<ChildProcess>();

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

function inbound(overrides: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
	return {
		inboundEventId: "inbound-1",
		requestId: "request-1",
		transport: "test-transport",
		actorRef: "principal",
		correlationRef: "channel-1",
		requestedControl: "new",
		payloadDigest: "payload-1",
		receivedAt: 1_700_000_000_000,
		...overrides,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function createStatePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "prime-task-runtime-regression-"));
	tempDirectories.push(directory);
	return join(directory, "task-runtime.json");
}

function spawnAdmissionWorker(
	statePath: string,
	event: NormalizedInboundEvent,
	workerId: string,
	mode: "admit" | "commit-barrier" | "coordinated" | "execute",
): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, workerPath, statePath, JSON.stringify(event), workerId, mode], {
		cwd: resolve(__dirname, "../.."),
		env: {
			...process.env,
			TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json"),
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	children.add(child);
	return child;
}

function waitForMessage(child: ChildProcess, type: WorkerMessage["type"]): Promise<WorkerMessage> {
	return new Promise((resolveMessage, rejectMessage) => {
		const timeout = setTimeout(() => {
			cleanup();
			rejectMessage(new Error(`Timed out waiting for worker message: ${type}`));
		}, 10_000);
		const onMessage = (message: unknown) => {
			if (!isWorkerMessage(message) || message.type !== type) return;
			cleanup();
			resolveMessage(message);
		};
		const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
			cleanup();
			rejectMessage(new Error(`Worker exited before ${type}: code=${code} signal=${signal}`));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			child.off("message", onMessage);
			child.off("exit", onExit);
		};
		child.on("message", onMessage);
		child.once("exit", onExit);
	});
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => rejectExit(new Error("Timed out waiting for worker exit")), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit();
		});
	});
}

function isWorkerMessage(value: unknown): value is WorkerMessage {
	return !!value && typeof value === "object" && "type" in value && typeof value.type === "string";
}

function requireObservation(message: WorkerMessage): WorkerObservation {
	if (!message.observation) throw new Error("Expected a worker observation");
	return message.observation;
}

type AdmissionCommittedDecision = Extract<AdmissionResult, { kind: "AdmissionCommitted" }>;

function requireAdmission(result: unknown): AdmissionCommittedDecision {
	if (!result || typeof result !== "object" || !("kind" in result) || result.kind !== "AdmissionCommitted") {
		throw new Error(`Expected AdmissionCommitted, received ${JSON.stringify(result)}`);
	}
	return result as AdmissionCommittedDecision;
}

async function createRuntime(statePath: string, workerId: string, authorize = () => true): Promise<TaskRuntime> {
	return new TaskRuntime({
		store: await FileTaskRuntimeStore.open(statePath),
		workerId,
		policy: { isAdmissionAuthorized: authorize },
	});
}

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await Promise.allSettled([...children].map((child) => waitForExit(child)));
	children.clear();
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("RCRS-7 task-runtime corrective regressions", () => {
	it("commits one admission decision when two worker processes race the same inbound event", async () => {
		const statePath = await createStatePath();
		const event = inbound();
		const first = spawnAdmissionWorker(statePath, event, "worker-a", "coordinated");
		const second = spawnAdmissionWorker(statePath, event, "worker-b", "coordinated");

		await Promise.all([waitForMessage(first, "ready"), waitForMessage(second, "ready")]);
		first.send("go");
		second.send("go");
		const [firstResult, secondResult] = await Promise.all([
			waitForMessage(first, "result"),
			waitForMessage(second, "result"),
		]);

		expect(requireAdmission(firstResult.result).taskId).toBe(requireAdmission(secondResult.result).taskId);
		expect(requireObservation(firstResult).processId).not.toBe(requireObservation(secondResult).processId);
		expect(requireObservation(firstResult)).toMatchObject({
			taskId: requireAdmission(firstResult.result).taskId,
			sessionRef: expect.stringMatching(/^task-session:/),
			artifactRef: expect.stringMatching(/^task-artifacts:/),
			routeId: expect.any(String),
		});
		const snapshot = await (await FileTaskRuntimeStore.open(statePath)).snapshot();
		expect(Object.keys(snapshot.inbox)).toHaveLength(1);
		expect(Object.keys(snapshot.tasks)).toHaveLength(1);
		expect(snapshot.records.filter((record) => record.type === "InboxDecision")).toHaveLength(1);
	});

	it("replays a committed decision after an actual worker-process kill", async () => {
		const statePath = await createStatePath();
		const event = inbound();
		const first = spawnAdmissionWorker(statePath, event, "worker-a", "commit-barrier");
		const committed = await waitForMessage(first, "committed");
		first.kill("SIGKILL");
		await waitForExit(first);

		const replay = spawnAdmissionWorker(statePath, event, "worker-b", "admit");
		const replayed = await waitForMessage(replay, "result");
		expect(requireAdmission(replayed.result).taskId).toBe(requireAdmission(committed.result).taskId);
		expect(requireObservation(replayed).processId).not.toBe(requireObservation(committed).processId);
		expect(requireObservation(replayed)).toMatchObject({
			taskId: requireAdmission(committed.result).taskId,
			sessionRef: requireObservation(committed).sessionRef,
			artifactRef: requireObservation(committed).artifactRef,
			leaseWorkerId: "worker-a",
		});
		const snapshot = await (await FileTaskRuntimeStore.open(statePath)).snapshot();
		expect(Object.keys(snapshot.operations)).toHaveLength(0);
	});

	it("records live binding and adapter receipts from an actual worker process", async () => {
		const statePath = await createStatePath();
		const worker = spawnAdmissionWorker(statePath, inbound(), "worker-a", "execute");
		const result = await waitForMessage(worker, "result");
		expect(requireAdmission(result.result)).toMatchObject({ kind: "AdmissionCommitted" });
		expect(requireObservation(result)).toMatchObject({
			processId: expect.any(Number),
			bindingId: expect.any(String),
			adapterCalls: ["kernel", "provider", "effect", "delivery"],
		});
		const snapshot = await (await FileTaskRuntimeStore.open(statePath)).snapshot();
		expect(snapshot.records.map((record) => record.type)).toContain("TaskExecutionBound");
		expect(
			snapshot.records
				.filter((record) => record.type === "TaskExecutionObserved")
				.map((record) => record.observation.kind),
		).toEqual([
			"KernelBindingStarted",
			"KernelBindingSucceeded",
			"ProviderStarted",
			"ProviderSucceeded",
			"EffectStarted",
			"EffectSucceeded",
			"DeliveryStarted",
			"DeliverySucceeded",
		]);
	});

	it("keeps per-state locks independent when stores share a parent directory", async () => {
		const firstStatePath = await createStatePath();
		const secondStatePath = join(dirname(firstStatePath), "other-task-runtime.json");
		const firstStore = await FileTaskRuntimeStore.open(firstStatePath);
		const firstRuntime = new TaskRuntime({ store: firstStore, workerId: "first" });
		const secondRuntime = await createRuntime(secondStatePath, "second");
		const firstLockHeld = deferred<void>();
		const releaseFirstLock = deferred<void>();
		const blockedTransaction = firstStore.transaction(async () => {
			firstLockHeld.resolve();
			await releaseFirstLock.promise;
		});
		await firstLockHeld.promise;
		await secondRuntime.admit(inbound({ inboundEventId: "other-inbound", requestId: "other-request" }));
		releaseFirstLock.resolve();
		await blockedTransaction;

		await expect(
			firstRuntime.admit(inbound({ inboundEventId: "first-inbound", requestId: "first-request" })),
		).resolves.toMatchObject({ kind: "AdmissionCommitted" });
	});

	it("rejects a worker that does not own the lease before it starts an operation", async () => {
		const statePath = await createStatePath();
		const owner = await createRuntime(statePath, "owner");
		const admitted = requireAdmission(await owner.admit(inbound()));
		const lease = (await owner.snapshot()).leases[admitted.taskId];
		const nonOwner = await createRuntime(statePath, "non-owner");

		await expect(
			nonOwner.startOperation({
				taskId: admitted.taskId,
				expectedTransitionSeq: admitted.transitionSeq,
				expectedFenceEpoch: lease.fenceEpoch,
				requestDigest: "operation",
			}),
		).rejects.toThrow("does not own the lease");
	});

	it("preserves a normalized event captured before queueing and policy evaluation", async () => {
		const statePath = await createStatePath();
		const store = await FileTaskRuntimeStore.open(statePath);
		const queueGate = deferred<void>();
		const queueBlocker = store.transaction(async () => {
			await queueGate.promise;
		});
		const runtime = new TaskRuntime({
			store,
			policy: {
				isAdmissionAuthorized: (event) => {
					event.actorRef = "policy-mutated";
					event.requestedControl = "turn";
					return true;
				},
			},
		});
		const event = inbound();
		const admission = runtime.admit(event);
		event.actorRef = "caller-mutated";
		queueGate.resolve();
		await queueBlocker;

		const result = requireAdmission(await admission);
		const snapshot = await runtime.snapshot();
		expect(snapshot.inbox[JSON.stringify([event.transport, event.inboundEventId])].event).toMatchObject({
			actorRef: "principal",
			requestedControl: "new",
		});
		expect(result.kind).toBe("AdmissionCommitted");
	});

	it("requires a lease owner and an exact route CAS for same-scope active turns", async () => {
		const statePath = await createStatePath();
		const owner = await createRuntime(statePath, "owner");
		const first = requireAdmission(await owner.admit(inbound()));
		const second = requireAdmission(
			await owner.admit(
				inbound({ inboundEventId: "inbound-2", requestId: "request-2", payloadDigest: "payload-2" }),
			),
		);
		const secondLease = (await owner.snapshot()).leases[second.taskId];
		await owner.startOperation({
			taskId: second.taskId,
			expectedTransitionSeq: second.transitionSeq,
			expectedFenceEpoch: secondLease.fenceEpoch,
			requestDigest: "start-second",
		});
		const missingCas = await owner.admit(
			inbound({
				inboundEventId: "inbound-3",
				requestId: "request-3",
				requestedControl: "turn",
				payloadDigest: "missing-cas",
			}),
		);
		expect(missingCas).toMatchObject({ kind: "AdmissionRejected", reason: "active_turn_compare_and_set_failed" });

		const ownerExpectation: ActiveTurnExpectation = await owner.activeTurnExpectation(second.taskId);
		const nonOwner = await createRuntime(statePath, "non-owner");
		const rejectedNonOwner = await nonOwner.admit(
			inbound({
				inboundEventId: "inbound-4",
				requestId: "request-4",
				requestedControl: "turn",
				payloadDigest: "non-owner",
			}),
			ownerExpectation,
		);
		expect(rejectedNonOwner).toMatchObject({
			kind: "AdmissionRejected",
			reason: "active_turn_compare_and_set_failed",
		});

		const takenOver = await nonOwner.takeOverLease(second.taskId, secondLease.fenceEpoch);
		const winnerExpectation = await nonOwner.activeTurnExpectation(second.taskId);
		const accepted = await nonOwner.admit(
			inbound({
				inboundEventId: "inbound-5",
				requestId: "request-5",
				requestedControl: "turn",
				payloadDigest: "valid-follow-up",
			}),
			winnerExpectation,
		);
		expect(accepted).toMatchObject({ kind: "ActiveTurnAdmitted", taskId: second.taskId });
		expect(takenOver.fenceEpoch).toBe(secondLease.fenceEpoch + 1);

		const stale = await owner.admit(
			inbound({
				inboundEventId: "inbound-6",
				requestId: "request-6",
				requestedControl: "turn",
				payloadDigest: "stale",
			}),
			ownerExpectation,
		);
		expect(stale).toMatchObject({ kind: "AdmissionRejected", reason: "active_turn_compare_and_set_failed" });
		const snapshot = await owner.snapshot();
		expect(snapshot.tasks[first.taskId].state).toBe("Ready");
		expect(snapshot.tasks[second.taskId].transitionSeq).toBe(3);
		expect(snapshot.records.filter((record) => record.type === "TaskRouteAdvanced")).toHaveLength(1);
	});
});
