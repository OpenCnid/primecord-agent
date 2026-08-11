import { describe, expect, it } from "vitest";
import {
	parseDiscordExtensionReplyControl,
	parseDiscordExtensionUiInput,
	presentDiscordExtensionUi,
} from "../../src/gateway/discord/extension-ui.js";
import type { AgentConnectionExtensionUiRequest } from "../../src/modes/agent-connection/types.js";

function request(method: string, payload: Record<string, unknown>): AgentConnectionExtensionUiRequest {
	return { id: `request-${method}`, method, payload };
}

describe("Discord extension UI", () => {
	it("renders all supported dialog methods with bounded response instructions", () => {
		expect(
			presentDiscordExtensionUi(request("select", { title: "Choose", options: ["Alpha", "Beta"], timeout: 5_000 })),
		).toMatchObject({
			kind: "dialog",
			method: "select",
			options: ["Alpha", "Beta"],
			timeoutMs: 5_000,
		});
		expect(presentDiscordExtensionUi(request("confirm", { title: "Continue", message: "Proceed?" }))).toMatchObject({
			kind: "dialog",
			method: "confirm",
		});
		expect(presentDiscordExtensionUi(request("input", { title: "Value", placeholder: "text" }))).toMatchObject({
			kind: "dialog",
			method: "input",
		});
		expect(presentDiscordExtensionUi(request("editor", { title: "Edit", prefill: "line one" }))).toMatchObject({
			kind: "dialog",
			method: "editor",
		});
	});

	it("renders notifications and keyed state updates, including clears", () => {
		expect(presentDiscordExtensionUi(request("notify", { message: "done", notifyType: "info" }))).toEqual({
			kind: "notification",
			content: "**Prime Agent extension notification (info)**\ndone",
		});
		expect(presentDiscordExtensionUi(request("setStatus", { statusKey: "build", statusText: "running" }))).toEqual({
			kind: "state",
			key: "status:build",
			content: "**Prime Agent extension status — build**\nrunning",
		});
		expect(presentDiscordExtensionUi(request("setStatus", { statusKey: "build" }))).toEqual({
			kind: "state",
			key: "status:build",
			content: undefined,
		});
		expect(
			presentDiscordExtensionUi(request("setWidget", { widgetKey: "summary", widgetLines: ["one", "two"] })),
		).toMatchObject({
			kind: "state",
			key: "widget:summary",
		});
		expect(presentDiscordExtensionUi(request("setTitle", { title: "Prime Agent" }))).toMatchObject({
			kind: "state",
			key: "title",
		});
		expect(presentDiscordExtensionUi(request("setEditorText", { text: "prefill" }))).toMatchObject({
			kind: "state",
			key: "editor-text",
		});
		expect(presentDiscordExtensionUi(request("set_editor_text", { text: "compatibility" }))).toMatchObject({
			kind: "state",
			key: "editor-text",
		});
	});

	it("rejects malformed and unknown requests at the Discord edge", () => {
		expect(presentDiscordExtensionUi(request("select", { title: "Choose", options: ["ok", 1] }))).toEqual({
			kind: "unsupported",
			dialog: true,
		});
		expect(presentDiscordExtensionUi(request("select", { title: "Choose", options: [] }))).toEqual({
			kind: "unsupported",
			dialog: true,
		});
		expect(presentDiscordExtensionUi(request("notify", {}))).toEqual({
			kind: "unsupported",
			dialog: false,
		});
		expect(presentDiscordExtensionUi(request("future-method", {}))).toEqual({
			kind: "unsupported",
			dialog: false,
		});
	});

	it("parses explicit response controls, confirmation, selection, free-form, and cancellation", () => {
		expect(parseDiscordExtensionReplyControl("!prime respond yes")).toEqual({ type: "response", value: "yes" });
		expect(parseDiscordExtensionReplyControl("!prime cancel")).toEqual({ type: "cancel" });
		expect(parseDiscordExtensionReplyControl("an unrelated message")).toBeUndefined();
		expect(parseDiscordExtensionUiInput("confirm", [], "yes")).toEqual({
			accepted: true,
			response: { confirmed: true },
		});
		expect(parseDiscordExtensionUiInput("confirm", [], "no")).toEqual({
			accepted: true,
			response: { confirmed: false },
		});
		expect(parseDiscordExtensionUiInput("select", ["Alpha", "Beta"], "2")).toEqual({
			accepted: true,
			response: { value: "Beta" },
		});
		expect(parseDiscordExtensionUiInput("select", ["Alpha", "Beta"], "alpha")).toEqual({
			accepted: true,
			response: { value: "Alpha" },
		});
		expect(parseDiscordExtensionUiInput("input", [], " free form ")).toEqual({
			accepted: true,
			response: { value: "free form" },
		});
		expect(parseDiscordExtensionUiInput("editor", [], "cancel")).toEqual({
			accepted: true,
			response: { cancelled: true },
		});
		expect(parseDiscordExtensionUiInput("confirm", [], "maybe")).toMatchObject({ accepted: false });
	});
});
