import { describe, expect, it } from 'vitest';
import {
	isCleanVaultPath,
	sanitizeComponent,
	sanitizeVaultPath,
} from '../src/util/filename';

// These cases deliberately mirror `tests/test_paths.py` on the server. The two
// implementations must agree exactly, so if you change one, change both.

describe('sanitizeComponent', () => {
	it('strips punctuation', () => {
		expect(sanitizeComponent('Finally! A Typeface')).toBe('Finally A Typeface');
		expect(sanitizeComponent("Shein's")).toBe('Sheins');
		expect(sanitizeComponent('What: A Wiki & More')).toBe('What A Wiki More');
	});

	it('keeps the punctuation that joins words', () => {
		expect(sanitizeComponent('12-Bay NAS')).toBe('12-Bay NAS');
		expect(sanitizeComponent('fast-fashion')).toBe('fast-fashion');
		expect(sanitizeComponent('a_b')).toBe('a_b');
	});

	it('collapses the space it leaves behind', () => {
		expect(sanitizeComponent('a :  b')).toBe('a b');
		expect(sanitizeComponent('  padded  ')).toBe('padded');
	});

	it('keeps a leading dot only for directories', () => {
		expect(sanitizeComponent('.obsidian', true)).toBe('.obsidian');
		expect(sanitizeComponent('.hidden')).toBe('hidden');
		expect(sanitizeComponent('..', true)).toBe('.');
	});

	it('never returns an empty component', () => {
		expect(sanitizeComponent('!!!')).toBe('Untitled');
		expect(sanitizeComponent('?')).toBe('Untitled');
	});

	it('keeps unicode letters and drops emoji', () => {
		expect(sanitizeComponent('Café')).toBe('Café');
		expect(sanitizeComponent('Meet Gozen 🎬')).toBe('Meet Gozen');
	});
});

describe('sanitizeVaultPath', () => {
	it('fixes the real offenders found in the vault', () => {
		expect(
			sanitizeVaultPath(
				'Articles/YouTube/WunderTech/UGREEN HomeAgent First Impression: More Than Just a NAS?.md',
			),
		).toBe(
			'Articles/YouTube/WunderTech/UGREEN HomeAgent First Impression More Than Just a NAS.md',
		);
		expect(
			sanitizeVaultPath('Articles/Culture/These startups have a plan to end Shein’s.md'),
		).toBe('Articles/Culture/These startups have a plan to end Sheins.md');
	});

	it('preserves the .md suffix and directory names', () => {
		expect(sanitizeVaultPath('Projects/Caldera')).toBe('Projects/Caldera.md');
		expect(sanitizeVaultPath('/People/Friends/Matt.md')).toBe('People/Friends/Matt.md');
		expect(sanitizeVaultPath('.obsidian/plugins/x.md')).toBe('.obsidian/plugins/x.md');
	});

	it('strips punctuation from directories too, keeping their leading dot', () => {
		expect(sanitizeVaultPath('Projects/Game-Dev/Orade.Engine/Roadmap.md')).toBe(
			'Projects/Game-Dev/OradeEngine/Roadmap.md',
		);
		expect(sanitizeVaultPath('.obsidian/plugins/my.plugin/x.md')).toBe(
			'.obsidian/plugins/myplugin/x.md',
		);
	});

	it('is idempotent and leaves clean paths byte-identical', () => {
		const clean = 'Articles/YouTube/WunderTech/UGREEN HomeAgent First Impression.md';
		expect(sanitizeVaultPath(clean)).toBe(clean);
		expect(isCleanVaultPath(clean)).toBe(true);

		const once = sanitizeVaultPath('A: B?.md');
		expect(sanitizeVaultPath(once)).toBe(once);
	});

	it('never rewrites a traversal attempt into something legitimate', () => {
		expect(sanitizeVaultPath('../../etc/passwd.md')).toBe('../../etc/passwd.md');
		expect(isCleanVaultPath('../escape.md')).toBe(false);
	});
});
