import { describe, expect, it } from "vitest";
import {
	HOST_OWNED_DAEMON_ENV,
	HOST_OWNED_DAEMON_RESTART_EXIT_CODE,
	isHostOwnedDaemon,
} from "../src/modes/daemon/daemon-host-ownership.js";

describe("host-owned daemon lifecycle", () => {
	it("requires an explicit service ownership marker and uses a restartable nonzero status", () => {
		expect(isHostOwnedDaemon({})).toBe(false);
		expect(isHostOwnedDaemon({ [HOST_OWNED_DAEMON_ENV]: "0" })).toBe(false);
		expect(isHostOwnedDaemon({ [HOST_OWNED_DAEMON_ENV]: "1" })).toBe(true);
		expect(HOST_OWNED_DAEMON_RESTART_EXIT_CODE).toBeGreaterThan(0);
	});
});
