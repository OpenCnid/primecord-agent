import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** The stateless modern MCP revision served by PCG. */
export const PCG_PROTOCOL_VERSION = "2026-07-28";
export const PCG_MAX_REQUEST_BYTES = 256 * 1024;
export const PCG_MAX_SNAPSHOT_BYTES = 64 * 1024;
export const PCG_MAX_READ_BYTES = 16 * 1024;
export const PCG_MAX_SEARCH_RESULTS = 20;

export interface PcgConfig {
	host: string;
	port: number;
	dataDir: string;
	publicUrl: URL;
	resourceUrl: string;
	issuer: string;
	audience: string;
	jwksUrl: URL;
	tenant: string;
	masterKey: Buffer;
	allowedClientIds: ReadonlySet<string>;
	connectorClientIds: ReadonlySet<string>;
	allowedOrigins: ReadonlySet<string>;
	allowedHosts: ReadonlySet<string>;
	allowedForwardedHosts: ReadonlySet<string>;
	maxRequestBytes: number;
	maxSnapshotBytes: number;
	maxReadBytes: number;
	maxSearchResults: number;
	maxSnapshots: number;
}

export type PcgEnvironment = Readonly<Record<string, string | undefined>>;

export interface PcgConfigOverrides {
	host?: string;
	port?: number;
	dataDir?: string;
}

export function loadPcgConfig(env: PcgEnvironment = process.env, overrides: PcgConfigOverrides = {}): PcgConfig {
	const publicUrl = requiredHttpsUrl(env, "PRIME_PCG_PUBLIC_URL");
	if (publicUrl.pathname !== "/" && publicUrl.pathname !== "") {
		throw new Error("PRIME_PCG_PUBLIC_URL must be an origin without a path");
	}
	const resourceUrl = new URL("/mcp", publicUrl).toString();
	const audience = required(env, "PRIME_PCG_AUDIENCE");
	if (audience !== resourceUrl) {
		throw new Error("PRIME_PCG_AUDIENCE must exactly equal PRIME_PCG_PUBLIC_URL plus /mcp");
	}
	const issuer = requiredHttpsUrl(env, "PRIME_PCG_ISSUER").toString().replace(/\/$/, "");
	const jwksUrl = requiredHttpsUrl(env, "PRIME_PCG_JWKS_URL");
	const dataDir = resolve(overrides.dataDir ?? required(env, "PRIME_PCG_DATA_DIR"));
	const masterKey = decodeMasterKey(required(env, "PRIME_PCG_MASTER_KEY"));
	const host = overrides.host ?? env.PRIME_PCG_HOST?.trim() ?? "127.0.0.1";
	const port = overrides.port ?? positivePort(env.PRIME_PCG_PORT, 8787);
	const tenant = env.PRIME_PCG_TENANT?.trim() || "private";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) throw new Error("PRIME_PCG_TENANT must be 1-64 URL-safe characters");
	const allowedClientIds = requiredCsv(env, "PRIME_PCG_ALLOWED_CLIENT_IDS");
	const connectorClientIds = requiredCsv(env, "PRIME_PCG_CONNECTOR_CLIENT_IDS");
	const allowedOrigins = csv(env.PRIME_PCG_ALLOWED_ORIGINS);
	const allowedHosts = new Set([publicUrl.host, ...csv(env.PRIME_PCG_ALLOWED_HOSTS)]);
	const allowedForwardedHosts = new Set([publicUrl.host, ...csv(env.PRIME_PCG_ALLOWED_FORWARDED_HOSTS)]);
	return {
		host,
		port,
		dataDir,
		publicUrl,
		resourceUrl,
		issuer,
		audience,
		jwksUrl,
		tenant,
		masterKey,
		allowedClientIds,
		connectorClientIds,
		allowedOrigins,
		allowedHosts,
		allowedForwardedHosts,
		maxRequestBytes: PCG_MAX_REQUEST_BYTES,
		maxSnapshotBytes: PCG_MAX_SNAPSHOT_BYTES,
		maxReadBytes: PCG_MAX_READ_BYTES,
		maxSearchResults: PCG_MAX_SEARCH_RESULTS,
		maxSnapshots: positiveInt(env.PRIME_PCG_MAX_SNAPSHOTS, 1_000, "PRIME_PCG_MAX_SNAPSHOTS"),
	};
}

export function fingerprintConfig(config: Pick<PcgConfig, "issuer" | "audience" | "tenant">): string {
	return createHash("sha256")
		.update(`${config.issuer}\0${config.audience}\0${config.tenant}`)
		.digest("hex")
		.slice(0, 16);
}

function required(env: PcgEnvironment, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function requiredHttpsUrl(env: PcgEnvironment, name: string): URL {
	let url: URL;
	try {
		url = new URL(required(env, name));
	} catch {
		throw new Error(`${name} must be an absolute HTTPS URL`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash) {
		throw new Error(`${name} must be an absolute HTTPS URL without credentials or a fragment`);
	}
	return url;
}

function decodeMasterKey(value: string): Buffer {
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error("PRIME_PCG_MASTER_KEY must be base64url");
	const key = Buffer.from(value, "base64url");
	if (key.length !== 32) throw new Error("PRIME_PCG_MASTER_KEY must decode to exactly 32 bytes");
	return key;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
	if (!value?.trim()) return fallback;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 1 || number > 1_000_000) throw new Error(`${name} must be 1-1000000`);
	return number;
}

function positivePort(value: string | undefined, fallback: number): number {
	if (!value?.trim()) return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PRIME_PCG_PORT must be 1-65535");
	return port;
}

function csv(value: string | undefined): ReadonlySet<string> {
	return new Set(
		(value ?? "")
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean),
	);
}

function requiredCsv(env: PcgEnvironment, name: string): ReadonlySet<string> {
	const values = csv(required(env, name));
	if (values.size === 0) throw new Error(`${name} must contain at least one client ID`);
	return values;
}
