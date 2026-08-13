import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { OAuthError, type Principal, type TokenVerifier } from "./auth.js";
import { PCG_PROTOCOL_VERSION, type PcgConfig } from "./config.js";
import type { PcgStore, SnapshotInput } from "./store.js";

const MCP_READ_SCOPES = ["memory:search", "memory:read"] as const;
const CONNECTOR_SCOPE = "pcg.snapshot.write";
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{16,128}$/;

export interface PcgGatewayOptions {
	config: PcgConfig;
	store: PcgStore;
	verifier: TokenVerifier;
}

export function createPcgHandler(
	options: PcgGatewayOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
	return async (request, response) => {
		try {
			if (!validateHostAndOrigin(request, options.config)) {
				return sendJson(response, 403, { error: "forbidden" });
			}
			const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "invalid"}`).pathname;
			if (path === "/.well-known/oauth-protected-resource/mcp") {
				return handleProtectedResourceMetadata(request, response, options.config);
			}
			if (path === "/healthz") return handleHealth(request, response);
			if (path === "/mcp") return await handleMcp(request, response, options);
			if (path === "/connector/v1/snapshots") return await handleSnapshotIngest(request, response, options);
			return sendJson(response, 404, { error: "not_found" });
		} catch (error) {
			if (error instanceof OAuthError) return sendOAuthError(response, error, options.config);
			if (error instanceof RequestError) return sendJson(response, error.status, { error: error.code });
			return sendJson(response, 500, { error: "internal_error" });
		}
	};
}

export function createPcgServer(options: PcgGatewayOptions): Server {
	return createServer((request, response) => {
		void createPcgHandler(options)(request, response);
	});
}

async function handleMcp(
	request: IncomingMessage,
	response: ServerResponse,
	options: PcgGatewayOptions,
): Promise<void> {
	// Even the deliberately unsupported transport methods are protected. This
	// prevents the MCP endpoint itself becoming an unauthenticated probe surface.
	const principal = await options.verifier.verifyAny(
		request.headers.authorization,
		MCP_READ_SCOPES,
		options.config.allowedClientIds,
	);
	if (request.method !== "POST") return methodNotAllowed(response, "POST");
	const body = await readJson(request, options.config.maxRequestBytes);
	validateLegacyMcpProtocol(request, body);
	const server = createMcpServer(options, principal);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	try {
		await server.connect(transport);
		await transport.handleRequest(request, response, body);
	} finally {
		await Promise.allSettled([transport.close(), server.close()]);
	}
}

async function handleSnapshotIngest(
	request: IncomingMessage,
	response: ServerResponse,
	options: PcgGatewayOptions,
): Promise<void> {
	if (request.method !== "POST") return methodNotAllowed(response, "POST");
	const principal = await options.verifier.verify(
		request.headers.authorization,
		CONNECTOR_SCOPE,
		options.config.connectorClientIds,
	);
	const body = await readJson(request, options.config.maxSnapshotBytes);
	const snapshot = parseSnapshotInput(body, options.config.maxSnapshotBytes);
	await options.store.ingest(snapshot);
	await options.store.audit({
		action: "snapshot.ingest",
		principal: principal.subject,
		clientId: principal.clientId,
		resourceId: snapshot.id,
		outcome: "allow",
	});
	return sendJson(response, 201, { id: snapshot.id, expiresAt: snapshot.expiresAt });
}

function handleProtectedResourceMetadata(request: IncomingMessage, response: ServerResponse, config: PcgConfig): void {
	if (request.method !== "GET") {
		methodNotAllowed(response, "GET");
		return;
	}
	sendJson(response, 200, {
		resource: config.resourceUrl,
		authorization_servers: [config.issuer],
		scopes_supported: [...MCP_READ_SCOPES],
		bearer_methods_supported: ["header"],
	});
}

function handleHealth(request: IncomingMessage, response: ServerResponse): void {
	if (request.method !== "GET") {
		methodNotAllowed(response, "GET");
		return;
	}
	response.writeHead(204, { "Cache-Control": "no-store" });
	response.end();
}

function createMcpServer(options: PcgGatewayOptions, principal: Principal): McpServer {
	const server = new McpServer(
		{ name: "primecord-private-context-gateway", version: "0.7.1" },
		{ capabilities: { tools: { listChanged: false } } },
	);
	if (principal.scopes.has("memory:search"))
		server.registerTool(
			"primecord.memory.search",
			{
				title: "Search approved Primecord context",
				description: "Search explicitly exported, redacted snapshots that the caller is authorized to read.",
				inputSchema: { query: z.string().min(2).max(256) },
				annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			},
			async ({ query }) => {
				const results = options.store.search(principal.subject, query, options.config.maxSearchResults);
				await options.store.audit({
					action: "memory.search",
					principal: principal.subject,
					clientId: principal.clientId,
					outcome: "allow",
					count: results.length,
				});
				return {
					structuredContent: {
						results: results.map((result) => ({
							handle: result.id,
							citation: result.citation,
							excerpt: result.content,
							expiresAt: result.expiresAt,
						})),
					},
					content: [
						{
							type: "text",
							text: JSON.stringify({
								results: results.map((result) => ({
									handle: result.id,
									citation: result.citation,
									excerpt: result.content,
									expiresAt: result.expiresAt,
								})),
							}),
						},
					],
				};
			},
		);
	if (principal.scopes.has("memory:read"))
		server.registerTool(
			"primecord.memory.read",
			{
				title: "Read approved Primecord context",
				description: "Read one authorized snapshot by opaque handle.",
				inputSchema: { handle: z.string().regex(SNAPSHOT_ID) },
				annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
			},
			async ({ handle }) => {
				const result = options.store.read(principal.subject, handle);
				await options.store.audit({
					action: "memory.read",
					principal: principal.subject,
					clientId: principal.clientId,
					resourceId: handle,
					outcome: result ? "allow" : "deny",
				});
				if (!result) return toolError("Snapshot was not found, expired, or is not authorized");
				const content = Buffer.from(result.content, "utf8");
				if (content.byteLength > options.config.maxReadBytes)
					return toolError("Snapshot exceeds the read size limit");
				const value = {
					handle: result.id,
					citation: result.citation,
					content: result.content,
					expiresAt: result.expiresAt,
				};
				return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
			},
		);
	return server;
}

function toolError(message: string) {
	return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function validateHostAndOrigin(request: IncomingMessage, config: PcgConfig): boolean {
	const host = request.headers.host;
	if (!host || !config.allowedHosts.has(host)) return false;
	// The reverse proxy is a trust boundary: it must discard client-supplied
	// Forwarded/X-Forwarded-* and be explicitly named before PCG will honor it.
	const forwardedHost = firstForwardedHost(request.headers.forwarded);
	if (forwardedHost && !config.allowedForwardedHosts.has(forwardedHost)) return false;
	const origin = request.headers.origin;
	return !origin || config.allowedOrigins.has(origin);
}

function firstForwardedHost(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const match = /(?:^|;)\s*host=([^;,\s]+)/i.exec(value.split(",", 1)[0] ?? "");
	return match?.[1]?.replace(/^"|"$/g, "").toLocaleLowerCase();
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
	const contentType = request.headers["content-type"];
	if (!contentType?.toLocaleLowerCase().startsWith("application/json"))
		throw new RequestError(415, "json_content_type_required");
	const length = request.headers["content-length"];
	if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new RequestError(413, "request_too_large");
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += value.byteLength;
		if (size > limit) {
			request.destroy();
			throw new RequestError(413, "request_too_large");
		}
		chunks.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new RequestError(400, "invalid_json");
	}
}

function validateLegacyMcpProtocol(request: IncomingMessage, body: unknown): void {
	if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string")
		throw new RequestError(400, "invalid_mcp_request");
	if (body.method === "initialize") {
		if (!isRecord(body.params) || body.params.protocolVersion !== PCG_PROTOCOL_VERSION) {
			throw new RequestError(400, "unsupported_mcp_protocol_version");
		}
		return;
	}
	if (request.headers["mcp-protocol-version"] !== PCG_PROTOCOL_VERSION) {
		throw new RequestError(400, "unsupported_mcp_protocol_version");
	}
}

function parseSnapshotInput(value: unknown, maxBytes: number): SnapshotInput {
	if (!isRecord(value)) throw new RequestError(400, "invalid_snapshot");
	const id = stringValue(value.id);
	const owner = stringValue(value.owner);
	const expiresAt = stringValue(value.expiresAt);
	const citation = stringValue(value.citation);
	const content = stringValue(value.content);
	const readers =
		Array.isArray(value.readers) && value.readers.every((reader) => typeof reader === "string")
			? value.readers
			: undefined;
	if (
		!id ||
		!owner ||
		!expiresAt ||
		!citation ||
		!content ||
		!readers ||
		Buffer.byteLength(content, "utf8") > maxBytes
	)
		throw new RequestError(400, "invalid_snapshot");
	return { id, owner, readers, expiresAt, citation, content };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function methodNotAllowed(response: ServerResponse, allowed: string): void {
	response.writeHead(405, { Allow: allowed, "Cache-Control": "no-store" });
	response.end();
}

function sendOAuthError(response: ServerResponse, error: OAuthError, config: PcgConfig): void {
	const metadata = new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).toString();
	const challenge = `Bearer resource_metadata="${metadata}", error="${error.error}", scope="${MCP_READ_SCOPES.join(" ")}"`;
	sendJson(response, error.status, { error: error.error }, { "WWW-Authenticate": challenge });
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	if (response.headersSent) return;
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
	response.end(JSON.stringify(body));
}

class RequestError extends Error {
	constructor(
		readonly status: 400 | 413 | 415,
		readonly code: string,
	) {
		super(code);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function newSnapshotId(): string {
	return randomUUID().replaceAll("-", "");
}
