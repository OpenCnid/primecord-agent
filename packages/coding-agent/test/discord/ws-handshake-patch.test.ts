import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

/**
 * @discordjs/ws clears `onerror` while a ws client is still CONNECTING. A later
 * handshake timeout then becomes an unhandled EventEmitter error and exits Node.
 * The root postinstall patch retains a no-op listener for that teardown case.
 */
describe("Discord WebSocket handshake teardown patch", () => {
	it("survives a handshake timeout after destroying a connecting socket", async () => {
		const script = `
			const net = require("node:net");
			const { WebSocketShard, WebSocketShardEvents } = require("@discordjs/ws");
			const server = net.createServer(() => {});
			server.listen(0, "127.0.0.1", () => {
				const { port } = server.address();
				const strategy = {
					options: {
						version: "10", encoding: "json", compression: null,
						gatewayInformation: { url: "ws://127.0.0.1:" + port },
						shardCount: 1, handshakeTimeout: 50, helloTimeout: 1_000,
					},
					retrieveSessionInfo: async () => null,
					updateSessionInfo: async () => {},
					waitForIdentify: async () => {},
				};
				const shard = new WebSocketShard(strategy, 0);
				shard.on(WebSocketShardEvents.Error, () => {});
				shard.connect().catch(() => {});
				setTimeout(() => void shard.destroy(), 10);
				setTimeout(() => {
					console.log("survived");
					server.close();
					process.exit(0);
				}, 200);
			});
		`;
		const { stdout } = await execFile(process.execPath, ["-e", script], { timeout: 2_000 });
		expect(stdout).toContain("survived");
	});
});
