import { describe, expect, it } from "vitest";
import { DiscordDispatchQueue, DiscordMessageDedupe } from "../../src/gateway/discord/dispatch-queue.js";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("DiscordDispatchQueue", () => {
	it("runs work in FIFO order for the same key", async () => {
		const queue = new DiscordDispatchQueue();
		const releaseFirst = deferred<void>();
		const firstStarted = deferred<void>();
		const order: string[] = [];
		const first = queue.enqueue("alpha", async () => {
			order.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			order.push("first:end");
		});
		const second = queue.enqueue("alpha", async () => {
			order.push("second");
		});

		await firstStarted.promise;
		expect(order).toEqual(["first:start"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("runs different keys independently", async () => {
		const queue = new DiscordDispatchQueue();
		const releaseAlpha = deferred<void>();
		const alphaStarted = deferred<void>();
		const completed: string[] = [];
		const alpha = queue.enqueue("alpha", async () => {
			alphaStarted.resolve();
			await releaseAlpha.promise;
			completed.push("alpha");
		});
		await alphaStarted.promise;

		await queue.enqueue("beta", async () => {
			completed.push("beta");
		});
		expect(completed).toEqual(["beta"]);

		releaseAlpha.resolve();
		await alpha;
		expect(completed).toEqual(["beta", "alpha"]);
	});

	it("clear lets active work finish and skips queued work", async () => {
		const queue = new DiscordDispatchQueue();
		const releaseFirst = deferred<void>();
		const firstStarted = deferred<void>();
		let queuedRuns = 0;
		const first = queue.enqueue("alpha", async () => {
			firstStarted.resolve();
			await releaseFirst.promise;
		});
		await firstStarted.promise;
		const queued = queue.enqueue("alpha", async () => {
			queuedRuns++;
		});

		queue.clear("alpha");
		releaseFirst.resolve();
		await Promise.all([first, queued]);
		expect(queuedRuns).toBe(0);
	});

	it("continues a key after a task fails", async () => {
		const queue = new DiscordDispatchQueue();
		const failure = new Error("failed task");
		const first = queue.enqueue("alpha", async () => {
			throw failure;
		});
		let secondRan = false;
		const second = queue.enqueue("alpha", async () => {
			secondRan = true;
		});

		await expect(first).rejects.toBe(failure);
		await expect(second).resolves.toBeUndefined();
		expect(secondRan).toBe(true);
	});
});

describe("DiscordMessageDedupe", () => {
	it("rejects duplicates while evicting the oldest IDs at its bound", () => {
		const dedupe = new DiscordMessageDedupe(2);

		expect(dedupe.add("one")).toBe(true);
		expect(dedupe.add("one")).toBe(false);
		expect(dedupe.add("two")).toBe(true);
		expect(dedupe.add("three")).toBe(true);
		expect(dedupe.add("two")).toBe(false);
		expect(dedupe.add("one")).toBe(true);
		expect(dedupe.add("three")).toBe(false);
	});
});
