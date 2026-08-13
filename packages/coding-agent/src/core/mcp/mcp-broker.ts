import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const LEGACY_MCP_PROTOCOL = "2025-11-25";
export const LEGACY_MCP_PROTOCOL_CONFIG = "legacy-2025-11-25";

const MAX_SERVER_NAME_LENGTH = 64;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_COUNT = 256;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_TOOL_DESCRIPTION_LENGTH = 8 * 1024;

export type McpTool = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
};

export type McpBrokerServer =
	| {
			name: string;
			transport: "http";
			url: string;
			headers?: Record<string, string>;
			authorization?: string;
			approvedTools?: readonly string[];
			blockedTools?: readonly string[];
			protocol: typeof LEGACY_MCP_PROTOCOL_CONFIG;
	  }
	| {
			name: string;
			transport: "stdio";
			command: string;
			args?: readonly string[];
			env?: Record<string, string>;
			approved: true;
			approvedTools?: readonly string[];
			blockedTools?: readonly string[];
			protocol: typeof LEGACY_MCP_PROTOCOL_CONFIG;
	  };

export interface McpBrokerConnection {
	listTools(): Promise<readonly McpTool[]>;
	callTool(tool: string, arguments_: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}

export interface McpBrokerConnectionFactory {
	open(server: McpBrokerServer): Promise<McpBrokerConnection>;
}

export type McpBrokerServerResolver = (server: string) => Promise<McpBrokerServer | undefined>;

/**
 * Host-owned MCP client surface. It deliberately exposes only JSON-safe tool
 * metadata/results to the kernel; endpoint credentials remain inside this process.
 *
 * The released official TypeScript SDK currently supports the legacy handshake era.
 * Callers must opt into it explicitly rather than silently treating it as the
 * requested 2026 protocol.
 */
export class McpBroker {
	constructor(
		private readonly resolveServer: McpBrokerServerResolver,
		private readonly connectionFactory: McpBrokerConnectionFactory = new SdkMcpBrokerConnectionFactory(),
	) {}

	async listTools(serverName: string): Promise<McpTool[]> {
		const server = await this.requireServer(serverName);
		const connection = await this.connectionFactory.open(server);
		try {
			const tools = await connection.listTools();
			if (tools.length > MAX_TOOL_COUNT) {
				throw new Error(`MCP server '${server.name}' returned too many tools (maximum ${MAX_TOOL_COUNT})`);
			}
			return tools.map((tool) => sanitizeTool(tool));
		} finally {
			await connection.close();
		}
	}

	async callTool(serverName: string, toolName: string, arguments_: Record<string, unknown>): Promise<unknown> {
		const server = await this.requireServer(serverName);
		validateToolName(toolName);
		validateJson(arguments_, "arguments");
		if (!server.approvedTools?.includes(toolName) || server.blockedTools?.includes(toolName)) {
			throw new Error(
				`MCP tool '${toolName}' on '${server.name}' is not explicitly approved. Inspect it first, then add it to enabledTools.`,
			);
		}

		const connection = await this.connectionFactory.open(server);
		try {
			return sanitizeJsonValue(await connection.callTool(toolName, arguments_), "MCP tool result");
		} finally {
			await connection.close();
		}
	}

	private async requireServer(serverName: string): Promise<McpBrokerServer> {
		validateServerName(serverName);
		const server = await this.resolveServer(serverName);
		if (!server) throw new Error(`Unknown MCP server '${serverName}'`);
		if (server.protocol !== LEGACY_MCP_PROTOCOL_CONFIG) {
			throw new Error(
				`MCP server '${serverName}' must explicitly set protocol '${LEGACY_MCP_PROTOCOL_CONFIG}'. The installed official SDK does not yet implement 2026-07-28.`,
			);
		}
		return server;
	}
}

export class SdkMcpBrokerConnectionFactory implements McpBrokerConnectionFactory {
	async open(server: McpBrokerServer): Promise<McpBrokerConnection> {
		const client = new Client({ name: "prime-agent", version: "0.7.1" }, { capabilities: {} });
		const transport = await createTransport(server);
		await client.connect(transport);
		return {
			async listTools(): Promise<readonly McpTool[]> {
				const result = await client.listTools();
				return result.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					outputSchema: tool.outputSchema,
					annotations: tool.annotations,
				}));
			},
			async callTool(tool: string, arguments_: Record<string, unknown>): Promise<unknown> {
				const result = (await client.callTool({ name: tool, arguments: arguments_ })) as CallToolResult;
				return result;
			},
			async close(): Promise<void> {
				await client.close();
			},
		};
	}
}

