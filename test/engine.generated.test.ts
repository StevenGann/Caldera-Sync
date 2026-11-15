import { describe, it, expect, afterEach, vi } from 'vitest';
import type { CalderaClient, WriteResult } from '../src/api/client';
import { SyncEngine } from '../src/sync/engine';
import { SyncState } from '../src/sync/state';
import { checksum } from '../src/util/hash';
import type { ChangeEvent, ChangesResponse, Manifest, RawNote } from '../src/types';
import { FakeApp, wire } from './fake-vault';
import { makeSettings, waitFor } from './helpers';

// Record every Notice so the tests can assert the merge path stays silent.
const notices = vi.hoisted(() => [] as string[]);
vi.mock('obsidian', async (importOriginal) => {
	const actual = await importOriginal<typeof import('obsidian')>();
	return {
		...actual,
		Notice: class {
			constructor(public message: string) {
				notices.push(message);
			}
		},
	};
});

/**
 * In-memory stand-in for a Caldera server, exposing the slice of CalderaClient
 * the engine uses. Writes honour If-Match and append to a change log that the
 * engine's polling transport consumes — so, like the live-server harness, the
 * engine sees the echo of its own pushes.
 */
class FakeServer {
	notes = new Map<string, { content: string; checksum: string }>();
	events: ChangeEvent[] = [];
	puts: { path: string; content: string; ifMatch?: string }[] = [];
	/** Reject this many upcoming If-Match writes with 412 (simulates a lost race). */
	rejectNextPuts = 0;

	get head(): number {
		return this.events.length;
	}

	/** Write as another client would (machine A), emitting an upsert event. */
	async write(path: string, content: string): Promise<void> {
		const sum = await checksum(content);
		this.notes.set(path, { content, checksum: sum });
		this.events.push({
			seq: this.events.length + 1,
			ts: new Date().toISOString(),
			type: 'upsert',
			path,
			checksum: sum,
			origin: 'api',
		});
	}

	asClient(): CalderaClient {
		const client = {
			getManifest: async (): Promise<Manifest> => ({
				head: this.head,
				notes: [...this.notes].map(([path, n]) => ({ path, checksum: n.checksum })),
			}),
			getChanges: async (since: number): Promise<ChangesResponse> => ({
				head: this.head,
				floor: 0,
				resync: false,
				events: this.events.filter((e) => e.seq > since),
			}),
			getRaw: async (path: string): Promise<RawNote | null> => {
				const n = this.notes.get(path);
				return n ? { content: n.content, checksum: n.checksum } : null;
			},
			putRaw: async (path: string, content: string, ifMatch?: string): Promise<WriteResult> => {
				this.puts.push({ path, content, ifMatch });
				const current = this.notes.get(path);
				if (ifMatch && this.rejectNextPuts > 0) {
					this.rejectNextPuts--;
					return { ok: false, status: 412, conflict: true };
				}
				if (current && ifMatch && current.checksum !== ifMatch) {
					return { ok: false, status: 412, conflict: true };
				}
				await this.write(path, content);
				return { ok: true, status: 200, checksum: this.notes.get(path)?.checksum, conflict: false };
			},
			deleteNote: async (path: string): Promise<WriteResult> => {
				this.notes.delete(path);
				return { ok: true, status: 204, conflict: false };
			},
		};
		return client as unknown as CalderaClient;
	}
}

const PATH = 'Articles/Authors/Authors.md';

function hub(entries: string[], body = 'People whose work I read.') {
	return `# Authors\n\n${body}\n\n%% Begin Waypoint %%\n${entries.join('\n')}\n\n%% End Waypoint %%\n`;
}

const BASE = hub(['- [[Ada]]', '- [[Grace]]']);

