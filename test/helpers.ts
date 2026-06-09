import type { CalderaSyncSettings } from '../src/settings';

/** Caldera server under test, supplied by CI (or a local dev server). */
export const CALDERA_URL = process.env.CALDERA_URL ?? '';
export const CALDERA_KEY = process.env.CALDERA_KEY ?? '';

/** Integration tests are skipped unless a server URL is configured. */
export const hasServer = CALDERA_URL.length > 0;

export function makeSettings(overrides: Partial<CalderaSyncSettings> = {}): CalderaSyncSettings {
	return {
		serverUrl: CALDERA_URL,
		apiKey: CALDERA_KEY,
		folder: '',
		enabled: true,
		transport: 'sse',
		pollIntervalMs: 500,
		pushDebounceMs: 200,
		conflictStrategy: 'conflict-copy',
		...overrides,
	};
}

/** A unique note path so parallel/repeated runs don't collide. */
export function uniquePath(prefix = 'CITest'): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `${prefix}/note-${rand}.md`;
}

/** Poll a predicate until it returns true or the timeout elapses. */
export async function waitFor(
	predicate: () => boolean,
	{ timeout = 10000, interval = 50 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (predicate()) return;
		if (Date.now() - start > timeout) throw new Error('waitFor: timed out');
		await new Promise((r) => setTimeout(r, interval));
	}
}
