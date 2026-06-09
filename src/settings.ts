import { App, PluginSettingTab, Setting } from 'obsidian';
import type CalderaSyncPlugin from './main';

export type Transport = 'sse' | 'poll';
export type ConflictStrategy = 'conflict-copy' | 'prefer-remote' | 'prefer-local';

export interface CalderaSyncSettings {
	/** Base URL of the Caldera server, e.g. http://localhost:8000 (no trailing slash). */
	serverUrl: string;
	/** Bearer API key (one of CALDERA_API_KEYS on the server). */
	apiKey: string;
	/** Only mirror notes under this vault-relative folder. Empty = whole vault. */
	folder: string;
	/** Whether sync is active. */
	enabled: boolean;
	/** Live transport: SSE stream (desktop) or polling (works everywhere). */
	transport: Transport;
	/** Poll interval in ms when transport === 'poll' (or SSE fallback). */
	pollIntervalMs: number;
	/** Debounce in ms before pushing a local edit upstream. */
	pushDebounceMs: number;
	/** What to do when local and remote both changed since the last sync. */
	conflictStrategy: ConflictStrategy;
}

export const DEFAULT_SETTINGS: CalderaSyncSettings = {
	serverUrl: '',
	apiKey: '',
	folder: '',
	enabled: false,
	transport: 'sse',
	pollIntervalMs: 3000,
	pushDebounceMs: 1200,
	conflictStrategy: 'conflict-copy',
};

export class CalderaSyncSettingTab extends PluginSettingTab {
	plugin: CalderaSyncPlugin;

	constructor(app: App, plugin: CalderaSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Inline validation for the server URL: require an http/https scheme, and warn
	 * when a non-localhost http:// origin is paired with an API key (the Bearer
	 * token would travel in cleartext). Empty string = nothing to flag yet.
	 */
	private serverUrlWarning(): string {
		const raw = this.plugin.settings.serverUrl.trim();
		if (!raw) return '';
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			return 'Invalid URL. Use a full http:// or https:// address.';
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return 'Server URL must use http:// or https://.';
		}
		const host = url.hostname;
		const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
		if (url.protocol === 'http:' && !isLocal && this.plugin.settings.apiKey) {
			return 'Warning: over plain http:// your API key is sent in cleartext. Use https:// for remote servers.';
		}
		return '';
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Enable sync')
			.setDesc('Mirror this vault with the Caldera server.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
					this.plugin.settings.enabled = v;
					await this.plugin.saveSettings();
					await this.plugin.restartSync();
				}),
			);

		const urlSetting = new Setting(containerEl)
			.setName('Server URL')
			.setDesc('Base URL of the Caldera server, with no trailing slash.');
		const urlWarning = containerEl.createEl('div', { cls: 'caldera-sync-warning' });
		const refreshUrlWarning = () => {
			urlWarning.setText(this.serverUrlWarning());
		};
		refreshUrlWarning();
		urlSetting.addText((t) =>
			t
				.setPlaceholder('http://localhost:8000')
				.setValue(this.plugin.settings.serverUrl)
				.onChange(async (v) => {
					this.plugin.settings.serverUrl = v.replace(/\/+$/, '');
					await this.plugin.saveSettings();
					refreshUrlWarning();
				}),
		);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('A Bearer key configured in the server’s CALDERA_API_KEYS.')
			.addText((t) => {
				t.setPlaceholder('Paste key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (v) => {
						this.plugin.settings.apiKey = v.trim();
						await this.plugin.saveSettings();
						refreshUrlWarning();
					});
				t.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Folder')
			.setDesc('Only sync notes under this folder. Leave empty to sync the whole vault.')
			.addText((t) =>
				t
					.setPlaceholder('(Whole vault)')
					.setValue(this.plugin.settings.folder)
					.onChange(async (v) => {
						this.plugin.settings.folder = v.replace(/^\/+|\/+$/g, '');
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Live transport')
			.setDesc('SSE streams changes instantly (desktop). Polling works everywhere, including mobile.')
			.addDropdown((d) =>
				d
					.addOption('sse', 'SSE (real-time)')
					.addOption('poll', 'Polling')
					.setValue(this.plugin.settings.transport)
					.onChange(async (v) => {
						this.plugin.settings.transport = v as Transport;
						await this.plugin.saveSettings();
						await this.plugin.restartSync();
					}),
			);

		new Setting(containerEl)
			.setName('Poll interval (ms)')
			.setDesc('How often to poll for changes when using polling.')
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.pollIntervalMs))
					.onChange(async (v) => {
						const n = Number(v);
						if (Number.isFinite(n) && n >= 500) {
							this.plugin.settings.pollIntervalMs = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName('Conflict handling')
			.setDesc('When a note changed on both sides since the last sync.')
			.addDropdown((d) =>
				d
					.addOption('conflict-copy', 'Keep both (conflict copy)')
					.addOption('prefer-remote', 'Prefer server')
					.addOption('prefer-local', 'Prefer local')
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (v) => {
						this.plugin.settings.conflictStrategy = v as ConflictStrategy;
						await this.plugin.saveSettings();
					}),
			);
	}
}
