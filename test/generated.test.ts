import { describe, expect, it } from 'vitest';
import {
	isGeneratedOnlyDifference,
	mergeGenerated,
	stripGenerated,
} from '../src/sync/generated';

const hub = (entries: string[], body = 'Hand-written intro.') =>
	`---\ntags: hub\n---\n# Authors\n\n${body}\n\n%% Begin Waypoint %%\n${entries.join('\n')}\n\n%% End Waypoint %%\n\nFooter.\n`;

describe('stripGenerated', () => {
	it('is the identity when there is no generated block', () => {
		const text = '# Plain\n\nNo waypoint here.\n';
		expect(stripGenerated(text)).toBe(text);
	});

	it('removes one block', () => {
		expect(stripGenerated('a\n%% Begin Waypoint %%\n- [[x]]\n%% End Waypoint %%\nb\n')).toBe('a\n\nb\n');
	});

	it('removes two blocks, non-greedily (text between them survives)', () => {
		const text =
			'a\n%% Begin Waypoint %%\n- [[x]]\n%% End Waypoint %%\nmiddle\n%% Begin Waypoint %%\n- [[y]]\n%% End Waypoint %%\nb\n';
		expect(stripGenerated(text)).toBe('a\n\nmiddle\n\nb\n');
	});

	it('normalises CRLF before matching', () => {
		const text = 'a\r\n%% Begin Waypoint %%\r\n- [[x]]\r\n%% End Waypoint %%\r\nb\r\n';
		expect(stripGenerated(text)).toBe('a\n\nb\n');
	});

	it('handles a block at end of file', () => {
		expect(stripGenerated('a\n%% Begin Waypoint %%\n- [[x]]\n%% End Waypoint %%')).toBe('a\n');
	});

	it('treats a bare %% Waypoint %% marker as generated to EOF', () => {
		expect(stripGenerated('a\nb\n%% Waypoint %%\n- [[x]]\n- [[y]]\n')).toBe('a\nb\n');
	});
});

describe('isGeneratedOnlyDifference', () => {
	it('is false when text without a block differs', () => {
		expect(isGeneratedOnlyDifference('# A\n', '# B\n')).toBe(false);
	});

	it('is true when text without a block is equal', () => {
		expect(isGeneratedOnlyDifference('# A\n', '# A\n')).toBe(true);
	});

	it('is true when only the block differs', () => {
		expect(isGeneratedOnlyDifference(hub(['- [[A]]']), hub(['- [[A]]', '- [[B]]']))).toBe(true);
	});

	it('is false when the hand-written body differs too', () => {
		expect(
			isGeneratedOnlyDifference(hub(['- [[A]]']), hub(['- [[A]]', '- [[B]]'], 'Edited intro.')),
		).toBe(false);
	});

	it('ignores per-line trailing whitespace, the trailing newline and CRLF', () => {
		const lf = hub(['- [[A]]']);
		const crlf = hub(['- [[B]]']).replace(/\n/g, '\r\n');
		expect(isGeneratedOnlyDifference(lf, crlf)).toBe(true);
		expect(isGeneratedOnlyDifference('a  \nb\n', 'a\nb')).toBe(true);
	});

	it('handles a block at end of file and two blocks', () => {
		expect(
			isGeneratedOnlyDifference(
				'x\n%% Begin Waypoint %%\n- [[A]]\n%% End Waypoint %%\ny\n%% Begin Waypoint %%\n%% End Waypoint %%',
				'x\n%% Begin Waypoint %%\n- [[B]]\n%% End Waypoint %%\ny\n%% Begin Waypoint %%\n- [[C]]\n%% End Waypoint %%',
			),
		).toBe(true);
	});
});

