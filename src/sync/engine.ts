import { App, Notice, TFile, normalizePath } from 'obsidian';
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
/**
 * Sentinel checksum for an expected delete echo (a delete carries no content).
 * The `echo:` prefix keeps it distinct from any real `sha256:…` checksum.
 */
const ECHO_DELETE = 'echo:delete';

export class SyncEngine {
	private stream: ChangeStream | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	/** path → set of checksums we expect to see echoed back from our own writes. */
	private applying = new Map<string, Set<string>>();
	private pushTimers = new Map<string, number>();
	/** Pending expiry timers for echo expectations, cleared on stop(). */
	private echoTimers = new Set<number>();
	/** One-shot bypass of the large-sync safety limit (set by the confirm command). */
	private bypassLimitOnce = false;

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
		let result: 'ok' | 'paused';
		try {
			result = await this.withLock(() => this.reconcile());
		} catch (err) {
			this.onStatus({ kind: 'error', detail: this.msg(err) });
			return;
		}
		if (result === 'paused') return; // safety limit tripped — do not go live
		this.startStream();
	}

	private startStream(): void {
		if (this.stream) return;
		this.stream = new ChangeStream(this.settings, this.client, {
			onEvent: (ev) => this.withLock(() => this.applyEvent(ev)),
			onResync: () =>
				this.withLock(() => this.reconcile()).then((r) => {
					if (r === 'paused') this.stream?.stop(); // don't keep streaming past a tripped limit
				}),
			onStatus: (s) => this.onStatus(s),
			getCursor: () => this.state.cursor,
		});
		this.stream.start();
	}

	/** User confirmed an over-limit sync — let the next reconcile through once. */
	async confirmLargeSync(): Promise<void> {
		this.bypassLimitOnce = true;
		await this.start();
	}

	async stop(): Promise<void> {
		this.stream?.stop();
		this.stream = null;
		for (const t of this.pushTimers.values()) window.clearTimeout(t);
		this.pushTimers.clear();
		for (const t of this.echoTimers) window.clearTimeout(t);
		this.echoTimers.clear();
		this.applying.clear();
		await this.state.flush();
	}

	/** Run a one-off full reconcile (the manual "Sync now" command). */
	async syncNow(): Promise<void> {
		await this.withLock(() => this.reconcile());
	}

	// ── Reconcile (bootstrap / resync) ────────────────────────────────
	private async reconcile(): Promise<'ok' | 'paused'> {
		this.onStatus({ kind: 'reconciling' });
		const manifest = await this.client.getManifest();
		const remote = new Map(manifest.notes.map((n) => [normalizePath(n.path), n.checksum]));
		const local = await this.hashLocalFiles();

		// Build the full plan BEFORE touching anything, so a safety limit can veto
		// a runaway batch. A mis-rooted server or a path-nesting bug can otherwise
		// turn one reconcile into hundreds of creates/deletes (a commit storm).
		type Action =
			| 'pull' | 'pushLocal' | 'pushCreate' | 'trashLocal' | 'deleteRemote' | 'conflict' | 'baseline';
		const plan: { path: string; action: Action; checksum?: string }[] = [];
		const paths = new Set<string>([...remote.keys(), ...local.keys()]);
		for (const path of paths) {
			// Three-way compare: server checksum vs local checksum vs the baseline
			// (last agreed checksum). Each branch decides who, if anyone, changed.
			const remoteSum = remote.get(path);
			const localSum = local.get(path);
			const baseSum = this.state.get(path);
			if (remoteSum && !localSum) {
				if (baseSum !== undefined && baseSum === remoteSum)
					plan.push({ path, action: 'deleteRemote', checksum: remoteSum }); // deleted locally while offline
				else plan.push({ path, action: 'pull' });
			} else if (!remoteSum && localSum) {
				if (baseSum !== undefined && baseSum === localSum)
					plan.push({ path, action: 'trashLocal' }); // remote deleted while offline
				else plan.push({ path, action: 'pushCreate' });
			} else if (remoteSum && localSum) {
				if (remoteSum === localSum) plan.push({ path, action: 'baseline', checksum: remoteSum });
				else if (baseSum === remoteSum) plan.push({ path, action: 'pushLocal' });
				else if (baseSum === localSum) plan.push({ path, action: 'pull' });
				else plan.push({ path, action: 'conflict' });
			}
		}

		// Circuit-breaker: refuse an over-limit batch unless the user confirmed.
		const mutations = plan.filter((p) => p.action !== 'baseline');
		const limit = this.settings.maxBatchChanges;
		if (limit > 0 && mutations.length > limit && !this.bypassLimitOnce) {
			this.onStatus({ kind: 'paused', detail: `${mutations.length} changes > ${limit} limit` });
			new Notice(
				`Caldera Sync paused: this sync would change ${mutations.length} files (limit ${limit}). ` +
					`If expected (e.g. a first import), run "Caldera Sync: confirm large sync"; ` +
					`otherwise check the server's vault root.`,
			);
			return 'paused';
		}
		this.bypassLimitOnce = false;

		for (const item of plan) {
			switch (item.action) {
				case 'baseline': this.state.set(item.path, item.checksum as string); break;
				case 'pull': await this.pullToLocal(item.path); break;
				case 'pushLocal': await this.pushLocal(item.path); break;
				case 'pushCreate': await this.pushCreate(item.path); break;
				case 'trashLocal': await this.trashLocal(item.path); break;
				case 'deleteRemote': await this.deleteRemote(item.path, item.checksum); break;
				case 'conflict': await this.resolveConflict(item.path); break;
			}
		}
		this.state.setCursor(manifest.head);
		await this.state.flush();
		return 'ok';
	}

	// ── Remote → local ────────────────────────────────────────────────
	private async applyEvent(ev: ChangeEvent): Promise<void> {
		if (!ev.path || !this.inScope(ev.path)) {
			this.state.setCursor(ev.seq);
			return;
		}
		const path = normalizePath(ev.path);
		if (ev.type === 'delete') {
			if (this.state.get(path) !== undefined || this.localFile(path)) {
				await this.trashLocal(path);
			}
		} else if (ev.type === 'upsert') {
			await this.applyUpsert(path, ev.checksum);
		}
		// Advance the cursor only after the event is successfully applied. If apply
		// throws, the cursor stays put so backoff/reconnect re-delivers this seq
		// rather than silently skipping it.
		this.state.setCursor(ev.seq);
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
		const sum = raw.checksum || (await checksum(raw.content));
		this.expectEcho(path, sum);
		await this.writeLocal(path, raw.content);
		this.state.set(path, sum);
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
		if (this.consumeEcho(path, ECHO_DELETE)) return; // our own remote-applied delete
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
		// avoid double link-rewriting against Obsidian's own.) Both halves run as a
		// single locked unit so a remote edit can't interleave between them, and the
		// old path's pending debounce/echo bookkeeping is settled up front.
		const oldInScope = this.inScope(oldPath);
		const newInScope = this.inScope(newPath);
		if (!oldInScope && !newInScope) return;

		// Cancel any pending push for the old path; it's about to disappear.
		const pending = this.pushTimers.get(oldPath);
		if (pending) {
			window.clearTimeout(pending);
			this.pushTimers.delete(oldPath);
		}

		void this.withLock(async () => {
			// A rename never originates from the engine (only trashLocal registers an
			// ECHO_DELETE, and trashing fires a delete — not a rename), so an in-scope
			// old path is always a genuine user move: delete it remotely.
			if (oldInScope) {
				await this.deleteRemote(oldPath, this.state.get(oldPath));
			}
			if (newInScope) await this.pushLocal(newPath);
		});
	}

	private async pushLocal(path: string): Promise<void> {
		const content = await this.readLocal(path);
		if (content === null) return;
		const local = await checksum(content);
		if (this.consumeEcho(path, local)) return; // echo of a remote-applied write
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
		const folder = normalizePath(f);
		return path === folder || path.startsWith(`${folder}/`);
	}

	private localPaths(): string[] {
		return this.app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => this.inScope(p));
	}

	/**
	 * Hash every in-scope local note for the reconcile baseline. Hashing is bounded
	 * (a fixed number of files in flight) and yields between chunks so a large vault
	 * can't freeze the UI; files whose mtime+size match the cached baseline reuse the
	 * cached checksum instead of being re-read and re-hashed. Progress is surfaced
	 * through the existing "reconciling" status detail.
	 */
	private async hashLocalFiles(): Promise<Map<string, string>> {
		const CONCURRENCY = 8;
		const local = new Map<string, string>();
		const files = this.localPaths()
			.map((p) => this.localFile(p))
			.filter((f): f is TFile => f !== null);
		const total = files.length;
		let done = 0;

		for (let i = 0; i < total; i += CONCURRENCY) {
			const chunk = files.slice(i, i + CONCURRENCY);
			await Promise.all(
				chunk.map(async (file) => {
					const sum = await this.hashFile(file);
					if (sum !== null) local.set(file.path, sum);
				}),
			);
			done += chunk.length;
			if (total > CONCURRENCY) {
				this.onStatus({ kind: 'reconciling', detail: `${done}/${total}` });
			}
			// Yield to the event loop between chunks so a large vault stays responsive.
			await new Promise((r) => window.setTimeout(r, 0));
		}
		return local;
	}

	/** Checksum a file, reusing the stat cache when mtime+size are unchanged. */
	private async hashFile(file: TFile): Promise<string | null> {
		const stat = file.stat;
		if (stat) {
			const cached = this.state.cachedChecksum(file.path, stat.mtime, stat.size);
			if (cached) return cached;
		}
		const content = await this.app.vault.read(file);
		const sum = await checksum(content);
		if (stat) this.state.setStat(file.path, stat.mtime, stat.size, sum);
		return sum;
	}

	private localFile(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
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
		else await this.app.vault.create(normalizePath(path), content);
	}

	private async trashLocal(path: string): Promise<void> {
		const file = this.localFile(path);
		if (file) {
			this.expectEcho(path, ECHO_DELETE);
			await this.app.fileManager.trashFile(file);
		}
		this.state.delete(path);
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const slash = normalized.lastIndexOf('/');
		if (slash < 0) return;
		const segments = normalized.slice(0, slash).split('/');
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
		return normalizePath(`${stem} (conflict ${ts}).md`);
	}

	// ── Echo guard ────────────────────────────────────────────────────
	// A remote-applied write/delete produces a vault event that flows back into
	// the engine as if the user had made it. We record the *checksum* we expect
	// to see echoed (the sentinel ECHO_DELETE for deletes) so suppression matches
	// the exact change we caused — not merely "some change to this path".
	private expectEcho(path: string, expected: string): void {
		let set = this.applying.get(path);
		if (!set) {
			set = new Set<string>();
			this.applying.set(path, set);
		}
		set.add(expected);
		// Safety: drop a never-delivered expectation so it can't swallow a real edit.
		// The expiry must outlast the local-push debounce — otherwise a slow vault
		// event could fire its own push before the echo we registered here is
		// consumed, so the invariant is `pushDebounceMs < echoExpiry`. Derive the
		// window from the debounce (plus a buffer) to keep that coupling explicit.
		const echoExpiry = Math.max(3000, this.settings.pushDebounceMs + 2000);
		const timer = window.setTimeout(() => {
			this.echoTimers.delete(timer);
			const s = this.applying.get(path);
			if (s) {
				s.delete(expected);
				if (s.size === 0) this.applying.delete(path);
			}
		}, echoExpiry);
		this.echoTimers.add(timer);
	}

	private consumeEcho(path: string, actual: string): boolean {
		const set = this.applying.get(path);
		if (set?.has(actual)) {
			set.delete(actual);
			if (set.size === 0) this.applying.delete(path);
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
