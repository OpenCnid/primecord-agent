import { describe, expect, it } from "vitest";
import { createSessionKey } from "../../src/gateway/discord/session-key.js";

describe("createSessionKey", () => {
	it("is stable for the same conversation", () => {
		const input = { kind: "guild" as const, guildId: "guild-1", channelId: "channel-1", userId: "user-1" };
		expect(createSessionKey(input)).toBe(createSessionKey(input));
		expect(createSessionKey(input)).toMatch(/^discord:v1:[A-Za-z0-9_-]+$/);
	});

	it("isolates guild and thread sessions per user by default", () => {
		const guild = { kind: "guild" as const, guildId: "guild-1", channelId: "channel-1" };
		expect(createSessionKey({ ...guild, userId: "user-1" })).not.toBe(
			createSessionKey({ ...guild, userId: "user-2" }),
		);

		const thread = { kind: "thread" as const, guildId: "guild-1", channelId: "thread-1" };
		expect(createSessionKey({ ...thread, userId: "user-1" })).not.toBe(
			createSessionKey({ ...thread, userId: "user-2" }),
		);
	});

	it("supports shared guild and thread sessions", () => {
		const input = { kind: "guild" as const, guildId: "guild-1", channelId: "channel-1" };
		expect(createSessionKey({ ...input, userId: "user-1" }, { shared: true })).toBe(
			createSessionKey({ ...input, userId: "user-2" }, { shared: true }),
		);
		expect(createSessionKey({ ...input, userId: "user-1" }, { groupSessionsPerUser: false })).toBe(
			createSessionKey({ ...input, userId: "user-2" }, { groupSessionsPerUser: false }),
		);
		expect(createSessionKey({ ...input, userId: "user-1" }, { shared: false })).not.toBe(
			createSessionKey({ ...input, userId: "user-2" }, { shared: false }),
		);
	});

	it("keeps DMs private even when shared guild sessions are enabled", () => {
		const dm = { kind: "dm" as const, channelId: "dm-1" };
		expect(createSessionKey({ ...dm, userId: "user-1" }, { shared: true })).not.toBe(
			createSessionKey({ ...dm, userId: "user-2" }, { shared: true }),
		);
	});

	it("separates channel kinds, guilds, and adversarial component boundaries", () => {
		const base = { guildId: "guild-1", channelId: "channel-1", userId: "user-1" };
		expect(createSessionKey({ ...base, kind: "guild" })).not.toBe(createSessionKey({ ...base, kind: "thread" }));
		expect(createSessionKey({ ...base, kind: "guild" })).not.toBe(
			createSessionKey({ ...base, kind: "guild", guildId: "guild-2" }),
		);
		expect(createSessionKey({ kind: "guild", guildId: "a", channelId: "b:c", userId: "d" })).not.toBe(
			createSessionKey({ kind: "guild", guildId: "a:b", channelId: "c", userId: "d" }),
		);
	});

	it("rejects incomplete session coordinates", () => {
		expect(() => createSessionKey({ kind: "guild", channelId: "channel-1", userId: "user-1" })).toThrow(
			"guildId is required",
		);
		expect(() => createSessionKey({ kind: "dm", channelId: "", userId: "user-1" })).toThrow("channelId is required");
	});
});
