import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PcgConfig } from "./config.js";

const SNAPSHOT_LOG = "snapshots.v1.jsonl";
const AUDIT_LOG = "audit.v1.jsonl";
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MAX_AUDIT_FIELD_BYTES = 1024;

export interface SnapshotInput {
	id: string;
	owner: string;
	readers: readonly string[];
	expiresAt: string;
	citation: string;
	content: string;
}

type SnapshotPayload = Omit<SnapshotInput, "id" | "expiresAt">;

export interface SnapshotRecord {
	version: 1;
	id: string;
	tenant: string;
	expiresAt: string;
	createdAt: string;
	nonce: string;
	ciphertext: string;
}

export interface AuditRecord {
	version: 1;
	at: string;
	action: "snapshot.ingest" | "memory.search" | "memory.read";
	principal: string;
	clientId: string;
	resourceId?: string;
	outcome: "allow" | "deny";
	count?: number;
	previousHash: string;
	hash: string;
}

export interface StoredSnapshot {
	id: string;
	citation: string;
	content: string;
	expiresAt: string;
}

/**
 * Small private-tenant storage: metadata needed for expiry is cleartext; all
 * context, source/citation, and ACL identities live inside AES-256-GCM payloads.
 * The snapshot journal is compacted only to remove expired records. Audit is never
 * compacted by this process and is hash chained.
 */
export class PcgStore {
	private readonly snapshots = new Map<string, SnapshotRecord>();
	private readonly snapshotFile: string;
	private readonly auditFile: string;
	private auditHead = "";

	constructor(private readonly config: Pick<PcgConfig, "dataDir" | "masterKey" | "tenant" | "maxSnapshots">) {
		this.snapshotFile = join(config.dataDir, SNAPSHOT_LOG);
		this.auditFile = join(config.dataDir, AUDIT_LOG);
	}

	async initialize(): Promise<void> {
		await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
		await this.loadSnapshots();
		await this.compactExpired();
		await this.loadAuditHead();
	}

	async ingest(input: SnapshotInput): Promise<void> {
		validateSnapshotInput(input);
		await this.compactExpired();
		if (this.snapshots.has(input.id))
			throw new Error("Snapshot id already exists; updates require a new explicit export");
		if (this.snapshots.size >= this.config.maxSnapshots) throw new Error("Snapshot quota is exhausted");
		const createdAt = new Date().toISOString();
		const nonce = randomBytes(GCM_NONCE_BYTES);
		const cipher = createCipheriv("aes-256-gcm", this.config.masterKey, nonce);
		cipher.setAAD(aad(this.config.tenant, input.id, input.expiresAt));
		const payload: SnapshotPayload = {
			owner: input.owner,
			readers: uniqueSorted(input.readers),
			citation: input.citation,
			content: input.content,
		};
		const ciphertext = Buffer.concat([
			cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
			cipher.final(),
			cipher.getAuthTag(),
		]);
		const record: SnapshotRecord = {
			version: 1,
			id: input.id,
			tenant: this.config.tenant,
			expiresAt: input.expiresAt,
			createdAt,
			nonce: nonce.toString("base64url"),
			ciphertext: ciphertext.toString("base64url"),
		};
		await appendJsonLine(this.snapshotFile, record);
		this.snapshots.set(record.id, record);
	}

	search(principal: string, query: string, limit: number, now = new Date()): StoredSnapshot[] {
		const terms = tokenize(query);
		if (terms.length === 0) return [];
		return Array.from(this.snapshots.values())
			.filter((record) => record.expiresAt > now.toISOString())
			.map((record) => ({ record, payload: this.decrypt(record) }))
			.filter(({ payload }) => canRead(payload, principal))
			.map(({ record, payload }) => ({ record, payload, score: score(payload.content, terms) }))
			.filter((result) => result.score > 0)
			.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
			.slice(0, limit)
			.map(({ record, payload }) => ({
				id: record.id,
				citation: payload.citation,
				content: excerpt(payload.content, terms),
				expiresAt: record.expiresAt,
			}));
	}

