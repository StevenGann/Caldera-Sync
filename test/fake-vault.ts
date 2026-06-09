import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import type { SyncEngine } from '../src/sync/engine';

// An in-memory stand-in for the slice of Obsidian's App/Vault the SyncEngine
// uses. Mutations emit the same vault events Obsidian fires, so wiring them to
// the engine (as main.ts does) exercises the real echo-suppression loop: when
// the engine writes a remote change, the resulting 'create'/'modify' event flows
// back into the engine and must be recognised as its own echo.

type Listener = (...args: unknown[]) => void;

export class FakeApp {
	private files = new Map<string, string>();
	private folders = new Set<string>();
	private listeners: Record<string, Listener[]> = {
		create: [],
		modify: [],
		delete: [],
		rename: [],
	};

	private tfile(path: string): TFile {
		const f = new TFile();
		f.path = path;
		f.name = path.split('/').pop() ?? path;
		return f;
	}

	private emit(name: string, ...args: unknown[]): void {
		for (const cb of this.listeners[name] ?? []) cb(...args);
	}

	// ── The Obsidian-shaped surface the engine calls ──────────────────
	vault = {
		getMarkdownFiles: (): TFile[] =>
			[...this.files.keys()].filter((p) => p.endsWith('.md')).map((p) => this.tfile(p)),
		getAbstractFileByPath: (path: string): TFile | TFolder | null => {
			if (this.files.has(path)) return this.tfile(path);
			if (this.folders.has(path)) {
				const f = new TFolder();
				f.path = path;
				return f;
			}
			return null;
		},
		read: async (file: TFile): Promise<string> => this.files.get(file.path) ?? '',
		modify: async (file: TFile, content: string): Promise<void> => {
			this.files.set(file.path, content);
			this.emit('modify', this.tfile(file.path));
		},
		create: async (path: string, content: string): Promise<TFile> => {
			this.files.set(path, content);
			const f = this.tfile(path);
			this.emit('create', f);
			return f;
		},
		createFolder: async (path: string): Promise<void> => {
			this.folders.add(path);
		},
		on: (name: string, cb: Listener): { name: string; cb: Listener } => {
			this.listeners[name]?.push(cb);
			return { name, cb };
		},
	};

	fileManager = {
		trashFile: async (file: TFile): Promise<void> => {
			this.files.delete(file.path);
			this.emit('delete', this.tfile(file.path));
		},
	};

	// ── Test-side helpers (simulate the user editing in Obsidian) ──────
	/** A pre-existing file, present before the engine starts (no event). */
	seed(path: string, content: string): void {
		this.files.set(path, content);
	}
	putLocal(path: string, content: string): void {
		const isNew = !this.files.has(path);
		this.files.set(path, content);
		this.emit(isNew ? 'create' : 'modify', this.tfile(path));
	}
	deleteLocal(path: string): void {
		this.files.delete(path);
		this.emit('delete', this.tfile(path));
	}
	renameLocal(oldPath: string, newPath: string): void {
		const content = this.files.get(oldPath) ?? '';
		this.files.delete(oldPath);
		this.files.set(newPath, content);
		this.emit('rename', this.tfile(newPath), oldPath);
	}
	getContent(path: string): string | undefined {
		return this.files.get(path);
	}
	has(path: string): boolean {
		return this.files.has(path);
	}
	paths(): string[] {
		return [...this.files.keys()];
	}

	asApp(): App {
		return this as unknown as App;
	}
}

/** Wire the fake vault's events to the engine exactly as main.ts does. */
export function wire(fake: FakeApp, engine: SyncEngine): void {
	fake.vault.on('create', (f) => engine.queueLocalUpsert((f as TFile).path));
	fake.vault.on('modify', (f) => engine.queueLocalUpsert((f as TFile).path));
	fake.vault.on('delete', (f) => engine.handleLocalDelete((f as TFile).path));
	fake.vault.on('rename', (f, old) =>
		engine.handleLocalRename(old as string, (f as TFile).path),
	);
}
