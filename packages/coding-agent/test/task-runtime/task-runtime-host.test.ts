import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FileTaskRuntimeStore,
	type NormalizedInboundEvent,
	TaskRuntime,
	TaskRuntimeHost,
	type TaskRuntimeHostAdapters,
	type TaskRuntimeStore,
} from "../../src/core/task-runtime/index.js";

const temporaryDirectories: string[] = [];

class FailProviderSuccessRecordStore implements TaskRuntimeStore {
	private failed = false;

	constructor(private readonly inner: TaskRuntimeStore) {}

	transaction<T>(
		mutate: (
			state: Parameters<TaskRuntimeStore["transaction"]>[0] extends (state: infer State) => unknown ? State : never,
		) => Promise<T> | T,
	): Promise<T> {
		return this.inner.transaction(async (state) => {
			const before = state.records.length;
			const result = await mutate(state);
			if (
				!this.failed &&
				state.records
					.slice(before)
					.some(
						(record) =>
							record.type === "TaskExecutionObserved" && record.observation.kind === "ProviderSucceeded",
					)
			) {
				this.failed = true;
				throw new Error("simulated durable observation write failure");
			}
			return result;
		});
	}

	snapshot() {
		return this.inner.snapshot();
	}
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

async function createStatePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "prime-task-runtime-host-"));
	temporaryDirectories.push(directory);
	return join(directory, "task-runtime.json");
}

