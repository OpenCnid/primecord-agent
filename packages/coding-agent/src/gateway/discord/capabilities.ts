import { basename } from "node:path";
import type {
	AgentConnectionResourceSnapshot,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "../../modes/agent-connection/types.js";

export type DiscordTextControl = { type: "capabilities" } | { type: "run"; input: string };

export interface DiscordResourceInvocation {
	command: AgentConnectionSlashCommand;
	prompt: string;
}

const DISPLAY_LIMIT = 20;

export function parseDiscordTextControl(content: string): DiscordTextControl | undefined {
	const trimmed = content.trim();
	if (/^!prime\s+(?:capabilities|commands)$/i.test(trimmed)) {
		return { type: "capabilities" };
	}
	const run = /^!prime\s+run(?:\s+([\s\S]+))?$/i.exec(trimmed);
	if (!run) return undefined;
	return { type: "run", input: run[1]?.trim() ?? "" };
}

export function resolveDiscordResourceInvocation(
	input: string,
	commands: readonly AgentConnectionSlashCommand[],
): DiscordResourceInvocation | undefined {
	const trimmed = input.trim();
	if (!trimmed) return undefined;
	const prompt = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	const separator = prompt.search(/\s/);
	const name = prompt.slice(1, separator === -1 ? undefined : separator);
	const command = commands.find((candidate) => candidate.name === name);
	return command ? { command, prompt } : undefined;
}

export function formatDiscordCapabilities(
	state: AgentConnectionState,
	resources: AgentConnectionResourceSnapshot,
	commands: readonly AgentConnectionSlashCommand[],
): string {
	const commandNames = (source: AgentConnectionSlashCommand["source"]) =>
		commands.filter((command) => command.source === source).map((command) => `/${command.name}`);
	return [
		"**Prime Agent capabilities**",
		formatNamedList("Active tools", state.activeToolNames),
		formatNamedList(
			"Context files",
			resources.contextFiles.map((entry) => basename(entry.path)),
		),
		formatNamedList(
			"Extensions",
			resources.extensions.map((entry) => basename(entry.path)),
		),
		formatNamedList("Extension commands", commandNames("extension")),
		formatNamedList(
			"Prompt templates",
			resources.prompts.map((entry) => entry.name),
		),
		formatNamedList("Prompt commands", commandNames("prompt")),
		formatNamedList(
			"Skills",
			resources.skills.map((entry) => entry.name),
		),
		formatNamedList("Skill commands", commandNames("skill")),
		formatNamedList(
			"Themes",
			resources.themes.map((entry) => entry.name ?? (entry.sourcePath ? basename(entry.sourcePath) : "unnamed")),
		),
	].join("\n");
}

function formatNamedList(label: string, values: readonly string[]): string {
	const unique = [...new Set(values)].sort((left, right) => left.localeCompare(right));
	if (unique.length === 0) return `${label} (0): none`;
	const visible = unique.slice(0, DISPLAY_LIMIT).map((value) => `\`${escapeInlineCode(value)}\``);
	const remainder = unique.length - visible.length;
	return `${label} (${unique.length}): ${visible.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
}

function escapeInlineCode(value: string): string {
	return value.replace(/[\r\n]+/g, " ").replaceAll("`", "'");
}
