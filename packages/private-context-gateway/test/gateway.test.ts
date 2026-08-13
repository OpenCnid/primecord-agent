import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { type Principal, StaticTokenVerifier } from "../src/auth.js";
import { loadPcgConfig, type PcgConfig } from "../src/config.js";
import { createPcgServer } from "../src/gateway.js";
import { PcgStore } from "../src/store.js";

const dataDirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	await Promise.all(dataDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function config(dataDir: string): PcgConfig {
	return loadPcgConfig({
		PRIME_PCG_PUBLIC_URL: "https://pcg.example.test",
		PRIME_PCG_AUDIENCE: "https://pcg.example.test/mcp",
		PRIME_PCG_ISSUER: "https://id.example.test",
		PRIME_PCG_JWKS_URL: "https://id.example.test/.well-known/jwks.json",
		PRIME_PCG_DATA_DIR: dataDir,
		PRIME_PCG_MASTER_KEY: Buffer.alloc(32, 7).toString("base64url"),
		PRIME_PCG_ALLOWED_CLIENT_IDS: "approved-agent",
		PRIME_PCG_CONNECTOR_CLIENT_IDS: "primecord-connector",
		PRIME_PCG_ALLOWED_ORIGINS: "https://agent.example.test",
		PRIME_PCG_TENANT: "private",
	});
}

async function service() {
	const dataDir = await mkdtemp(join(tmpdir(), "pcg-test-"));
	dataDirs.push(dataDir);
	const pcgConfig = config(dataDir);
	const store = new PcgStore(pcgConfig);
	await store.initialize();
	const tokens = new Map<string, Principal>([
		[
			"connector",
			{ subject: "connector:local", clientId: "primecord-connector", scopes: new Set(["pcg.snapshot.write"]) },
		],
		["search", { subject: "user:alice", clientId: "approved-agent", scopes: new Set(["memory:search"]) }],
		[
			"reader",
			{ subject: "user:alice", clientId: "approved-agent", scopes: new Set(["memory:search", "memory:read"]) },
		],
		["bob", { subject: "user:bob", clientId: "approved-agent", scopes: new Set(["memory:search", "memory:read"]) }],
	]);
	const server = createPcgServer({ config: pcgConfig, store, verifier: new StaticTokenVerifier(tokens) });
	servers.push(server);
	return { pcgConfig, store, server };
}

async function fetchServer(
	server: Server,
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
	await new Promise<void>((resolve) => (server.listening ? resolve() : server.listen(0, "127.0.0.1", resolve)));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server unavailable");
	return new Promise<Response>((resolve, reject) => {
		const request = httpRequest(
			{ hostname: "127.0.0.1", port: address.port, path, method: init.method ?? "GET", headers: init.headers },
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve(
						new Response(Buffer.concat(chunks), {
							status: response.statusCode,
							headers: response.headers as Record<string, string>,
						}),
					),
				);
			},
		);
		request.on("error", reject);
		request.end(init.body);
	});
}

