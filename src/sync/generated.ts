// Generated-region awareness for folder-index plugins (Waypoint).
//
// Waypoint rewrites the `%% Begin Waypoint %% … %% End Waypoint %%` block of a
// folder note whenever the folder's contents change. Two machines running it
// independently produce different blocks for the same hub note, which the sync
// engine would otherwise treat as a two-sided edit and resolve with a conflict
// copy — whose creation makes Waypoint regenerate the hub again, ad infinitum.
//
// These helpers let the engine recognise "only the generated block differs"
// and merge the blocks instead of declaring a conflict.

/**
 * One generated region: a full `%% Begin Waypoint %% … %% End Waypoint %%`
 * block, or a bare `%% Waypoint %%` marker, which claims everything to EOF.
 */
const REGION = /%% Begin Waypoint %%([\s\S]*?)%% End Waypoint %%|%% Waypoint %%([\s\S]*)$/g;

interface Region {
	/** Offset of the region's first character (the opening marker). */
	start: number;
	/** Offset just past the region (after the closing marker, or EOF). */
	end: number;
	/** Text between the markers. */
	inner: string;
	/** Offset of `inner` within the document. */
	innerStart: number;
}

function normalizeEol(content: string): string {
	return content.replace(/\r\n/g, '\n');
}

function findRegions(content: string): Region[] {
	const regions: Region[] = [];
	for (const m of content.matchAll(REGION)) {
		const start = m.index;
		const bounded = m[1] !== undefined;
		const inner = bounded ? (m[1] as string) : (m[2] ?? '');
		const openLen = bounded ? '%% Begin Waypoint %%'.length : '%% Waypoint %%'.length;
		regions.push({
			start,
			end: start + m[0].length,
			inner,
			innerStart: start + openLen,
		});
	}
	return regions;
}

/** Canonical form for comparison: per-line trailing whitespace and the trailing newline ignored. */
function canonical(content: string): string {
	return content
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/\n+$/, '');
}

/**
 * Remove every generated region (markers included). CRLF is normalised to LF
 * first; content without a generated region is otherwise returned unchanged.
 */
export function stripGenerated(content: string): string {
	return normalizeEol(content).replace(REGION, '');
}

/**
 * True when `local` and `remote` differ only inside generated regions.
 *
 * Text outside the regions is compared ignoring per-line trailing whitespace
 * and the trailing newline, so any difference in hand-written text — with or
 * without a generated region present — returns false.
 */
export function isGeneratedOnlyDifference(local: string, remote: string): boolean {
	return canonical(stripGenerated(local)) === canonical(stripGenerated(remote));
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s/;

function bulletIndent(line: string): number | null {
	const m = BULLET.exec(line);
	return m ? (m[1] as string).length : null;
}

/** Index just past the last bullet line, or past the last non-blank line if there are none. */
function insertionPoint(lines: string[]): number {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (bulletIndent(lines[i] as string) !== null) return i + 1;
	}
	for (let i = lines.length - 1; i >= 1; i--) {
		if ((lines[i] as string).trim() !== '') return i + 1;
	}
	return Math.min(1, lines.length);
}

/**
 * Union the bullet lines of two region bodies. Remote lines stay as they are,
 * in place; local-only bullets follow in their local order. A local-only
 * nested bullet whose parent is present is placed at the end of that parent's
 * children rather than at the end of the list, so the tree shape survives.
 */
function mergeRegionBody(localInner: string, remoteInner: string): string {
	const out = remoteInner.split('\n');
	// A one-line body ("%% Begin Waypoint %%%% End Waypoint %%") has no room
	// for an inserted line between the markers; open it up.
	if (out.length === 1) out.push('');
	const seen = new Set(out);
	const local = localInner.split('\n');

	for (let li = 0; li < local.length; li++) {
		const line = local[li] as string;
		const indent = bulletIndent(line);
		if (indent === null || seen.has(line)) continue;
		seen.add(line);

		// Nearest preceding, less-indented bullet in the local list = parent.
		let parentIdx = -1;
		for (let p = li - 1; p >= 0; p--) {
			const pIndent = bulletIndent(local[p] as string);
			if (pIndent !== null && pIndent < indent) {
				parentIdx = out.indexOf(local[p] as string);
				break;
			}
		}

		let at: number;
		if (parentIdx >= 0) {
			const parentIndent = bulletIndent(out[parentIdx] as string) ?? 0;
			at = parentIdx + 1;
			while (at < out.length) {
				const i = bulletIndent(out[at] as string);
				if (i === null || i <= parentIndent) break;
				at++;
			}
		} else {
			at = insertionPoint(out);
		}
		out.splice(at, 0, line);
	}
	return out.join('\n');
}

/**
 * Merge two copies of a note that carry generated regions.
 *
 * Outside every generated region the remote text wins. Inside, the result is
 * the union of both sides' bullet lines (remote order first, then local-only
 * lines in local order, exact duplicates dropped); non-bullet lines come from
 * the remote. Regions are paired by position. When every paired region is
 * already equal the remote text is returned unchanged.
 */
export function mergeGenerated(local: string, remote: string): string {
	const l = normalizeEol(local);
	const r = normalizeEol(remote);
	const lRegions = findRegions(l);
	const rRegions = findRegions(r);

	let changed = false;
	let result = '';
	let cursor = 0;
	rRegions.forEach((region, i) => {
		const other = lRegions[i];
		let inner = region.inner;
		if (other && other.inner !== region.inner) {
			inner = mergeRegionBody(other.inner, region.inner);
			if (inner !== region.inner) changed = true;
		}
		result += r.slice(cursor, region.innerStart) + inner;
		cursor = region.innerStart + region.inner.length;
	});
	if (!changed) return remote;
	result += r.slice(cursor);
	// Keep the remote's line endings.
	return remote.includes('\r\n') ? result.replace(/\n/g, '\r\n') : result;
}
