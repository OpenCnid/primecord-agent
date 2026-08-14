import { describe, expect, it } from "vitest";
import { hasScope } from "../src/auth.js";

describe("PCG OAuth scope hierarchy", () => {
	it("allows only the resource server's defined colon-delimited parent scopes", () => {
		expect(hasScope(new Set(["memory"]), "memory:search")).toBe(true);
		expect(hasScope(new Set(["memory"]), "memory:read")).toBe(true);
		expect(hasScope(new Set(["memory:search"]), "memory:read")).toBe(false);
		expect(hasScope(new Set(["pcg.snapshot"]), "pcg.snapshot.write")).toBe(false);
	});
});
