import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		// Node test code (Vitest) — not Obsidian-runtime plugin code, so the
		// obsidian-specific rules (window timers, no-fetch) don't apply.
		'test/**',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Our UI text contains proper nouns, acronyms, and identifiers that the
		// sentence-case rule would otherwise rewrite incorrectly. Allowlist them
		// rather than disabling the rule. NOTE: supplying `acronyms`/`brands`
		// *replaces* the plugin defaults, so the defaults we still rely on (URL,
		// HTTP, SSE, API, Obsidian) are re-listed here explicitly.
		rules: {
			'obsidianmd/ui/sentence-case': [
				'error',
				{
					acronyms: ['SSE', 'API', 'URL', 'HTTP', 'HTTPS'],
					brands: ['Caldera Sync', 'Caldera', 'Obsidian'],
					// The server env var and example URL are literal identifiers,
					// not prose, and must keep their casing.
					ignoreWords: ['CALDERA_API_KEYS'],
					// Skip strings that are an example URL, or that embed an
					// UPPER_SNAKE_CASE identifier (e.g. an env-var name) which must
					// keep its casing rather than be sentence-cased.
					ignoreRegex: ['^https?://', '[A-Z][A-Z0-9]*(_[A-Z0-9]+)+'],
				},
			],
		},
	},
);
