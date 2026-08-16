import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type DurableDiscordTurnStatus = "reserved" | "accepted" | "running" | "completed" | "failed" | "cancelled";

export interface DurableDiscordTurnRecord {
	version: 1;
	turnId: string;
	logicalSessionId: string;
	requestDigest: string;
	fence: number;
	revision: number;
	status: DurableDiscordTurnStatus;
	terminalResult?: string;
	error?: string;
}

type TurnEvent = DurableDiscordTurnRecord;

/** Durable supervisor-owned state for a Discord request.  Cancellation is absorbing. */
export class DurableDiscordTurnStore {
	private readonly records = new Map<string, DurableDiscordTurnRecord>();

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.load();
	}

	reserve(turnId: string, logicalSessionId: string, requestDigest: string): DurableDiscordTurnRecord {
		if (!turnId || !logicalSessionId || !requestDigest) throw new Error("Durable Discord turn identity is required");
		const existing = this.records.get(turnId);
		if (existing) {
			if (existing.logicalSessionId !== logicalSessionId || existing.requestDigest !== requestDigest) {
				throw new Error(`Durable Discord turn ID conflict: ${turnId}`);
			}
			return { ...existing };
		}
		return this.transition({ version: 1, turnId, logicalSessionId, requestDigest, fence: 0, revision: 0, status: "reserved" });
	}

	get(turnId: string): DurableDiscordTurnRecord | undefined {
		const record = this.records.get(turnId);
		return record && { ...record };
	}

	advance(turnId: string, fence: number, status: Exclude<DurableDiscordTurnStatus, "cancelled">, result?: string): DurableDiscordTurnRecord {
		const current = this.require(turnId);
		if (current.status === "cancelled" || current.fence !== fence) return { ...current };
		if (status === "completed" && !result) throw new Error("Completed Discord turn requires a terminal result");
		return this.transition({ ...current, revision: current.revision + 1, status, ...(result ? { terminalResult: result } : {}) });
	}

	cancel(turnId: string): DurableDiscordTurnRecord {
		const current = this.require(turnId);
		if (current.status === "cancelled") return { ...current };
		return this.transition({ ...current, fence: current.fence + 1, revision: current.revision + 1, status: "cancelled", terminalResult: undefined });
	}

	private require(turnId: string): DurableDiscordTurnRecord {
		const current = this.records.get(turnId);
		if (!current) throw new Error(`Unknown durable Discord turn: ${turnId}`);
		return current;
	}

	private transition(record: DurableDiscordTurnRecord): DurableDiscordTurnRecord {
		this.append(record);
		this.records.set(record.turnId, record);
		return { ...record };
	}

	private append(record: TurnEvent): void {
		const fd = openSync(this.path, "a", 0o600);
		try { writeSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
		chmodSync(this.path, 0o600);
	}

	private load(): void {
		let text: string;
		try { text = readFileSync(this.path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		for (const line of text.split("\n")) {
			if (!line) continue;
			try { const record = JSON.parse(line) as DurableDiscordTurnRecord; if (valid(record)) this.records.set(record.turnId, record); } catch { /* tolerate torn final append */ }
		}
	}
}

function valid(value: DurableDiscordTurnRecord): boolean {
	return value.version === 1 && typeof value.turnId === "string" && typeof value.logicalSessionId === "string" && typeof value.requestDigest === "string" && Number.isInteger(value.fence) && Number.isInteger(value.revision) && ["reserved", "accepted", "running", "completed", "failed", "cancelled"].includes(value.status);
}
