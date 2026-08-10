import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanupDiscordAttachmentDirectory,
	type DiscordAttachmentDescriptor,
	processDiscordAttachments,
	validateDiscordAttachmentUrl,
} from "../../src/gateway/discord/attachments.js";

const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
	"base64",
);
const ATTACHMENT_URL = "https://cdn.discordapp.com/attachments/123/456/file.txt";
const tempDirectories: string[] = [];

function attachment(overrides: Partial<DiscordAttachmentDescriptor> = {}): DiscordAttachmentDescriptor {
	return {
		id: "456",
		name: "file.txt",
		url: ATTACHMENT_URL,
		contentType: "text/plain; charset=utf-8",
		size: 5,
		...overrides,
	};
}

function response(body: string | ArrayBuffer, init: ResponseInit = {}, url = ""): Response {
	const result = new Response(body, init);
	if (url !== "") Object.defineProperty(result, "url", { value: url });
	return result;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const result = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(result).set(bytes);
	return result;
}

async function makeCache(): Promise<{ cacheRoot: string; messageDirectory: string }> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "prime-discord-attachments-"));
	tempDirectories.push(cacheRoot);
	return { cacheRoot, messageDirectory: "message-123" };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of tempDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("validateDiscordAttachmentUrl", () => {
	it("accepts only Discord CDN attachment URLs", () => {
		expect(validateDiscordAttachmentUrl(ATTACHMENT_URL).hostname).toBe("cdn.discordapp.com");
		expect(
			validateDiscordAttachmentUrl("https://media.discordapp.net/attachments/1/2/image.png?width=100").hostname,
		).toBe("media.discordapp.net");
		for (const invalid of [
			"http://cdn.discordapp.com/attachments/1/2/a",
			"https://cdn.discordapp.com.evil.example/attachments/1/2/a",
			"https://cdn.discordapp.com:444/attachments/1/2/a",
			"https://user:pass@cdn.discordapp.com/attachments/1/2/a",
			"https://cdn.discordapp.com/not-attachments/1/2/a",
		]) {
			expect(() => validateDiscordAttachmentUrl(invalid), invalid).toThrow();
		}
	});
});

