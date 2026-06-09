import { requestUrl } from 'obsidian';
import type { CalderaSyncSettings } from '../settings';
import type { ChangesResponse, Manifest, RawNote } from '../types';

export interface WriteResult {
	ok: boolean;
	status: number;
	/** Server checksum after the write (from the ETag / body), when available. */
	checksum?: string;
	/** True for 409/412 — the precondition failed, caller should resolve a conflict. */
	conflict: boolean;
}

/** Encode a vault-relative path for a Caldera `{path:path}` route (keep slashes). */
function encodePath(path: string): string {
	return path
		.split('/')
		.map((seg) => encodeURIComponent(seg))
		.join('/');
}

function unquoteEtag(etag: string | undefined): string | undefined {
	if (!etag) return undefined;
	return etag.replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** Case-insensitive header lookup (Obsidian's requestUrl lowercases header keys). */
function header(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

/**
 * Thin REST wrapper over Caldera. Uses Obsidian's `requestUrl` (no CORS issues,
 * works on desktop and mobile). Non-2xx responses are inspected rather than
 * thrown, so callers can branch on 404 / 409 / 412.
 */
export class CalderaClient {
	constructor(private settings: CalderaSyncSettings) {}

	private get base(): string {
		return `${this.settings.serverUrl}/api/v1`;
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		return {
			Authorization: `Bearer ${this.settings.apiKey}`,
			...extra,
		};
	}

	async getManifest(): Promise<Manifest> {
		const folderQuery = this.settings.folder
			? `?folder=${encodeURIComponent(this.settings.folder)}`
			: '';
		const r = await requestUrl({
			url: `${this.base}/manifest${folderQuery}`,
			headers: this.headers(),
			throw: true,
		});
		return r.json as Manifest;
	}

	async getChanges(since: number, limit = 500): Promise<ChangesResponse> {
		const r = await requestUrl({
			url: `${this.base}/changes?since=${since}&limit=${limit}`,
			headers: this.headers(),
			throw: true,
		});
		return r.json as ChangesResponse;
	}

	/** Fetch a note's raw markdown + checksum. Returns null if it doesn't exist. */
	async getRaw(path: string): Promise<RawNote | null> {
		const r = await requestUrl({
			url: `${this.base}/notes/${encodePath(path)}?format=markdown`,
			headers: this.headers(),
			throw: false,
		});
		if (r.status === 404) return null;
		if (r.status >= 400) {
			throw new Error(`GET ${path} → HTTP ${r.status}`);
		}
		const checksum = unquoteEtag(header(r.headers, 'etag'));
		return { content: r.text, checksum: checksum ?? '' };
	}

	/**
	 * Create-or-replace a note with the *entire* raw file as `content`, omitting
	 * `frontmatter` so Caldera stores it verbatim (checksum fidelity). `ifMatch`
	 * is the last-known checksum for optimistic concurrency.
	 */
	async putRaw(path: string, content: string, ifMatch?: string): Promise<WriteResult> {
		const headers = this.headers({ 'Content-Type': 'application/json' });
		if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
		const r = await requestUrl({
			url: `${this.base}/notes/${encodePath(path)}`,
			method: 'PUT',
			headers,
			body: JSON.stringify({ content }),
			throw: false,
		});
		if (r.status === 409 || r.status === 412) {
			return { ok: false, status: r.status, conflict: true };
		}
		if (r.status >= 400) {
			throw new Error(`PUT ${path} → HTTP ${r.status}`);
		}
		const bodyChecksum = (r.json as { checksum?: string } | undefined)?.checksum;
		const checksum = bodyChecksum ?? unquoteEtag(header(r.headers, 'etag'));
		return { ok: true, status: r.status, checksum, conflict: false };
	}

	/** Delete a note. A 404 is treated as success (already gone). */
	async deleteNote(path: string, ifMatch?: string): Promise<WriteResult> {
		const headers = this.headers();
		if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
		const r = await requestUrl({
			url: `${this.base}/notes/${encodePath(path)}`,
			method: 'DELETE',
			headers,
			throw: false,
		});
		if (r.status === 409 || r.status === 412) {
			return { ok: false, status: r.status, conflict: true };
		}
		if (r.status >= 400 && r.status !== 404) {
			throw new Error(`DELETE ${path} → HTTP ${r.status}`);
		}
		return { ok: true, status: r.status, conflict: false };
	}
}
