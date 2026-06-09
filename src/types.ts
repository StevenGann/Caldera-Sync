// Shared types mirroring Caldera's real-time sync API (see docs/REALTIME_SYNC.md
// in the Caldera repo). Checksums are the literal `sha256:<hex>` strings Caldera
// emits; the plugin computes them identically over the raw file bytes.

export type ChangeType = 'upsert' | 'delete' | 'resync';
export type Origin = 'api' | 'external';

export interface ChangeEvent {
	seq: number;
	ts: string;
	type: ChangeType;
	path: string | null;
	checksum: string | null;
	origin: Origin;
}

export interface ManifestEntry {
	path: string;
	checksum: string;
}

export interface Manifest {
	head: number;
	notes: ManifestEntry[];
}

export interface ChangesResponse {
	head: number;
	floor: number;
	resync: boolean;
	events: ChangeEvent[];
}

/** A note fetched from Caldera as raw markdown plus its server checksum. */
export interface RawNote {
	content: string;
	checksum: string;
}

export type SyncStatusKind =
	| 'disabled'
	| 'connecting'
	| 'reconciling'
	| 'live'
	| 'polling'
	| 'error';

export interface SyncStatusInfo {
	kind: SyncStatusKind;
	detail?: string;
}