function createAdapters(permittedOperationClasses: readonly ("pure" | "idempotent-external")[] = ["pure"]): {
	adapters: TaskRuntimeHostAdapters;
	events: string[];
} {
	const events: string[] = [];
	return {
		events,
		adapters: {
			kernel: {
				bind: vi.fn(async ({ task }) => {
					events.push(`kernel:${task.taskId}`);
					return {
						kernelId: `kernel:${task.taskId}`,
						capabilityId: `capability:${task.taskId}`,
						permittedOperationClasses,
					};
				}),
			},
			provider: {
				invoke: vi.fn(async ({ operation }) => {
					events.push(`provider:${operation.operationId}`);
					return { receiptRef: `provider-receipt:${operation.operationId}` };
				}),
			},
			effect: {
				execute: vi.fn(async ({ operation }) => {
					events.push(`effect:${operation.operationId}`);
					return { receiptRef: `effect-receipt:${operation.operationId}` };
				}),
			},
			delivery: {
				deliver: vi.fn(async ({ operation }) => {
					events.push(`delivery:${operation.operationId}`);
					return { receiptRef: `delivery-receipt:${operation.operationId}` };
				}),
			},
		},
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("TaskRuntimeHost observable execution boundary", () => {
	it("binds task/session/artifact/capability context after durable preparation and exposes real receipts", async () => {
		const statePath = await createStatePath();
		const runtime = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "owner" });
		const { adapters, events } = createAdapters(["pure", "idempotent-external"]);
		const host = new TaskRuntimeHost({ runtime, adapters });
		const admitted = await runtime.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];

		const executed = await host.startAndExecute({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: lease.fenceEpoch,
			requestDigest: "execute-1",
			operationClass: "idempotent-external",
		});

		expect(events).toEqual([
			`kernel:${admitted.taskId}`,
			`provider:${executed.operation.operationId}`,
			`effect:${executed.operation.operationId}`,
			`delivery:${executed.operation.operationId}`,
		]);
		expect(executed.receipts).toEqual({
			provider: { receiptRef: `provider-receipt:${executed.operation.operationId}` },
			effect: { receiptRef: `effect-receipt:${executed.operation.operationId}` },
			delivery: { receiptRef: `delivery-receipt:${executed.operation.operationId}` },
		});
		expect(adapters.delivery.deliver).toHaveBeenCalledWith(
			expect.objectContaining({
				binding: expect.objectContaining({ routeId: expect.any(String) }),
				operation: expect.objectContaining({ idempotencyKey: executed.operation.idempotencyKey }),
			}),
		);
		const [binding] = host.kernelBindings();
		expect(binding).toMatchObject({
			taskId: admitted.taskId,
			sessionRef: `task-session:${admitted.taskId}`,
			artifactRef: `task-artifacts:${admitted.taskId}`,
			kernelId: `kernel:${admitted.taskId}`,
			capabilityId: `capability:${admitted.taskId}`,
		});
		expect(host.capabilityBindings()).toEqual([
			expect.objectContaining({ taskId: admitted.taskId, capabilityId: `capability:${admitted.taskId}` }),
		]);
		expect(host.artifactManifest()).toEqual([
			{ taskId: admitted.taskId, artifactRef: `task-artifacts:${admitted.taskId}`, bindingId: binding.bindingId },
		]);
		expect(host.resolveArtifactRoute({ taskId: admitted.taskId, bindingId: binding.bindingId })).toBe(
			`task-artifacts:${admitted.taskId}`,
		);
		const records = await runtime.snapshot();
		expect(records.records.map((record) => record.type)).toContain("TaskExecutionBound");
		expect(
			records.records
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

	it("records a durable failed provider observation and does not fabricate later effects or delivery", async () => {
		const statePath = await createStatePath();
		const runtime = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "owner" });
		const { adapters, events } = createAdapters();
		adapters.provider.invoke = vi.fn(async ({ operation }) => {
			events.push(`provider:${operation.operationId}`);
			throw new Error("provider unavailable");
		});
		const host = new TaskRuntimeHost({ runtime, adapters });
		const admitted = await runtime.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];

		await expect(
			host.startAndExecute({
				taskId: admitted.taskId,
				expectedTransitionSeq: admitted.transitionSeq,
				expectedFenceEpoch: lease.fenceEpoch,
				requestDigest: "provider-failure",
			}),
		).rejects.toThrow("provider unavailable");
		expect(events).toEqual([`kernel:${admitted.taskId}`, expect.stringMatching(/^provider:/)]);
		const records = await runtime.snapshot();
		expect(
			records.records
				.filter((record) => record.type === "TaskExecutionObserved")
				.map((record) => record.observation.kind),
		).toEqual(["KernelBindingStarted", "KernelBindingSucceeded", "ProviderStarted", "ProviderFailed"]);
		expect(
			records.records.some(
				(record) => record.type === "TaskExecutionObserved" && record.observation.kind === "EffectStarted",
			),
		).toBe(false);
		expect(
			records.records.some(
				(record) => record.type === "TaskExecutionObserved" && record.observation.kind === "DeliveryStarted",
			),
		).toBe(false);
	});

	it("does not mislabel a successful provider call as failed when its success observation cannot persist", async () => {
		const statePath = await createStatePath();
		const runtime = new TaskRuntime({
			store: new FailProviderSuccessRecordStore(await FileTaskRuntimeStore.open(statePath)),
			workerId: "owner",
		});
		const { adapters, events } = createAdapters();
		const host = new TaskRuntimeHost({ runtime, adapters });
		const admitted = await runtime.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];

		await expect(
			host.startAndExecute({
				taskId: admitted.taskId,
				expectedTransitionSeq: admitted.transitionSeq,
				expectedFenceEpoch: lease.fenceEpoch,
				requestDigest: "provider-observation-write-failure",
			}),
		).rejects.toThrow("simulated durable observation write failure");
		expect(events.some((event) => event.startsWith("provider:"))).toBe(true);
		const records = await runtime.snapshot();
		expect(
			records.records
				.filter((record) => record.type === "TaskExecutionObserved")
				.map((record) => record.observation.kind),
		).toEqual(["KernelBindingStarted", "KernelBindingSucceeded", "ProviderStarted"]);
	});

	it("claims a prepared active-turn operation exactly once before any adapter dispatch", async () => {
		const statePath = await createStatePath();
		const runtime = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "owner" });
		const firstAdapters = createAdapters();
		const secondAdapters = createAdapters();
		const firstHost = new TaskRuntimeHost({ runtime, adapters: firstAdapters.adapters });
		const secondHost = new TaskRuntimeHost({ runtime, adapters: secondAdapters.adapters });
		const admitted = await runtime.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];
		const started = await runtime.startOperation({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: lease.fenceEpoch,
			requestDigest: "initial",
		});
		const expectation = await runtime.activeTurnExpectation(admitted.taskId);
		const turn = await runtime.admit(
			inbound({ inboundEventId: "inbound-2", requestId: "request-2", requestedControl: "turn" }),
			expectation,
		);
		expect(turn).toMatchObject({ kind: "ActiveTurnAdmitted" });
		if (turn.kind !== "ActiveTurnAdmitted") return;

		const attempts = await Promise.allSettled([
			firstHost.executePrepared({ taskId: admitted.taskId, operationId: turn.operationId }),
			secondHost.executePrepared({ taskId: admitted.taskId, operationId: turn.operationId }),
		]);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
		expect(firstAdapters.events.length + secondAdapters.events.length).toBe(4);
		expect([...firstAdapters.events, ...secondAdapters.events]).toContain(`provider:${turn.operationId}`);
		expect((await runtime.snapshot()).operations[started.operation.operationId].state).toBe("Prepared");
		expect((await runtime.snapshot()).operations[turn.operationId].state).toBe("Claimed");
	});

	it("rejects an expired active route before claiming or dispatching its prepared operation", async () => {
		const statePath = await createStatePath();
		let now = 1_700_000_000_000;
		const runtime = new TaskRuntime({
			store: await FileTaskRuntimeStore.open(statePath),
			workerId: "owner",
			clock: { now: () => now },
			policy: { activeRouteIdleTtlMs: 1, activeRouteMaximumLifetimeMs: 1 },
		});
		const { adapters } = createAdapters();
		const host = new TaskRuntimeHost({ runtime, adapters });
		const admitted = await runtime.admit(inbound({ receivedAt: now }));
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];
		const prepared = await runtime.startOperation({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: lease.fenceEpoch,
			requestDigest: "expired-before-claim",
		});
		now += 2;
		await expect(
			host.executePrepared({ taskId: admitted.taskId, operationId: prepared.operation.operationId }),
		).rejects.toThrow("active execution route");
		expect(adapters.kernel.bind).not.toHaveBeenCalled();
		expect(adapters.provider.invoke).not.toHaveBeenCalled();
		expect(adapters.effect.execute).not.toHaveBeenCalled();
		expect(adapters.delivery.deliver).not.toHaveBeenCalled();
	});

	it("rejects forged terminal-delivery evidence before its kernel/provider/effect sequence", async () => {
		const statePath = await createStatePath();
		const runtime = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "owner" });
		const admitted = await runtime.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];
		const started = await runtime.startOperation({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: lease.fenceEpoch,
			requestDigest: "forged-observation",
		});
		await runtime.claimExecution({ taskId: admitted.taskId, operationId: started.operation.operationId });
		await expect(
			runtime.recordExecutionObservation({
				taskId: admitted.taskId,
				operationId: started.operation.operationId,
				fenceEpoch: lease.fenceEpoch,
				bindingId: "forged-binding",
				kind: "DeliverySucceeded",
				receiptRef: "forged-delivery",
			}),
		).rejects.toThrow("not allowed");
	});

	it("invalidates a task binding on fence rollover before its next dispatch", async () => {
		const statePath = await createStatePath();
		const store = await FileTaskRuntimeStore.open(statePath);
		const owner = new TaskRuntime({ store, workerId: "owner" });
		const successor = new TaskRuntime({ store, workerId: "successor" });
		const { adapters } = createAdapters();
		const host = new TaskRuntimeHost({ runtime: owner, adapters });
		const admitted = await owner.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const firstLease = (await owner.snapshot()).leases[admitted.taskId];
		const first = await host.startAndExecute({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: firstLease.fenceEpoch,
			requestDigest: "first-fence-bound-operation",
		});
		const successorLease = await successor.takeOverLease(admitted.taskId, firstLease.fenceEpoch);
		const recoveredLease = await owner.takeOverLease(admitted.taskId, successorLease.fenceEpoch);
		const expectation = await owner.activeTurnExpectation(admitted.taskId);
		const continuation = await owner.admit(
			inbound({
				inboundEventId: "fence-rollover-follow-up",
				requestId: "fence-rollover-request",
				requestedControl: "turn",
				payloadDigest: "fence-rollover-payload",
			}),
			expectation,
		);
		expect(continuation).toMatchObject({ kind: "ActiveTurnAdmitted" });
		if (continuation.kind !== "ActiveTurnAdmitted") return;
		const second = await host.executePrepared({
			taskId: admitted.taskId,
			operationId: continuation.operationId,
		});

		expect(adapters.kernel.bind).toHaveBeenCalledTimes(2);
		expect(first.binding.fenceEpoch).toBe(firstLease.fenceEpoch);
		expect(second.binding).toMatchObject({ fenceEpoch: recoveredLease.fenceEpoch });
		expect(second.binding.bindingId).not.toBe(first.binding.bindingId);
	});

	it("coalesces concurrent task-scoped kernel binding before external dispatch", async () => {
		const statePath = await createStatePath();
		const runtime = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "owner" });
		const { adapters } = createAdapters();
		let releaseKernel: (() => void) | undefined;
		const kernelRelease = new Promise<void>((resolve) => {
			releaseKernel = resolve;
		});
		const originalBind = adapters.kernel.bind;
		let bindCalls = 0;
		adapters.kernel.bind = async (input) => {
			bindCalls += 1;
			await kernelRelease;
			return originalBind(input);
		};
		const host = new TaskRuntimeHost({ runtime, adapters });
		const admitted = await runtime.admit(inbound());
		expect(admitted).toMatchObject({ kind: "AdmissionCommitted" });
		if (admitted.kind !== "AdmissionCommitted") return;
		const lease = (await runtime.snapshot()).leases[admitted.taskId];
		const first = await runtime.startOperation({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: lease.fenceEpoch,
			requestDigest: "concurrent-first",
		});
		const expectation = await runtime.activeTurnExpectation(admitted.taskId);
		const continuation = await runtime.admit(
			inbound({
				inboundEventId: "concurrent-second",
				requestId: "concurrent-second-request",
				requestedControl: "turn",
				payloadDigest: "concurrent-second-payload",
			}),
			expectation,
		);
		expect(continuation).toMatchObject({ kind: "ActiveTurnAdmitted" });
		if (continuation.kind !== "ActiveTurnAdmitted") return;
		const firstExecution = host.executePrepared({
			taskId: admitted.taskId,
			operationId: first.operation.operationId,
		});
		for (let attempt = 0; bindCalls === 0 && attempt < 20; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(bindCalls).toBe(1);
		const secondExecution = host.executePrepared({ taskId: admitted.taskId, operationId: continuation.operationId });
		for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
		expect(bindCalls).toBe(1);
		releaseKernel?.();
		const [firstResult, secondResult] = await Promise.all([firstExecution, secondExecution]);
		expect(firstResult.binding.bindingId).toBe(secondResult.binding.bindingId);
	});

	it("refuses cross-task artifact use and stale or unauthorized execution before any remote adapter call", async () => {
		const statePath = await createStatePath();
		const owner = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "owner" });
		const { adapters, events } = createAdapters(["pure"]);
		const host = new TaskRuntimeHost({ runtime: owner, adapters });
		const first = await owner.admit(inbound());
		const second = await owner.admit(inbound({ inboundEventId: "inbound-2", requestId: "request-2" }));
		expect(first).toMatchObject({ kind: "AdmissionCommitted" });
		expect(second).toMatchObject({ kind: "AdmissionCommitted" });
		if (first.kind !== "AdmissionCommitted" || second.kind !== "AdmissionCommitted") return;
		const snapshot = await owner.snapshot();
		const firstExecution = await host.startAndExecute({
			taskId: first.taskId,
			expectedTransitionSeq: first.transitionSeq,
			expectedFenceEpoch: snapshot.leases[first.taskId].fenceEpoch,
			requestDigest: "first",
		});
		const firstBinding = host.kernelBindings()[0];

		expect(() => host.resolveArtifactRoute({ taskId: second.taskId, bindingId: firstBinding.bindingId })).toThrow(
			"does not own binding",
		);
		const callsAfterFirst = [...events];
		await expect(
			host.startAndExecute({
				taskId: second.taskId,
				expectedTransitionSeq: second.transitionSeq,
				expectedFenceEpoch: snapshot.leases[second.taskId].fenceEpoch,
				requestDigest: "not-permitted",
				operationClass: "idempotent-external",
			}),
		).rejects.toThrow("does not permit operation class");
		expect(events).toEqual([...callsAfterFirst, `kernel:${second.taskId}`]);

		const stale = new TaskRuntime({ store: await FileTaskRuntimeStore.open(statePath), workerId: "stale" });
		const staleAdapters = createAdapters();
		const staleHost = new TaskRuntimeHost({ runtime: stale, adapters: staleAdapters.adapters });
		await expect(
			staleHost.startAndExecute({
				taskId: first.taskId,
				expectedTransitionSeq: firstExecution.task.transitionSeq,
				expectedFenceEpoch: snapshot.leases[first.taskId].fenceEpoch,
				requestDigest: "stale",
			}),
		).rejects.toThrow("does not own the lease");
		expect(staleAdapters.events).toEqual([]);
		expect(staleHost.kernelBindings()).toEqual([]);
	});
});
