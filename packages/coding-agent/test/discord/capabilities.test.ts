import { describe, expect, it } from "vitest";
import {
	formatDiscordCapabilities,
	parseDiscordTextControl,
	resolveDiscordResourceInvocation,
} from "../../src/gateway/discord/capabilities.js";
import type {
	AgentConnectionResourceSnapshot,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "../../src/modes/agent-connection/types.js";

function command(name: string, source: AgentConnectionSlashCommand["source"]): AgentConnectionSlashCommand {
	return {
		name,
		registeredName: `registered-${name}`,
		source,
		sourceInfo: { path: `/resources/${name}`, source: "test", scope: "project", origin: "top-level" },
	};
}

describe("Discord capability commands", () => {
	it("parses text aliases without treating unrelated messages as controls", () => {
		expect(parseDiscordTextControl(" !prime capabilities ")).toEqual({ type: "capabilities" });
		expect(parseDiscordTextControl("!prime commands")).toEqual({ type: "capabilities" });
		expect(parseDiscordTextControl("!prime run skill:websearch query")).toEqual({
			type: "run",
			input: "skill:websearch query",
		});
		expect(parseDiscordTextControl("explain !prime run")).toBeUndefined();
	});

	it("resolves only the collision-safe invocation name and preserves raw arguments", () => {
		const commands = [command("skill:websearch", "skill")];
		expect(resolveDiscordResourceInvocation("skill:websearch current weather", commands)).toMatchObject({
			command: commands[0],
			prompt: "/skill:websearch current weather",
		});
		expect(resolveDiscordResourceInvocation("/registered-skill:websearch query", commands)).toBeUndefined();
		expect(resolveDiscordResourceInvocation("skill:missing", commands)).toBeUndefined();
	});

	it("formats tools and every discovered resource family without exposing full local paths", () => {
		const state = { activeToolNames: ["ipython", "custom-tool"] } as AgentConnectionState;
		const resources = {
			contextFiles: [{ path: "/private/workspace/AGENTS.md" }],
			skills: [{ name: "websearch", filePath: "/private/skills/websearch/SKILL.md" }],
			prompts: [{ name: "review", filePath: "/private/prompts/review.md" }],
			extensions: [{ path: "/private/extensions/sample.ts" }],
			themes: [{ name: "dark" }],
			diagnostics: { skills: [], prompts: [], extensions: [], themes: [] },
		} satisfies AgentConnectionResourceSnapshot;
		const formatted = formatDiscordCapabilities(state, resources, [
			command("hello", "extension"),
			command("review", "prompt"),
			command("skill:websearch", "skill"),
		]);

		expect(formatted).toContain("Active tools (2)");
		expect(formatted).toContain("Extensions (1): `sample.ts`");
		expect(formatted).toContain("Extension commands (1): `/hello`");
		expect(formatted).toContain("Prompt templates (1): `review`");
		expect(formatted).toContain("Skills (1): `websearch`");
		expect(formatted).toContain("Themes (1): `dark`");
		expect(formatted).not.toContain("/private/");
	});
});
