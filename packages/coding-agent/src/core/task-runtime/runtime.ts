import { createHash, randomUUID } from "node:crypto";
import type { TaskRuntimeStore } from "./store.js";
import type {
	ActiveTurnAdmittedDecision,
	ActiveTurnExpectation,
	AdmissionCommittedDecision,
	AdmissionRejectedDecision,
	AdmissionRejectionReason,
	AdmissionResult,
	DurableTaskRuntimeState,
	InboxConflict,
	InboxDecision,
	NormalizedInboundEvent,
	OperationClass,
	OperationRecord,
	StartOperationInput,
	StartOperationResult,
	TaskLease,
	TaskRecord,
	TaskRetentionPolicy,
	TaskRoute,
	TaskRuntimeClock,
	TaskRuntimeIdGenerator,
	TaskRuntimeIdKind,
	TaskRuntimePolicy,
	TaskRuntimeRecord,
	TaskRuntimeSnapshot,
	TaskTransition,
} from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

type TaskRuntimeRecordInput = StripRecordMetadata<TaskRuntimeRecord>;
type StripRecordMetadata<T> = T extends unknown ? Omit<T, "recordId" | "at"> : never;

export interface TaskRuntimeOptions {
	store: TaskRuntimeStore;
	clock?: TaskRuntimeClock;
	idGenerator?: TaskRuntimeIdGenerator;
	workerId?: string;
	policy?: Partial<Omit<TaskRuntimePolicy, "isAdmissionAuthorized">> & {
		isAdmissionAuthorized?: TaskRuntimePolicy["isAdmissionAuthorized"];
	};
}

export const DEFAULT_TASK_RUNTIME_POLICY: Omit<TaskRuntimePolicy, "isAdmissionAuthorized"> = {
	noActiveRoute: "reject",
	activeRouteIdleTtlMs: 30 * MINUTE_MS,
	activeRouteMaximumLifetimeMs: DAY_MS,
	retentionPolicyVersion: "rcrs-7-v1",
	continuationRetentionMs: DAY_MS,
	evidenceRetentionMs: 30 * DAY_MS,
	tombstoneRetentionMs: 90 * DAY_MS,
};

export class TaskRuntime {
	private readonly clock: TaskRuntimeClock;
	private readonly idGenerator: TaskRuntimeIdGenerator;
	private readonly workerId: string;
	private readonly policy: TaskRuntimePolicy;

	constructor(options: TaskRuntimeOptions) {
		this.clock = options.clock ?? { now: () => Date.now() };
		this.idGenerator = options.idGenerator ?? (() => randomUUID());
		this.workerId = options.workerId ?? "task-runtime-host";
		this.policy = {
			...DEFAULT_TASK_RUNTIME_POLICY,
			...options.policy,
			isAdmissionAuthorized: options.policy?.isAdmissionAuthorized ?? (() => true),
		};
		this.store = options.store;
	}

	private readonly store: TaskRuntimeStore;

	async admit(event: NormalizedInboundEvent, expectation?: ActiveTurnExpectation): Promise<AdmissionResult> {
		assertNormalizedInboundEvent(event);
		return this.store.transaction(async (state) => {
			const now = this.clock.now();
			const inboxKey = createInboxKey(event);
			const existing = state.inbox[inboxKey];
			if (existing) {
				if (existing.event.payloadDigest === event.payloadDigest) return structuredClone(existing.decision);
				const conflict: InboxConflict = {
					kind: "InboxConflict",
					inboundEventId: event.inboundEventId,
					requestId: event.requestId,
					inboxKey,
					expectedPayloadDigest: existing.event.payloadDigest,
					actualPayloadDigest: event.payloadDigest,
					recordedAt: now,
				};
				this.append(state, { type: "InboxConflictRejected", conflict }, now);
				return conflict;
			}

			const immutableEvent = structuredClone(event);
			this.append(state, { type: "InboxReceived", inboxKey, event: immutableEvent }, now);

			if (!(await this.policy.isAdmissionAuthorized(immutableEvent))) {
				return this.commitRejection(state, inboxKey, immutableEvent, "unauthorized_actor", now);
			}

			if (immutableEvent.requestedControl === "new") {
				return this.commitAdmission(state, inboxKey, immutableEvent, now);
			}
			if (immutableEvent.requestedControl === "turn") {
				return this.commitActiveTurn(state, inboxKey, immutableEvent, expectation, now);
			}
			return this.commitRejection(state, inboxKey, immutableEvent, "unsupported_control", now);
		});
	}