describe('mergeGenerated', () => {
	it('takes a remote-only entry', () => {
		const local = hub(['- [[A]]']);
		const remote = hub(['- [[A]]', '- [[B]]']);
		expect(mergeGenerated(local, remote)).toBe(remote);
	});

	it('keeps a local-only entry, after the remote entries', () => {
		const local = hub(['- [[A]]', '- [[L]]']);
		const remote = hub(['- [[A]]']);
		expect(mergeGenerated(local, remote)).toBe(hub(['- [[A]]', '- [[L]]']));
	});

	it('unions both sides: remote order first, then local-only in local order', () => {
		const local = hub(['- [[L2]]', '- [[A]]', '- [[L1]]']);
		const remote = hub(['- [[R]]', '- [[A]]']);
		expect(mergeGenerated(local, remote)).toBe(hub(['- [[R]]', '- [[A]]', '- [[L2]]', '- [[L1]]']));
	});

	it('returns the remote unchanged when only the order differs', () => {
		const local = hub(['- [[B]]', '- [[A]]']);
		const remote = hub(['- [[A]]', '- [[B]]']);
		expect(mergeGenerated(local, remote)).toBe(remote);
	});

	it('places nested indented bullets under their parent', () => {
		const local = hub(['- **[[Sub]]**', '\t- [[Sub/X]]', '\t- [[Sub/Local]]', '- [[Z]]']);
		const remote = hub(['- **[[Sub]]**', '\t- [[Sub/X]]', '- [[Z]]', '- [[Remote]]']);
		expect(mergeGenerated(local, remote)).toBe(
			hub(['- **[[Sub]]**', '\t- [[Sub/X]]', '\t- [[Sub/Local]]', '- [[Z]]', '- [[Remote]]']),
		);
	});

	it('takes the remote text outside the block', () => {
		const local = hub(['- [[A]]', '- [[L]]'], 'Old intro.');
		const remote = hub(['- [[A]]'], 'New intro.');
		expect(mergeGenerated(local, remote)).toBe(hub(['- [[A]]', '- [[L]]'], 'New intro.'));
	});

	it('keeps non-bullet lines from the remote, in place', () => {
		const local = '%% Begin Waypoint %%\nlocal note\n- [[A]]\n- [[L]]\n%% End Waypoint %%\n';
		const remote = '%% Begin Waypoint %%\nremote note\n- [[A]]\n%% End Waypoint %%\n';
		expect(mergeGenerated(local, remote)).toBe(
			'%% Begin Waypoint %%\nremote note\n- [[A]]\n- [[L]]\n%% End Waypoint %%\n',
		);
	});

	it('merges each of two blocks independently', () => {
		const local = 'x\n%% Begin Waypoint %%\n- [[A]]\n%% End Waypoint %%\ny\n%% Begin Waypoint %%\n- [[C]]\n%% End Waypoint %%\n';
		const remote = 'x\n%% Begin Waypoint %%\n- [[B]]\n%% End Waypoint %%\ny\n%% Begin Waypoint %%\n- [[C]]\n%% End Waypoint %%\n';
		expect(mergeGenerated(local, remote)).toBe(
			'x\n%% Begin Waypoint %%\n- [[B]]\n- [[A]]\n%% End Waypoint %%\ny\n%% Begin Waypoint %%\n- [[C]]\n%% End Waypoint %%\n',
		);
	});

	it('merges a bare %% Waypoint %% region to EOF', () => {
		expect(mergeGenerated('a\n%% Waypoint %%\n- [[L]]\n', 'a\n%% Waypoint %%\n- [[R]]\n')).toBe(
			'a\n%% Waypoint %%\n- [[R]]\n- [[L]]\n',
		);
	});

	it('preserves CRLF line endings of the remote', () => {
		const local = hub(['- [[A]]', '- [[L]]']).replace(/\n/g, '\r\n');
		const remote = hub(['- [[A]]']).replace(/\n/g, '\r\n');
		expect(mergeGenerated(local, remote)).toBe(hub(['- [[A]]', '- [[L]]']).replace(/\n/g, '\r\n'));
	});

	it('is idempotent: mergeGenerated(x, x) === x', () => {
		for (const x of [
			hub(['- [[A]]', '\t- [[A/B]]']),
			'# no block\n',
			'a\r\n%% Begin Waypoint %%\r\n- [[x]]\r\n%% End Waypoint %%\r\n',
			'a\n%% Waypoint %%\n- [[x]]',
		]) {
			expect(mergeGenerated(x, x)).toBe(x);
		}
	});

	it('is stable: merging the merged result again changes nothing', () => {
		const local = hub(['- [[L]]', '- [[A]]']);
		const remote = hub(['- [[A]]', '- [[R]]']);
		const merged = mergeGenerated(local, remote);
		expect(mergeGenerated(local, merged)).toBe(merged);
		expect(mergeGenerated(merged, merged)).toBe(merged);
	});
});
