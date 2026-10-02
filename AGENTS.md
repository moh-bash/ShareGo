<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## What this is

ShareGo moves files between devices on the same network. The browser app is a thin
client: the signaling endpoint only introduces peers, and **all file bytes travel
directly over WebRTC DataChannels**. Nothing is uploaded, stored, or persisted.

## Commands

- `npm run dev` / `build` / `start` — plain Next.js. There is no second process:
  signaling is a route inside the app.
- `npm run typecheck` — `tsc --noEmit` over the whole repo.
- `npm run lint` — bare `eslint` over the whole repo. There is **no** `next lint`,
  and `next lint --dir` does not exist in this version.

Verification order that matters: `npm run typecheck && npm run lint && npm run build`.
There is **no test suite and no test runner** — don't invent a `npm test` script
expectation. End-to-end behaviour is verified manually with two browser windows
(see below).

## Layout

- `src/lib/` — framework-agnostic core, no React imports. `engine.ts` is the app
  singleton; `signaling/` owns peer introduction; `webrtc/` owns connections;
  `file-transfer/` owns bytes.
- `src/app/api/signal/route.ts` — the signaling endpoint: `GET` is a
  `text/event-stream`, `POST` carries one client message upstream.
- `src/lib/signaling/hub.ts` — roster + relay, shared by every instance that
  hosts a stream.
- `src/components/`, `src/hooks/` — the only React layer.
- `src/app/` — App Router. The whole page is client-side; `layout.tsx` owns
  metadata/fonts and mounts the provider.

## The signaling transport

`GET /api/signal?session=…&name=…&type=…` holds an event stream open;
`POST /api/signal` sends `{ session, message }` upstream. This replaced a
WebSocket server because a long-lived socket does not survive a serverless
platform in any predictable way, whereas a bounded HTTP response degrades into a
reconnect that *resumes* the same `deviceId` (the session token in the URL is
minted by the server in `welcome`).

Consequences worth knowing before you touch it:

- **Identity is server-minted.** `deviceId` is never accepted from a client; the
  session token is a bearer secret stored in `localStorage`, per endpoint, by
  `src/lib/config.ts`. `from` on every relayed message is stamped server-side.
- **A signaling blip does not tear down peers.** `SignalingClient.onReset` fires
  only when a `welcome` carries a *different* `deviceId`; established
  DataChannels are unaffected by a dropped stream.
- **`MemoryDirectory` vs `RedisDirectory`.** Without `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN` the hub keeps state in the process, which is right
  for `next dev` and wrong for a multi-instance deployment. The client is told
  via `welcome.config.sharedDirectory` and warns the user. Do not make this
  failure mode silent.
- Deadlines cross the wire as **durations**, never absolute timestamps: two
  devices rarely share a wall clock.

## Architecture rules that are easy to break

- **One engine per tab.** `ShareGoProvider` creates it with
  `useState(() => new ShareGoEngine())` and disposes it on unmount. Do not move it
  to a module singleton or a ref — streams and peer connections would outlive the
  page. All state changes go through the stores; UI reads them via
  `useSyncExternalStore` hooks in `src/hooks/use-share-go.ts`.
- **The hub is a `globalThis` singleton**, deliberately: `next dev`'s hot reload
  would otherwise leave a second roster behind and two windows could stop seeing
  each other after an edit.
- **Never trust a peer-supplied string.** Control messages are parsed and length
  limited in `src/lib/webrtc/protocol.ts`; `category` in particular is recomputed
  locally rather than accepted. Signaling messages are parsed in *both*
  directions by `src/lib/signaling/protocol.ts`, shared with the route handler so
  both sides agree. Keep validation at the wire boundary, not in components.
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
- `.env.example` **is** committed (the `.gitignore` negates `.env*`).
- The browser defaults the signaling endpoint to its own origin
  (`/api/signal`), so LAN testing usually needs no config. A user-typed URL in
  Settings overrides it and persists in `localStorage`
  (`src/lib/config.ts`); "Use default" clears it.
- **Second-device testing is the main stumbling block**: the phone must dial the
  dev machine's LAN address, not `localhost` — e.g. `http://192.168.1.20:3000`.

## Manual end-to-end check

Two windows, same machine: window A adds files → window B sends a connection
request → A accepts → B sees A's files without asking → download/preview → verify
progress and the settings activity log. Two tabs in one browser work because ICE
host candidates are used.

The signaling endpoint can also be exercised without a browser: open the event
stream with `curl -N` and post a message with `curl -X POST`.

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
- **Anything a component passes into an effect's dependency array must be
  stable.** A function literal recreated per render retriggers the effect on
  every store update — which is how a preview ended up requesting its file in a
  loop.

## Environment gotcha (this machine)

If `next build` fails with `Turbopack is not supported on this platform … Only
WebAssembly (WASM) bindings were loaded`, the native
`node_modules/@next/swc-win32-x64-msvc/next-swc.win32-x64-msvc.node` is
**truncated**, not a platform problem. Fix by removing the directory and
reinstalling it (`npm cache verify` first); the file must be ~106 MB. It then
reports ~13 MB and every load fails with "not a valid Win32 application".

## Known gaps

- `npm run lint`, `npm run typecheck` and `npm run build` pass; the two-peer
  WebRTC flow has not been exercised by an automated test.
- `RedisDirectory` is the one path with no automated coverage and no credentials
  available locally. Its logic is deliberately thin, but treat changes to it as
  unverified until a deployment with `UPSTASH_REDIS_*` set has been exercised.