	async startOperation(input: StartOperationInput): Promise<StartOperationResult> {
		assertNonEmptyString(input.taskId, "taskId");
		assertNonEmptyString(input.requestDigest, "requestDigest");
		return this.store.transaction((state) => {
			const now = this.clock.now();
			const task = state.tasks[input.taskId];
			const lease = state.leases[input.taskId];
			if (!task || !lease) throw new Error(`Unknown task: ${input.taskId}`);
			if (task.state !== "Ready") throw new Error(`Task ${input.taskId} is not ready to start work`);
			if (task.transitionSeq !== input.expectedTransitionSeq || lease.fenceEpoch !== input.expectedFenceEpoch) {
				throw new Error(`Task ${input.taskId} start rejected by transition or fence compare-and-set`);
			}

			const nextTransitionSeq = task.transitionSeq + 1;
			const operation = this.createOperation(
				input.taskId,
				nextTransitionSeq,
				lease.fenceEpoch,
				input.requestDigest,
				input.operationClass ?? "pure",
				now,
			);
			const activeTask: TaskRecord = {
				...task,
				state: "Active",
				transitionSeq: nextTransitionSeq,
				updatedAt: now,
			};
			state.tasks[input.taskId] = activeTask;
			state.operations[operation.operationId] = operation;
			this.append(
				state,
				{
					type: "TaskTransition",
					transition: this.createTransition({
						taskId: input.taskId,
						seq: nextTransitionSeq,
						expectedState: "Ready",
						nextState: "Active",
						fenceEpoch: lease.fenceEpoch,
						reason: "OperationStarted",
						actor: this.workerId,
						timestamp: now,
						recordRefs: [operation.operationId],
					}),
				},
				now,
			);
			this.append(state, { type: "OperationPrepared", operation }, now);
			return structuredClone({ task: activeTask, operation });
		});
	}

	async activeTurnExpectation(taskId: string): Promise<ActiveTurnExpectation> {
		const snapshot = await this.snapshot();
		const task = snapshot.tasks[taskId];
		const lease = snapshot.leases[taskId];
		if (!task || !lease) throw new Error(`Unknown task: ${taskId}`);
		return { transitionSeq: task.transitionSeq, fenceEpoch: lease.fenceEpoch };
	}

	async takeOverLease(taskId: string, expectedFenceEpoch: number): Promise<TaskLease> {
		assertNonEmptyString(taskId, "taskId");
		return this.store.transaction((state) => {
			const lease = state.leases[taskId];
			if (!lease) throw new Error(`Unknown task lease: ${taskId}`);
			if (lease.fenceEpoch !== expectedFenceEpoch) {
				throw new Error(`Task ${taskId} lease takeover rejected by fence compare-and-set`);
			}
			const nextLease: TaskLease = {
				...lease,
				workerId: this.workerId,
				fenceEpoch: lease.fenceEpoch + 1,
				acquiredAt: this.clock.now(),
			};
			state.leases[taskId] = nextLease;
			this.append(state, { type: "TaskLeaseAcquired", lease: nextLease }, nextLease.acquiredAt);
			return structuredClone(nextLease);
		});
	}

	snapshot(): Promise<TaskRuntimeSnapshot> {
		return this.store.snapshot();
	}

