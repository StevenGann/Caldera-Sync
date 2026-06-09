// Checksum helper that must byte-for-byte match Caldera's:
//   "sha256:" + sha256(raw.encode("utf-8")).hexdigest()
// Web Crypto is available in both Electron (desktop) and Capacitor (mobile).

export async function checksum(content: string): Promise<string> {
	const bytes = new TextEncoder().encode(content);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `sha256:${hex}`;
}
