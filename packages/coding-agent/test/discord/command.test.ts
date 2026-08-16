import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiscordGatewayArgs } from "../../src/gateway/discord/command.js";

describe("parseDiscordGatewayArgs", () => {
	it("returns no overrides when no options are provided", () => {
		expect(parseDiscordGatewayArgs([])).toEqual({});
	});

	it("resolves cwd and daemon socket paths", () => {
		expect(parseDiscordGatewayArgs(["--cwd", "workspace", "--daemon-socket", "state/daemon.sock"])).toEqual({
			cwd: resolve("workspace"),
			daemonSocket: resolve("state/daemon.sock"),
		});
	});

	it("uses the last value when an option is repeated", () => {
		expect(parseDiscordGatewayArgs(["--cwd", "first", "--cwd", "second"])).toEqual({
			cwd: resolve("second"),
		});
	});

	it("selects an attach-only external daemon without relying on ambient environment", () => {
		expect(parseDiscordGatewayArgs(["--daemon-owner", "external"])).toEqual({ daemonOwner: "external" });
		expect(parseDiscordGatewayArgs(["--daemon-owner", "managed"])).toEqual({ daemonOwner: "managed" });
		expect(() => parseDiscordGatewayArgs(["--daemon-owner", "child"])).toThrow(
			"--daemon-owner must be one of: managed, external",
		);
	});

	it.each(["--cwd", "--daemon-socket"])("rejects a missing value for %s", (option) => {
		expect(() => parseDiscordGatewayArgs([option])).toThrow(`${option} requires a value`);
		expect(() => parseDiscordGatewayArgs([option, ""])).toThrow(`${option} requires a value`);
		expect(() => parseDiscordGatewayArgs([option, "--cwd"])).toThrow(`${option} requires a value`);
	});

	it("rejects unknown and equals-form options", () => {
		expect(() => parseDiscordGatewayArgs(["--unknown"])).toThrow("Unknown Discord gateway option: --unknown");
		expect(() => parseDiscordGatewayArgs(["--cwd=workspace"])).toThrow(
			"Unknown Discord gateway option: --cwd=workspace",
		);
	});
});
