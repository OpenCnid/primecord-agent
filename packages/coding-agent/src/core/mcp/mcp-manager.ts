// Host side of MCP integrations. The protocol itself runs Python-side in the kernel; the host
// only registers OAuth providers, gates integration skills by auth, and serves mcp.* host-requests.

import {
	BUILTIN_MCP_CATALOG,
	createMcpOAuthProvider,
	getCatalogEntry,
	registerBuiltinMcpOAuthProviders,
} from "@earendil-works/pi-ai/mcp";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { AuthStorage } from "../auth-storage.js";
import type { McpServerConfig } from "../settings-manager.js";
import {
	LEGACY_MCP_PROTOCOL_CONFIG,
	McpBroker,
	type McpBrokerServer,
	type McpProtocolConfig,
	MODERN_MCP_PROTOCOL_CONFIG,
} from "./mcp-broker.js";

export interface McpManagerOptions {
	authStorage: AuthStorage;
	/** Reads the current Settings.mcpServers (name → config). Re-read on refresh(). */
	getUserServers?: () => Record<string, McpServerConfig> | undefined;
	/** Start an interactive host-side login for a server. Provided by the UI mode. */
	beginLogin?: (server: string) => Promise<void>;
}

/** A resolved integration: a catalog/user entry plus its provider id. */
interface ResolvedIntegration {
	server: string;
	label: string;
	url: string;
	usesOAuth: boolean;
	bearerTokenEnvVar?: string;
	/** Public OAuth client registration supplied by the administrator. */
	oauthClientId?: string;
	/** Least-privilege OAuth scopes supplied by the administrator. */
	oauthScopes?: readonly string[];
	enabled?: boolean;
	/** Extra static HTTP headers from the user config. */
	headers?: Record<string, string>;
	/** Explicit wire-protocol selection for the generic broker. */
	protocol?: McpProtocolConfig;
	/** Exact user-approved tools. All tool calls are denied if this is unset. */
	enabledTools?: readonly string[];
	/** Tools blocked even if they are present in enabledTools. */
	disabledTools?: readonly string[];
	/** True when this came from Settings.mcpServers (may override a catalog name). */
	userDeclared?: boolean;
}

export class McpManager {
	private readonly authStorage: AuthStorage;
	private readonly getUserServers: () => Record<string, McpServerConfig> | undefined;
	private readonly beginLogin?: (server: string) => Promise<void>;
	private integrations = new Map<string, ResolvedIntegration>();
	private readonly broker: McpBroker;
	/** Provider ids we registered for user servers, so refresh can drop removed ones. */
	private registeredUserProviderIds = new Set<string>();

	constructor(options: McpManagerOptions) {
		this.authStorage = options.authStorage;
		this.getUserServers = options.getUserServers ?? (() => undefined);
		this.beginLogin = options.beginLogin;
		this.resolveIntegrations();
		this.registerProviders();
		this.broker = new McpBroker((server) => this.resolveBrokerServer(server));
	}

	/** Re-read settings and re-register providers; call after a session reload. */
	refresh(): void {
		this.resolveIntegrations();
		this.registerProviders();
	}

	private providerId(server: string): string {
		return `mcp:${server}`;
	}

	private resolveIntegrations(): void {
		const integrations = new Map<string, ResolvedIntegration>();
		for (const entry of BUILTIN_MCP_CATALOG) {
			integrations.set(entry.server, {
				server: entry.server,
				label: entry.label,
				url: entry.url,
				usesOAuth: entry.oauth?.kind === "oauth",
			});
		}
		for (const [server, config] of Object.entries(this.getUserServers() ?? {})) {
			if (config.type !== "http") continue; // stdio needs a separately approved broker path
			integrations.set(server, {
				server,
				label: server,
				url: config.url,
				usesOAuth: config.oauth === true,
				bearerTokenEnvVar: config.bearerTokenEnvVar,
				oauthClientId: config.oauthClientId,
				oauthScopes: config.oauthScopes,
				enabled: config.enabled,
				headers: config.headers,
				protocol: config.protocol,
				enabledTools: config.enabledTools,
				disabledTools: config.disabledTools,
				userDeclared: true,
			});
		}
		this.integrations = integrations;
	}