function requestBody(method: string, params: unknown, id = 1) {
	return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const headers = (token: string, protocol?: string) => ({
	"content-type": "application/json",
	accept: "application/json, text/event-stream",
	authorization: `Bearer ${token}`,
	host: "pcg.example.test",
	...(protocol ? { "mcp-protocol-version": protocol } : {}),
});

describe("Primecord PCG v1", () => {
	it("publishes protected-resource metadata and rejects unauthenticated MCP", async () => {
		const { server } = await service();
		const metadata = await fetchServer(server, "/.well-known/oauth-protected-resource/mcp", {
			headers: { host: "pcg.example.test" },
		});
		expect(metadata.status).toBe(200);
		expect(await metadata.json()).toEqual({
			resource: "https://pcg.example.test/mcp",
			authorization_servers: ["https://id.example.test"],
			scopes_supported: ["memory:search", "memory:read"],
			bearer_methods_supported: ["header"],
		});
		const denied = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: { "content-type": "application/json", host: "pcg.example.test" },
			body: requestBody("initialize", {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			}),
		});
		expect(denied.status).toBe(401);
		expect(denied.headers.get("www-authenticate")).toContain("resource_metadata");
	});

	it("accepts only explicit connector snapshots and never stores plaintext", async () => {
		const { server, pcgConfig } = await service();
		const id = "x".repeat(16);
		const ingest = await fetchServer(server, "/connector/v1/snapshots", {
			method: "POST",
			headers: headers("connector"),
			body: JSON.stringify({
				id,
				owner: "user:alice",
				readers: [],
				expiresAt: "2030-01-01T00:00:00.000Z",
				citation: "approved export",
				content: "Secret project pineapple roadmap",
			}),
		});
		expect(ingest.status).toBe(201);
		const journal = await readFile(join(pcgConfig.dataDir, "snapshots.v1.jsonl"), "utf8");
		expect(journal).not.toContain("pineapple");
		expect(journal).not.toContain("user:alice");
		const nonConnector = await fetchServer(server, "/connector/v1/snapshots", {
			method: "POST",
			headers: headers("reader"),
			body: JSON.stringify({}),
		});
		expect(nonConnector.status).toBe(401);
	});

	it("requires protocol 2025-11-25 and allows stateless direct JSON initialization", async () => {
		const { server } = await service();
		const response = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: headers("reader"),
			body: requestBody("initialize", {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			}),
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("mcp-session-id")).toBeNull();
		const wrongVersion = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: headers("reader"),
			body: requestBody("initialize", {
				protocolVersion: "2026-07-28",
				capabilities: {},
				clientInfo: { name: "test", version: "1" },
			}),
		});
		expect(wrongVersion.status).toBe(400);
	});

	it("works with the official stateless Streamable HTTP client", async () => {
		const { server, pcgConfig } = await service();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test server unavailable");
		(pcgConfig.allowedHosts as Set<string>).add(`127.0.0.1:${address.port}`);
		const client = new Client({ name: "pcg-integration-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
			requestInit: { headers: { authorization: "Bearer reader" } },
		});
		try {
			await client.connect(transport);
			expect(transport.sessionId).toBeUndefined();
			const inventory = await client.listTools();
			expect(inventory.tools.map((tool) => tool.name)).toEqual(["primecord.memory.search", "primecord.memory.read"]);
		} finally {
			await client.close();
		}
	});

	it("enforces independent tool scope plus subject ACL for search and read", async () => {
		const { server } = await service();
		const id = "z".repeat(16);
		await fetchServer(server, "/connector/v1/snapshots", {
			method: "POST",
			headers: headers("connector"),
			body: JSON.stringify({
				id,
				owner: "user:alice",
				readers: [],
				expiresAt: "2030-01-01T00:00:00.000Z",
				citation: "approved export",
				content: "Pineapple roadmap for the project",
			}),
		});
		const search = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: headers("search", "2025-11-25"),
			body: requestBody("tools/call", { name: "primecord.memory.search", arguments: { query: "pineapple" } }),
		});
		expect(search.status).toBe(200);
		expect(await search.text()).toContain(id);
		const noRead = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: headers("search", "2025-11-25"),
			body: requestBody("tools/call", { name: "primecord.memory.read", arguments: { handle: id } }),
		});
		expect(await noRead.text()).toContain("Tool primecord.memory.read not found");
		const outsider = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: headers("bob", "2025-11-25"),
			body: requestBody("tools/call", { name: "primecord.memory.read", arguments: { handle: id } }),
		});
		expect(await outsider.text()).toContain("not found, expired, or is not authorized");
		const allowed = await fetchServer(server, "/mcp", {
			method: "POST",
			headers: headers("reader", "2025-11-25"),
			body: requestBody("tools/call", { name: "primecord.memory.read", arguments: { handle: id } }),
		});
		expect(await allowed.text()).toContain("Pineapple roadmap");
	});
});
