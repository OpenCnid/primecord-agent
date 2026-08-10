import { resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import { defaultDaemonSocketPath } from "../../modes/daemon/daemon-socket.js";
import { DiscordBridge } from "./bridge.js";
import { type DiscordEnvironment, loadDiscordConfig } from "./config.js";

interface DiscordGatewayCliOptions {
	cwd?: string;
	daemonSocket?: string;
}

export async function runDiscordGatewayCommand(args: readonly string[]): Promise<void> {
	const options = parseDiscordGatewayArgs(args);
	const environment: DiscordEnvironment = {
		...process.env,
		PRIME_DISCORD_BOT_TOKEN: process.env.PRIME_DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN,
		PRIME_DISCORD_CWD: options.cwd ?? process.env.PRIME_DISCORD_CWD,
	};
	const config = loadDiscordConfig(environment);
	delete process.env.PRIME_DISCORD_BOT_TOKEN;
	delete process.env.DISCORD_BOT_TOKEN;

	const bridge = new DiscordBridge(config, {
		agentDir: getAgentDir(),
		socketPath: options.daemonSocket ?? defaultDaemonSocketPath(),
	});
	let signalHandled = false;
	const handleSignal = (signal: NodeJS.Signals) => {
		if (signalHandled) return;
		signalHandled = true;
		process.exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
		void bridge.stop().catch(() => undefined);
	};
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (process.platform !== "win32") signals.push("SIGHUP");
	const signalHandlers = signals.map((signal) => {
		const handler = () => handleSignal(signal);
		process.on(signal, handler);
		return { signal, handler };
	});

	try {
		const tag = await bridge.start();
		console.log(`Prime Agent Discord gateway connected as ${tag}.`);
		await bridge.waitUntilStopped();
		await bridge.stop();
	} catch (error) {
		let shutdownError: unknown;
		try {
			await bridge.stop();
		} catch (stopError) {
			shutdownError = stopError;
		}
		if (shutdownError) throw shutdownError;
		if (!signalHandled) throw error;
	} finally {
		for (const { signal, handler } of signalHandlers) process.off(signal, handler);
	}
}

export function parseDiscordGatewayArgs(args: readonly string[]): DiscordGatewayCliOptions {
	const options: DiscordGatewayCliOptions = {};
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === "--cwd" || argument === "--daemon-socket") {
			const value = args[++index];
			if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value`);
			if (argument === "--cwd") options.cwd = resolve(value);
			else options.daemonSocket = resolve(value);
			continue;
		}
		throw new Error(`Unknown Discord gateway option: ${argument}`);
	}
	return options;
}
