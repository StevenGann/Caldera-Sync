import { App, Notice, TFile } from 'obsidian';
import type { CalderaSyncSettings } from '../settings';
import type { CalderaClient } from '../api/client';
import { ChangeStream } from '../api/events';
import type { SyncState } from './state';
import { checksum } from '../util/hash';
import type { ChangeEvent, RawNote, SyncStatusInfo } from '../types';

/**
 * Bidirectional mirror between this vault and a Caldera server.
 *
 * Echo suppression is twofold: an upsert is ignored when its checksum already
 * matches our baseline (we made that change), and remote-applied writes/deletes
 * register an expected "echo" of the vault event they trigger. Conflicts — both
 * sides changed since the last sync — are resolved per the configured strategy.
 *
 * All mutating work runs through a single async lock so applying a remote event
 * and pushing a local edit can never interleave on the same note.
 */
export class SyncEngine {
	private stream: ChangeStream | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private applying = new Map<string, number>();
	private pushTimers = new Map<string, number>();

	constructor(
		private app: App,
		private settings: CalderaSyncSettings,
		private client: CalderaClient,
		private state: SyncState,
		private onStatus: (info: SyncStatusInfo) => void,
	) {}

	// ── Lifecycle ─────────────────────────────────────────────────────
	async start(): Promise<void> {
		this.onStatus({ kind: 'connecting' });
		try {
			await this.withLock(() => this.reconcile());
		} catch (err) {
			this.onStatus({ kind: 'error', detail: this.msg(err) });
			return;
		}
		this.stream = new ChangeStream(this.settings, this.client, {
			onEvent: (ev) => this.withLock(() => this.applyEvent(ev)),
			onResync: () => this.withLock(() => this.reconcile()),
			onStatus: (s) => this.onStatus(s),
			getCursor: () => this.state.cursor,
		});
		this.stream.start();
	}

	async stop(): Promise<void> {
		this.stream?.stop();
		this.stream = null;
		for (const t of this.pushTimers.values()) window.clearTimeout(t);
		this.pushTimers.clear();
		await this.state.flush();
	}

	/** Run a one-off full reconcile (the manual "Sync now" command). */
	async syncNow(): Promise<void> {
		await this.withLock(() => this.reconcile());
	}

	// ── Reconcile (bootstrap / resync) ────────────────────────────────
	private async reconcile(): Promise<void> {
		this.onStatus({ kind: 'reconciling' });
		const manifest = await this.client.getManifest();
		const remote = new Map(manifest.notes.map((n) => [n.path, n.checksum]));

		const local = new Map<string, string>();
		for (const path of this.localPaths()) {
			const content = await this.readLocal(path);
			if (content !== null) local.set(path, await checksum(content));
		}

		const paths = new Set<string>([...remote.keys(), ...local.keys()]);
		for (const path of paths) {
			const r = remote.get(path);
			const l = local.get(path);
			const s = this.state.get(path);
			if (r && !l) {
				// Present on server, missing locally.
				if (s !== undefined && s === r) await this.deleteRemote(path, r); // deleted while offline
				else await this.pullToLocal(path);
			} else if (!r && l) {
				// Present locally, missing on server.
				if (s !== undefined && s === l) await this.trashLocal(path); // remote deleted while offline
				else await this.pushCreate(path);
			} else if (r && l) {
				if (r === l) {
					this.state.set(path, r); // already identical
				} else if (s === r) {
					await this.pushLocal(path); // only local changed
				} else if (s === l) {
					await this.pullToLocal(path); // only remote changed
				} else {
					await this.resolveConflict(path); // both changed (or no baseline)
				}
			}
		}
		this.state.setCursor(manifest.head);
		await this.state.flush();
	}

