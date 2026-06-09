// Test shim for the 'obsidian' module (aliased in vitest.config.ts).
//
// It provides just enough of the Obsidian API for the plugin's own code to run
// under Node against a live Caldera server:
//   - `requestUrl` implemented over Node's global fetch, matching Obsidian's
//     response shape and `throw` semantics;
//   - class stand-ins (TFile, Notice, App, …) so `instanceof` checks and value
//     imports resolve. The real file operations are supplied by a fake vault in
//     the engine tests, not here.

export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

export async function requestUrl(
	param: RequestUrlParam | string,
): Promise<RequestUrlResponse> {
	const p = typeof param === 'string' ? { url: param } : param;
	const resp = await fetch(p.url, {
		method: p.method ?? 'GET',
		headers: p.headers,
		body: p.body,
	});
	const text = await resp.text();
	const headers: Record<string, string> = {};
	resp.headers.forEach((v, k) => {
		headers[k] = v;
	});
	let json: unknown;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = undefined;
	}
	// Obsidian's requestUrl throws on >= 400 unless `throw: false`.
	if (resp.status >= 400 && p.throw !== false) {
		throw new Error(`requestUrl ${p.url} → HTTP ${resp.status}`);
	}
	return { status: resp.status, headers, text, json, arrayBuffer: new ArrayBuffer(0) };
}

export class TAbstractFile {
	path = '';
	name = '';
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

export class Notice {
	constructor(public message: string) {}
}

// Minimal value stand-ins so named value-imports resolve. The engine tests
// inject a fake App; these are never instantiated by production code under test.
export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
