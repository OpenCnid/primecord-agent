#!/usr/bin/env node
/**
 * Keep a raw ws error listener attached while @discordjs/ws discards a
 * connecting socket. ws can emit the opening-handshake timeout afterwards;
 * without a listener Node terminates on the unhandled EventEmitter error.
 *
 * This is intentionally version-pinned and fails loudly if upstream changes
 * the affected implementation, rather than silently applying an unsafe patch.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(repositoryRoot, "node_modules/@discordjs/ws/package.json");
const targets = [
	"node_modules/@discordjs/ws/dist/index.js",
	"node_modules/@discordjs/ws/dist/index.mjs",
	"node_modules/@discordjs/ws/dist/defaultWorker.js",
	"node_modules/@discordjs/ws/dist/defaultWorker.mjs",
];
const original = "      this.connection.onerror = null;";
const replacement = [
	"      // A CONNECTING ws client can emit its handshake error after teardown.",
	"      // Keep that raw EventEmitter error consumed so it cannot terminate Node.",
	"      this.connection.onerror = () => undefined;",
].join("\n");

const installed = JSON.parse(await readFile(packagePath, "utf8"));
if (installed.version !== "1.2.3") {
	throw new Error(`Unsupported @discordjs/ws version ${installed.version}; review the handshake teardown patch.`);
}

let changed = 0;
for (const relativePath of targets) {
	const path = resolve(repositoryRoot, relativePath);
	const source = await readFile(path, "utf8");
	if (source.includes(replacement)) continue;
	const occurrences = source.split(original).length - 1;
	if (occurrences !== 1) {
		throw new Error(`Expected one unpatched error-listener teardown in ${relativePath}, found ${occurrences}.`);
	}
	await writeFile(path, source.replace(original, replacement));
	changed++;
}
console.log(`@discordjs/ws handshake teardown patch ${changed === 0 ? "already applied" : "applied"}.`);
