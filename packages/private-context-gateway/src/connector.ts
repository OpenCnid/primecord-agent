import { randomUUID } from "node:crypto";

const DEFAULT_REDACTIONS: ReadonlyArray<RegExp> = [
	/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
	/\b(?:ghp|github_pat|glpat|xox[baprs])_[A-Za-z0-9_=-]{16,}\b/g,
	/\b(?:sk|rk)_[A-Za-z0-9_-]{20,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
	/\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[^\s"',;]{8,}/gi,
];

export interface ExplicitExportApproval {
	kind: "explicit";
	approvedBy: string;
	approvedAt: string;
}

export interface SnapshotExportInput {
	/** A caller must make an explicit local approval before this connector releases data. */
	approval: ExplicitExportApproval;
	owner: string;
	readers: readonly string[];
	expiresAt: string;
	citation: string;
	content: string;
}

export interface RedactionResult {
	content: string;
	replacements: number;
}

export interface PcgSnapshotConnectorConfig {
	/** Exact canonical MCP resource URL, e.g. https://pcg.example.com/mcp. */
	resourceUrl: string;
	/** Organization IdP token endpoint; HTTPS only. */
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	/** Additional organization-specific redaction patterns, compiled by application code. */
	redactions?: readonly RegExp[];
	fetch?: typeof fetch;
}

interface CachedToken {
	accessToken: string;
	expiresAt: number;
}

/**
 * Host-side-only outbound publisher. It obtains and keeps the client secret and
 * access token in its own process; its public method accepts only an explicit
 * export and sends a pre-redacted snapshot to PCG over HTTPS with redirects off.
 */
export class PcgSnapshotConnector {
	private readonly resourceUrl: URL;
	private readonly endpoint: URL;
	private readonly tokenUrl: URL;
	private readonly fetchFn: typeof fetch;
	private readonly redactions: readonly RegExp[];
	private token: CachedToken | undefined;

	constructor(private readonly config: PcgSnapshotConnectorConfig) {
		this.resourceUrl = httpsUrl(config.resourceUrl, "PCG resource URL");
		if (this.resourceUrl.pathname !== "/mcp" || this.resourceUrl.search || this.resourceUrl.hash)
			throw new Error("PCG resource URL must be the canonical HTTPS /mcp URL");
		this.endpoint = new URL("/connector/v1/snapshots", this.resourceUrl);
		this.tokenUrl = httpsUrl(config.tokenUrl, "OIDC token URL");
		if (!config.clientId || !config.clientSecret) throw new Error("Connector OAuth client credentials are required");
		this.fetchFn = config.fetch ?? fetch;
		this.redactions = [...DEFAULT_REDACTIONS, ...(config.redactions ?? [])];
	}

	async publish(input: SnapshotExportInput): Promise<{ id: string; expiresAt: string; replacements: number }> {
		validateExplicitApproval(input.approval);
		validateExport(input);
		const redacted = redactSnapshot(input.content, this.redactions);
		const response = await this.fetchFn(this.endpoint, {
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${await this.accessToken()}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				id: randomUUID().replaceAll("-", ""),
				owner: input.owner,
				readers: input.readers,
				expiresAt: input.expiresAt,
				citation: input.citation,
				content: redacted.content,
			}),
		});
		if (response.status !== 201) throw new Error(`PCG snapshot export failed with HTTP ${response.status}`);
		const body: unknown = await response.json();
		if (!isRecord(body) || typeof body.id !== "string" || typeof body.expiresAt !== "string")
			throw new Error("PCG snapshot export returned an invalid response");
		return { id: body.id, expiresAt: body.expiresAt, replacements: redacted.replacements };
	}

	private async accessToken(): Promise<string> {
		if (this.token && Date.now() < this.token.expiresAt) return this.token.accessToken;
		const body = new URLSearchParams({
			grant_type: "client_credentials",
			client_id: this.config.clientId,
			client_secret: this.config.clientSecret,
			resource: this.resourceUrl.toString(),
			scope: "pcg.snapshot.write",
		});
		const response = await this.fetchFn(this.tokenUrl, {
			method: "POST",
			redirect: "error",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body,
		});
		if (!response.ok) throw new Error(`Connector token request failed with HTTP ${response.status}`);
		const value: unknown = await response.json();
		if (
			!isRecord(value) ||
			typeof value.access_token !== "string" ||
			!value.access_token ||
			typeof value.expires_in !== "number" ||
			!Number.isFinite(value.expires_in) ||
			value.expires_in <= 0
		) {
			throw new Error("Connector token response is invalid");
		}
		this.token = {
			accessToken: value.access_token,
			expiresAt: Date.now() + Math.max(1, value.expires_in - 30) * 1_000,
		};
		return this.token.accessToken;
	}
}

export function redactSnapshot(content: string, redactions: readonly RegExp[] = DEFAULT_REDACTIONS): RedactionResult {
	let replacements = 0;
	let value = content;
	for (const source of redactions) {
		const expression = ensureGlobal(source);
		value = value.replace(expression, () => {
			replacements++;
			return "[REDACTED]";
		});
	}
	return { content: value, replacements };
}

function ensureGlobal(expression: RegExp): RegExp {
	return new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`);
}

function validateExplicitApproval(value: ExplicitExportApproval): void {
	if (value.kind !== "explicit" || !validPrincipal(value.approvedBy) || !Number.isFinite(Date.parse(value.approvedAt)))
		throw new Error("A current explicit snapshot-export approval is required");
}

function validateExport(input: SnapshotExportInput): void {
	if (
		!validPrincipal(input.owner) ||
		!Array.isArray(input.readers) ||
		input.readers.some((reader) => !validPrincipal(reader))
	)
		throw new Error("Snapshot owner/readers are invalid");
	if (!input.content.trim() || Buffer.byteLength(input.content, "utf8") > 64 * 1024)
		throw new Error("Snapshot content must be 1-65536 bytes before redaction");
	if (!input.citation.trim() || Buffer.byteLength(input.citation, "utf8") > 1024)
		throw new Error("Snapshot citation is invalid");
	if (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= new Date().toISOString())
		throw new Error("Snapshot expiry must be in the future");
}
function validPrincipal(value: string): boolean {
	return /^[A-Za-z0-9._:@/-]{1,256}$/.test(value);
}
function httpsUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an absolute HTTPS URL`);
	}
	if (url.protocol !== "https:" || url.username || url.password || url.hash)
		throw new Error(`${label} must be an absolute HTTPS URL without credentials or a fragment`);
	return url;
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
