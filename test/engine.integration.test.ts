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

	it('adopts a remote upsert whose content equals the local file without a conflict copy', async () => {
		// SEN-2 regression: a remote upsert that happens to match the existing local
		// content must be recognised as already-identical (checksum baseline), not
		// treated as a competing change that spawns a conflict copy.
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const path = `${folder}/identical.md`;
		const content = '# same on both sides\n';

		// Push locally first so the vault holds `content` and a baseline is recorded.
		fake.putLocal(path, content);
		await waitForAsync(async () => (await client.getRaw(path))?.content === content);

		// Re-PUT the identical content through the API: a remote upsert event arrives
		// for content the vault already has.
		await client.putRaw(path, content, (await client.getRaw(path))?.checksum);
		await new Promise((r) => setTimeout(r, 700));

		expect(fake.paths().filter((p) => p.includes('(conflict'))).toHaveLength(0);
		expect(fake.getContent(path)).toBe(content);
	});

	it('renames a note as delete-old + create-new on the server', async () => {
		// SEN-5: a local rename mirrors as one locked unit — old path removed, new
		// path created — even when a remote edit could otherwise interleave.
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const oldPath = `${folder}/before.md`;
		const newPath = `${folder}/after.md`;
		const content = '# rename me\n';

		fake.putLocal(oldPath, content);
		await waitForAsync(async () => (await client.getRaw(oldPath))?.content === content);

		fake.renameLocal(oldPath, newPath);
		await waitForAsync(async () => (await client.getRaw(newPath))?.content === content);
		await waitForAsync(async () => (await client.getRaw(oldPath)) === null);

		expect((await client.getRaw(newPath))?.content).toBe(content);
		expect(await client.getRaw(oldPath)).toBeNull();
	});

	it('renames a just-adopted remote note without a loop or conflict copy', async () => {
		// SEN-5: renaming a note immediately after the engine adopted it from the
		// server must not be mistaken for a competing edit (paired echo bookkeeping).
		const folder = uniqueFolder();
		const { client, fake } = await setup(folder);
		const remotePath = `${folder}/adopted.md`;
		const renamed = `${folder}/adopted-renamed.md`;
		const content = '# from the server\n';

		await client.putRaw(remotePath, content); // agent write → adopted into the vault
		await waitFor(() => fake.getContent(remotePath) === content);

		fake.renameLocal(remotePath, renamed);
		await waitForAsync(async () => (await client.getRaw(renamed))?.content === content);
		await waitForAsync(async () => (await client.getRaw(remotePath)) === null);

		expect(fake.paths().filter((p) => p.includes('(conflict'))).toHaveLength(0);
		expect((await client.getRaw(renamed))?.content).toBe(content);
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

	it('pauses an over-limit reconcile and applies it on confirm (storm guard)', async () => {
		const folder = uniqueFolder();
		const client = new CalderaClient(makeSettings({ folder }));
		for (const n of ['a', 'b', 'c']) await client.putRaw(`${folder}/${n}.md`, `# ${n}\n`);

		const fake = new FakeApp();
		const state = new SyncState(async () => {});
		const statuses: string[] = [];
		const settings = makeSettings({ folder, maxBatchChanges: 2 });
		const engine = new SyncEngine(fake.asApp(), settings, client, state, (s) => statuses.push(s.kind));
		wire(fake, engine);

		await engine.start();
		started.push(engine);
		// 3 pulls > limit of 2 → paused, nothing applied locally.
		expect(statuses).toContain('paused');
		expect(fake.paths().length).toBe(0);

		// Confirm bypasses the limit once and applies all three.
		await engine.confirmLargeSync();
		await waitFor(() => fake.paths().filter((p) => p.startsWith(folder)).length === 3);

		for (const n of ['a', 'b', 'c']) await client.deleteNote(`${folder}/${n}.md`);
	});
});
