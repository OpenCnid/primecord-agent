import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { fileTypeFromBuffer } from "file-type";

const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TEXTUAL_APPLICATION_MIME_TYPES = new Set([
	"application/json",
	"application/javascript",
	"application/toml",
	"application/xml",
	"application/x-yaml",
	"application/yaml",
]);

export const DEFAULT_MAX_DISCORD_ATTACHMENTS = 10;
export const DEFAULT_MAX_DISCORD_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_DISCORD_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
export const DEFAULT_DISCORD_ATTACHMENT_TIMEOUT_MS = 15_000;

export interface DiscordAttachmentDescriptor {
	id: string;
	name: string;
	url: string;
	contentType?: string;
	size: number;
}

export type DiscordAttachmentFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ProcessDiscordAttachmentOptions {
	cacheRoot: string;
	messageDirectory: string;
	fetch?: DiscordAttachmentFetch;
	timeoutMs?: number;
	maxAttachments?: number;
	maxBytesPerAttachment?: number;
	maxTotalBytes?: number;
	inlineTextMaxBytes?: number;
}

export interface ProcessedDiscordAttachments {
	images: ImageContent[];
	promptNotes: string[];
	cachedFiles: string[];
	cleanup: () => Promise<void>;
}

interface ResolvedLimits {
	timeoutMs: number;
	maxAttachments: number;
	maxBytesPerAttachment: number;
	maxTotalBytes: number;
	inlineTextMaxBytes: number;
}

interface DownloadedAttachment {
	bytes: Buffer;
	responseContentType?: string;
}

