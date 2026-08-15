import { randomUUID } from "node:crypto";
import type { TaskRuntime } from "./runtime.js";
import type {
	OperationClass,
	OperationRecord,
	StartOperationInput,
	StartOperationResult,
	TaskLease,
	TaskRecord,
	TaskRoute,
} from "./types.js";

export interface TaskRuntimeExternalReceipt {
	receiptRef: string;
}

export interface TaskRuntimeKernelBinding {
	bindingId: string;
	taskId: string;
	operationId: string;
	sessionRef: string;
	artifactRef: string;
	routeId: string;
	authorizationScopeDigest: string;
	fenceEpoch: number;
	kernelId: string;
	capabilityId: string;
	permittedOperationClasses: readonly OperationClass[];
}

export interface TaskRuntimeCapabilityBinding {
	bindingId: string;
	taskId: string;
	capabilityId: string;
	authorizationScopeDigest: string;
	permittedOperationClasses: readonly OperationClass[];
	artifactRouteRef: string;
}

export interface TaskRuntimeArtifactManifestEntry {
	taskId: string;
	artifactRef: string;
	bindingId: string;
}

export interface TaskRuntimeRouteBinding {
	bindingId: string;
	taskId: string;
	routeId: string;
	authorizationScopeDigest: string;
	fenceEpoch: number;
}

export interface TaskRuntimeHostAdapters {
	kernel: {
		bind(input: { task: TaskRecord; lease: TaskLease; route: TaskRoute }): Promise<{
			kernelId: string;
			capabilityId: string;
			permittedOperationClasses: readonly OperationClass[];
		}>;
	};
	provider: {
		invoke(input: {
			binding: TaskRuntimeKernelBinding;
			operation: OperationRecord;
		}): Promise<TaskRuntimeExternalReceipt>;
	};
	effect: {
		execute(input: {
			binding: TaskRuntimeKernelBinding;
			operation: OperationRecord;
			providerReceipt: TaskRuntimeExternalReceipt;
		}): Promise<TaskRuntimeExternalReceipt>;
	};
	delivery: {
		deliver(input: {
			binding: TaskRuntimeKernelBinding;
			operation: OperationRecord;
			effectReceipt: TaskRuntimeExternalReceipt;
		}): Promise<TaskRuntimeExternalReceipt>;
	};
}

export interface TaskRuntimeHostOptions {
	runtime: TaskRuntime;
	adapters: TaskRuntimeHostAdapters;
	bindingIdGenerator?: () => string;
}

export interface TaskRuntimeExecutionResult extends StartOperationResult {
	binding: TaskRuntimeKernelBinding;
	receipts: {
		provider: TaskRuntimeExternalReceipt;
		effect: TaskRuntimeExternalReceipt;
		delivery: TaskRuntimeExternalReceipt;
	};
}

/**
 * Host-owned bridge from a durably prepared task operation to live execution adapters.
 *
 * This deliberately does not model effect reconciliation or terminal outcomes. It gives
 * the host a narrow, observable boundary: a lease-protected operation is durably prepared
 * and claimed first, then one task-scoped kernel/capability/artifact binding is used for provider, effect,
 * and delivery calls. Concrete production adapters can bind AgentSession/IPython and
 * transport delivery without giving an adapter authority over task identity or routing.
 */
export class TaskRuntimeHost {
	private readonly runtime: TaskRuntime;
	private readonly adapters: TaskRuntimeHostAdapters;
	private readonly bindingIdGenerator: () => string;
	private readonly bindings = new Map<string, TaskRuntimeKernelBinding>();
	private readonly pendingBindings = new Map<string, Promise<TaskRuntimeKernelBinding>>();

	constructor(options: TaskRuntimeHostOptions) {
		this.runtime = options.runtime;
		this.adapters = options.adapters;
		this.bindingIdGenerator = options.bindingIdGenerator ?? randomUUID;
	}

	async startAndExecute(input: StartOperationInput): Promise<TaskRuntimeExecutionResult> {
		const prepared = await this.runtime.startOperation(input);
		return this.executeClaimed(
			await this.runtime.claimExecution({
				taskId: prepared.task.taskId,
				operationId: prepared.operation.operationId,
			}),
		);
	}

	async executePrepared(input: { taskId: string; operationId: string }): Promise<TaskRuntimeExecutionResult> {
		return this.executeClaimed(await this.runtime.claimExecution(input));
	}