	read(principal: string, id: string, now = new Date()): StoredSnapshot | undefined {
		const record = this.snapshots.get(id);
		if (!record || record.expiresAt <= now.toISOString()) return undefined;
		const payload = this.decrypt(record);
		if (!canRead(payload, principal)) return undefined;
		return { id: record.id, citation: payload.citation, content: payload.content, expiresAt: record.expiresAt };
	}

	async audit(event: Omit<AuditRecord, "version" | "at" | "previousHash" | "hash">): Promise<void> {
		const value = {
			version: 1 as const,
			at: new Date().toISOString(),
			action: event.action,
			principal: boundedAuditField(event.principal),
			clientId: boundedAuditField(event.clientId),
			...(event.resourceId ? { resourceId: boundedAuditField(event.resourceId) } : {}),
			outcome: event.outcome,
			...(event.count === undefined ? {} : { count: event.count }),
			previousHash: this.auditHead,
		};
		const record: AuditRecord = { ...value, hash: hashRecord(value) };
		await appendJsonLine(this.auditFile, record);
		this.auditHead = record.hash;
	}

	private decrypt(record: SnapshotRecord): SnapshotPayload {
		if (record.tenant !== this.config.tenant) throw new Error("Snapshot belongs to a different tenant");
		const payload = Buffer.from(record.ciphertext, "base64url");
		if (payload.length <= GCM_TAG_BYTES) throw new Error("Stored snapshot ciphertext is malformed");
		try {
			const decipher = createDecipheriv(
				"aes-256-gcm",
				this.config.masterKey,
				Buffer.from(record.nonce, "base64url"),
			);
			decipher.setAAD(aad(record.tenant, record.id, record.expiresAt));
			decipher.setAuthTag(payload.subarray(-GCM_TAG_BYTES));
			return parsePayload(
				Buffer.concat([decipher.update(payload.subarray(0, -GCM_TAG_BYTES)), decipher.final()]).toString("utf8"),
			);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Stored snapshot")) throw error;
			throw new Error("Stored snapshot authentication failed");
		}
	}

	private async loadSnapshots(): Promise<void> {
		for (const line of await readLinesIfExists(this.snapshotFile)) {
			const record = parseSnapshot(line);
			if (record.tenant !== this.config.tenant) continue;
			if (this.snapshots.has(record.id)) throw new Error("Duplicate snapshot id in storage");
			this.snapshots.set(record.id, record);
		}
		if (this.snapshots.size > this.config.maxSnapshots)
			throw new Error("Stored snapshot count exceeds configured quota");
	}

	private async compactExpired(now = new Date()): Promise<void> {
		const active = Array.from(this.snapshots.values()).filter((record) => record.expiresAt > now.toISOString());
		if (active.length === this.snapshots.size) return;
		this.snapshots.clear();
		for (const record of active) this.snapshots.set(record.id, record);
		const temporary = `${this.snapshotFile}.${process.pid}.tmp`;
		await writeFile(
			temporary,
			active.map((record) => JSON.stringify(record)).join(active.length ? "\n" : "") + (active.length ? "\n" : ""),
			{
				encoding: "utf8",
				mode: 0o600,
			},
		);
		await rename(temporary, this.snapshotFile);
	}

	private async loadAuditHead(): Promise<void> {
		let previousHash = "";
		for (const line of await readLinesIfExists(this.auditFile)) {
			const record = parseAudit(line);
			if (record.previousHash !== previousHash || record.hash !== hashRecord(withoutHash(record))) {
				throw new Error("PCG audit log integrity check failed");
			}
			previousHash = record.hash;
		}
		this.auditHead = previousHash;
	}
}

function aad(tenant: string, id: string, expiresAt: string): Buffer {
	return Buffer.from(`primecord-pcg/v1\0${tenant}\0${id}\0${expiresAt}`, "utf8");
}

function canRead(payload: SnapshotPayload, principal: string): boolean {
	return payload.owner === principal || payload.readers.includes(principal);
}