function isPathContained(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

function attachmentDirectoryPath(cacheRoot: string, messageDirectory: string): { root: string; directory: string } {
	const root = resolve(cacheRoot);
	const directory = isAbsolute(messageDirectory) ? resolve(messageDirectory) : resolve(root, messageDirectory);
	if (!isPathContained(root, directory)) {
		throw new Error("Discord attachment message directory must be contained by the cache root");
	}
	return { root, directory };
}

function assertPositiveInteger(value: number, optionName: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${optionName} must be a positive safe integer`);
	}
}

function resolveLimits(options: ProcessDiscordAttachmentOptions): ResolvedLimits {
	const limits: ResolvedLimits = {
		timeoutMs: options.timeoutMs ?? DEFAULT_DISCORD_ATTACHMENT_TIMEOUT_MS,
		maxAttachments: options.maxAttachments ?? DEFAULT_MAX_DISCORD_ATTACHMENTS,
		maxBytesPerAttachment: options.maxBytesPerAttachment ?? DEFAULT_MAX_DISCORD_ATTACHMENT_BYTES,
		maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_DISCORD_ATTACHMENT_TOTAL_BYTES,
		inlineTextMaxBytes: options.inlineTextMaxBytes ?? 0,
	};
	assertPositiveInteger(limits.timeoutMs, "timeoutMs");
	assertPositiveInteger(limits.maxAttachments, "maxAttachments");
	assertPositiveInteger(limits.maxBytesPerAttachment, "maxBytesPerAttachment");
	assertPositiveInteger(limits.maxTotalBytes, "maxTotalBytes");
	if (!Number.isSafeInteger(limits.inlineTextMaxBytes) || limits.inlineTextMaxBytes < 0) {
		throw new Error("inlineTextMaxBytes must be a non-negative safe integer");
	}
	return limits;
}

export function validateDiscordAttachmentUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Discord attachment URL is invalid");
	}
	if (url.protocol !== "https:") {
		throw new Error("Discord attachment URL must use HTTPS");
	}
	if (url.username !== "" || url.password !== "") {
		throw new Error("Discord attachment URL must not contain credentials");
	}
	if (url.port !== "") {
		throw new Error("Discord attachment URL must not use a custom port");
	}
	if (!DISCORD_ATTACHMENT_HOSTS.has(url.hostname)) {
		throw new Error("Discord attachment URL host is not allowed");
	}
	if (!url.pathname.startsWith("/attachments/")) {
		throw new Error("Discord attachment URL path is not allowed");
	}
	return url;
}

function parseContentLength(response: Response): number | undefined {
	const value = response.headers.get("content-length");
	if (value === null) return undefined;
	if (!/^\d+$/.test(value)) {
		throw new Error("Discord attachment response has an invalid Content-Length");
	}
	const length = Number(value);
	if (!Number.isSafeInteger(length)) {
		throw new Error("Discord attachment response Content-Length is too large");
	}
	return length;
}

async function readResponseBytes(
	response: Response,
	perAttachmentLimit: number,
	remainingTotal: number,
): Promise<Buffer> {
	if (!response.body) {
		throw new Error("Discord attachment response has no body");
	}
	const contentLength = parseContentLength(response);
	if (contentLength !== undefined && contentLength > perAttachmentLimit) {
		throw new Error("Discord attachment exceeds the per-attachment byte limit");
	}
	if (contentLength !== undefined && contentLength > remainingTotal) {
		throw new Error("Discord attachments exceed the total byte limit");
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let byteCount = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			byteCount += chunk.value.byteLength;
			if (byteCount > perAttachmentLimit) {
				throw new Error("Discord attachment exceeds the per-attachment byte limit while downloading");
			}
			if (byteCount > remainingTotal) {
				throw new Error("Discord attachments exceed the total byte limit while downloading");
			}
			chunks.push(Buffer.from(chunk.value));
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, byteCount);
}

async function downloadAttachment(
	descriptor: DiscordAttachmentDescriptor,
	url: URL,
	fetchImplementation: DiscordAttachmentFetch,
	limits: ResolvedLimits,
	remainingTotal: number,
): Promise<DownloadedAttachment> {
	const controller = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutHandle = setTimeout(() => {
			controller.abort();
			reject(new Error(`Discord attachment ${descriptor.id} download timed out`));
		}, limits.timeoutMs);
	});
	const download = async (): Promise<DownloadedAttachment> => {
		const response = await fetchImplementation(url.href, {
			credentials: "omit",
			redirect: "manual",
			referrerPolicy: "no-referrer",
			signal: controller.signal,
		});
		if (response.status >= 300 && response.status < 400) {
			throw new Error("Discord attachment redirects are not allowed");
		}
		if (!response.ok) {
			throw new Error(`Discord attachment download failed with status ${response.status}`);
		}
		if (response.redirected) {
			throw new Error("Discord attachment redirects are not allowed");
		}
		if (response.url !== "") {
			const responseUrl = validateDiscordAttachmentUrl(response.url);
			if (responseUrl.href !== url.href) {
				throw new Error("Discord attachment response URL does not match the requested URL");
			}
		}
		return {
			bytes: await readResponseBytes(response, limits.maxBytesPerAttachment, remainingTotal),
			responseContentType: response.headers.get("content-type") ?? undefined,
		};
	};

	try {
		return await Promise.race([download(), timeout]);
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

function normalizedMimeType(contentType: string | undefined): string | undefined {
	return contentType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

function isTextualMimeType(contentType: string | undefined): boolean {
	const mimeType = normalizedMimeType(contentType);
	return mimeType !== undefined && (mimeType.startsWith("text/") || TEXTUAL_APPLICATION_MIME_TYPES.has(mimeType));
}

function decodeUtf8Text(bytes: Buffer, contentType: string | undefined, maximumBytes: number): string | undefined {
	if (maximumBytes === 0 || bytes.byteLength > maximumBytes || !isTextualMimeType(contentType)) return undefined;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

function safeExtension(extension: string | undefined, contentType: string | undefined): string {
	if (extension && /^[a-z0-9]{1,10}$/.test(extension)) return extension;
	return isTextualMimeType(contentType) ? "txt" : "bin";
}

async function createAttachmentDirectory(cacheRoot: string, messageDirectory: string): Promise<string> {
	const paths = attachmentDirectoryPath(cacheRoot, messageDirectory);
	await mkdir(paths.root, { recursive: true, mode: 0o700 });
	const realRoot = await realpath(paths.root);
	await mkdir(paths.directory, { mode: 0o700 });
	const realDirectory = await realpath(paths.directory);
	if (!isPathContained(realRoot, realDirectory)) {
		throw new Error("Discord attachment message directory resolves outside the cache root");
	}
	return realDirectory;
}

async function cacheAttachment(directory: string, bytes: Buffer, extension: string): Promise<string> {
	const filePath = resolve(directory, `${randomUUID()}.${extension}`);
	if (!isPathContained(directory, filePath)) {
		throw new Error("Generated Discord attachment path escaped the message directory");
	}
	await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
	await chmod(filePath, 0o600);
	return filePath;
}

export async function cleanupDiscordAttachmentDirectory(cacheRoot: string, messageDirectory: string): Promise<void> {
	const paths = attachmentDirectoryPath(cacheRoot, messageDirectory);
	let directoryInfo: Stats;
	try {
		directoryInfo = await lstat(paths.directory);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (directoryInfo.isSymbolicLink()) {
		throw new Error("Refusing to clean a symbolic-link Discord attachment directory");
	}
	const [realRoot, realDirectory] = await Promise.all([realpath(paths.root), realpath(paths.directory)]);
	if (!isPathContained(realRoot, realDirectory)) {
		throw new Error("Refusing to clean a Discord attachment directory outside the cache root");
	}
	await rm(realDirectory, { recursive: true, force: true });
}

export async function processDiscordAttachments(
	descriptors: readonly DiscordAttachmentDescriptor[],
	options: ProcessDiscordAttachmentOptions,
): Promise<ProcessedDiscordAttachments> {
	const limits = resolveLimits(options);
	attachmentDirectoryPath(options.cacheRoot, options.messageDirectory);
	if (descriptors.length > limits.maxAttachments) {
		throw new Error(`Discord message has more than ${limits.maxAttachments} attachments`);
	}

	let declaredTotal = 0;
	const validated = descriptors.map((descriptor) => {
		if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) {
			throw new Error(`Discord attachment ${descriptor.id} has an invalid declared size`);
		}
		if (descriptor.size > limits.maxBytesPerAttachment) {
			throw new Error(`Discord attachment ${descriptor.id} exceeds the declared per-attachment byte limit`);
		}
		declaredTotal += descriptor.size;
		if (!Number.isSafeInteger(declaredTotal) || declaredTotal > limits.maxTotalBytes) {
			throw new Error("Discord attachments exceed the declared total byte limit");
		}
		return { descriptor, url: validateDiscordAttachmentUrl(descriptor.url) };
	});

	const fetchImplementation: DiscordAttachmentFetch = options.fetch ?? fetch;
	const images: ImageContent[] = [];
	const promptNotes: string[] = [];
	const cachedFiles: string[] = [];
	let actualTotal = 0;
	let cacheDirectory: string | undefined;
	const cleanup = async (): Promise<void> => {
		if (cacheDirectory !== undefined) {
			await cleanupDiscordAttachmentDirectory(options.cacheRoot, options.messageDirectory);
			cacheDirectory = undefined;
		}
	};

	try {
		for (const { descriptor, url } of validated) {
			const downloaded = await downloadAttachment(
				descriptor,
				url,
				fetchImplementation,
				limits,
				limits.maxTotalBytes - actualTotal,
			);
			actualTotal += downloaded.bytes.byteLength;
			const detectedType = await fileTypeFromBuffer(downloaded.bytes);
			if (detectedType && SUPPORTED_IMAGE_MIME_TYPES.has(detectedType.mime)) {
				images.push({
					type: "image",
					data: downloaded.bytes.toString("base64"),
					mimeType: detectedType.mime,
				});
				continue;
			}

			cacheDirectory ??= await createAttachmentDirectory(options.cacheRoot, options.messageDirectory);
			const contentType = descriptor.contentType ?? downloaded.responseContentType;
			const extension = safeExtension(detectedType?.ext, contentType);
			const cachedFile = await cacheAttachment(cacheDirectory, downloaded.bytes, extension);
			cachedFiles.push(cachedFile);
			const inlineText = decodeUtf8Text(downloaded.bytes, contentType, limits.inlineTextMaxBytes);
			const note = `Discord attachment ${JSON.stringify(descriptor.name)} cached at ${JSON.stringify(cachedFile)}.`;
			promptNotes.push(inlineText === undefined ? note : `${note}\nUTF-8 contents:\n${inlineText}`);
		}
	} catch (error) {
		await cleanup().catch(() => undefined);
		throw error;
	}

	return { images, promptNotes, cachedFiles, cleanup };
}
