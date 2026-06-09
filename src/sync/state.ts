// Durable sync state: the last checksum at which each note was agreed between
// this vault and the server, plus the stream cursor (last applied seq). This is
// the three-way-merge baseline — comparing a side's current checksum against it
// tells us whether *that* side changed since the last successful sync.

/** Cached file stat → checksum, letting reconcile skip re-hashing unchanged files. */
export interface StatEntry {
	mtime: number;
	size: number;
	checksum: string;
}

export interface PersistedState {
	cursor: number;
	checksums: Record<string, string>;
	/** Optional stat cache (mtime+size → checksum) to avoid re-hashing on reconcile. */
	stats?: Record<string, StatEntry>;
}

export class SyncState {
	cursor = 0;
	private checksums = new Map<string, string>();
	private stats = new Map<string, StatEntry>();
	private saveTimer: number | null = null;

	constructor(private persist: (s: PersistedState) => Promise<void>) {}

	load(s: PersistedState | undefined): void {
		this.cursor = s?.cursor ?? 0;
		this.checksums = new Map(Object.entries(s?.checksums ?? {}));
		this.stats = new Map(Object.entries(s?.stats ?? {}));
	}

	/** Return the cached checksum for a path if its mtime+size are unchanged. */
	cachedChecksum(path: string, mtime: number, size: number): string | undefined {
		const e = this.stats.get(path);
		return e && e.mtime === mtime && e.size === size ? e.checksum : undefined;
	}

	/** Record a path's stat → checksum so a later reconcile can skip re-hashing it. */
	setStat(path: string, mtime: number, size: number, checksum: string): void {
		this.stats.set(path, { mtime, size, checksum });
		this.scheduleSave();
	}

	get(path: string): string | undefined {
		return this.checksums.get(path);
	}

	set(path: string, checksum: string): void {
		this.checksums.set(path, checksum);
		this.scheduleSave();
	}

	delete(path: string): void {
		const had = this.checksums.delete(path);
		const hadStat = this.stats.delete(path);
		if (had || hadStat) this.scheduleSave();
	}

	setCursor(seq: number): void {
		if (seq > this.cursor) {
			this.cursor = seq;
			this.scheduleSave();
		}
	}

	snapshot(): PersistedState {
		return {
			cursor: this.cursor,
			checksums: Object.fromEntries(this.checksums),
			stats: Object.fromEntries(this.stats),
		};
	}

	/** Debounced persistence so a burst of changes writes data.json once. */
	private scheduleSave(): void {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.persist(this.snapshot());
		}, 500);
	}

	/** Force an immediate save (e.g. on unload). */
	async flush(): Promise<void> {
		if (this.saveTimer) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.persist(this.snapshot());
	}
}