	private registerProviders(): void {
		registerBuiltinMcpOAuthProviders();
		this.registerUserProviders();
	}

	/**
	 * Register OAuth providers for user-declared (non-catalog) servers. Public so it
	 * can run after ModelRegistry.refresh() resets the registry — otherwise custom
	 * `mcp:<server>` providers vanish on every refresh (e.g. post-login).
	 */
	registerUserProviders(): void {
		const current = new Set<string>();
		for (const integration of this.integrations.values()) {
			if (!integration.userDeclared) continue;
			const id = this.providerId(integration.server);
			if (integration.usesOAuth) {
				// Register pointing at the user's URL (overrides a catalog default too).
				current.add(id);
				registerOAuthProvider(
					createMcpOAuthProvider({
						server: integration.server,
						label: integration.label,
						url: integration.url,
						clientId: integration.oauthClientId,
						scopes: integration.oauthScopes?.join(" "),
					}),
				);
			} else if (getCatalogEntry(integration.server)) {
				// User overrode a catalog server with a custom URL but no oauth: drop the
				// built-in provider so we never send the official token to that URL.
				unregisterOAuthProvider(id);
			}
		}
		// Drop providers for user servers removed since the last registration.
		for (const id of this.registeredUserProviderIds) {
			if (!current.has(id)) unregisterOAuthProvider(id);
		}
		this.registeredUserProviderIds = current;
	}

	/** True when valid credentials exist for the integration (drives enablement). */
	private isAuthed(integration: ResolvedIntegration): boolean {
		if (integration.enabled === false) return false;
		if (integration.bearerTokenEnvVar && process.env[integration.bearerTokenEnvVar]?.trim()) {
			return true;
		}
		// A user server that overrides a catalog name must NOT inherit the built-in's
		// stored mcp: creds — those were issued for the official endpoint and could be
		// sent to the override URL. Such an override authenticates only via a bearer
		// env var (handled above); we don't trust auth.json OAuth creds for it.
		if (integration.userDeclared && getCatalogEntry(integration.server)) {
			return false;
		}
		const cred = this.authStorage.get(this.providerId(integration.server));
		return cred !== undefined;
	}

	/**
	 * Resolve a kernel request into a host-only broker descriptor. Credentials are
	 * fetched only after the name has resolved to the currently configured endpoint
	 * and never cross the Jupyter comm boundary.
	 */
	private async resolveBrokerServer(server: string): Promise<McpBrokerServer | undefined> {
		const userConfig = this.getUserServers()?.[server];
		if (userConfig?.type === "stdio") {
			if (userConfig.enabled === false) throw new Error(`MCP server '${server}' is disabled`);
			if (userConfig.approved !== true) {
				throw new Error(`Local MCP server '${server}' requires explicit command approval`);
			}
			if (!userConfig.protocol) {
				throw new Error(
					`Local MCP server '${server}' must explicitly set protocol '${MODERN_MCP_PROTOCOL_CONFIG}' (or the explicit legacy compatibility value '${LEGACY_MCP_PROTOCOL_CONFIG}')`,
				);
			}
			return {
				name: server,
				transport: "stdio",
				command: userConfig.command,
				args: userConfig.args,
				env: userConfig.env,
				approved: true,
				approvedTools: userConfig.enabledTools,
				blockedTools: userConfig.disabledTools,
				protocol: userConfig.protocol,
			};
		}

		const integration = this.integrations.get(server);
		if (!integration) return undefined;
		if (integration.enabled === false) throw new Error(`MCP server '${server}' is disabled`);
		if (!integration.protocol) {
			throw new Error(
				`MCP server '${server}' must explicitly set protocol '${MODERN_MCP_PROTOCOL_CONFIG}' (or the explicit legacy compatibility value '${LEGACY_MCP_PROTOCOL_CONFIG}')`,
			);
		}
		if (hasCredentialHeader(integration.headers)) {
			throw new Error(`MCP server '${server}' must use OAuth or bearerTokenEnvVar, not an Authorization header`);
		}

		let authorization: string | undefined;
		if (integration.bearerTokenEnvVar) {
			authorization = process.env[integration.bearerTokenEnvVar]?.trim() || undefined;
		} else if (!(integration.userDeclared && getCatalogEntry(integration.server))) {
			authorization = await this.authStorage.getApiKey(this.providerId(integration.server), {
				includeFallback: false,
			});
		}
		return {
			name: server,
			transport: "http",
			url: integration.url,
			headers: integration.headers,
			authorization,
			approvedTools: integration.enabledTools,
			blockedTools: integration.disabledTools,
			protocol: integration.protocol,
		};
	}

