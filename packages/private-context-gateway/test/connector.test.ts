import { describe, expect, it } from "vitest";
import { PcgSnapshotConnector, redactSnapshot } from "../src/connector.js";

describe("PcgSnapshotConnector", () => {
	it("requires explicit approval, redacts before POST, and keeps the M2M token resource-bound", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const connector = new PcgSnapshotConnector({
			resourceUrl: "https://pcg.example.test/mcp",
			tokenUrl: "https://id.example.test/token",
			clientId: "connector",
			clientSecret: "host-only-secret",
			fetch: async (input, init) => {
				calls.push({ url: String(input), init: init ?? {} });
				if (String(input).includes("/token"))
					return new Response(JSON.stringify({ access_token: "m2m-token", expires_in: 300 }), { status: 200 });
				return new Response(JSON.stringify({ id: "a".repeat(16), expiresAt: "2030-01-01T00:00:00.000Z" }), {
					status: 201,
				});
			},
		});
		const result = await connector.publish({
			approval: { kind: "explicit", approvedBy: "user:alice", approvedAt: "2026-08-13T00:00:00.000Z" },
			owner: "user:alice",
			readers: [],
			expiresAt: "2030-01-01T00:00:00.000Z",
			citation: "approved",
			content: "password=not-for-export ghp_abcdefghijklmnopqrstuvwx",
		});
		expect(result.replacements).toBe(2);
		expect(calls).toHaveLength(2);
		expect(String(calls[0]?.init.body)).toContain("resource=https%3A%2F%2Fpcg.example.test%2Fmcp");
		expect(calls[1]?.init.redirect).toBe("error");
		expect(calls[1]?.init.headers).toMatchObject({ Authorization: "Bearer m2m-token" });
		expect(String(calls[1]?.init.body)).not.toContain("not-for-export");
		expect(String(calls[1]?.init.body)).not.toContain("ghp_");
	});

	it("does not pretend redaction is infallible: custom organization rules can be applied", () => {
		const result = redactSnapshot("customer-123 and ordinary text", [/customer-\d+/]);
		expect(result).toEqual({ content: "[REDACTED] and ordinary text", replacements: 1 });
	});
});