	// ── Remote → local ────────────────────────────────────────────────
	private async applyEvent(ev: ChangeEvent): Promise<void> {
		if (!ev.path || !this.inScope(ev.path)) {
			this.state.setCursor(ev.seq);
			return;
		}
		const path = ev.path;
		try {
			if (ev.type === 'delete') {
				if (this.state.get(path) !== undefined || this.localFile(path)) {
					await this.trashLocal(path);
				}
			} else if (ev.type === 'upsert') {
				await this.applyUpsert(path, ev.checksum);
			}
		} finally {
			this.state.setCursor(ev.seq);
		}
	}

	private async applyUpsert(path: string, evChecksum: string | null): Promise<void> {
		if (evChecksum && evChecksum === this.state.get(path)) return; // echo of our own push
		const content = await this.readLocal(path);
		if (content !== null) {
			const local = await checksum(content);
			if (evChecksum && local === evChecksum) {
				this.state.set(path, evChecksum); // already identical, just baseline it
				return;
			}
			if (local !== this.state.get(path)) {
				// Local has unsynced edits and the server changed too → conflict.
				await this.resolveConflict(path);
				return;
			}
		}
		await this.pullToLocal(path); // safe to adopt the server copy
	}

	private async pullToLocal(path: string): Promise<void> {
		const raw = await this.client.getRaw(path);
		if (!raw) return;
		await this.adoptRemote(path, raw);
	}

	private async adoptRemote(path: string, raw: RawNote): Promise<void> {
		this.expectEcho(path);
		await this.writeLocal(path, raw.content);
		this.state.set(path, raw.checksum || (await checksum(raw.content)));
	}

	// ── Local → remote (debounced from vault events) ──────────────────
	queueLocalUpsert(path: string): void {
		if (!this.inScope(path)) return;
		const existing = this.pushTimers.get(path);
		if (existing) window.clearTimeout(existing);
		this.pushTimers.set(
			path,
			window.setTimeout(() => {
				this.pushTimers.delete(path);
				void this.withLock(() => this.pushLocal(path));
			}, this.settings.pushDebounceMs),
		);
	}

	handleLocalDelete(path: string): void {
		if (!this.inScope(path)) return;
		if (this.consumeEcho(path)) return; // our own remote-applied delete
		const timer = this.pushTimers.get(path);
		if (timer) {
			window.clearTimeout(timer);
			this.pushTimers.delete(path);
		}
		void this.withLock(() => this.deleteRemote(path, this.state.get(path)));
	}

	handleLocalRename(oldPath: string, newPath: string): void {
		// Modeled as delete-old + create-new; Caldera rewrites of links arrive as
		// their own upsert events. (Server-side move is intentionally not used to
		// avoid double link-rewriting against Obsidian's own.)
		if (this.inScope(oldPath) && !this.consumeEcho(oldPath)) {
			void this.withLock(() => this.deleteRemote(oldPath, this.state.get(oldPath)));
		}
		if (this.inScope(newPath)) this.queueLocalUpsert(newPath);
	}

	private async pushLocal(path: string): Promise<void> {
		if (this.consumeEcho(path)) return; // echo of a remote-applied write
		const content = await this.readLocal(path);
		if (content === null) return;
		const local = await checksum(content);
		if (local === this.state.get(path)) return; // nothing actually changed
		const res = await this.client.putRaw(path, content, this.state.get(path));
		if (res.conflict) {
			await this.resolveConflict(path);
			return;
		}
		if (res.ok) this.state.set(path, res.checksum ?? local);
	}

	private async pushCreate(path: string): Promise<void> {
		const content = await this.readLocal(path);
		if (content === null) return;
		const res = await this.client.putRaw(path, content); // no If-Match: create
		if (res.conflict) {
			await this.resolveConflict(path);
			return;
		}
		if (res.ok) this.state.set(path, res.checksum ?? (await checksum(content)));
	}

