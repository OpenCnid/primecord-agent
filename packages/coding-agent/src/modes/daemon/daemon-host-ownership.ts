/** Marks a supervisor owned by systemd rather than a detached worker/update handoff. */
export const HOST_OWNED_DAEMON_ENV = "PRIME_AGENT_HOST_OWNED_DAEMON";
/** Nonzero status that lets a service manager restart a requested replacement. */
export const HOST_OWNED_DAEMON_RESTART_EXIT_CODE = 75;
export function isHostOwnedDaemon(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[HOST_OWNED_DAEMON_ENV] === "1";
}
