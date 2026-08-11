import type {
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
} from "../../modes/agent-connection/types.js";

export type DiscordExtensionDialogMethod = "select" | "confirm" | "input" | "editor";

export type DiscordExtensionUiPresentation =
	| {
			kind: "dialog";
			method: DiscordExtensionDialogMethod;
			content: string;
			options: readonly string[];
			timeoutMs?: number;
	  }
	| { kind: "notification"; content: string }
	| { kind: "state"; key: string; content?: string }
	| { kind: "unsupported"; dialog: boolean };

export type DiscordExtensionUiInputResult =
	| { accepted: true; response: AgentConnectionExtensionUiResponse }
	| { accepted: false; error: string };

export function presentDiscordExtensionUi(request: AgentConnectionExtensionUiRequest): DiscordExtensionUiPresentation {
	const payload = request.payload;
	switch (request.method) {
		case "select": {
			const title = readString(payload, "title") ?? "Select an option";
			const options = readStringArray(payload, "options");
			if (!options || options.length === 0) return { kind: "unsupported", dialog: true };
			return {
				kind: "dialog",
				method: "select",
				content: [
					`**Prime Agent extension request — ${title}**`,
					...options.map((option, index) => `\`${index + 1}\` — ${option}`),
					"Reply `!prime respond <option number or name>`, or `!prime cancel`.",
				].join("\n"),
				options,
				timeoutMs: readPositiveNumber(payload, "timeout"),
			};
		}
		case "confirm": {
			const title = readString(payload, "title") ?? "Confirm";
			const message = readString(payload, "message");
			return {
				kind: "dialog",
				method: "confirm",
				content: [
					`**Prime Agent extension request — ${title}**`,
					message,
					"Reply `!prime respond yes`, `!prime respond no`, or `!prime cancel`.",
				]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
				options: [],
				timeoutMs: readPositiveNumber(payload, "timeout"),
			};
		}
		case "input":
		case "editor": {
			const title = readString(payload, "title") ?? "Enter a value";
			const hint = readString(payload, request.method === "editor" ? "prefill" : "placeholder");
			return {
				kind: "dialog",
				method: request.method,
				content: [
					`**Prime Agent extension request — ${title}**`,
					hint
						? `${request.method === "editor" ? "Current value" : "Hint"}:
${hint}`
						: undefined,
					"Reply `!prime respond <value>`, or `!prime cancel`.",
				]
					.filter((line): line is string => Boolean(line))
					.join("\n"),
				options: [],
				timeoutMs: readPositiveNumber(payload, "timeout"),
			};
		}
		case "notify": {
			const message = readString(payload, "message");
			if (!message) return { kind: "unsupported", dialog: false };
			const notifyType = readString(payload, "notifyType") ?? "info";
			return {
				kind: "notification",
				content: `**Prime Agent extension notification (${notifyType})**
${message}`,
			};
		}
		case "setStatus": {
			const statusKey = readString(payload, "statusKey") ?? "status";
			const statusText = readString(payload, "statusText");
			return {
				kind: "state",
				key: `status:${statusKey}`,
				content: statusText
					? `**Prime Agent extension status — ${statusKey}**
${statusText}`
					: undefined,
			};
		}
		case "setWidget": {
			const widgetKey = readString(payload, "widgetKey") ?? "widget";
			const widgetLines = readStringArray(payload, "widgetLines");
			return {
				kind: "state",
				key: `widget:${widgetKey}`,
				content: widgetLines
					? `**Prime Agent extension widget — ${widgetKey}**
${widgetLines.join("\n")}`
					: undefined,
			};
		}
		case "setTitle": {
			const title = readString(payload, "title");
			return {
				kind: "state",
				key: "title",
				content: title ? `**Prime Agent extension title:** ${title}` : undefined,
			};
		}
		case "setEditorText":
		case "set_editor_text": {
			const text = readString(payload, "text");
			return {
				kind: "state",
				key: "editor-text",
				content: text
					? `**Prime Agent extension suggested input**
${text}`
					: undefined,
			};
		}
		default:
			return { kind: "unsupported", dialog: false };
	}
}

export type DiscordExtensionReplyControl = { type: "response"; value: string } | { type: "cancel" };

export function parseDiscordExtensionReplyControl(content: string): DiscordExtensionReplyControl | undefined {
	const trimmed = content.trim();
	if (/^!prime\s+cancel$/i.test(trimmed)) return { type: "cancel" };
	const response = /^!prime\s+respond(?:\s+([\s\S]+))?$/i.exec(trimmed);
	return response ? { type: "response", value: response[1]?.trim() ?? "" } : undefined;
}

export function parseDiscordExtensionUiInput(
	method: DiscordExtensionDialogMethod,
	options: readonly string[],
	input: string,
): DiscordExtensionUiInputResult {
	const value = input.trim();
	const normalized = value.toLowerCase();
	if (["cancel", "/cancel", "!cancel", "!prime abort"].includes(normalized)) {
		return { accepted: true, response: { cancelled: true } };
	}
	if (method === "confirm") {
		if (["yes", "y", "true", "confirm", "1"].includes(normalized)) {
			return { accepted: true, response: { confirmed: true } };
		}
		if (["no", "n", "false", "0"].includes(normalized)) {
			return { accepted: true, response: { confirmed: false } };
		}
		return { accepted: false, error: "Please reply `yes`, `no`, or `cancel`." };
	}
	if (method === "select") {
		const exact = options.find((option) => option.toLowerCase() === normalized);
		const index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
		const selected = exact ?? (index >= 0 ? options[index] : undefined);
		return selected
			? { accepted: true, response: { value: selected } }
			: { accepted: false, error: "Please reply with a listed option number/name, or `cancel`." };
	}
	return value
		? { accepted: true, response: { value } }
		: { accepted: false, error: "Please provide a value, or reply `cancel`." };
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
	const value = payload[key];
	return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function readPositiveNumber(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