describe("processDiscordAttachments", () => {
	it("disables redirects and sends no token or authorization headers", async () => {
		const cache = await makeCache();
		const fetchImplementation = vi.fn(async (_url: string, init: RequestInit) => {
			expect(init.redirect).toBe("manual");
			expect(init.credentials).toBe("omit");
			expect(init.headers).toBeUndefined();
			return response("", { status: 302, headers: { location: "https://evil.example/file" } });
		});
		await expect(
			processDiscordAttachments([attachment({ size: 0 })], { ...cache, fetch: fetchImplementation }),
		).rejects.toThrow("redirects are not allowed");
		expect(fetchImplementation).toHaveBeenCalledOnce();
	});

	it("rejects a changed or invalid final response URL", async () => {
		const cache = await makeCache();
		await expect(
			processDiscordAttachments([attachment()], {
				...cache,
				fetch: async () => response("hello", {}, "https://evil.example/attachments/1/2/a"),
			}),
		).rejects.toThrow("host is not allowed");
	});

	it("enforces attachment count and declared, response, and streamed byte limits", async () => {
		const cache = await makeCache();
		const fetchImplementation = vi.fn(async () => response("123456"));
		await expect(
			processDiscordAttachments([attachment(), attachment({ id: "2" })], {
				...cache,
				maxAttachments: 1,
				fetch: fetchImplementation,
			}),
		).rejects.toThrow("more than 1");
		await expect(
			processDiscordAttachments([attachment({ size: 6 })], {
				...cache,
				messageDirectory: "declared",
				maxBytesPerAttachment: 5,
				fetch: fetchImplementation,
			}),
		).rejects.toThrow("declared per-attachment");
		await expect(
			processDiscordAttachments([attachment({ size: 5 })], {
				...cache,
				messageDirectory: "header",
				maxBytesPerAttachment: 5,
				fetch: async () => response("123456", { headers: { "content-length": "6" } }),
			}),
		).rejects.toThrow("per-attachment byte limit");
		await expect(
			processDiscordAttachments([attachment({ size: 5 })], {
				...cache,
				messageDirectory: "stream",
				maxBytesPerAttachment: 5,
				fetch: fetchImplementation,
			}),
		).rejects.toThrow("while downloading");
	});

	it("uses magic bytes rather than a declared MIME type for images", async () => {
		const cache = await makeCache();
		const result = await processDiscordAttachments(
			[attachment({ name: "not-an-image.txt", contentType: "text/plain", size: PNG_BYTES.byteLength })],
			{
				...cache,
				fetch: async () => response(arrayBuffer(PNG_BYTES), { headers: { "content-type": "text/plain" } }),
			},
		);
		expect(result.images).toEqual([{ type: "image", mimeType: "image/png", data: PNG_BYTES.toString("base64") }]);
		expect(result.cachedFiles).toEqual([]);
		expect(result.promptNotes).toEqual([]);
		await result.cleanup();
	});

	it("does not treat a declared image MIME type as image bytes", async () => {
		const cache = await makeCache();
		const result = await processDiscordAttachments([attachment({ contentType: "image/png" })], {
			...cache,
			fetch: async () => response("hello"),
		});
		expect(result.images).toEqual([]);
		expect(result.cachedFiles).toHaveLength(1);
		expect(await readFile(result.cachedFiles[0]!, "utf8")).toBe("hello");
		await result.cleanup();
	});

	it("caches non-images under a generated mode-0600 filename and optionally inlines UTF-8 text", async () => {
		const cache = await makeCache();
		const sourceName = "../../escape.txt";
		const result = await processDiscordAttachments([attachment({ name: sourceName })], {
			...cache,
			inlineTextMaxBytes: 32,
			fetch: async () => response("hello"),
		});
		expect(result.cachedFiles).toHaveLength(1);
		const cachedFile = result.cachedFiles[0]!;
		expect(
			resolve(cachedFile).startsWith(`${resolve(cache.cacheRoot)}${process.platform === "win32" ? "\\" : "/"}`),
		).toBe(true);
		expect(basename(cachedFile)).not.toContain("escape");
		expect(await readFile(cachedFile, "utf8")).toBe("hello");
		expect(result.promptNotes[0]).toContain("UTF-8 contents:\nhello");
		if (process.platform !== "win32") {
			expect((await lstat(cachedFile)).mode & 0o777).toBe(0o600);
		}
		await result.cleanup();
		expect(await lstat(join(cache.cacheRoot, cache.messageDirectory)).catch(() => undefined)).toBeUndefined();
	});

	it("rejects message-directory traversal without fetching", async () => {
		const cache = await makeCache();
		const fetchImplementation = vi.fn(async () => response("hello"));
		await expect(
			processDiscordAttachments([attachment()], {
				...cache,
				messageDirectory: "../outside",
				fetch: fetchImplementation,
			}),
		).rejects.toThrow("contained by the cache root");
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("aborts downloads that exceed the timeout", async () => {
		const cache = await makeCache();
		const fetchImplementation = vi.fn(
			(_url: string, init: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		await expect(
			processDiscordAttachments([attachment()], { ...cache, fetch: fetchImplementation, timeoutMs: 10 }),
		).rejects.toThrow("timed out");
		expect((fetchImplementation.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
	});
});

describe("cleanupDiscordAttachmentDirectory", () => {
	it("removes only a contained message directory", async () => {
		const cache = await makeCache();
		const messagePath = join(cache.cacheRoot, cache.messageDirectory);
		await mkdir(messagePath);
		await writeFile(join(messagePath, "cached.bin"), "data");
		await cleanupDiscordAttachmentDirectory(cache.cacheRoot, cache.messageDirectory);
		expect(await lstat(messagePath).catch(() => undefined)).toBeUndefined();
		await expect(cleanupDiscordAttachmentDirectory(cache.cacheRoot, ".")).rejects.toThrow(
			"contained by the cache root",
		);
		await expect(cleanupDiscordAttachmentDirectory(cache.cacheRoot, "../outside")).rejects.toThrow(
			"contained by the cache root",
		);
	});

	it("refuses to recursively remove a symbolic-link message directory", async () => {
		if (process.platform === "win32") return;
		const cache = await makeCache();
		const outside = await mkdtemp(join(tmpdir(), "prime-discord-outside-"));
		tempDirectories.push(outside);
		await chmod(outside, 0o700);
		await symlink(outside, join(cache.cacheRoot, cache.messageDirectory), "dir");
		await expect(cleanupDiscordAttachmentDirectory(cache.cacheRoot, cache.messageDirectory)).rejects.toThrow(
			"symbolic-link",
		);
	});
});
