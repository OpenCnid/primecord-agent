import { AsyncLocalStorage } from "node:async_hooks";
import type { DaemonSocketClient } from "./active-session-state.js";

export interface DaemonExtensionUiExecutionOwner {
	client: DaemonSocketClient;
	supportsExtensionUi: boolean;
	supportsDiscordGatewayRead?: boolean;
	targetClientId?: string;
}

const extensionUiOwnerStorage = new AsyncLocalStorage<DaemonExtensionUiExecutionOwner>();

export function currentDaemonExtensionUiExecutionOwner(): DaemonExtensionUiExecutionOwner | undefined {
	return extensionUiOwnerStorage.getStore();
}

export function withDaemonExtensionUiExecutionOwner<T>(
	owner: DaemonExtensionUiExecutionOwner,
	run: () => Promise<T>,
): Promise<T> {
	return extensionUiOwnerStorage.run(owner, run);
}
