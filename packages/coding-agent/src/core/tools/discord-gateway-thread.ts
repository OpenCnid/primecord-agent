import { type Static, Type } from "typebox";
import {
	DISCORD_GATEWAY_THREAD_CREATION_TOOL_NAME,
	type DiscordGatewayThreadCreationController,
	type DiscordGatewayThreadCreationRequest,
	discordGatewayThreadCreationFailure,
} from "../discord-gateway-thread.js";
import type { ToolDefinition } from "../extensions/types.js";

const discordGatewayThreadCreationSchema = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 100 }),
});

type DiscordGatewayThreadCreationToolInput = Static<typeof discordGatewayThreadCreationSchema>;

function requestFromToolInput(
	input: DiscordGatewayThreadCreationToolInput,
): DiscordGatewayThreadCreationRequest | undefined {
	return input.title.trim() ? { title: input.title } : undefined;
}

export function createDiscordGatewayThreadCreationTool(
	controller: DiscordGatewayThreadCreationController,
): ToolDefinition<typeof discordGatewayThreadCreationSchema> {
	return {
		name: DISCORD_GATEWAY_THREAD_CREATION_TOOL_NAME,
		label: "Create Discord thread",
		description:
			"Create one public Discord thread in the current authorized server channel, or as a sibling of the current " +
			"authorized thread. Use it when the user asks to create a Discord thread. The gateway enforces the initiating " +
			"user's current channel policy and Discord thread-creation permission.",
		promptSnippet: "discord_create_thread - create an authorized Discord conversation thread",
		promptGuidelines: [
			"Use discord_create_thread only when the user explicitly asks to create a Discord thread.",
			"Choose a concise title that describes the requested conversation; do not claim a thread was created unless the tool succeeds.",
		],
		parameters: discordGatewayThreadCreationSchema,
		propagateToSubagents: false,
		executionMode: "sequential",
		execute: async (_toolCallId, input, signal) => {
			const request = requestFromToolInput(input);
			const response = request
				? await controller.request(request, signal)
				: discordGatewayThreadCreationFailure("INVALID_REQUEST", "Discord thread titles cannot be empty.");
			return {
				content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				details: response,
				isError: !response.ok,
			};
		},
	};
}
