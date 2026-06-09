import type { CalderaClient } from './client';
import type { CalderaSyncSettings } from '../settings';
import type { ChangeEvent, SyncStatusInfo } from '../types';

export interface StreamHandlers {
	/** Apply one change (upsert/delete). */
	onEvent: (ev: ChangeEvent) => Promise<void>;
	/** Server asked us to reload the manifest (we fell behind the buffer). */
	onResync: () => Promise<void>;
	/** Surface connection status to the UI. */
	onStatus: (info: SyncStatusInfo) => void;
	/** Last applied sequence number — used as `since` for streaming/polling. */
	getCursor: () => number;
}

const MAX_BACKOFF_MS = 30000;

/**
 * Live change subscription. Prefers an SSE stream over `fetch` (instant), and
 * falls back to polling `/changes` where a held-open stream isn't available
 * (mobile) or the user selected polling. Reconnects with capped backoff.
 */
export class ChangeStream {
	private abort: AbortController | null = null;
	private running = false;

	constructor(
		private settings: CalderaSyncSettings,
		private client: CalderaClient,
		private handlers: StreamHandlers,
	) {}

	start(): void {
		if (this.running) return;
		this.running = true;
		void this.loop();
	}

	stop(): void {
		this.running = false;
		this.abort?.abort();
		this.abort = null;
	}

	private async loop(): Promise<void> {
		let backoff = 1000;
		while (this.running) {
			this.abort = new AbortController();
			try {
				if (this.settings.transport === 'sse') {
					await this.runSse(this.abort.signal);
				} else {
					await this.runPoll(this.abort.signal);
				}
				backoff = 1000; // a clean return resets backoff
			} catch (err) {
				if (!this.running) break;
				const detail = err instanceof Error ? err.message : String(err);
				this.handlers.onStatus({ kind: 'error', detail });
				await this.sleep(backoff, this.abort.signal);
				backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
			}
		}
	}

	// ── SSE transport ────────────────────────────────────────────────
	private async runSse(signal: AbortSignal): Promise<void> {
		const since = this.handlers.getCursor();
		const url = `${this.settings.serverUrl}/api/v1/events?since=${since}`;
		// requestUrl can't stream a response body, so the SSE feed must use fetch.
		// eslint-disable-next-line no-restricted-globals
		const resp = await fetch(url, {
			headers: { Authorization: `Bearer ${this.settings.apiKey}` },
			signal,
		});
		if (!resp.ok) throw new Error(`events stream → HTTP ${resp.status}`);
		if (!resp.body) {
			// Streaming unsupported on this platform — degrade to polling.
			await this.runPoll(signal);
			return;
		}
		this.handlers.onStatus({ kind: 'live' });
		const reader = resp.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return; // server closed; loop() will reconnect
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				await this.handleFrame(frame);
			}
		}
	}

	private async handleFrame(frame: string): Promise<void> {
		const dataLines = frame
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trim());
		if (dataLines.length === 0) return; // keepalive comment or id-only frame
		const ev = JSON.parse(dataLines.join('\n')) as ChangeEvent;
		if (ev.type === 'resync') {
			await this.handlers.onResync();
		} else {
			await this.handlers.onEvent(ev);
		}
	}

	// ── Poll transport ───────────────────────────────────────────────
	private async runPoll(signal: AbortSignal): Promise<void> {
		this.handlers.onStatus({ kind: 'polling' });
		while (this.running && !signal.aborted) {
			const since = this.handlers.getCursor();
			const res = await this.client.getChanges(since);
			if (res.resync) {
				await this.handlers.onResync();
			} else {
				for (const ev of res.events) {
					await this.handlers.onEvent(ev);
				}
			}
			await this.sleep(this.settings.pollIntervalMs, signal);
		}
	}

	private sleep(ms: number, signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				signal.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				window.clearTimeout(timer);
				reject(new DOMException('aborted', 'AbortError'));
			};
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}
}
