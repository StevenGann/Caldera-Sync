# Caldera Sync

An Obsidian plugin that mirrors your vault with a [Caldera](https://github.com/StevenGann/Caldera)
server **in real time** over Caldera's REST API. Edits in Obsidian flow to
Caldera (and on to its GitHub backup); changes an AI agent makes through Caldera
flow back into Obsidian the instant they happen.

Because Obsidian stays in charge of its own files, you can keep using **Obsidian
Sync**, iCloud, or any other sync for the vault itself — Caldera Sync only keeps
Obsidian and the Caldera server in step with each other.

## How it works

```
   Obsidian  ⇄  Caldera Sync (this plugin)  ⇄  Caldera server  ⇄  GitHub
      ⇅                                              ⇅
 Obsidian Sync / iCloud / …                      AI agents
```

- **Local → server.** When you create, edit, rename, or delete a note, the
  plugin pushes it to Caldera. Updates and deletes carry an `If-Match`
  precondition (optimistic concurrency) so a stale write is rejected and
  resolved as a conflict; the first create of a new note is sent without one.
- **Server → local.** The plugin subscribes to Caldera's change stream
  (`GET /api/v1/events`, Server-Sent Events) and applies upserts/deletes as they
  arrive. On mobile, or if you prefer, it polls `GET /api/v1/changes` instead.
- **Echo suppression.** Every change carries a `sha256` checksum. A change whose
  checksum already matches what we have is recognised as our own echo and
  skipped, so edits don't ping-pong.
- **Conflicts.** If a note changed on both sides since the last sync, the plugin
  resolves it per your setting — by default it keeps your version as a
  `… (conflict <timestamp>).md` copy and adopts the server's version.

See [`docs/REALTIME_SYNC.md`](https://github.com/StevenGann/Caldera/blob/main/docs/REALTIME_SYNC.md)
in the Caldera repo for the server-side contract.

## Requirements

- A running Caldera server reachable from your device, with an API key
  (`CALDERA_API_KEYS`).
- Obsidian 1.6.6 or newer.

## Setup

1. Install the plugin (see **Manual install** below) and enable it in
   **Settings → Community plugins**.
2. Open **Settings → Caldera Sync** and set:
   - **Server URL** — e.g. `http://localhost:8000` (no trailing slash).
   - **API key** — one of the server's `CALDERA_API_KEYS`.
   - **Folder** — optional; restrict syncing to one folder. Leave empty for the
     whole vault. Paths are preserved, so the server mirrors the same structure.
   - **Live transport** — *SSE* for instant updates (desktop), or *Polling*
     (works everywhere, including mobile).
   - **Conflict handling** — keep both (default), prefer server, or prefer local.
3. Toggle **Enable sync** on. The status bar shows the connection state — one of
   `Caldera: off`, `Caldera: connecting…`, `Caldera: reconciling…`,
   `Caldera: live`, `Caldera: polling`, or `Caldera: error`.

On first run the plugin reconciles the whole vault against the server (pulling,
pushing, or flagging conflicts per note), then switches to the live feed.

You can re-run that reconcile at any time with the **Caldera Sync: Sync now**
command (open the command palette and search for "Sync now"); it's a handy way
to force a full resync after being offline.

## Scope and limitations

- **Markdown only.** Caldera indexes `*.md`; attachments (images, PDFs, etc.)
  are not synced.
- **Whole-file fidelity.** Notes are sent verbatim (frontmatter included) so the
  checksum matches the server byte-for-byte and the sync loop settles. The
  plugin never reformats your notes.
- **One server per vault.** The plugin mirrors against a single Caldera server.

## Privacy

- **What's sent.** The full contents of every in-scope note — including
  frontmatter — and its vault-relative path are sent to the Caldera server you
  configure, which in turn stores them and backs them up to GitHub. If you set a
  **Folder**, only notes under that folder leave your device.
- **Where it goes.** Only to the **Server URL** you enter. The server URL and
  API key are entirely user-supplied; the plugin contacts no other host and
  sends no analytics or telemetry of any kind.
- **Transport.** Over a plain `http://` server (other than localhost) the Bearer
  API key travels in cleartext — the settings tab warns about this. Use
  `https://` for any remote server.

## Development

```bash
npm install
npm run dev          # watch build → main.js
npm run build        # type-check + production bundle
npm run lint
npm test             # run the vitest integration suite once
npm run test:watch   # re-run tests on change
```

The vitest suite under [`test/`](test/) drives the real client, SSE stream, and
sync engine (with an in-memory vault) end to end against a live Caldera server.
The integration tests are skipped unless a server is configured via the
`CALDERA_URL` (and `CALDERA_KEY`) environment variables, so `npm test` is safe
to run in a build-only checkout.

Source layout:

```
src/
  main.ts          plugin lifecycle, vault-event wiring, status bar
  settings.ts      settings interface + settings tab
  types.ts         shared types mirroring Caldera's API
  api/client.ts    REST calls (manifest, raw get/put, delete)
  api/events.ts    SSE stream + polling fallback
  sync/engine.ts   bidirectional reconcile, echo suppression, conflicts
  sync/state.ts    persisted per-note baseline checksums + stream cursor
  util/hash.ts     sha256 matching Caldera's checksum format
```

## Manual install

Copy `main.js`, `manifest.json`, and `styles.css` into
`<Vault>/.obsidian/plugins/caldera-sync/`, then reload Obsidian and enable the
plugin under **Settings → Community plugins**.

## License

Released under the [BSD Zero Clause License](LICENSE) (`0BSD`).
Copyright (c) 2025 Steven Gann.