	private async commitActiveTurn(
		state: DurableTaskRuntimeState,
		inboxKey: string,
		event: NormalizedInboundEvent,
		expectation: ActiveTurnExpectation | undefined,
		now: number,
	): Promise<AdmissionResult> {
		const route = this.findRoute(state, event);
		if (!route) {
			if (this.policy.noActiveRoute === "new_admission") return this.commitAdmission(state, inboxKey, event, now);
			return this.commitRejection(state, inboxKey, event, "no_active_route", now);
		}
		if (route.idleExpiresAt <= now || route.absoluteExpiresAt <= now) {
			const expiredRoute: TaskRoute = { ...route, state: "expired" };
			state.routes[route.routeId] = expiredRoute;
			this.append(state, { type: "TaskRouteExpired", routeId: route.routeId, taskId: route.taskId }, now);
			return this.commitRejection(state, inboxKey, event, "active_route_expired", now);
		}

		const task = state.tasks[route.taskId];
		const lease = state.leases[route.taskId];
		if (!task || !lease || task.state !== "Active") {
			return this.commitRejection(state, inboxKey, event, "no_active_route", now);
		}
		const expected = expectation ?? { transitionSeq: task.transitionSeq, fenceEpoch: lease.fenceEpoch };
		if (expected.transitionSeq !== task.transitionSeq || expected.fenceEpoch !== lease.fenceEpoch) {
			return this.commitRejection(state, inboxKey, event, "active_turn_compare_and_set_failed", now);
		}

		const nextTransitionSeq = task.transitionSeq + 1;
		const operation = this.createOperation(
			task.taskId,
			nextTransitionSeq,
			lease.fenceEpoch,
			event.payloadDigest,
			"pure",
			now,
		);
		const decision: ActiveTurnAdmittedDecision = {
			kind: "ActiveTurnAdmitted",
			decisionId: this.id("decision"),
			inboundEventId: event.inboundEventId,
			requestId: event.requestId,
			taskId: task.taskId,
			transitionSeq: nextTransitionSeq,
			operationId: operation.operationId,
			recordedAt: now,
		};
		const activeTask: TaskRecord = { ...task, transitionSeq: nextTransitionSeq, updatedAt: now };
		const advancedRoute: TaskRoute = {
			...route,
			idleExpiresAt: Math.min(now + this.policy.activeRouteIdleTtlMs, route.absoluteExpiresAt),
		};
		state.tasks[task.taskId] = activeTask;
		state.operations[operation.operationId] = operation;
		state.routes[route.routeId] = advancedRoute;
		this.append(
			state,
			{
				type: "TaskTransition",
				transition: this.createTransition({
					taskId: task.taskId,
					seq: nextTransitionSeq,
					expectedState: "Active",
					nextState: "Active",
					fenceEpoch: lease.fenceEpoch,
					reason: "ActiveTurnAdmitted",
					actor: this.workerId,
					timestamp: now,
					recordRefs: [decision.decisionId, operation.operationId, route.routeId],
				}),
			},
			now,
		);
		this.append(state, { type: "OperationPrepared", operation }, now);
		this.append(state, { type: "TaskRouteAdvanced", route: advancedRoute }, now);
		this.append(
			state,
			{
				type: "ActiveTurnAdmitted",
				inboxKey,
				decision,
				expectedTransitionSeq: expected.transitionSeq,
				expectedFenceEpoch: expected.fenceEpoch,
			},
			now,
		);
		return this.commitInboxDecision(state, inboxKey, event, decision, now);
	}

	private commitAdmission(
		state: DurableTaskRuntimeState,
		inboxKey: string,
		event: NormalizedInboundEvent,
		now: number,
	): AdmissionCommittedDecision {
		const taskId = this.id("task");
		const sessionRef = `task-session:${taskId}`;
		const artifactRef = `task-artifacts:${taskId}`;
		const retentionPolicy = this.createRetentionPolicy(now);
		const task: TaskRecord = {
			taskId,
			schemaVersion: 1,
			state: "Ready",
			transitionSeq: 1,
			sessionRef,
			artifactRef,
			retentionPolicy,
			sourceCorrelations: [
				{
					transport: event.transport,
					actorRef: event.actorRef,
					correlationDigest: digest(event.correlationRef),
				},
			],
			createdAt: now,
			updatedAt: now,
		};
		const lease: TaskLease = {
			taskId,
			workerId: this.workerId,
			sessionId: sessionRef,
			fenceEpoch: 1,
			acquiredAt: now,
		};
		const route: TaskRoute = {
			routeId: this.id("route"),
			taskId,
			transport: event.transport,
			actorRef: event.actorRef,
			correlationDigest: digest(event.correlationRef),
			authorizationScopeDigest: digest(event.actorRef),
			createdAt: now,
			idleExpiresAt: now + this.policy.activeRouteIdleTtlMs,
			absoluteExpiresAt: now + this.policy.activeRouteMaximumLifetimeMs,
			state: "active",
		};
		const decision: AdmissionCommittedDecision = {
			kind: "AdmissionCommitted",
			decisionId: this.id("decision"),
			inboundEventId: event.inboundEventId,
			requestId: event.requestId,
			taskId,
			transitionSeq: task.transitionSeq,
			recordedAt: now,
		};
		state.tasks[taskId] = task;
		state.leases[taskId] = lease;
		state.routes[route.routeId] = route;
		this.append(state, { type: "TaskCreated", task }, now);
		this.append(state, { type: "TaskLeaseAcquired", lease }, now);
		this.append(state, { type: "TaskRouteCreated", route }, now);
		this.append(
			state,
			{
				type: "TaskTransition",
				transition: this.createTransition({
					taskId,
					seq: task.transitionSeq,
					expectedState: "Absent",
					nextState: "Ready",
					fenceEpoch: lease.fenceEpoch,
					reason: "AdmissionCommitted",
					actor: this.workerId,
					timestamp: now,
					recordRefs: [decision.decisionId, sessionRef, artifactRef, route.routeId],
				}),
			},
			now,
		);
		this.append(
			state,
			{
				type: "AdmissionCommitted",
				inboxKey,
				decision,
				taskId,
				sessionRef,
				artifactRef,
				retentionPolicy,
				initialFenceEpoch: lease.fenceEpoch,
			},
			now,
		);
		return this.commitInboxDecision(state, inboxKey, event, decision, now) as AdmissionCommittedDecision;
	}

