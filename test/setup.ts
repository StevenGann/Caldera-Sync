// Obsidian runs in Electron (desktop) and Capacitor (mobile), where `window` is
// the global object — so the plugin uses `window.setTimeout` (as the obsidianmd
// lint rules require). Under Node there is no `window`; alias it to globalThis so
// the same code runs unchanged in tests.
const g = globalThis as unknown as { window?: typeof globalThis };
g.window ??= globalThis;
