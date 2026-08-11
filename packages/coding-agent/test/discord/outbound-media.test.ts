import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractDiscordMedia, loadDiscordOutboundMedia } from "../../src/gateway/discord/outbound-media.js";

const temporaryDirectories: string[] = [];

async function makeWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "prime-discord-outbound-media-"));
	temporaryDirectories.push(workspace);
	return workspace;
}

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("extractDiscordMedia", () => {
	it("removes inline MEDIA:/path tags without treating prose as an upload", () => {
		expect(
			extractDiscordMedia("Created the chart MEDIA:reports/chart.png\n\nUse MEDIA: paths only in the tag syntax."),
		).toEqual({
			text: "Created the chart\n\nUse MEDIA: paths only in the tag syntax.",
			paths: ["reports/chart.png"],
		});
	});
});

describe("loadDiscordOutboundMedia", () => {
	it("loads distinct workspace files and keeps processing after an invalid tag", async () => {
		const workspace = await makeWorkspace();
		await writeFile(join(workspace, "chart.png"), "chart bytes");
		const result = await loadDiscordOutboundMedia(["chart.png", "missing.png", "chart.png"], {
			cwd: workspace,
			maxAttachments: 5,
			maxBytesPerAttachment: 100,
		});

		expect(result.attachments).toEqual([{ name: "chart.png", content: Buffer.from("chart bytes") }]);
		expect(result.errors).toEqual(['Could not attach "missing.png".']);
	});

	it("refuses paths outside the configured workspace, including symlinks", async () => {
		if (process.platform === "win32") return;
		const workspace = await makeWorkspace();
		const outside = await makeWorkspace();
		await writeFile(join(outside, "secret.txt"), "secret");
		await symlink(join(outside, "secret.txt"), join(workspace, "leak.txt"));

		const result = await loadDiscordOutboundMedia(["../secret.txt", "leak.txt"], {
			cwd: workspace,
			maxAttachments: 5,
			maxBytesPerAttachment: 100,
		});

		expect(result.attachments).toEqual([]);
		expect(result.errors).toEqual(['Could not attach "secret.txt".', 'Could not attach "leak.txt".']);
	});

	it("enforces attachment count and byte limits", async () => {
		const workspace = await makeWorkspace();
		await Promise.all([
			writeFile(join(workspace, "one.txt"), "one"),
			writeFile(join(workspace, "two.txt"), "two"),
			writeFile(join(workspace, "large.txt"), "large"),
		]);
		const countLimited = await loadDiscordOutboundMedia(["one.txt", "two.txt"], {
			cwd: workspace,
			maxAttachments: 1,
			maxBytesPerAttachment: 100,
		});
		expect(countLimited.attachments.map((attachment) => attachment.name)).toEqual(["one.txt"]);
		expect(countLimited.errors).toEqual(['Could not attach "two.txt" because the attachment limit was reached.']);

		const byteLimited = await loadDiscordOutboundMedia(["large.txt"], {
			cwd: workspace,
			maxAttachments: 1,
			maxBytesPerAttachment: 4,
		});
		expect(byteLimited.attachments).toEqual([]);
		expect(byteLimited.errors).toEqual(['Could not attach "large.txt".']);
	});
});
