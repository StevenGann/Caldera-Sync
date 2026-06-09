// Durable sync state: the last checksum at which each note was agreed between
// this vault and the server, plus the stream cursor (last applied seq). This is
// the three-way-merge baseline — comparing a side's current checksum against it
// tells us whether *that* side changed since the last successful sync.

export interface PersistedState {
	cursor: number;
	checksums: Record<string, string>;
}

export class SyncState {
	cursor = 0;
	private checksums = new Map<string, string>();
	private saveTimer: number | null = null;

	constructor(private persist: (s: PersistedState) => Promise<void>) {}

	load(s: PersistedState | undefined): void {
		this.cursor = s?.cursor ?? 0;
		this.checksums = new Map(Object.entries(s?.checksums ?? {}));
	}

	get(path: string): string | undefined {
		return this.checksums.get(path);
	}

	set(path: string, checksum: string): void {
		this.checksums.set(path, checksum);
		this.scheduleSave();
	}

	delete(path: string): void {
		if (this.checksums.delete(path)) this.scheduleSave();
	}

	setCursor(seq: number): void {
		if (seq > this.cursor) {
			this.cursor = seq;
			this.scheduleSave();
		}
	}

	knownPaths(): string[] {
		return [...this.checksums.keys()];
	}

	snapshot(): PersistedState {
		return { cursor: this.cursor, checksums: Object.fromEntries(this.checksums) };
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
