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
		// Our UI text contains proper nouns and acronyms (Caldera, SSE, API, URL)
		// that the sentence-case rule rewrites incorrectly.
		rules: {
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
);