function score(content: string, terms: readonly string[]): number {
	const haystack = content.toLocaleLowerCase();
	return terms.reduce((total, term) => total + occurrences(haystack, term), 0);
}

function occurrences(haystack: string, needle: string): number {
	let count = 0;
	let at = 0;
	while (at < haystack.length) {
		const found = haystack.indexOf(needle, at);
		if (found === -1) break;
		count++;
		at = found + needle.length;
	}
	return count;
}

function excerpt(content: string, terms: readonly string[]): string {
	const lower = content.toLocaleLowerCase();
	const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
	const start = Math.max(0, first - 160);
	const end = Math.min(content.length, start + 480);
	return `${start ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

function tokenize(query: string): string[] {
	return uniqueSorted(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).slice(0, 16);
}

function uniqueSorted(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

function validateSnapshotInput(input: SnapshotInput): void {
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.id))
		throw new Error("Snapshot id must be an opaque 16-128 character URL-safe token");
	if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(input.owner)) throw new Error("Snapshot owner is invalid");
	if (
		!Array.isArray(input.readers) ||
		input.readers.length > 256 ||
		input.readers.some((value) => !/^[A-Za-z0-9._:@/-]{1,256}$/.test(value))
	)
		throw new Error("Snapshot readers are invalid");
	if (!Number.isFinite(Date.parse(input.expiresAt)) || input.expiresAt <= new Date().toISOString())
		throw new Error("Snapshot expiry must be an ISO date in the future");
	if (!input.citation.trim() || Buffer.byteLength(input.citation, "utf8") > 1024)
		throw new Error("Snapshot citation is invalid");
	if (!input.content.trim()) throw new Error("Snapshot content must not be empty");
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
	const file = await open(path, "a", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
}

async function readLinesIfExists(path: string): Promise<string[]> {
	try {
		return (await readFile(path, "utf8")).split("\n").filter(Boolean);
	} catch (error: unknown) {
		if (isErrno(error, "ENOENT")) return [];
		throw error;
	}
}

function parseSnapshot(line: string): SnapshotRecord {
	const value: unknown = JSON.parse(line);
	if (
		!isObject(value) ||
		value.version !== 1 ||
		!isString(value.id) ||
		!isString(value.tenant) ||
		!isString(value.expiresAt) ||
		!isString(value.createdAt) ||
		!isString(value.nonce) ||
		!isString(value.ciphertext)
	)
		throw new Error("Stored snapshot record is malformed");
	return value as unknown as SnapshotRecord;
}

function parsePayload(raw: string): SnapshotPayload {
	const value: unknown = JSON.parse(raw);
	if (
		!isObject(value) ||
		!isString(value.owner) ||
		!Array.isArray(value.readers) ||
		!value.readers.every(isString) ||
		!isString(value.citation) ||
		!isString(value.content)
	)
		throw new Error("Stored snapshot payload is malformed");
	return value as unknown as SnapshotPayload;
}

function parseAudit(line: string): AuditRecord {
	const value: unknown = JSON.parse(line);
	if (
		!isObject(value) ||
		value.version !== 1 ||
		!isString(value.at) ||
		!isString(value.action) ||
		!isString(value.principal) ||
		!isString(value.clientId) ||
		!isString(value.outcome) ||
		!isString(value.previousHash) ||
		!isString(value.hash)
	)
		throw new Error("Stored audit record is malformed");
	return value as unknown as AuditRecord;
}

function withoutHash(record: AuditRecord): Omit<AuditRecord, "hash"> {
	const { hash: _hash, ...value } = record;
	return value;
}
function hashRecord(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function boundedAuditField(value: string): string {
	return Buffer.from(value, "utf8").subarray(0, MAX_AUDIT_FIELD_BYTES).toString("utf8");
}
function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isString(value: unknown): value is string {
	return typeof value === "string";
}
function isErrno(value: unknown, code: string): boolean {
	return isObject(value) && value.code === code;
}
export function equalOpaque(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