async function createTransport(server: McpBrokerServer): Promise<StreamableHTTPClientTransport | StdioClientTransport> {
	if (server.transport === "stdio") {
		return new StdioClientTransport({
			command: server.command,
			args: server.args ? [...server.args] : undefined,
			env: server.env ? { ...server.env } : undefined,
			stderr: "pipe",
			maxBufferSize: MAX_JSON_BYTES,
		});
	}

	const url = await validateRemoteUrl(server.url);
	const headers = new Headers(server.headers);
	if (server.authorization) headers.set("Authorization", `Bearer ${server.authorization}`);
	return new StreamableHTTPClientTransport(url, {
		requestInit: { headers, redirect: "error" },
		fetch: guardedFetch,
	});
}

async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
	const url = new URL(input.toString());
	await validateRemoteUrl(url.toString());
	return fetch(input, { ...init, redirect: "error" });
}

async function validateRemoteUrl(rawUrl: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("MCP HTTP endpoint must be an absolute URL");
	}
	if (url.protocol !== "https:") throw new Error("MCP HTTP endpoint must use HTTPS");
	if (url.username || url.password) throw new Error("MCP HTTP endpoint must not contain credentials");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || isPrivateAddress(hostname)) {
		throw new Error("MCP HTTP endpoint must not target a private or loopback address");
	}
	const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
	if (addresses.length === 0) throw new Error(`Could not resolve MCP endpoint host '${hostname}'`);
	if (addresses.some((entry) => isPrivateAddress(entry.address))) {
		throw new Error("MCP HTTP endpoint resolves to a private or loopback address");
	}
	return url;
}

function isPrivateAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		const [first, second] = address.split(".").map(Number);
		return (
			first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 169 && second === 254) ||
			(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			first === 255
		);
	}
	if (version === 6) {
		const normalized = address.toLowerCase();
		return (
			normalized === "::1" ||
			normalized.startsWith("fe80:") ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd")
		);
	}
	return false;
}

function validateServerName(server: string): void {
	if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(server) || server.length > MAX_SERVER_NAME_LENGTH) {
		throw new Error("MCP server must be an alphanumeric name up to 64 characters");
	}
}

function validateToolName(tool: string): void {
	if (!tool || tool.length > MAX_TOOL_NAME_LENGTH) {
		throw new Error(`MCP tool name must be between 1 and ${MAX_TOOL_NAME_LENGTH} characters`);
	}
}

function sanitizeTool(tool: McpTool): McpTool {
	validateToolName(tool.name);
	validateJson(tool.inputSchema, `input schema for '${tool.name}'`);
	if (tool.outputSchema) validateJson(tool.outputSchema, `output schema for '${tool.name}'`);
	if (tool.annotations) validateJson(tool.annotations, `annotations for '${tool.name}'`);
	return {
		name: tool.name,
		description: tool.description?.slice(0, MAX_TOOL_DESCRIPTION_LENGTH),
		inputSchema: sanitizeJsonValue(tool.inputSchema, `input schema for '${tool.name}'`) as Record<string, unknown>,
		outputSchema: tool.outputSchema
			? (sanitizeJsonValue(tool.outputSchema, `output schema for '${tool.name}'`) as Record<string, unknown>)
			: undefined,
		annotations: tool.annotations
			? (sanitizeJsonValue(tool.annotations, `annotations for '${tool.name}'`) as Record<string, unknown>)
			: undefined,
	};
}

function validateJson(value: unknown, label: string): void {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > MAX_JSON_BYTES) {
		throw new Error(`${label} exceeds the ${MAX_JSON_BYTES}-byte limit or is not JSON serializable`);
	}
	assertJsonDepth(value, label, 0);
}

function sanitizeJsonValue(value: unknown, label: string): unknown {
	validateJson(value, label);
	return JSON.parse(JSON.stringify(value)) as unknown;
}

function assertJsonDepth(value: unknown, label: string, depth: number): void {
	if (depth > MAX_JSON_DEPTH) throw new Error(`${label} exceeds the maximum JSON depth of ${MAX_JSON_DEPTH}`);
	if (Array.isArray(value)) {
		for (const item of value) assertJsonDepth(item, label, depth + 1);
		return;
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) assertJsonDepth(item, label, depth + 1);
	}
}
