import { describe, it, expect, afterEach } from 'vitest';
import { CalderaClient } from '../src/api/client';
import { SyncEngine } from '../src/sync/engine';
import { SyncState } from '../src/sync/state';
import { FakeApp, wire } from './fake-vault';
import { hasServer, makeSettings, waitFor, waitForAsync } from './helpers';

// Drives the REAL SyncEngine (with a fake in-memory vault) against a live
// Caldera server, exercising the full bidirectional loop end to end.
describe.skipIf(!hasServer)('SyncEngine ↔ Caldera (fake vault, live server)', () => {
	const started: SyncEngine[] = [];

	afterEach(async () => {
		for (const e of started) await e.stop();
		started.length = 0;
	});

	function uniqueFolder(): string {
		return `EngineCI/${Math.random().toString(36).slice(2, 8)}`;
	}

	async function setup(folder: string) {
		const settings = makeSettings({ folder, pushDebounceMs: 100 });
		const client = new CalderaClient(settings);
		const fake = new FakeApp();
		const state = new SyncState(async () => {});
		const engine = new SyncEngine(fake.asApp(), settings, client, state, () => {});
		wire(fake, engine);
		await engine.start();
		started.push(engine);
		return { settings, client, fake, engine };
	}

	it('pushes a local create to the server (local → remote)', async () => {
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const path = `${folder}/local.md`;
		const content = '---\nsrc: obsidian\n---\n\n# Local note\n';

		fake.putLocal(path, content);

		await waitForAsync(async () => (await client.getRaw(path))?.content === content);
		expect((await client.getRaw(path))?.content).toBe(content);
	});

	it('applies a remote (agent) write into the vault (remote → local)', async () => {
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const path = `${folder}/remote.md`;
		const content = '# Written by an agent via the API\n';

		await client.putRaw(path, content); // simulate an agent writing through Caldera

		await waitFor(() => fake.getContent(path) === content);
		expect(fake.getContent(path)).toBe(content);
	});

	it('suppresses the echo of its own push (no loop, no conflict copy)', async () => {
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const path = `${folder}/echo.md`;
		const content = '# round trip\n';

		fake.putLocal(path, content);
		await waitForAsync(async () => (await client.getRaw(path))?.content === content);

		// Give the SSE echo time to arrive and (correctly) be ignored.
		await new Promise((r) => setTimeout(r, 600));
		expect(fake.paths().filter((p) => p.includes('(conflict'))).toHaveLength(0);
		expect(fake.paths().filter((p) => p === path)).toHaveLength(1);
		expect((await client.getRaw(path))?.content).toBe(content);
	});

	it('mirrors a remote delete into the vault', async () => {
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const path = `${folder}/doomed.md`;
		const put = await client.putRaw(path, '# delete me\n');
		await waitFor(() => fake.has(path));

		await client.deleteNote(path, put.checksum);
		await waitFor(() => !fake.has(path));
		expect(fake.has(path)).toBe(false);
	});

	it('pushes a local delete to the server', async () => {
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const path = `${folder}/local-del.md`;
		fake.putLocal(path, '# temp\n');
		await waitForAsync(async () => (await client.getRaw(path)) !== null);

		fake.deleteLocal(path);
		await waitForAsync(async () => (await client.getRaw(path)) === null);
		expect(await client.getRaw(path)).toBeNull();
	});

	it('keeps both sides on a conflict (conflict-copy)', async () => {
		const folder = uniqueFolder();
		const path = `${folder}/conf.md`;
		const remote = '# remote version\n';
		const local = '# local version\n';

		// Server already has the remote version.
		const client = new CalderaClient(makeSettings({ folder }));
		await client.putRaw(path, remote);

		// Local vault has a different version pre-existing on disk, with a baseline
		// that matches neither side — so reconcile sees BOTH as changed → conflict.
		const fake = new FakeApp();
		fake.seed(path, local);
		const state = new SyncState(async () => {});
		state.load({ cursor: 0, checksums: { [path]: 'sha256:' + 'b'.repeat(64) } });
		const engine = new SyncEngine(fake.asApp(), makeSettings({ folder }), client, state, () => {});
		wire(fake, engine);
		await engine.start(); // reconcile resolves the conflict during start()
		started.push(engine);

		// Remote adopted into the real path; local kept as a conflict copy.
		await waitFor(() => fake.getContent(path) === remote);
		const copy = fake.paths().find((p) => p.includes('(conflict'));
		expect(copy).toBeDefined();
		expect(fake.getContent(copy as string)).toBe(local);
	});
});
