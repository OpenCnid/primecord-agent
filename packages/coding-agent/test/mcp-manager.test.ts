import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { McpManager } from "../src/core/mcp/mcp-manager.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { McpServerConfig } from "../src/core/settings-manager.js";

describe("McpManager", () => {
	let tempDir: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-mgr-"));
		authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		resetOAuthProviders();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		resetOAuthProviders();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("disables every built-in integration when no credentials exist", () => {
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");
	});

	it("enables an integration once credentials are stored", () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "tok",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({ authStorage });
		const overrides = manager.getDisabledBuiltinSkillOverrides();
		expect(overrides).not.toContain("-linear/SKILL.md");
		expect(overrides).toContain("-notion/SKILL.md");

		const status = manager.listStatus().find((s) => s.server === "linear");
		expect(status?.enabled).toBe(true);
	});

	it("registers an OAuth provider per built-in integration", () => {
		new McpManager({ authStorage });
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("keeps MCP providers registered after ModelRegistry.refresh() resets the registry", () => {
		new McpManager({ authStorage });
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.refresh(); // calls resetOAuthProviders(); must re-add MCP providers
		expect(getOAuthProvider("mcp:linear")).toBeDefined();
		expect(getOAuthProvider("mcp:notion")).toBeDefined();
	});

	it("re-registers user-declared OAuth servers after ModelRegistry.refresh via the reset hook", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } }),
		});
		const registry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		registry.setOnOAuthProvidersReset(() => manager.registerUserProviders());
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
		registry.refresh(); // resets registry; hook must re-add the custom provider
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("forwards a pre-registered OAuth client and its requested scopes for a custom server", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				pcg: {
					type: "http",
					url: "https://pcg.test/mcp",
					oauth: true,
					oauthClientId: "primecord-approved-agent",
					oauthScopes: ["memory:search", "memory:read"],
				},
			}),
		});
		void manager;
		let authUrl = "";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === "https://pcg.test/.well-known/oauth-protected-resource/mcp") {
					return new Response(
						JSON.stringify({
							authorization_servers: ["https://id.test"],
							scopes_supported: ["memory:search", "memory:read"],
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://id.test/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://id.test/authorize",
							token_endpoint: "https://id.test/token",
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://id.test/token") {
					const params = new URLSearchParams(String(init?.body));
					expect(params.get("client_id")).toBe("primecord-approved-agent");
					return new Response(
						JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
						{
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const provider = getOAuthProvider("mcp:pcg");
		expect(provider).toBeDefined();
		const credentials = await provider?.login({
			onAuth: (info) => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			onManualCodeInput: async () => {
				const callbackUrl = new URL(authUrl).searchParams.get("redirect_uri") ?? "";
				const state = new URL(authUrl).searchParams.get("state") ?? "";
				return `${callbackUrl}?code=approved&state=${state}`;
			},
		});
		expect(credentials?.access).toBe("access");
		const authParams = new URL(authUrl).searchParams;
		expect(authParams.get("client_id")).toBe("primecord-approved-agent");
		expect(authParams.get("scope")).toBe("memory:search memory:read");
	});

	it("exposes only mcp.refresh when no interactive login is wired", async () => {
		const manager = new McpManager({ authStorage });
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual(["mcp.call_tool", "mcp.config", "mcp.list_tools", "mcp.refresh"]);

		// refresh with no credentials fails (so the kernel reports a refresh error,
		// not a false success), and a missing server arg is rejected.
		await expect(handlers["mcp.refresh"]({ server: "linear" })).rejects.toThrow("Could not refresh");
		await expect(handlers["mcp.refresh"]({})).rejects.toThrow("requires a server");
	});

	it("exposes mcp.begin_login only when beginLogin is provided", async () => {
		let called = "";
		const manager = new McpManager({
			authStorage,
			beginLogin: async (server) => {
				called = server;
			},
		});
		const handlers = manager.hostHandlers();
		expect(Object.keys(handlers).sort()).toEqual([
			"mcp.begin_login",
			"mcp.call_tool",
			"mcp.config",
			"mcp.list_tools",
			"mcp.refresh",
		]);
		await handlers["mcp.begin_login"]({ server: "linear" });
		expect(called).toBe("linear");
	});

	it("mcp.config returns the resolved URL + headers, honoring a user override of a catalog name", async () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({
				linear: { type: "http", url: "https://proxy.test/mcp", oauth: true, headers: { "X-Extra": "1" } },
			}),
		});
		const handlers = manager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "linear" })).toEqual({
			url: "https://proxy.test/mcp",
			headers: { "X-Extra": "1" },
		});
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({ url: "https://mcp.notion.com/mcp" });
	});

	it("does not treat an oauth override of a catalog name as authed via the official stored cred", () => {
		// Pre-existing official Linear cred from a prior login.
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "official",
			refresh: "r",
			expires: Date.now() + 3600_000,
		});
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp", oauth: true } }),
		});
		// Must NOT be enabled — else the official token would be sent to the override URL.
		expect(manager.listStatus().find((s) => s.server === "linear")?.enabled).toBe(false);
	});

	it("honors a bearer-token env var for user-declared servers", () => {
		process.env.MY_MCP_TOKEN = "secret";
		try {
			const manager = new McpManager({
				authStorage,
				getUserServers: () => ({
					custom: { type: "http", url: "https://example.test/mcp", bearerTokenEnvVar: "MY_MCP_TOKEN" },
				}),
			});
			const status = manager.listStatus().find((s) => s.server === "custom");
			expect(status?.enabled).toBe(true);
		} finally {
			delete process.env.MY_MCP_TOKEN;
		}
	});

	it("picks up mcpServers added after construction on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeUndefined();

		servers = { acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true } };
		manager.refresh();
		expect(manager.listStatus().find((s) => s.server === "acme")).toBeDefined();
		expect(getOAuthProvider("mcp:acme")).toBeDefined();
	});

	it("drops the built-in provider when a catalog name is overridden without oauth", () => {
		const manager = new McpManager({
			authStorage,
			getUserServers: () => ({ linear: { type: "http", url: "https://proxy.test/mcp" } }),
		});
		void manager;
		// Built-in linear provider must be gone so we don't send the official token to the override URL.
		expect(getOAuthProvider("mcp:linear")).toBeUndefined();
	});

	it("unregisters a user server's OAuth provider when it's removed on refresh()", () => {
		let servers: Record<string, McpServerConfig> = {
			acme: { type: "http", url: "https://mcp.acme.test/mcp", oauth: true },
		};
		const manager = new McpManager({ authStorage, getUserServers: () => servers });
		expect(getOAuthProvider("mcp:acme")).toBeDefined();

		servers = {};
		manager.refresh();
		expect(getOAuthProvider("mcp:acme")).toBeUndefined();
	});
});
