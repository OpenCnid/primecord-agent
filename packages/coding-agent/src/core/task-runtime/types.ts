export type RequestedControl = "new" | "turn";

export interface NormalizedInboundEvent {
	inboundEventId: string;
	requestId: string;
	transport: string;
	actorRef: string;
	correlationRef: string;
	requestedControl: RequestedControl;
	payloadDigest: string;
	receivedAt: number;
}

export type TaskState = "Ready" | "Active";

export interface TaskRetentionPolicy {
	policyVersion: string;
	continuationEligibleUntil: number;
	evidenceDeleteAt: number;
	tombstoneDeleteAt: number;
}

export interface SourceCorrelation {
	transport: string;
	actorRef: string;
	correlationDigest: string;
}

export interface TaskRecord {
	taskId: string;
	schemaVersion: 1;
	state: TaskState;
	transitionSeq: number;
	sessionRef: string;
	artifactRef: string;
	retentionPolicy: TaskRetentionPolicy;
	sourceCorrelations: readonly SourceCorrelation[];
	createdAt: number;
	updatedAt: number;
}

export interface TaskLease {
	taskId: string;
	workerId: string;
	sessionId: string;
	fenceEpoch: number;
	acquiredAt: number;
	expiresAt?: number;
}

export interface TaskRoute {
	routeId: string;
	taskId: string;
	transport: string;
	actorRef: string;
	correlationDigest: string;
	authorizationScopeDigest: string;
	createdAt: number;
	idleExpiresAt: number;
	absoluteExpiresAt: number;
	state: "active" | "expired" | "revoked";
}

export type OperationClass = "pure" | "idempotent-external" | "non-idempotent-external";

export interface OperationRecord {
	operationId: string;
	taskId: string;
	transitionSeq: number;
	fenceEpoch: number;
	idempotencyKey: string;
	class: OperationClass;
	state: "Prepared";
	requestDigest: string;
	startedAt: number;
}

export interface TaskTransition {
	taskId: string;
	seq: number;
	expectedState: "Absent" | TaskState;
	nextState: TaskState;
	fenceEpoch: number;
	reason: "AdmissionCommitted" | "OperationStarted" | "ActiveTurnAdmitted";
	actor: string;
	timestamp: number;
	recordRefs: readonly string[];
}

export type AdmissionRejectionReason =
	| "unauthorized_actor"
	| "unsupported_control"
	| "no_active_route"
	| "active_route_expired"
	| "active_turn_compare_and_set_failed";

interface InboxDecisionBase {
	decisionId: string;
	inboundEventId: string;
	requestId: string;
	recordedAt: number;
}

export interface AdmissionRejectedDecision extends InboxDecisionBase {
	kind: "AdmissionRejected";
	reason: AdmissionRejectionReason;
}

export interface AdmissionCommittedDecision extends InboxDecisionBase {
	kind: "AdmissionCommitted";
	taskId: string;
	transitionSeq: number;
}

export interface ActiveTurnAdmittedDecision extends InboxDecisionBase {
	kind: "ActiveTurnAdmitted";
	taskId: string;
	transitionSeq: number;
	operationId: string;
}

export type InboxDecision = AdmissionRejectedDecision | AdmissionCommittedDecision | ActiveTurnAdmittedDecision;

export interface InboxConflict {
	kind: "InboxConflict";
	inboundEventId: string;
	requestId: string;
	inboxKey: string;
	expectedPayloadDigest: string;
	actualPayloadDigest: string;
	recordedAt: number;
}

export type AdmissionResult = InboxDecision | InboxConflict;

export interface InboxEntry {
	inboxKey: string;
	event: NormalizedInboundEvent;
	decision: InboxDecision;
}

interface DurableRecordBase {
	recordId: string;
	at: number;
}

export interface InboxReceivedRecord extends DurableRecordBase {
	type: "InboxReceived";
	inboxKey: string;
	event: NormalizedInboundEvent;
}

export interface InboxDecisionRecord extends DurableRecordBase {
	type: "InboxDecision";
	inboxKey: string;
	decision: InboxDecision;
}

export interface AdmissionRejectedRecord extends DurableRecordBase {
	type: "AdmissionRejected";
	inboxKey: string;
	decision: AdmissionRejectedDecision;
}

