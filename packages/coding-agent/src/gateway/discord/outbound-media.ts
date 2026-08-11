import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

export interface DiscordOutboundMedia {
	content: Buffer;
	name: string;
}

export interface DiscordOutboundMediaOptions {
	cwd: string;
	maxAttachments: number;
	maxBytesPerAttachment: number;
}

export interface ExtractedDiscordMedia {
	text: string;
	paths: readonly string[];
}

export interface LoadedDiscordOutboundMedia {
	attachments: readonly DiscordOutboundMedia[];
	errors: readonly string[];
}

function isPathContained(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return pathFromRoot !== "" && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

function safeFileName(path: string): string {
	const name = basename(path)
		.replace(/[\\/\r\n]/g, "_")
		.trim();
	return (name || "attachment").slice(0, 100);
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} must be a non-negative safe integer`);
	}
}

/** Removes MEDIA:/path tags from an agent response and returns their requested paths. */
export function extractDiscordMedia(text: string): ExtractedDiscordMedia {
	const paths: string[] = [];
	const stripped = text.replace(/(^|\s)MEDIA:([^\s]+)/gm, (_match, prefix: string, path: string) => {
		paths.push(path);
		return prefix;
	});
	return {
		text: stripped
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
		paths,
	};
}

export async function loadDiscordOutboundMedia(
	paths: readonly string[],
	options: DiscordOutboundMediaOptions,
): Promise<LoadedDiscordOutboundMedia> {
	assertNonNegativeSafeInteger(options.maxAttachments, "maxAttachments");
	assertNonNegativeSafeInteger(options.maxBytesPerAttachment, "maxBytesPerAttachment");
	if (paths.length === 0) return { attachments: [], errors: [] };

	const attachments: DiscordOutboundMedia[] = [];
	const errors: string[] = [];
	const seenPaths = new Set<string>();
	let workspace: string | undefined;
	try {
		workspace = await realpath(options.cwd);
	} catch {
		return { attachments: [], errors: ["Prime Agent workspace is unavailable for media upload."] };
	}

	for (const path of paths) {
		const name = safeFileName(path);
		if (attachments.length >= options.maxAttachments) {
			errors.push(`Could not attach ${JSON.stringify(name)} because the attachment limit was reached.`);
			continue;
		}
		try {
			const requestedPath = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
			const resolvedPath = await realpath(requestedPath);
			if (!isPathContained(workspace, resolvedPath)) {
				throw new Error("media path is outside the configured workspace");
			}
			if (seenPaths.has(resolvedPath)) continue;
			const info = await stat(resolvedPath);
			if (!info.isFile()) throw new Error("media path is not a regular file");
			if (info.size > options.maxBytesPerAttachment) throw new Error("media file exceeds the byte limit");
			const content = await readFile(resolvedPath);
			if (content.byteLength > options.maxBytesPerAttachment) {
				throw new Error("media file exceeds the byte limit");
			}
			seenPaths.add(resolvedPath);
			attachments.push({ content, name: safeFileName(resolvedPath) });
		} catch {
			errors.push(`Could not attach ${JSON.stringify(name)}.`);
		}
	}
	return { attachments, errors };
}
