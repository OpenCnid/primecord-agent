#!/usr/bin/env node
import { JwtTokenVerifier } from "./auth.js";
import { loadPcgConfig } from "./config.js";
import { createPcgServer } from "./gateway.js";
import { PcgStore } from "./store.js";

const config = loadPcgConfig();
const store = new PcgStore(config);
await store.initialize();
const server = createPcgServer({ config, store, verifier: new JwtTokenVerifier(config) });
server.listen(config.port, config.host, () => {
	process.stdout.write(`Primecord PCG listening on ${config.host}:${config.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => server.close(() => process.exit(0)));
}
