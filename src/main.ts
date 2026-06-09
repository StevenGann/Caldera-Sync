import { Notice, Plugin, TFile } from 'obsidian';
import {
	CalderaSyncSettings,
	CalderaSyncSettingTab,
	DEFAULT_SETTINGS,
} from './settings';
import { CalderaClient } from './api/client';
import { SyncEngine } from './sync/engine';
import { SyncState, type PersistedState } from './sync/state';
import type { SyncStatusInfo } from './types';

interface PluginData {
	settings: CalderaSyncSettings;
	sync?: PersistedState;
}

const STATUS_LABEL: Record<SyncStatusInfo['kind'], string> = {
	disabled: 'Caldera: off',
	connecting: 'Caldera: connecting…',
	reconciling: 'Caldera: reconciling…',
	live: 'Caldera: live',
	polling: 'Caldera: polling',
	error: 'Caldera: error',
};

export default class CalderaSyncPlugin extends Plugin {
	settings!: CalderaSyncSettings;
	private state!: SyncState;
	private engine: SyncEngine | null = null;
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadAll();

		this.statusEl = this.addStatusBarItem();
		this.setStatus({ kind: this.settings.enabled ? 'connecting' : 'disabled' });

		this.addSettingTab(new CalderaSyncSettingTab(this.app, this));

		this.addCommand({
			id: 'sync-now',
			name: 'Sync now',
			callback: () => {
				if (!this.engine) {
					new Notice('Caldera Sync is not running. Enable it in settings.');
					return;
				}
				void this.engine
					.syncNow()
					.then(() => new Notice('Caldera Sync: reconciled.'))
					.catch((e) => new Notice(`Caldera Sync failed: ${String(e)}`));
			},
		});

		// Local vault edits → server. Handlers no-op until the engine is running.
		this.registerEvent(
			this.app.vault.on('create', (f) => {
				if (f instanceof TFile) this.engine?.queueLocalUpsert(f.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('modify', (f) => {
				if (f instanceof TFile) this.engine?.queueLocalUpsert(f.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (f) => {
				if (f instanceof TFile) this.engine?.handleLocalDelete(f.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (f, oldPath) => {
				if (f instanceof TFile) this.engine?.handleLocalRename(oldPath, f.path);
			}),
		);

		// Start after the workspace is ready so the initial reconcile doesn't race
		// the vault still loading.
		this.app.workspace.onLayoutReady(() => {
			void this.startSync();
		});
	}

	onunload(): void {
		void this.stopSync();
	}

	// ── Sync lifecycle ────────────────────────────────────────────────
	private async startSync(): Promise<void> {
		if (!this.settings.enabled) {
			this.setStatus({ kind: 'disabled' });
			return;
		}
		if (!this.settings.serverUrl || !this.settings.apiKey) {
			this.setStatus({ kind: 'error', detail: 'set server URL and API key' });
			return;
		}
		const client = new CalderaClient(this.settings);
		this.engine = new SyncEngine(this.app, this.settings, client, this.state, (s) =>
			this.setStatus(s),
		);
		await this.engine.start();
	}

	private async stopSync(): Promise<void> {
		if (this.engine) {
			await this.engine.stop();
			this.engine = null;
		}
	}

	/** Called by the settings tab when a setting that affects sync changes. */
	async restartSync(): Promise<void> {
		await this.stopSync();
		await this.startSync();
	}

	// ── Persistence ───────────────────────────────────────────────────
	private async loadAll(): Promise<void> {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, raw?.settings);
		this.state = new SyncState((s) => this.persist(s));
		this.state.load(raw?.sync);
	}

	private async persist(sync: PersistedState): Promise<void> {
		await this.saveData({ settings: this.settings, sync } satisfies PluginData);
	}

	async saveSettings(): Promise<void> {
		await this.persist(this.state.snapshot());
	}

	// ── Status bar ────────────────────────────────────────────────────
	private setStatus(info: SyncStatusInfo): void {
		if (!this.statusEl) return;
		const label = STATUS_LABEL[info.kind];
		this.statusEl.setText(info.detail ? `${label} (${info.detail})` : label);
	}
}
