/**
 * Cross-platform filename policy — the client half of `caldera/core/paths.py`.
 *
 * The vault is mirrored between Obsidian clients (Windows, macOS, Linux) and a
 * Caldera server. Windows and macOS reject or mangle characters Linux accepts,
 * so a note created with ":" or "?" syncs perfectly server-side and then breaks
 * the client checkout — and the server's own health signals still say "clean".
 *
 * Rather than enumerate what each platform forbids, one allowlist rule governs
 * both ends:
 *
 *   a path component may contain only letters, digits, whitespace, "-" and "_".
 *
 * Everything else is removed, not replaced. Hyphen and underscore survive
 * because they join words — stripping them turns "fast-fashion" into
 * "fastfashion". Directories keep a leading "." so `.obsidian` is never
 * renamed out from under Obsidian.
 *
 * This module must stay in lockstep with the server implementation. If you
 * change one, change the other and re-run both test suites.
 */

const ALLOWED_PUNCTUATION = '-_';
const FALLBACK_STEM = 'Untitled';

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/;

/**
 * Strip punctuation from a single path component (no "/" inside).
 *
 * Whitespace collapses to single spaces and is trimmed, so removing a
 * character can never leave a double space behind.
 */
export function sanitizeComponent(name: string, keepLeadingDot = false): string {
	let lead = '';
	let body = name;
	if (keepLeadingDot && body.startsWith('.')) {
		lead = '.';
		body = body.replace(/^\.+/, '');
	}

	let kept = '';
	for (const ch of body) {
		if (LETTER_OR_NUMBER.test(ch) || WHITESPACE.test(ch) || ALLOWED_PUNCTUATION.includes(ch)) {
			kept += ch;
		}
	}

	const cleaned = kept.replace(/\s+/g, ' ').trim();
	if (!cleaned) return lead || FALLBACK_STEM;
	return lead + cleaned;
}

/**
 * Return `path` with punctuation removed from every component.
 *
 * The trailing `.md` is preserved, and a clean input is returned unchanged, so
 * callers can detect a rewrite with a plain string comparison. A path
 * containing ".." is returned untouched — never rewrite a traversal attempt
 * into something that looks legitimate.
 */
export function sanitizeVaultPath(path: string): string {
	let rel = path.normalize('NFC').replace(/^\/+/, '');
	if (!rel) return path;
	if (!rel.endsWith('.md')) rel += '.md';

	const parts = rel.split('/');
	if (parts.includes('..')) return path;

	const lastIndex = parts.length - 1;
	return parts
		.map((part, index) =>
			index === lastIndex
				? sanitizeComponent(part.replace(/\.md$/, '')) + '.md'
				: sanitizeComponent(part, true),
		)
		.join('/');
}

/** True when `path` already satisfies the policy and is safely scoped. */
export function isCleanVaultPath(path: string): boolean {
	if (path.split('/').includes('..')) return false;
	return sanitizeVaultPath(path) === path;
}
