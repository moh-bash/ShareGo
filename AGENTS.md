<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## What this is

ShareGo moves files between devices on the same network. The browser app is a thin
client: a WebSocket server only introduces peers, and **all file bytes travel
directly over WebRTC DataChannels**. Nothing is uploaded, stored, or persisted.

## Commands

- `npm run dev:all` — the only command you usually want: runs the signaling server
  and `next dev` together with prefixed output (`scripts/dev-all.mjs`).
- `npm run signal` — signaling server only (`tsx signaling/server.ts`, port 8080,
  prints both `localhost` and LAN URLs on boot).
- `npm run dev` / `build` / `start` — plain Next.js.
- `npm run typecheck` — `tsc --noEmit`. Covers `signaling/` too (tsconfig includes
  `**/*.ts`).
- `npm run lint` — bare `eslint` over the whole repo. There is **no** `next lint`,
  and `next lint --dir` does not exist in this version.

Verification order that matters: `npm run typecheck && npm run lint && npm run build`.
There is **no test suite and no test runner** — don't invent a `npm test` script
expectation. End-to-end behaviour is verified manually with two browser windows
(see below).

## Layout

- `src/lib/` — framework-agnostic core, no React imports. `engine.ts` is the app
  singleton; `webrtc/` owns connections; `file-transfer/` owns bytes.
- `src/components/`, `src/hooks/` — the only React layer.
- `signaling/server.ts` — standalone Node `ws` server, run via `tsx`, reuses the
  browser's validator from `src/lib/websocket/protocol.ts` so both sides agree.
- `src/app/` — App Router. The whole page is client-side; `layout.tsx` owns
  metadata/fonts and mounts the provider.

## Architecture rules that are easy to break

- **One engine per tab.** `ShareGoProvider` creates it with
  `useState(() => new ShareGoEngine())` and disposes it on unmount. Do not move it
  to a module singleton or a ref — sockets and peer connections would outlive the
  page. All state changes go through the stores; UI reads them via
  `useSyncExternalStore` hooks in `src/hooks/use-share-go.ts`.
- **Never trust a peer-supplied string.** Control messages are parsed and length
  limited in `src/lib/webrtc/protocol.ts`; `category` in particular is recomputed
  locally rather than accepted. Keep validation at the wire boundary, not in
  components.
- **`SharedFileMetaLite` is a subset of `SharedFileMeta`** — never include the
  `File` handle on the wire.
- **Object URLs are owned by `ArtifactStore`** and must be released
  (`releaseArtifact`) when a preview closes. Leaks are silent and only show up
  after many previews.
- **`file-list` / `files-changed` are handled in `PeerManager`, not
  `TransferEngine`** — per-peer UI state lives in the manager; the engine only
  handles byte-moving messages. `TransferEngine.requestFileList()` exists for the
  `files-changed` re-request.
- **Downloads auto-save on completion** inside `TransferEngine.onComplete`, but
  only when `purpose === "download"`. Previews must never save to the user's disk.

## Environment

- `.env.example` documents every variable; **all are optional**. `NEXT_PUBLIC_*`
  values are inlined at build time, so changing one needs a dev-server restart.
- **`.env.example` is gitignored** by the `.env*` rule in `.gitignore`. It exists
  locally but will not be committed until that rule is negated (`!.env.example`).
  Fix that before relying on it for onboarding anyone else.
- The browser derives the signaling URL from `window.location` (port 8080 unless
  the page is on 3000/3001), so LAN testing usually needs no config. A user-typed
  URL in Settings overrides it and persists in `localStorage`
  (`src/lib/config.ts`).
- **Second-device testing is the main stumbling block**: the phone must dial the
  dev machine's LAN address, not `localhost`. The signaling server prints the exact
  URLs at startup.

## Manual end-to-end check

Two windows, same machine: window A adds files → window B sends a connection
request → A accepts → B sees A's files without asking → download/preview → verify
progress and the settings activity log. Two tabs in one browser work because ICE
host candidates are used.

## Style rules the linter enforces here

`npm run lint` runs the React Compiler rules, so these are errors, not warnings:

- No `setState` synchronously inside an effect (`react-hooks/set-state-in-effect`).
  Start side effects in the effect and *derive* what you render from a store — see
  the artifact lookup in `file-preview-dialog.tsx` and the shared clock in
  `src/hooks/use-timing.ts`. `useMounted()` is `useSyncExternalStore`-based, not
  `useState` + `useEffect`.
- No impure reads during render (`Date.now()`); use `useNow()`.
- For "reset state when a prop changes", unmount the child (render `null` when
  closed, e.g. `SettingsSheet`) so its `useState` initializer re-runs, instead of
  syncing with an effect.

## Environment gotcha (this machine)

If `next build` fails with `Turbopack is not supported on this platform … Only
WebAssembly (WASM) bindings were loaded`, the native
`node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node` is
**truncated**, not a platform problem. Fix by removing the directory and
reinstalling it (`npm cache verify` first); the file must be ~106 MB. It then
reports ~13 MB and every load fails with "not a valid Win32 application".

## Known gaps

- `README.md` is still the create-next-app boilerplate and does **not** describe
  this app — trust this file and the code instead.
- `npm run lint`, `npm run typecheck` and `npm run build` pass; the two-peer
  WebRTC flow has not been exercised by an automated test.