	private commitRejection(
		state: DurableTaskRuntimeState,
		inboxKey: string,
		event: NormalizedInboundEvent,
		reason: AdmissionRejectionReason,
		now: number,
	): AdmissionRejectedDecision {
		const decision: AdmissionRejectedDecision = {
			kind: "AdmissionRejected",
			decisionId: this.id("decision"),
			inboundEventId: event.inboundEventId,
			requestId: event.requestId,
			reason,
			recordedAt: now,
		};
		this.append(state, { type: "AdmissionRejected", inboxKey, decision }, now);
		return this.commitInboxDecision(state, inboxKey, event, decision, now) as AdmissionRejectedDecision;
	}

	private commitInboxDecision(
		state: DurableTaskRuntimeState,
		inboxKey: string,
		event: NormalizedInboundEvent,
		decision: InboxDecision,
		now: number,
	): InboxDecision {
		state.inbox[inboxKey] = { inboxKey, event, decision };
		this.append(state, { type: "InboxDecision", inboxKey, decision }, now);
		return structuredClone(decision);
	}

	private findRoute(state: DurableTaskRuntimeState, event: NormalizedInboundEvent): TaskRoute | undefined {
		const correlationDigest = digest(event.correlationRef);
		return Object.values(state.routes).find(
			(route) =>
				route.state === "active" &&
				route.transport === event.transport &&
				route.actorRef === event.actorRef &&
				route.correlationDigest === correlationDigest,
		);
	}

	private createOperation(
		taskId: string,
		transitionSeq: number,
		fenceEpoch: number,
		requestDigest: string,
		operationClass: OperationClass,
		now: number,
	): OperationRecord {
		const operationId = this.id("operation");
		return {
			operationId,
			taskId,
			transitionSeq,
			fenceEpoch,
			idempotencyKey: `${taskId}:${operationId}`,
			class: operationClass,
			state: "Prepared",
			requestDigest,
			startedAt: now,
		};
	}

	private createRetentionPolicy(now: number): TaskRetentionPolicy {
		return {
			policyVersion: this.policy.retentionPolicyVersion,
			continuationEligibleUntil: now + this.policy.continuationRetentionMs,
			evidenceDeleteAt: now + this.policy.evidenceRetentionMs,
			tombstoneDeleteAt: now + this.policy.tombstoneRetentionMs,
		};
	}

	private createTransition(transition: TaskTransition): TaskTransition {
		return transition;
	}

	private append(state: DurableTaskRuntimeState, record: TaskRuntimeRecordInput, at: number): string {
		const recordId = this.id("record");
		state.records.push({ ...record, recordId, at } as TaskRuntimeRecord);
		return recordId;
	}

	private id(kind: TaskRuntimeIdKind): string {
		return this.idGenerator(kind);
	}
}

export function createInboxKey(event: Pick<NormalizedInboundEvent, "transport" | "inboundEventId">): string {
	return JSON.stringify([event.transport, event.inboundEventId]);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertNormalizedInboundEvent(event: NormalizedInboundEvent): void {
	assertNonEmptyString(event.inboundEventId, "inboundEventId");
	assertNonEmptyString(event.requestId, "requestId");
	assertNonEmptyString(event.transport, "transport");
	assertNonEmptyString(event.actorRef, "actorRef");
	assertNonEmptyString(event.correlationRef, "correlationRef");
	assertNonEmptyString(event.payloadDigest, "payloadDigest");
	if (!Number.isFinite(event.receivedAt)) throw new Error("receivedAt must be a finite timestamp");
}

function assertNonEmptyString(value: string, name: string): void {
	if (!value) throw new Error(`${name} is required`);
}
