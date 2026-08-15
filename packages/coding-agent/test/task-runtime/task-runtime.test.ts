import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedInboundEvent } from "../../src/core/task-runtime/index.js";
import { createTaskRuntimeHarness, SimulatedTaskRuntimeProcessKill, type TaskRuntimeHarness } from "./harness.js";

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

describe("RCRS-7 task runtime control plane", () => {
	let harness: TaskRuntimeHarness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("ADM-01 durably rejects an unauthorized admission without creating a task binding", async () => {
		harness = await createTaskRuntimeHarness();

		const result = await harness.transport.deliver(inbound({ actorRef: "other-user" }));

		expect(result).toMatchObject({ kind: "AdmissionRejected", reason: "unauthorized_actor" });
		expect((await harness.records()).map((record) => record.type)).toEqual([
			"InboxReceived",
			"AdmissionRejected",
			"InboxDecision",
		]);
		const snapshot = await harness.snapshot();
		expect(snapshot.tasks).toEqual({});
		expect(snapshot.leases).toEqual({});
		expect(await harness.artifactManifest()).toEqual([]);
		expect(harness.kernelBindings()).toEqual([]);
		expect(harness.capabilityBindings()).toEqual([]);
	});

	it("ADM-02 issues independent lazy task, session, and artifact records for same-scope admissions", async () => {
		harness = await createTaskRuntimeHarness();

		const first = await harness.transport.deliver(inbound());
		const second = await harness.transport.deliver(
			inbound({ inboundEventId: "inbound-2", requestId: "request-2", payloadDigest: "payload-2" }),
		);

		expect(first.kind).toBe("AdmissionCommitted");
		expect(second.kind).toBe("AdmissionCommitted");
		if (first.kind !== "AdmissionCommitted" || second.kind !== "AdmissionCommitted") return;
		expect(first.taskId).not.toBe(second.taskId);

		const snapshot = await harness.snapshot();
		const firstTask = snapshot.tasks[first.taskId];
		const secondTask = snapshot.tasks[second.taskId];
		expect(firstTask).toMatchObject({ state: "Ready", transitionSeq: 1 });
		expect(secondTask).toMatchObject({ state: "Ready", transitionSeq: 1 });
		expect(firstTask.sessionRef).not.toBe(secondTask.sessionRef);
		expect(firstTask.artifactRef).not.toBe(secondTask.artifactRef);
		expect(harness.kernelBindings()).toEqual([]);
		expect((await harness.records()).filter((record) => record.type === "AdmissionCommitted")).toHaveLength(2);
	});

	it("INB-01 replays a committed inbox decision after a simulated restart without new work", async () => {
		harness = await createTaskRuntimeHarness();
		harness.arm("after_AdmissionCommitted_before_ack");
		const event = inbound();
		const firstDelivery = harness.transport.deliver(event);

		await harness.waitUntilReached("after_AdmissionCommitted_before_ack");
		harness.acknowledge("after_AdmissionCommitted_before_ack", "killProcess");
		await expect(firstDelivery).rejects.toBeInstanceOf(SimulatedTaskRuntimeProcessKill);

		await harness.restart();
		const replay = await harness.transport.deliver(event);

		expect(replay).toMatchObject({ kind: "AdmissionCommitted" });
		const snapshot = await harness.snapshot();
		expect(Object.keys(snapshot.inbox)).toHaveLength(1);
		expect(Object.keys(snapshot.tasks)).toHaveLength(1);
		expect(Object.keys(snapshot.operations)).toHaveLength(0);
		expect((await harness.records()).filter((record) => record.type === "InboxReceived")).toHaveLength(1);
		expect((await harness.records()).filter((record) => record.type === "InboxDecision")).toHaveLength(1);
		expect(harness.transport.acknowledgements).toEqual([event.inboundEventId]);
		expect(harness.provider.callCount).toBe(0);
		expect(harness.effect.callCount).toBe(0);
	});

	it("ATR-01 routes an authorized active follow-up with host CAS and rejects a stale assertion", async () => {
		harness = await createTaskRuntimeHarness();
		const admitted = await harness.transport.deliver(inbound());
		expect(admitted.kind).toBe("AdmissionCommitted");
		if (admitted.kind !== "AdmissionCommitted") return;

		const admittedSnapshot = await harness.snapshot();
		const started = await harness.startOperation({
			taskId: admitted.taskId,
			expectedTransitionSeq: admitted.transitionSeq,
			expectedFenceEpoch: admittedSnapshot.leases[admitted.taskId].fenceEpoch,
			requestDigest: "first-operation",
		});
		const staleExpectation = {
			transitionSeq: started.task.transitionSeq,
			fenceEpoch: started.operation.fenceEpoch,
		};
		const followUp = await harness.transport.deliver(
			inbound({
				inboundEventId: "inbound-2",
				requestId: "request-2",
				requestedControl: "turn",
				payloadDigest: "follow-up",
			}),
		);

		expect(followUp).toMatchObject({ kind: "ActiveTurnAdmitted", taskId: admitted.taskId });
		expect(followUp.kind).toBe("ActiveTurnAdmitted");
		if (followUp.kind !== "ActiveTurnAdmitted") return;
		expect(followUp.operationId).not.toBe(started.operation.operationId);

		const stale = await harness.transport.deliver(
			inbound({
				inboundEventId: "inbound-3",
				requestId: "request-3",
				requestedControl: "turn",
				payloadDigest: "stale-follow-up",
			}),
			staleExpectation,
		);

		expect(stale).toMatchObject({ kind: "AdmissionRejected", reason: "active_turn_compare_and_set_failed" });
		const snapshot = await harness.snapshot();
		expect(snapshot.tasks[admitted.taskId]).toMatchObject({ state: "Active", transitionSeq: followUp.transitionSeq });
		expect(Object.values(snapshot.operations)).toHaveLength(2);
		const records = await harness.records();
		expect(records.filter((record) => record.type === "TaskCreated")).toHaveLength(1);
		expect(records.filter((record) => record.type === "ActiveTurnAdmitted")).toHaveLength(1);
		expect(records.filter((record) => record.type === "OperationPrepared")).toHaveLength(2);
	});
});