const conflictCopies = (fake: FakeApp) => fake.paths().filter((p) => p.includes('conflict'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SyncEngine — generated-region (Waypoint) merge (fake server)', () => {
	const started: SyncEngine[] = [];

	afterEach(async () => {
		for (const e of started) await e.stop();
		started.length = 0;
		notices.length = 0;
	});

	/**
	 * A vault + server that agree on BASE at `PATH`, with the baseline recorded
	 * — i.e. the state right after a successful sync, before either Waypoint runs.
	 */
	async function inSync() {
		const server = new FakeServer();
		await server.write(PATH, BASE);
		const fake = new FakeApp();
		fake.seed(PATH, BASE);
		const state = new SyncState(async () => {});
		state.load({ cursor: server.head, checksums: { [PATH]: await checksum(BASE) } });
		return { server, fake, state };
	}

	async function startEngine(server: FakeServer, fake: FakeApp, state: SyncState, pushDebounceMs = 400) {
		const settings = makeSettings({ transport: 'poll', pollIntervalMs: 20, pushDebounceMs });
		const engine = new SyncEngine(fake.asApp(), settings, server.asClient(), state, () => {});
		wire(fake, engine);
		await engine.start();
		started.push(engine);
		return engine;
	}

	it('merges a live upsert that differs only inside the Waypoint block (no conflict copy)', async () => {
		const { server, fake, state } = await inSync();
		await startEngine(server, fake, state);

		// Both machines' Waypoint regenerate the hub differently. The local
		// rewrite is still inside its push debounce when machine A's arrives.
		fake.putLocal(PATH, hub(['- [[Ada]]', '- [[Grace]]', '- [[Local Author]]']));
		await server.write(PATH, hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]']));

		const merged = hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]', '- [[Local Author]]']);
		await waitFor(() => fake.getContent(PATH) === merged && server.notes.get(PATH)?.content === merged);

		expect(conflictCopies(fake)).toHaveLength(0);
		expect(notices).toHaveLength(0);
		expect(state.get(PATH)).toBe(await checksum(merged));
	});

	it('merges during reconcile (resolveConflict) instead of writing a conflict copy', async () => {
		const { server, fake, state } = await inSync();
		// Diverged while offline: both sides regenerated the block.
		fake.seed(PATH, hub(['- [[Ada]]', '- [[Local Author]]']));
		await server.write(PATH, hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]']));
		state.setCursor(server.head);

		await startEngine(server, fake, state);

		const merged = hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]', '- [[Local Author]]']);
		expect(fake.getContent(PATH)).toBe(merged);
		expect(server.notes.get(PATH)?.content).toBe(merged);
		expect(conflictCopies(fake)).toHaveLength(0);
		expect(notices).toHaveLength(0);
	});

	it('adopts the remote silently when the merge equals the remote copy', async () => {
		const { server, fake, state } = await inSync();
		await startEngine(server, fake, state);

		// Local block is a reordering of the remote's; nothing local-only to keep.
		fake.putLocal(PATH, hub(['- [[Grace]]', '- [[Ada]]']));
		const remote = hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]']);
		await server.write(PATH, remote);
		const putsBefore = server.puts.length;

		await waitFor(() => fake.getContent(PATH) === remote);
		await sleep(600); // past the push debounce

		expect(server.puts.length).toBe(putsBefore); // adopted, nothing pushed
		expect(conflictCopies(fake)).toHaveLength(0);
		expect(notices).toHaveLength(0);
		expect(state.get(PATH)).toBe(await checksum(remote));
	});

	it('still writes a conflict copy for a real edit in the hand-written body', async () => {
		const { server, fake, state } = await inSync();
		await startEngine(server, fake, state);

		const local = hub(['- [[Ada]]', '- [[Grace]]', '- [[Local Author]]'], 'My own edit.');
		const remote = hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]']);
		fake.putLocal(PATH, local);
		await server.write(PATH, remote);

		await waitFor(() => conflictCopies(fake).length === 1);
		expect(fake.getContent(PATH)).toBe(remote);
		expect(fake.getContent(conflictCopies(fake)[0] as string)).toBe(local);
		expect(notices.some((n) => n.includes('conflict'))).toBe(true);
	});

	it('baselines the merged result so the next event for the path is a no-op', async () => {
		const { server, fake, state } = await inSync();
		await startEngine(server, fake, state);

		fake.putLocal(PATH, hub(['- [[Ada]]', '- [[Grace]]', '- [[Local Author]]']));
		await server.write(PATH, hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]']));
		const merged = hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]', '- [[Local Author]]']);
		await waitFor(() => server.notes.get(PATH)?.content === merged);

		// Let the echo of our merged push and any pending debounced push play out.
		await sleep(800);
		const puts = server.puts.length;
		const head = server.head;
		const baseline = state.get(PATH);
		expect(baseline).toBe(await checksum(merged));

		// Another upsert for the same, unchanged note (e.g. a re-delivered echo).
		await server.write(PATH, merged);
		await sleep(600);

		expect(server.puts.length).toBe(puts);
		expect(server.head).toBe(head + 1); // only the write above; nothing pushed back
		expect(state.get(PATH)).toBe(baseline);
		expect(fake.getContent(PATH)).toBe(merged);
		expect(conflictCopies(fake)).toHaveLength(0);
	});

	it('falls back to the conflict path once when the merged push is rejected', async () => {
		const { server, fake, state } = await inSync();
		const local = hub(['- [[Ada]]', '- [[Local Author]]']);
		fake.seed(PATH, local);
		await server.write(PATH, hub(['- [[Ada]]', '- [[Grace]]', '- [[Remote Author]]']));
		state.setCursor(server.head);
		server.rejectNextPuts = 1;

		await startEngine(server, fake, state);

		// One rejected merge push, then the ordinary strategy — no retry loop.
		expect(server.puts.filter((p) => p.path === PATH)).toHaveLength(1);
		expect(conflictCopies(fake)).toHaveLength(1);
		expect(fake.getContent(conflictCopies(fake)[0] as string)).toBe(local);
		expect(fake.getContent(PATH)).toBe(server.notes.get(PATH)?.content);
	});
});
