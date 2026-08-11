import { describe, expect, it, vi } from "vitest";
import { createDiscordGatewayThreadCreationTool } from "../../src/core/tools/discord-gateway-thread.js";
import type { DiscordRoutingPolicy } from "../../src/gateway/discord/routing.js";
import {
	type DiscordThreadCreationAdapter,
	DiscordThreadCreationAdapterError,
	type DiscordThreadCreationParentChannel,
	type DiscordThreadCreationScope,
	DiscordThreadCreationService,
} from "../../src/gateway/discord/thread.js";

const GUILD = "100000000000000001";
const CHANNEL = "300000000000000001";
const THREAD = "400000000000000001";
const NEW_THREAD = "500000000000000001";
const USER = "600000000000000001";
const MESSAGE = "700000000000000001";

function policy(overrides: Partial<DiscordRoutingPolicy> = {}): DiscordRoutingPolicy {
	return {
		allowedUsers: [USER],
		allowedRoles: [],
		allowAllUsers: false,
		allowedChannels: [],
		ignoredChannels: [],
		freeResponseChannels: [],
		noThreadChannels: [],
		requireMention: true,
		threadRequireMention: false,
		ignoreNoMention: true,
		autoThread: true,
		botMessageMode: "none",
		...overrides,
	};
}

function scope(overrides: Partial<DiscordThreadCreationScope> = {}): DiscordThreadCreationScope {
	return { userId: USER, kind: "guild", guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE, ...overrides };
}

function parent(overrides: Partial<DiscordThreadCreationParentChannel> = {}): DiscordThreadCreationParentChannel {
	return {
		id: CHANNEL,
		kind: "guild",
		guildId: GUILD,
		canUserCreateThread: async () => true,
		createThread: async () => ({ id: NEW_THREAD }),
		...overrides,
	};
}

function service(
	channels: ReadonlyMap<string, Awaited<ReturnType<DiscordThreadCreationAdapter["getChannel"]>>>,
	options: { policy?: DiscordRoutingPolicy; roles?: readonly string[] } = {},
): DiscordThreadCreationService {
	return new DiscordThreadCreationService(
		{ getChannel: async (id) => channels.get(id) },
		options.policy ?? policy(),
		async () => options.roles,
	);
}

describe("discord_create_thread tool", () => {
	it("forwards a bounded title and rejects an empty title before the gateway request", async () => {
		const request = vi.fn().mockResolvedValue({
			ok: true,
			thread: { id: NEW_THREAD, name: "Planning", url: `https://discord.com/channels/${GUILD}/${NEW_THREAD}` },
		});
		const tool = createDiscordGatewayThreadCreationTool({ request });
		const success = await tool.execute("call-1", { title: "Planning" }, undefined, undefined, {} as never);
		expect(request).toHaveBeenCalledWith({ title: "Planning" }, undefined);
		expect(JSON.stringify(success)).toContain('"ok":true');

		const invalid = await tool.execute("call-2", { title: "   " }, undefined, undefined, {} as never);
		expect(request).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(invalid)).toContain('"code":"INVALID_REQUEST"');
	});
});

describe("DiscordThreadCreationService", () => {
	it("creates a thread only in the initiating parent and returns normalized metadata", async () => {
		const createThread = vi.fn().mockResolvedValue({ id: NEW_THREAD });
		const result = await service(new Map([[CHANNEL, parent({ createThread })]])).create(scope(), {
			title: `  Planning
  thread  `,
		});

		expect(createThread).toHaveBeenCalledWith("Planning thread", MESSAGE);
		expect(result).toEqual({
			ok: true,
			thread: {
				id: NEW_THREAD,
				name: "Planning thread",
				url: `https://discord.com/channels/${GUILD}/${NEW_THREAD}`,
			},
		});
	});

	it("allows a current thread to create only a sibling under its authorized parent", async () => {
		const createThread = vi.fn().mockResolvedValue({ id: NEW_THREAD });
		const result = await service(
			new Map<string, Awaited<ReturnType<DiscordThreadCreationAdapter["getChannel"]>>>([
				[THREAD, { id: THREAD, kind: "thread", guildId: GUILD, parentChannelId: CHANNEL }],
				[CHANNEL, parent({ createThread })],
			]),
			{ policy: policy({ allowedChannels: [CHANNEL] }) },
		).create(scope({ kind: "thread", channelId: THREAD }), { title: "Sibling" });

		expect(result).toMatchObject({ ok: true, thread: { id: NEW_THREAD, name: "Sibling" } });
		expect(createThread).toHaveBeenCalledWith("Sibling", undefined);
	});

	it("fails closed for DMs, missing parents, policy denial, identity loss, and missing user permission", async () => {
		const createThread = vi.fn().mockResolvedValue({ id: NEW_THREAD });
		const current = parent({ createThread });
		const channels = new Map([[CHANNEL, current]]);
		const request = { title: "Security review" };

		await expect(
			service(channels).create({ userId: USER, kind: "dm", channelId: CHANNEL }, request),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(new Map([[THREAD, { id: THREAD, kind: "thread", guildId: GUILD }]])).create(
				scope({ kind: "thread", channelId: THREAD }),
				request,
			),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(channels, { policy: policy({ ignoredChannels: [CHANNEL] }) }).create(scope(), request),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(channels, { policy: policy({ allowedUsers: ["another-user"] }) }).create(scope(), request),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		await expect(
			service(new Map([[CHANNEL, parent({ canUserCreateThread: async () => false, createThread })]])).create(
				scope(),
				request,
			),
		).resolves.toMatchObject({ ok: false, code: "FORBIDDEN" });
		expect(createThread).not.toHaveBeenCalled();
	});

	it("maps Discord failures without exposing raw errors and validates titles", async () => {
		await expect(
			service(
				new Map([
					[
						CHANNEL,
						parent({
							createThread: async () => {
								throw new DiscordThreadCreationAdapterError("MISSING_PERMISSION", "secret Discord response");
							},
						}),
					],
				]),
			).create(scope(), { title: "Permission check" }),
		).resolves.toMatchObject({
			ok: false,
			code: "MISSING_PERMISSION",
			message: "Discord denied permission to create a thread in that channel.",
		});
		await expect(
			service(new Map([[CHANNEL, parent()]])).create(scope(), { title: "x".repeat(101) }),
		).resolves.toMatchObject({
			ok: false,
			code: "INVALID_REQUEST",
		});
	});
});