	private async executeClaimed(started: StartOperationResult): Promise<TaskRuntimeExecutionResult> {
		const binding = await this.ensureBinding(started.task, started.operation);
		if (binding.operationId !== started.operation.operationId) {
			await this.runtime.recordExecutionObservation({
				taskId: started.operation.taskId,
				operationId: started.operation.operationId,
				fenceEpoch: started.operation.fenceEpoch,
				bindingId: binding.bindingId,
				kind: "KernelBindingReused",
			});
		}
		if (!binding.permittedOperationClasses.includes(started.operation.class)) {
			throw new Error(
				`Capability ${binding.capabilityId} does not permit operation class ${started.operation.class}`,
			);
		}
		const provider = await this.callAdapter(
			binding,
			started.operation,
			"ProviderStarted",
			"ProviderSucceeded",
			"ProviderFailed",
			() => this.adapters.provider.invoke({ binding: structuredClone(binding), operation: started.operation }),
		);
		const effect = await this.callAdapter(
			binding,
			started.operation,
			"EffectStarted",
			"EffectSucceeded",
			"EffectFailed",
			() =>
				this.adapters.effect.execute({
					binding: structuredClone(binding),
					operation: started.operation,
					providerReceipt: structuredClone(provider),
				}),
		);
		const delivery = await this.callAdapter(
			binding,
			started.operation,
			"DeliveryStarted",
			"DeliverySucceeded",
			"DeliveryFailed",
			() =>
				this.adapters.delivery.deliver({
					binding: structuredClone(binding),
					operation: started.operation,
					effectReceipt: structuredClone(effect),
				}),
		);
		return {
			...started,
			binding: structuredClone(binding),
			receipts: {
				provider: structuredClone(provider),
				effect: structuredClone(effect),
				delivery: structuredClone(delivery),
			},
		};
	}

	kernelBindings(): readonly TaskRuntimeKernelBinding[] {
		return structuredClone([...this.bindings.values()]);
	}

	capabilityBindings(): readonly TaskRuntimeCapabilityBinding[] {
		return this.kernelBindings().map((binding) => ({
			bindingId: binding.bindingId,
			taskId: binding.taskId,
			capabilityId: binding.capabilityId,
			authorizationScopeDigest: binding.authorizationScopeDigest,
			permittedOperationClasses: binding.permittedOperationClasses,
			artifactRouteRef: binding.artifactRef,
		}));
	}

	artifactManifest(): readonly TaskRuntimeArtifactManifestEntry[] {
		return this.kernelBindings().map((binding) => ({
			taskId: binding.taskId,
			artifactRef: binding.artifactRef,
			bindingId: binding.bindingId,
		}));
	}

	routeBindings(): readonly TaskRuntimeRouteBinding[] {
		return this.kernelBindings().map((binding) => ({
			bindingId: binding.bindingId,
			taskId: binding.taskId,
			routeId: binding.routeId,
			authorizationScopeDigest: binding.authorizationScopeDigest,
			fenceEpoch: binding.fenceEpoch,
		}));
	}

	resolveArtifactRoute(input: { taskId: string; bindingId: string }): string {
		const binding = this.bindings.get(input.taskId);
		if (!binding || binding.bindingId !== input.bindingId) {
			throw new Error(`Task ${input.taskId} does not own binding ${input.bindingId}`);
		}
		return binding.artifactRef;
	}

	private async ensureBinding(task: TaskRecord, operation: OperationRecord): Promise<TaskRuntimeKernelBinding> {
		const snapshot = await this.runtime.snapshot();
		const lease = snapshot.leases[task.taskId];
		const routes = Object.values(snapshot.routes).filter(
			(route) => route.taskId === task.taskId && route.state === "active",
		);
		if (!lease || routes.length !== 1 || lease.fenceEpoch !== operation.fenceEpoch) {
			throw new Error(`Task ${task.taskId} has no live lease and route for ${operation.operationId}`);
		}
		const existing = this.bindings.get(task.taskId);
		if (existing?.fenceEpoch === lease.fenceEpoch) return existing;
		if (existing) this.bindings.delete(task.taskId);
		const pendingKey = `${task.taskId}:${lease.fenceEpoch}`;
		const pending = this.pendingBindings.get(pendingKey);
		if (pending) return pending;
		const bindingPromise = this.createBinding(task, operation, lease, routes[0]);
		this.pendingBindings.set(pendingKey, bindingPromise);
		try {
			return await bindingPromise;
		} finally {
			if (this.pendingBindings.get(pendingKey) === bindingPromise) this.pendingBindings.delete(pendingKey);
		}
	}

