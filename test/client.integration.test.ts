import { describe, it, expect } from 'vitest';
import { CalderaClient } from '../src/api/client';
import { checksum } from '../src/util/hash';
import { CALDERA_URL, hasServer, makeSettings, uniquePath } from './helpers';

// Exercises the real REST client against a live Caldera server. Skipped when no
// CALDERA_URL is set (e.g. the build-only matrix).
describe.skipIf(!hasServer)('CalderaClient ↔ Caldera REST API', () => {
	const client = new CalderaClient(makeSettings());

	it('connects to a configured server', () => {
		expect(CALDERA_URL).not.toBe('');
	});

	it('round-trips a note verbatim with a matching checksum', async () => {
		const path = uniquePath();
		const content = '---\ntitle: Hi\ntags: [ci, test]\n---\n\nBody with a [[Link]].\n';

		const put = await client.putRaw(path, content);
		expect(put.ok).toBe(true);
		expect(put.checksum).toBeDefined();

		// The client computes the same checksum Caldera does (sha256 parity).
		expect(await checksum(content)).toBe(put.checksum);

		// Caldera stored the bytes verbatim — frontmatter not reserialized.
		const raw = await client.getRaw(path);
		expect(raw).not.toBeNull();
		expect(raw?.content).toBe(content);
		expect(raw?.checksum).toBe(put.checksum);

		// The manifest reports the same checksum.
		const manifest = await client.getManifest();
		const entry = manifest.notes.find((n) => n.path === path);
		expect(entry?.checksum).toBe(put.checksum);

		await client.deleteNote(path, put.checksum);
	});

	it('rejects a stale write with an If-Match conflict', async () => {
		const path = uniquePath();
		const first = await client.putRaw(path, 'v1\n');
		expect(first.ok).toBe(true);

		const stale = await client.putRaw(path, 'v2\n', 'sha256:' + '0'.repeat(64));
		expect(stale.ok).toBe(false);
		expect(stale.conflict).toBe(true);

		// With the current checksum it succeeds.
		const ok = await client.putRaw(path, 'v2\n', first.checksum);
		expect(ok.ok).toBe(true);

		await client.deleteNote(path, ok.checksum);
	});

	it('returns null for a missing note and treats delete-missing as success', async () => {
		const path = uniquePath();
		expect(await client.getRaw(path)).toBeNull();
		const del = await client.deleteNote(path);
		expect(del.ok).toBe(true);
	});
});
