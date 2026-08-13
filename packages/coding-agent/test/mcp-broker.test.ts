import { describe, expect, it } from "vitest";
import {
	isPrivateMcpAddress,
	LEGACY_MCP_PROTOCOL_CONFIG,
	McpBroker,
	type McpBrokerConnectionFactory,
	type McpBrokerServer,
	SdkMcpBrokerConnectionFactory,
} from "../src/core/mcp/mcp-broker.js";

const server: McpBrokerServer = {
	name: "pcg",
	transport: "http",
	url: "https://pcg.example.test/mcp",
	authorization: "host-only-secret",
	protocol: LEGACY_MCP_PROTOCOL_CONFIG,
	approvedTools: ["primecord.memory.search"],
};

class FakeConnectionFactory implements McpBrokerConnectionFactory {
	opened: McpBrokerServer | undefined;
	closed = false;
	calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];

	async open(input: McpBrokerServer) {
		this.opened = input;
		return {
			listTools: async () => [
				{
					name: "primecord.memory.search",
					description: "Search snapshots",
					inputSchema: { type: "object", properties: { query: { type: "string" } } },
				},
			],
			callTool: async (tool: string, arguments_: Record<string, unknown>) => {
				this.calls.push({ tool, arguments: arguments_ });
				return { structuredContent: { results: [{ citation: "snapshot:opaque" }] } };
			},
			close: async () => {
				this.closed = true;
			},
		};
	}
}

describe("McpBroker", () => {
	it("keeps a host credential out of the kernel-facing tool inventory", async () => {
		const factory = new FakeConnectionFactory();
		const broker = new McpBroker(async (name) => (name === "pcg" ? server : undefined), factory);

		const tools = await broker.listTools("pcg");

		expect(tools).toEqual([
			{
				name: "primecord.memory.search",
				description: "Search snapshots",
				inputSchema: { type: "object", properties: { query: { type: "string" } } },
				outputSchema: undefined,
				annotations: undefined,
			},
		]);
		expect(JSON.stringify(tools)).not.toContain("host-only-secret");
		expect(factory.opened?.transport).toBe("http");
		if (factory.opened?.transport === "http") {
			expect(factory.opened.authorization).toBe("host-only-secret");
		}
		expect(factory.closed).toBe(true);
	});

	it("permits only an exact explicitly approved tool", async () => {
		const factory = new FakeConnectionFactory();
		const broker = new McpBroker(async () => server, factory);

		await expect(broker.callTool("pcg", "primecord.memory.search", { query: "roadmap" })).resolves.toEqual({
			structuredContent: { results: [{ citation: "snapshot:opaque" }] },
		});
		expect(factory.calls).toEqual([{ tool: "primecord.memory.search", arguments: { query: "roadmap" } }]);

		await expect(broker.callTool("pcg", "primecord.agent.ask", { question: "x" })).rejects.toThrow(
			"not explicitly approved",
		);
	});

	it("rejects a blocked tool even if an administrator accidentally listed it twice", async () => {
		const factory = new FakeConnectionFactory();
		const broker = new McpBroker(async () => ({ ...server, blockedTools: ["primecord.memory.search"] }), factory);

		await expect(broker.callTool("pcg", "primecord.memory.search", {})).rejects.toThrow("not explicitly approved");
	});

	it("requires an explicit legacy compatibility declaration", async () => {
		const factory = new FakeConnectionFactory();
		const broker = new McpBroker(
			async () => ({ ...server, protocol: undefined }) as unknown as McpBrokerServer,
			factory,
		);

		await expect(broker.listTools("pcg")).rejects.toThrow("must explicitly set protocol");
		expect(factory.opened).toBeUndefined();
	});
});

describe("McpBroker official SDK compatibility", () => {
	it("discovers and calls a user-approved local stdio server", async () => {
		const childProgram = [
			'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
			'import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";',
			'import * as z from "zod/v4";',
			'const server = new McpServer({ name: "test-pcg", version: "1.0.0" });',
			'server.registerTool("primecord.memory.search", { inputSchema: { query: z.string() } }, async ({ query }) => ({ content: [{ type: "text", text: "found:" + query }] }));',
			"await server.connect(new StdioServerTransport());",
		].join("\n");
		const localServer: McpBrokerServer = {
			name: "pcg",
			transport: "stdio",
			command: process.execPath,
			args: ["--input-type=module", "--eval", childProgram],
			approved: true,
			approvedTools: ["primecord.memory.search"],
			protocol: LEGACY_MCP_PROTOCOL_CONFIG,
		};
		const broker = new McpBroker(async () => localServer);

		await expect(broker.listTools("pcg")).resolves.toMatchObject([{ name: "primecord.memory.search" }]);
		await expect(broker.callTool("pcg", "primecord.memory.search", { query: "roadmap" })).resolves.toMatchObject({
			content: [{ type: "text", text: "found:roadmap" }],
		});
	});
});

describe("SdkMcpBrokerConnectionFactory endpoint policy", () => {
	it("rejects insecure and loopback HTTP endpoints before connecting", async () => {
		const factory = new SdkMcpBrokerConnectionFactory();
		await expect(factory.open({ ...server, url: "http://example.test/mcp" })).rejects.toThrow("must use HTTPS");
		await expect(factory.open({ ...server, url: "https://127.0.0.1/mcp" })).rejects.toThrow("private or loopback");
		await expect(factory.open({ ...server, url: "https://[::1]/mcp" })).rejects.toThrow("private or loopback");
	});
});

describe("MCP endpoint IP policy", () => {
	it("blocks private, special-use, and IPv4-mapped private addresses", () => {
		for (const address of [
			"0.0.0.0",
			"10.0.0.1",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.1.1",
			"172.16.0.1",
			"192.0.2.1",
			"192.168.0.1",
			"198.18.0.1",
			"224.0.0.1",
			"::",
			"::1",
			"::ffff:127.0.0.1",
			"fe80::1",
			"fc00::1",
			"ff02::1",
		]) {
			expect(isPrivateMcpAddress(address)).toBe(true);
		}
		expect(isPrivateMcpAddress("8.8.8.8")).toBe(false);
	});
});