	private async deleteRemote(path: string, ifMatch?: string): Promise<void> {
		const res = await this.client.deleteNote(path, ifMatch);
		if (res.conflict) {
			// Remote changed since our baseline; the upsert wins — re-pull it.
			await this.pullToLocal(path);
			return;
		}
		this.state.delete(path);
	}

	// ── Conflict resolution ───────────────────────────────────────────
	private async resolveConflict(path: string): Promise<void> {
		const localContent = await this.readLocal(path);
		const remote = await this.client.getRaw(path);

		if (!remote) {
			// Remote gone but local changed → recreate it from local.
			if (localContent !== null) await this.pushCreate(path);
			return;
		}
		if (localContent === null) {
			await this.adoptRemote(path, remote); // nothing local to keep
			return;
		}

		switch (this.settings.conflictStrategy) {
			case 'prefer-local': {
				const res = await this.client.putRaw(path, localContent, remote.checksum);
				if (res.ok) this.state.set(path, res.checksum ?? (await checksum(localContent)));
				break;
			}
			case 'prefer-remote':
				await this.adoptRemote(path, remote);
				break;
			case 'conflict-copy':
			default: {
				const copy = this.conflictPath(path);
				await this.writeLocal(copy, localContent); // a new file → syncs up on its own
				await this.adoptRemote(path, remote);
				new Notice(`Caldera Sync: conflict on ${path}. Kept your copy as ${copy}.`);
				break;
			}
		}
	}

	// ── Vault helpers ─────────────────────────────────────────────────
	private inScope(path: string): boolean {
		if (!path.endsWith('.md')) return false;
		const f = this.settings.folder;
		if (!f) return true;
		return path === f || path.startsWith(`${f}/`);
	}

	private localPaths(): string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => this.inScope(p));
	}

	private localFile(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	private async readLocal(path: string): Promise<string | null> {
		const file = this.localFile(path);
		return file ? this.app.vault.read(file) : null;
	}

	private async writeLocal(path: string, content: string): Promise<void> {
		await this.ensureFolder(path);
		const existing = this.localFile(path);
		if (existing) await this.app.vault.modify(existing, content);
		else await this.app.vault.create(path, content);
	}

	private async trashLocal(path: string): Promise<void> {
		const file = this.localFile(path);
		if (file) {
			this.expectEcho(path);
			await this.app.fileManager.trashFile(file);
		}
		this.state.delete(path);
	}

	private async ensureFolder(path: string): Promise<void> {
		const slash = path.lastIndexOf('/');
		if (slash < 0) return;
		const segments = path.slice(0, slash).split('/');
		let acc = '';
		for (const seg of segments) {
			acc = acc ? `${acc}/${seg}` : seg;
			if (!this.app.vault.getAbstractFileByPath(acc)) {
				try {
					await this.app.vault.createFolder(acc);
				} catch {
					// Raced with another create — fine.
				}
			}
		}
	}

	private conflictPath(path: string): string {
		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, '0');
		const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
		const dot = path.lastIndexOf('.');
		const stem = dot >= 0 ? path.slice(0, dot) : path;
		return `${stem} (conflict ${ts}).md`;
	}

	// ── Echo guard ────────────────────────────────────────────────────
	private expectEcho(path: string): void {
		this.applying.set(path, (this.applying.get(path) ?? 0) + 1);
		// Safety: drop a never-delivered expectation so it can't swallow a real edit.
		window.setTimeout(() => {
			const n = this.applying.get(path);
			if (n && n > 0) this.applying.set(path, n - 1);
			if (this.applying.get(path) === 0) this.applying.delete(path);
		}, 3000);
	}

	private consumeEcho(path: string): boolean {
		const n = this.applying.get(path);
		if (n && n > 0) {
			if (n === 1) this.applying.delete(path);
			else this.applying.set(path, n - 1);
			return true;
		}
		return false;
	}

	// ── Async lock ────────────────────────────────────────────────────
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private msg(err: unknown): string {
		return err instanceof Error ? err.message : String(err);
	}
}
