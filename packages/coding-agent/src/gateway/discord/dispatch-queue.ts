export class DiscordDispatchQueue {
	private readonly tails = new Map<string, Promise<void>>();
	private readonly generations = new Map<string, number>();
	private accepting = true;

	enqueue(key: string, task: () => Promise<void>): Promise<void> {
		if (!this.accepting) {
			return Promise.reject(new Error("Discord gateway is shutting down"));
		}
		const generation = this.generations.get(key) ?? 0;
		const previous = this.tails.get(key) ?? Promise.resolve();
		const run = previous
			.catch(() => undefined)
			.then(async () => {
				if ((this.generations.get(key) ?? 0) !== generation) return;
				await task();
			});
		const settled = run
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				if (this.tails.get(key) === settled) {
					this.tails.delete(key);
					this.generations.delete(key);
				}
			});
		this.tails.set(key, settled);
		return run;
	}

	clear(key: string): void {
		this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
	}

	async stopAcceptingAndDrain(): Promise<void> {
		this.accepting = false;
		await Promise.allSettled(this.tails.values());
	}
}

export class DiscordMessageDedupe {
	private readonly ids = new Set<string>();

	constructor(private readonly maxSize = 10_000) {}

	add(id: string): boolean {
		if (this.ids.has(id)) return false;
		this.ids.add(id);
		while (this.ids.size > this.maxSize) {
			const oldest = this.ids.values().next().value;
			if (oldest === undefined) break;
			this.ids.delete(oldest);
		}
		return true;
	}
}