export interface InboxConflictRejectedRecord extends DurableRecordBase {
	type: "InboxConflictRejected";
	conflict: InboxConflict;
}

export interface TaskCreatedRecord extends DurableRecordBase {
	type: "TaskCreated";
	task: TaskRecord;
}

export interface TaskLeaseAcquiredRecord extends DurableRecordBase {
	type: "TaskLeaseAcquired";
	lease: TaskLease;
}

export interface TaskRouteCreatedRecord extends DurableRecordBase {
	type: "TaskRouteCreated";
	route: TaskRoute;
}

export interface TaskRouteAdvancedRecord extends DurableRecordBase {
	type: "TaskRouteAdvanced";
	route: TaskRoute;
}

export interface TaskRouteExpiredRecord extends DurableRecordBase {
	type: "TaskRouteExpired";
	routeId: string;
	taskId: string;
}

export interface TaskTransitionRecord extends DurableRecordBase {
	type: "TaskTransition";
	transition: TaskTransition;
}

export interface AdmissionCommittedRecord extends DurableRecordBase {
	type: "AdmissionCommitted";
	inboxKey: string;
	decision: AdmissionCommittedDecision;
	taskId: string;
	sessionRef: string;
	artifactRef: string;
	retentionPolicy: TaskRetentionPolicy;
	initialFenceEpoch: number;
}

export interface OperationPreparedRecord extends DurableRecordBase {
	type: "OperationPrepared";
	operation: OperationRecord;
}

export interface ActiveTurnAdmittedRecord extends DurableRecordBase {
	type: "ActiveTurnAdmitted";
	inboxKey: string;
	decision: ActiveTurnAdmittedDecision;
	expectedTransitionSeq: number;
	expectedFenceEpoch: number;
}

export type TaskRuntimeRecord =
	| InboxReceivedRecord
	| InboxDecisionRecord
	| AdmissionRejectedRecord
	| InboxConflictRejectedRecord
	| TaskCreatedRecord
	| TaskLeaseAcquiredRecord
	| TaskRouteCreatedRecord
	| TaskRouteAdvancedRecord
	| TaskRouteExpiredRecord
	| TaskTransitionRecord
	| AdmissionCommittedRecord
	| OperationPreparedRecord
	| ActiveTurnAdmittedRecord;

export interface DurableTaskRuntimeState {
	version: 1;
	inbox: Record<string, InboxEntry>;
	tasks: Record<string, TaskRecord>;
	leases: Record<string, TaskLease>;
	routes: Record<string, TaskRoute>;
	operations: Record<string, OperationRecord>;
	records: TaskRuntimeRecord[];
}

export interface TaskRuntimeSnapshot {
	readonly inbox: Readonly<Record<string, InboxEntry>>;
	readonly tasks: Readonly<Record<string, TaskRecord>>;
	readonly leases: Readonly<Record<string, TaskLease>>;
	readonly routes: Readonly<Record<string, TaskRoute>>;
	readonly operations: Readonly<Record<string, OperationRecord>>;
	readonly records: readonly TaskRuntimeRecord[];
}

export interface ActiveTurnExpectation {
	transitionSeq: number;
	fenceEpoch: number;
}

export interface TaskRuntimePolicy {
	isAdmissionAuthorized(event: NormalizedInboundEvent): boolean | Promise<boolean>;
	noActiveRoute: "reject" | "new_admission";
	activeRouteIdleTtlMs: number;
	activeRouteMaximumLifetimeMs: number;
	retentionPolicyVersion: string;
	continuationRetentionMs: number;
	evidenceRetentionMs: number;
	tombstoneRetentionMs: number;
}

export interface TaskRuntimeClock {
	now(): number;
}

export type TaskRuntimeIdKind = "decision" | "operation" | "record" | "route" | "task";
export type TaskRuntimeIdGenerator = (kind: TaskRuntimeIdKind) => string;

export interface StartOperationInput {
	taskId: string;
	expectedTransitionSeq: number;
	expectedFenceEpoch: number;
	requestDigest: string;
	operationClass?: OperationClass;
}

export interface StartOperationResult {
	task: TaskRecord;
	operation: OperationRecord;
}