	private async createBinding(
		task: TaskRecord,
		operation: OperationRecord,
		lease: TaskLease,
		route: TaskRoute,
	): Promise<TaskRuntimeKernelBinding> {
		const bindingId = this.bindingIdGenerator();
		await this.runtime.recordExecutionObservation({
			taskId: operation.taskId,
			operationId: operation.operationId,
			fenceEpoch: operation.fenceEpoch,
			bindingId,
			kind: "KernelBindingStarted",
		});
		let kernel: { kernelId: string; capabilityId: string; permittedOperationClasses: readonly OperationClass[] };
		try {
			kernel = await this.adapters.kernel.bind({
				task: structuredClone(task),
				lease: structuredClone(lease),
				route: structuredClone(route),
			});
			assertKernelDescriptor(kernel);
		} catch (error) {
			await this.runtime.recordExecutionObservation({
				taskId: operation.taskId,
				operationId: operation.operationId,
				fenceEpoch: operation.fenceEpoch,
				bindingId,
				kind: "KernelBindingFailed",
				failureKind: error instanceof Error ? error.name : "UnknownError",
			});
			throw error;
		}
		const binding: TaskRuntimeKernelBinding = {
			bindingId,
			taskId: task.taskId,
			operationId: operation.operationId,
			sessionRef: task.sessionRef,
			artifactRef: task.artifactRef,
			routeId: route.routeId,
			authorizationScopeDigest: route.authorizationScopeDigest,
			fenceEpoch: lease.fenceEpoch,
			kernelId: kernel.kernelId,
			capabilityId: kernel.capabilityId,
			permittedOperationClasses: structuredClone(kernel.permittedOperationClasses),
		};
		await this.runtime.recordExecutionBinding(binding);
		await this.runtime.recordExecutionObservation({
			taskId: operation.taskId,
			operationId: operation.operationId,
			fenceEpoch: operation.fenceEpoch,
			bindingId,
			kind: "KernelBindingSucceeded",
			receiptRef: kernel.kernelId,
		});
		this.bindings.set(task.taskId, binding);
		return binding;
	}

	private async callAdapter(
		binding: TaskRuntimeKernelBinding,
		operation: OperationRecord,
		startedKind: "ProviderStarted" | "EffectStarted" | "DeliveryStarted",
		succeededKind: "ProviderSucceeded" | "EffectSucceeded" | "DeliverySucceeded",
		failedKind: "ProviderFailed" | "EffectFailed" | "DeliveryFailed",
		action: () => Promise<TaskRuntimeExternalReceipt>,
	): Promise<TaskRuntimeExternalReceipt> {
		await this.runtime.recordExecutionObservation({
			taskId: operation.taskId,
			operationId: operation.operationId,
			fenceEpoch: operation.fenceEpoch,
			bindingId: binding.bindingId,
			kind: startedKind,
		});
		let receipt: TaskRuntimeExternalReceipt;
		try {
			receipt = await action();
		} catch (error) {
			await this.runtime.recordExecutionObservation({
				taskId: operation.taskId,
				operationId: operation.operationId,
				fenceEpoch: operation.fenceEpoch,
				bindingId: binding.bindingId,
				kind: failedKind,
				failureKind: error instanceof Error ? error.name : "UnknownError",
			});
			throw error;
		}
		await this.runtime.recordExecutionObservation({
			taskId: operation.taskId,
			operationId: operation.operationId,
			fenceEpoch: operation.fenceEpoch,
			bindingId: binding.bindingId,
			kind: succeededKind,
			receiptRef: receipt.receiptRef,
		});
		return receipt;
	}
}

function assertKernelDescriptor(value: {
	kernelId: string;
	capabilityId: string;
	permittedOperationClasses: readonly OperationClass[];
}): void {
	if (!value.kernelId) throw new Error("Kernel binding requires kernelId");
	if (!value.capabilityId) throw new Error("Kernel binding requires capabilityId");
	if (!Array.isArray(value.permittedOperationClasses))
		throw new Error("Kernel binding requires permitted operation classes");
}
