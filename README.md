# ShareGo

ShareGo is a browser-based local file-sharing application. Devices discover each
other through a signaling endpoint built into the app, then transfer file
metadata and bytes directly over WebRTC DataChannels whenever the network allows
it.

Nothing is uploaded, stored or proxied: the signaling endpoint only introduces
two devices to each other and steps aside. File bytes go straight from one
browser to the other.

![ShareGo Logo](https://github.com/moh-bash/ShareGo/blob/main/public/cover.webp?raw=true)

## 📦 Tech Stack

| Technology | Purpose |
| --- | --- |
| [Next.js 16](https://nextjs.org/) | Full-stack React framework and application routing |
| [React 19](https://react.dev/) | Client-side user interface |
| [TypeScript](https://www.typescriptlang.org/) | Type-safe application and server code |
| [Tailwind CSS 4](https://tailwindcss.com/) | UI styling and responsive layouts |
| WebRTC DataChannels | Direct peer-to-peer file and control-data transfers |
| Server-Sent Events (SSE) | Signaling stream between browsers and the app |
| [Upstash Redis](https://upstash.com/) | Optional shared signaling state for multi-instance deployments |
| ESLint | Static analysis and React Compiler checks |

## 📋 Requirements

- Node.js 20 or newer
- A modern browser with WebRTC DataChannel support
- Network access between the browsers
- Optionally an Upstash Redis database, but only for multi-instance deployments

## 🚀 Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000` in one or more browser windows. There is no second
process to start: the signaling endpoint is a route in the app itself
(`/api/signal`), so every window on the same origin sees every other window.

For two physical devices on the same Wi-Fi:

1. Start ShareGo with `npm run dev` on the development computer.
2. Open the computer's LAN address on the second device, e.g.
   `http://192.168.1.20:3000`. Use the LAN address, not `localhost` — the
   browser must be able to reach the machine.
3. Add files explicitly with the file picker on one device.
4. From the other device, send a connection request and accept it on the first.
5. Browse the shared metadata, preview supported media, or download files.

The browser sandbox means ShareGo can only access files the user explicitly
selects. It cannot enumerate `C:\`, `Users`, Downloads or other folders without a
file-picker action.

## 📋 Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development server (app + signaling route) |
| `npm run build` | Create a production build |
| `npm run start` | Start the production Next.js server |
| `npm run typecheck` | Type-check the whole repository |
| `npm run lint` | Run ESLint (includes the React Compiler rules) |

There is no test suite or test runner.

The recommended verification order is:

```bash
npm run typecheck
npm run lint
npm run build
```

## 📁 Project Structure

```text
.
├── public/                 # Public images and static assets
├── src/
│   ├── app/                # Next.js App Router pages and /api/signal route
│   ├── components/         # React UI components
│   ├── hooks/              # React hooks for subscribing to application state
│   ├── lib/
│   │   ├── file-transfer/  # File metadata, chunking, transfers, and previews
│   │   ├── signaling/      # SSE client, hub, and signaling protocol
│   │   ├── webrtc/         # Peer connections, sessions, and WebRTC protocol
│   │   ├── app-store.ts    # Shared application stores
│   │   └── engine.ts       # ShareGo application engine
│   └── types/              # Shared TypeScript types
├── .env.example            # Optional environment variable reference
├── CONTRIBUTING.md         # Contributor workflow and verification guide
├── next.config.ts          # Next.js configuration
├── package.json            # Scripts and dependencies
└── README.md               # Project documentation
```

The browser UI is mounted by the App Router, while the framework-agnostic
engine in `src/lib/` owns signaling, peer connections, shared files, transfers,
and notifications. React components consume engine snapshots through hooks;
file bytes never pass through the signaling route.

## Environment variables

Everything is optional; see `.env.example` for the full list. The two that
matter:

| Variable | Why |
| --- | --- |
| `NEXT_PUBLIC_SIGNALING_URL` | Point the app at a signaling origin other than the one serving the page. A bare origin is enough — `/api/signal` is appended. Also editable at runtime in **Settings**, where it is persisted in `localStorage`. |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Shared presence and relay bus. Required only when the deployment runs more than one instance; without them the app still works but devices landing on different instances cannot find each other, and the activity log says so. |

`NEXT_PUBLIC_*` values are embedded at build time, so restart `next dev` after
changing one.

## How the connection works

1. Each browser opens `GET /api/signal`, a `text/event-stream`, passing the
   session token it was last handed. The server answers with `welcome`
   immediately — no handshake round trip.
2. The server broadcasts the current device roster. Each device's roster omits
   itself, so nobody has to guess which entry is "me".
3. A user sends a connection request; the recipient must explicitly accept it.
   Nothing is negotiated before that, not even an SDP offer.
4. The requesting browser creates the WebRTC offer. Peers exchange offers,
   answers and ICE candidates by `POST`ing one message each to `/api/signal`,
   which relays it to the target device's stream.
5. Two reliable DataChannels (`sharego-control` and `sharego-file`) carry
   control messages and chunked file frames.
6. Only explicitly selected files are eligible to be requested by a peer.

### Why an event stream instead of a WebSocket

A WebSocket needs a process that stays alive and holds the socket, which a
serverless platform will eventually stop. The event stream is just a long HTTP
response, so it degrades in the least harmful way available: when the platform
ends it, the browser reconnects and — because the URL carries the session token
minted in `welcome` — comes back with the *same* deviceId. Established
peer-to-peer connections are not touched by a signaling blip at all.

`deviceId` is still minted by the server. A client can hold its own session
token, but it can never claim to be another device, and the `from` field on
every relayed message is stamped server-side.

Transfers use bounded chunks and DataChannel backpressure. Downloads are
assembled into a Blob and saved by the browser. Image, audio and video previews
use a progressive MediaSource path where supported, with a complete Blob
fallback where it is not.

## Browser and network limitations

- The browser sandbox requires explicit file selection.
- DataChannels are not HTTP streams and do not provide native Range requests.
- Some video containers can only start after the entire file arrives, especially
  when the container index sits at the end of the file (MP4s written without
  `+faststart`).
- Very large previews may require substantial browser memory.
- WebRTC may fail across restrictive NATs or firewalls. The default STUN
  configuration helps discover routes, but production deployments may also need a
  TURN relay configured through `NEXT_PUBLIC_ICE_SERVERS`.
- Signaling presence is not Wi-Fi scanning; it only includes browsers connected
  to the same signaling endpoint.

## Manual verification checklist

For detailed contributor guidance and a complete manual verification flow, see
[CONTRIBUTING.md](./CONTRIBUTING.md).

Two windows on one machine work (ICE host candidates are used), and two physical
devices are the real test:

- Both devices appear and disappear from **Nearby devices** as they connect and
  disconnect.
- Connection request, explicit accept, reject, timeout and disconnect states.
- WebRTC reaches **Connected** before file actions are enabled.
- Image, video, audio and document metadata appears remotely.
- Small and large chunked downloads show progress and speed.
- Preview transfers pull bytes from the remote peer and release object URLs when
  closed.
- Adding or removing a shared file refreshes the remote file list.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
development setup, repository conventions, verification commands, manual
WebRTC checks, and pull request guidance.