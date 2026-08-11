import { describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import type { DaemonClientCapability, DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

type DiscordGatewayBrokerRequest = Extract<
	DaemonOutbound,
	{ type: "discord_gateway_read_request" | "discord_gateway_thread_creation_request" }
>;

interface BrokerRequestOwner {
	client: DaemonSocketClient;
	worker: object;
	activeSessionId: string;
	requestId: string;
	targetId: string;
	type: DiscordGatewayBrokerRequest["type"];
}

interface BrokerHarness {
	extensionUiTargets: Map<string, { client: DaemonSocketClient; activeSessionId: string; expiresAt: number }>;
	clients: Set<DaemonSocketClient>;
	discordGatewayRequestOwners: Map<string, BrokerRequestOwner>;
	respondToWorkerDiscordGatewayRequest: ReturnType<typeof vi.fn>;
	createExtensionUiTarget(client: DaemonSocketClient, activeSessionId: string): string | null;
	routeDiscordGatewayRequest(worker: object, request: DiscordGatewayBrokerRequest): DaemonSocketClient | undefined;
	handleWorkerFrame(worker: object, frame: object): void;
	cancelClientDiscordGatewayRequests(
		client: DaemonSocketClient,
		activeSessionId: string | undefined,
		message: string,
	): void;
	handleCommand(
		client: DaemonSocketClient,
		command: {
			type: "discord_gateway_thread_creation_response";
			activeSessionId: string;
			requestId: string;
			response: { ok: false; code: "UNAVAILABLE"; message: string };
		},
	): Promise<unknown>;
}

function gatewayClient(activeSessionId: string, capabilities: readonly DaemonClientCapability[]): DaemonSocketClient {
	return {
		id: "gateway",
		attachedActiveSessionIds: new Set([activeSessionId]),
		capabilities: new Set(capabilities),
		capabilitiesByActiveSessionId: new Map([[activeSessionId, new Set(capabilities)]]),
	} as unknown as DaemonSocketClient;
}

function threadRequest(activeSessionId: string, targetClientId?: string): DiscordGatewayBrokerRequest {
	return {
		type: "discord_gateway_thread_creation_request",
		activeSessionId,
		id: "request-1",
		request: { title: "Planning" },
		...(targetClientId ? { targetClientId } : {}),
	};
}

describe("daemon supervisor Discord broker routing", () => {
	it("creates a prompt target for a Discord capability without extension UI", () => {
		const activeSessionId = "active-1";
		const client = gatewayClient(activeSessionId, ["discord_gateway_read"]);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			extensionUiTargets: new Map(),
		}) as BrokerHarness;

		const targetId = supervisor.createExtensionUiTarget(client, activeSessionId);
		expect(targetId).toEqual(expect.any(String));
		expect(supervisor.extensionUiTargets.get(targetId!)).toMatchObject({ client, activeSessionId });
	});

	it("routes a thread request only to the opaque target with the required capability", () => {
		const activeSessionId = "active-1";
		const client = gatewayClient(activeSessionId, ["discord_gateway_thread_creation"]);
		const worker = {};
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			extensionUiTargets: new Map([["target-1", { client, activeSessionId, expiresAt: Date.now() + 10_000 }]]),
			clients: new Set([client]),
			discordGatewayRequestOwners: new Map(),
			respondToWorkerDiscordGatewayRequest: vi.fn(),
		}) as BrokerHarness;

		expect(supervisor.routeDiscordGatewayRequest(worker, threadRequest(activeSessionId, "target-1"))).toBe(client);
		expect(supervisor.discordGatewayRequestOwners.get(`${activeSessionId}:request-1`)).toMatchObject({
			client,
			worker,
			activeSessionId,
			requestId: "request-1",
			targetId: "target-1",
			type: "discord_gateway_thread_creation_request",
		});
		expect(supervisor.respondToWorkerDiscordGatewayRequest).not.toHaveBeenCalled();
	});

	it("delivers a broker event only to its target and strips the routing token", () => {
		const activeSessionId = "active-1";
		const target = gatewayClient(activeSessionId, ["discord_gateway_thread_creation"]);
		const observer = gatewayClient(activeSessionId, ["discord_gateway_thread_creation"]);
		observer.id = "observer";
		const writeSerialized = vi.fn<(client: DaemonSocketClient, payload: Buffer) => boolean>(() => true);
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			extensionUiTargets: new Map([
				["target-1", { client: target, activeSessionId, expiresAt: Date.now() + 10_000 }],
			]),
			clients: new Set([target, observer]),
			discordGatewayRequestOwners: new Map(),
			respondToWorkerDiscordGatewayRequest: vi.fn(),
			streamReconstructor: { observe: vi.fn() },
			invalidateWorkerSnapshot: vi.fn(),
			writeSerialized,
		}) as BrokerHarness;
		const worker = {};
		const request = threadRequest(activeSessionId, "target-1");

		supervisor.handleWorkerFrame(worker, {
			header: {
				kind: "outbound",
				outboundType: request.type,
				activeSessionId,
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(`${JSON.stringify(request)}\n`),
		});

		expect(writeSerialized).toHaveBeenCalledOnce();
		expect(writeSerialized.mock.calls[0]![0]).toBe(target);
		expect(JSON.parse(writeSerialized.mock.calls[0]![1].toString())).toEqual({
			type: request.type,
			activeSessionId,
			id: request.id,
			request: request.request,
		});
	});

	it("cancels every pending broker request when its client disconnects", () => {
		const activeSessionId = "active-1";
		const client = gatewayClient(activeSessionId, ["discord_gateway_read"]);
		const worker = {};
		const respondToWorkerDiscordGatewayRequest = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			discordGatewayRequestOwners: new Map([
				[
					`${activeSessionId}:request-1`,
					{
						client,
						worker,
						activeSessionId,
						requestId: "request-1",
						targetId: "target-1",
						type: "discord_gateway_read_request",
					},
				],
			]),
			respondToWorkerDiscordGatewayRequest,
		}) as BrokerHarness;

		supervisor.cancelClientDiscordGatewayRequests(client, undefined, "disconnected");
		expect(supervisor.discordGatewayRequestOwners).toHaveLength(0);
		expect(respondToWorkerDiscordGatewayRequest).toHaveBeenCalledWith(
			worker,
			{ type: "discord_gateway_read_request", activeSessionId, id: "request-1" },
			"disconnected",
		);
	});

	it("accepts a broker response only from its selected client and matching request kind", async () => {
		const activeSessionId = "active-1";
		const requestId = "request-1";
		const selected = gatewayClient(activeSessionId, ["discord_gateway_thread_creation"]);
		const other = gatewayClient(activeSessionId, ["discord_gateway_thread_creation"]);
		other.id = "other";
		const worker = {};
		const forwardToWorker = vi.fn(async () => ({
			type: "response",
			command: "discord_gateway_thread_creation_response",
			success: true,
		}));
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			discordGatewayRequestOwners: new Map([
				[
					`${activeSessionId}:${requestId}`,
					{
						client: selected,
						worker,
						activeSessionId,
						requestId,
						targetId: "target-1",
						type: "discord_gateway_thread_creation_request",
					},
				],
			]),
			findWorkerForClient: vi.fn(async () => ({
				worker,
				summary: { id: activeSessionId, activeSessionId },
			})),
			forwardToWorker,
		}) as BrokerHarness;
		const response = {
			type: "discord_gateway_thread_creation_response" as const,
			activeSessionId,
			requestId,
			response: { ok: false as const, code: "UNAVAILABLE" as const, message: "cancelled" },
		};

		await expect(supervisor.handleCommand(other, response)).rejects.toThrow("belongs to another client");
		expect(forwardToWorker).not.toHaveBeenCalled();
		await expect(supervisor.handleCommand(selected, response)).resolves.toMatchObject({ success: true });
		expect(forwardToWorker).toHaveBeenCalledOnce();
		expect(supervisor.discordGatewayRequestOwners).toHaveLength(0);
	});

	it("rejects a broker request without an authorized opaque target", () => {
		const activeSessionId = "active-1";
		const worker = {};
		const respondToWorkerDiscordGatewayRequest = vi.fn();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			extensionUiTargets: new Map(),
			clients: new Set(),
			discordGatewayRequestOwners: new Map(),
			respondToWorkerDiscordGatewayRequest,
		}) as BrokerHarness;
		const request = threadRequest(activeSessionId);

		expect(supervisor.routeDiscordGatewayRequest(worker, request)).toBeUndefined();
		expect(supervisor.discordGatewayRequestOwners).toHaveLength(0);
		expect(respondToWorkerDiscordGatewayRequest).toHaveBeenCalledWith(
			worker,
			request,
			expect.stringContaining("unavailable"),
		);
	});
});
