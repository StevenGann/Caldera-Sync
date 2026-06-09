import { describe, it, expect, afterEach } from 'vitest';
import { CalderaClient } from '../src/api/client';
import { ChangeStream } from '../src/api/events';
import type { ChangeEvent } from '../src/types';
import { hasServer, makeSettings, uniquePath, waitFor } from './helpers';

// Drives the REAL SSE ChangeStream against a live Caldera server: a write made
// directly through the API (simulating an agent) must arrive on the stream.
describe.skipIf(!hasServer)('ChangeStream ↔ Caldera SSE', () => {
	let stream: ChangeStream | null = null;

	afterEach(() => {
		stream?.stop();
		stream = null;
	});

	async function openStream(transport: 'sse' | 'poll') {
		const settings = makeSettings({ transport });
		const client = new CalderaClient(settings);
		const events: ChangeEvent[] = [];
		// Subscribe from the current head so we only see changes from this test.
		let cursor = (await client.getManifest()).head;
		stream = new ChangeStream(settings, client, {
			onEvent: async (ev) => {
				cursor = ev.seq;
				events.push(ev);
			},
			onResync: async () => {
				cursor = (await client.getManifest()).head;
			},
			onStatus: () => {},
			getCursor: () => cursor,
		});
		stream.start();
		return { client, events };
	}

	it('delivers an upsert event for an API write over SSE', async () => {
		const { client, events } = await openStream('sse');
		const path = uniquePath();
		const content = '# streamed over sse\n';
		const put = await client.putRaw(path, content);

		await waitFor(() => events.some((e) => e.path === path && e.type === 'upsert'));
		const ev = events.find((e) => e.path === path);
		expect(ev?.type).toBe('upsert');
		expect(ev?.checksum).toBe(put.checksum); // carries the checksum for echo suppression

		await client.deleteNote(path, put.checksum);
		await waitFor(() => events.some((e) => e.path === path && e.type === 'delete'));
	});

	it('delivers changes over the polling fallback transport', async () => {
		const { client, events } = await openStream('poll');
		const path = uniquePath();
		const put = await client.putRaw(path, '# streamed over poll\n');

		await waitFor(() => events.some((e) => e.path === path && e.type === 'upsert'));
		await client.deleteNote(path, put.checksum);
	});
});