	/** `-<server>/SKILL.md` overrides for every built-in integration the user isn't logged into. */
	getDisabledBuiltinSkillOverrides(): string[] {
		const overrides: string[] = [];
		for (const entry of BUILTIN_MCP_CATALOG) {
			const integration = this.integrations.get(entry.server);
			if (integration && !this.isAuthed(integration)) {
				overrides.push(`-${entry.server}/SKILL.md`);
			}
		}
		return overrides;
	}

	/** Host-request handlers exposed to the kernel. */
	hostHandlers(): Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> {
		const handlers: Record<string, (payload: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
			"mcp.refresh": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.refresh requires a server");
				// getApiKey refreshes + rewrites auth.json under lock; Python re-reads.
				// Surface failure (throw) instead of a false success so the kernel can
				// report a refresh error rather than a misleading "not enabled".
				const key = await this.authStorage.getApiKey(this.providerId(server));
				if (!key) throw new Error(`Could not refresh credentials for ${server}`);
				return {};
			},
			// Resolved config so the kernel skill connects to the same URL the host
			// registered/authenticated (honors a user's mcpServers `url` override).
			"mcp.config": async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.config requires a server");
				const integration = this.integrations.get(server);
				if (!integration) return {};
				const config: Record<string, unknown> = { url: integration.url };
				if (integration.headers && Object.keys(integration.headers).length > 0) {
					config.headers = integration.headers;
				}
				return config;
			},
			"mcp.list_tools": async (payload) => ({
				tools: await this.broker.listTools(requiredPayloadString(payload, "server", "mcp.list_tools")),
			}),
			"mcp.call_tool": async (payload) => ({
				result: await this.broker.callTool(
					requiredPayloadString(payload, "server", "mcp.call_tool"),
					requiredPayloadString(payload, "tool", "mcp.call_tool"),
					recordPayload(payload.arguments, "mcp.call_tool arguments"),
				),
			}),
		};
		// Only expose begin_login when an interactive login is actually wired, so the
		// kernel doesn't get a handler whose only behavior is to throw.
		const beginLogin = this.beginLogin;
		if (beginLogin) {
			handlers["mcp.begin_login"] = async (payload) => {
				const server = String(payload.server ?? "");
				if (!server) throw new Error("mcp.begin_login requires a server");
				await beginLogin(server);
				return {};
			};
		}
		return handlers;
	}

	/** Status for the /mcp list command. */
	listStatus(): Array<{ server: string; label: string; enabled: boolean; usesOAuth: boolean }> {
		return Array.from(this.integrations.values()).map((integration) => ({
			server: integration.server,
			label: integration.label,
			enabled: this.isAuthed(integration),
			usesOAuth: integration.usesOAuth,
		}));
	}
}

function requiredPayloadString(payload: Record<string, unknown>, key: string, operation: string): string {
	const value = payload[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`${operation} requires a non-empty ${key}`);
	return value.trim();
}

function recordPayload(value: unknown, label: string): Record<string, unknown> {
	if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function hasCredentialHeader(headers: Record<string, string> | undefined): boolean {
	return Object.keys(headers ?? {}).some((name) => /^(authorization|proxy-authorization)$/i.test(name));
}
