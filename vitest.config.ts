import { defineConfig } from 'vitest/config';
import path from 'node:path';

// The plugin imports from 'obsidian', which only exists inside the Obsidian app.
// For tests we alias it to a lightweight shim (requestUrl over Node fetch, plus
// minimal TFile/Notice/App stand-ins) so the real client/engine code can run in
// Node and talk to a live Caldera container.
export default defineConfig({
	resolve: {
		alias: {
			obsidian: path.resolve(import.meta.dirname, 'test/obsidian.ts'),
		},
	},
	test: {
		environment: 'node',
		setupFiles: ['test/setup.ts'],
		include: ['test/**/*.test.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
	},
});
