import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type ConnectionOptions, connect as tlsConnect } from "node:tls";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Agent, fetch as undiciFetch } from "undici";

/** The modern stateless MCP revision implemented by the v2 SDK. */
export const MODERN_MCP_PROTOCOL = "2026-07-28";
/** The explicit configuration value for the modern MCP revision. */
export const MODERN_MCP_PROTOCOL_CONFIG = MODERN_MCP_PROTOCOL;
/**
 * Compatibility escape hatch for a deliberately configured pre-2026 server.
 * New integrations should use MODERN_MCP_PROTOCOL_CONFIG.
 */
export const LEGACY_MCP_PROTOCOL_CONFIG = "legacy-2025-11-25";
export type McpProtocolConfig = typeof MODERN_MCP_PROTOCOL_CONFIG | typeof LEGACY_MCP_PROTOCOL_CONFIG;

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
			protocol: McpProtocolConfig;
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
			protocol: McpProtocolConfig;
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
 * Modern servers are pinned to the 2026-07-28 stateless protocol so a declared
 * modern integration cannot be silently downgraded. Legacy remains an explicit
 * compatibility choice for a separately reviewed pre-2026 server.
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
		if (server.protocol !== MODERN_MCP_PROTOCOL_CONFIG && server.protocol !== LEGACY_MCP_PROTOCOL_CONFIG) {
			throw new Error(
				`MCP server '${serverName}' must explicitly set protocol '${MODERN_MCP_PROTOCOL_CONFIG}' or '${LEGACY_MCP_PROTOCOL_CONFIG}'.`,
			);
		}
		return server;
	}
}

export class SdkMcpBrokerConnectionFactory implements McpBrokerConnectionFactory {
	async open(server: McpBrokerServer): Promise<McpBrokerConnection> {
		const client = new Client(
			{ name: "prime-agent", version: "0.7.1" },
			{
				versionNegotiation: {
					mode: server.protocol === MODERN_MCP_PROTOCOL_CONFIG ? { pin: MODERN_MCP_PROTOCOL } : "legacy",
				},
			},
		);
		const connection = await createTransport(server);
		try {
			await client.connect(connection.transport);
		} catch (error) {
			await connection.close();
			throw error;
		}
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
				return await client.callTool({ name: tool, arguments: arguments_ });
			},
			async close(): Promise<void> {
				try {
					await client.close();
				} finally {
					await connection.close();
				}
			},
		};
	}
}

type BrokerTransport = {
	transport: StreamableHTTPClientTransport | StdioClientTransport;
	close: () => Promise<void>;
};

async function createTransport(server: McpBrokerServer): Promise<BrokerTransport> {
	if (server.transport === "stdio") {
		const transport = new StdioClientTransport({
			command: server.command,
			args: server.args ? [...server.args] : undefined,
			env: server.env ? { ...server.env } : undefined,
			stderr: "pipe",
			maxBufferSize: MAX_JSON_BYTES,
		});
		return { transport, close: async () => {} };
	}

	const endpoint = await resolveRemoteEndpoint(server.url);
	const pinned = createPinnedFetch(endpoint);
	const headers = new Headers(server.headers);
	if (server.authorization) headers.set("Authorization", `Bearer ${server.authorization}`);
	return {
		transport: new StreamableHTTPClientTransport(endpoint.url, {
			requestInit: { headers, redirect: "error" },
			fetch: pinned.fetch,
		}),
		close: pinned.close,
	};
}

type RemoteEndpoint = { url: URL; hostname: string; address: string };
type PinnedFetch = { fetch: typeof fetch; close: () => Promise<void> };

/**
 * Pin every connection to an address that passed the private-network check
 * instead of allowing fetch to resolve the hostname again. TLS still uses the
 * original hostname for SNI and certificate validation, which prevents a
 * DNS-rebinding endpoint from changing the peer after preflight validation.
 */
function createPinnedFetch(endpoint: RemoteEndpoint): PinnedFetch {
	const dispatcher = new Agent({
		connect: (options, callback) => {
			if (options.hostname !== endpoint.hostname || options.protocol !== "https:") {
				callback(new Error("MCP connection escaped its configured HTTPS endpoint"), null);
				return;
			}
			const tlsOptions: ConnectionOptions = {
				host: endpoint.address,
				port: Number(options.port) || 443,
				servername: endpoint.hostname,
				ALPNProtocols: ["http/1.1"],
				rejectUnauthorized: true,
			};
			const socket = tlsConnect(tlsOptions);
			let settled = false;
			const settleSuccess = () => {
				if (settled) return;
				settled = true;
				callback(null, socket);
			};
			const settleError = (error: Error) => {
				if (settled) return;
				settled = true;
				callback(error, null);
			};
			socket.once("secureConnect", settleSuccess);
			socket.once("error", settleError);
		},
	});
	return {
		fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.origin !== endpoint.url.origin) throw new Error("MCP request escaped its configured endpoint origin");
			// `undici` and Node's built-in fetch types use distinct but runtime-compatible
			// RequestInit declarations; preserve the host-facing fetch contract here.
			return undiciFetch(
				input as Parameters<typeof undiciFetch>[0],
				{ ...init, dispatcher, redirect: "error" } as Parameters<typeof undiciFetch>[1],
			) as Promise<Response>;
		},
		close: async () => dispatcher.destroy(),
	};
}

async function resolveRemoteEndpoint(rawUrl: string): Promise<RemoteEndpoint> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("MCP HTTP endpoint must be an absolute URL");
	}
	if (url.protocol !== "https:") throw new Error("MCP HTTP endpoint must use HTTPS");
	if (url.username || url.password) throw new Error("MCP HTTP endpoint must not contain credentials");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || isPrivateMcpAddress(hostname)) {
		throw new Error("MCP HTTP endpoint must not target a private or loopback address");
	}
	const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
	if (addresses.length === 0) throw new Error(`Could not resolve MCP endpoint host '${hostname}'`);
	const publicAddress = addresses.find((entry) => !isPrivateMcpAddress(entry.address));
	if (!publicAddress) throw new Error("MCP HTTP endpoint resolves to a private or loopback address");
	return { url, hostname, address: publicAddress.address };
}

export function isPrivateMcpAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		const [first, second] = address.split(".").map(Number);
		return (
			first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 100 && second !== undefined && second >= 64 && second <= 127) ||
			(first === 169 && second === 254) ||
			(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
			(first === 192 && (second === 0 || second === 168)) ||
			(first === 198 && second !== undefined && (second === 18 || second === 19)) ||
			first >= 224
		);
	}
	if (version === 6) {
		const normalized = address.toLowerCase();
		const ipv4Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
		return (
			normalized === "::" ||
			normalized === "::1" ||
			(ipv4Mapped !== null && isPrivateMcpAddress(ipv4Mapped[1])) ||
			normalized.startsWith("fe80:") ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("ff")
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
