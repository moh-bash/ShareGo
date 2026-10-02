# ShareGo

ShareGo is a browser-based local file-sharing application. Devices discover
each other through a small WebSocket signaling server, then transfer file
metadata and bytes directly over WebRTC DataChannels whenever the network
allows it.

The signaling server never receives, stores, or proxies file contents.

## Requirements

- Node.js 20 or newer
- A modern browser with WebRTC DataChannel support
- Network access between the browsers and the signaling server

## Local development

Install dependencies and start the Next.js app plus the signaling server:

```bash
npm install
npm run dev:all
```

Open `http://localhost:3000` in one or more browser windows. The signaling
server listens on port `8080` by default.

For two physical devices on the same Wi-Fi:

1. Start ShareGo on the development computer with `npm run dev:all`.
2. Use the LAN URL printed by the signaling server, not `localhost`, when
   opening the app on the second device.
3. If the app and signaling server are on different hosts, enter the
   reachable WebSocket URL in **Settings**, for example
   `ws://192.168.1.20:8080`.
4. Add files explicitly with the file picker on one device.
5. From the other device, send a connection request and accept it on the first
   device.
6. Browse the shared metadata, preview supported media, or download files.

The browser sandbox means ShareGo can only access files the user explicitly
selects. It cannot enumerate `C:\`, `Users`, Downloads, or other folders
without a file-picker action.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev:all` | Start signaling and Next.js together |
| `npm run dev` | Start only the Next.js development server |
| `npm run signal` | Start only the WebSocket signaling server |
| `npm run typecheck` | Type-check the frontend and signaling server |
| `npm run lint` | Run ESLint |
| `npm run build` | Create a production Next.js build |
| `npm run start` | Start the production Next.js server |

## Configuration

Copy `.env.example` to `.env.local` for local overrides. The important
frontend setting is:

```dotenv
NEXT_PUBLIC_SIGNALING_URL=ws://localhost:8080
```

For a deployed frontend, use the public WebSocket endpoint:

```dotenv
NEXT_PUBLIC_SIGNALING_URL=wss://signaling.example.com
```

`NEXT_PUBLIC_*` values are embedded at build time, so rebuild or restart the
Next.js process after changing them. The server-side settings
`SIGNALING_HOST` and `SIGNALING_PORT` control where the standalone signaling
process listens.

## Deployment

The frontend and signaling server are separate deployments:

1. Deploy the Next.js application to Vercel or another platform that supports
   Next.js.
2. Deploy `npm run signal` to a long-running Node.js service with persistent
   WebSocket support. A normal Vercel request function is not a replacement for
   this process because the roster is held in that process's memory. The
   included [`signaling/Dockerfile`](./signaling/Dockerfile) can be used by
   Docker-based hosts:

   ```bash
   docker build -f signaling/Dockerfile -t sharego-signaling .
   docker run --rm -p 8080:8080 \
     -e SIGNALING_HOST=0.0.0.0 \
     -e SIGNALING_PORT=8080 \
     sharego-signaling
   ```

   If the provider supplies a `PORT` environment variable, the server uses it
   when `SIGNALING_PORT` is not set. Ensure the provider exposes that port and
   keeps the process running.
3. Put the signaling service behind a TLS-capable reverse proxy or the
   provider's managed TLS. Terminate HTTPS/WSS there and proxy WebSocket
   upgrades to the Node process over plain `ws://127.0.0.1:<port>`. The
   signaling process itself is intentionally a plain `ws` server; it does not
   store certificates or file data.
4. Set the Vercel project's build-time environment variable:

   ```dotenv
   NEXT_PUBLIC_SIGNALING_URL=wss://signaling.example.com
   ```

   Replace the hostname with the public WSS hostname configured for the
   signaling service. Redeploy the Vercel project after changing it because
   `NEXT_PUBLIC_*` values are embedded into the client bundle at build time.
   The production browser will not derive a port-8080 socket from the Vercel
   page URL. A previously saved URL in Settings takes precedence, so clear or
   replace that value when testing an existing browser profile.
5. Configure the signaling service's host, port, TLS termination, and network
   firewall according to the hosting provider. Allow WebSocket upgrade requests
   and permit the browser origin used by the frontend at the proxy layer if
   the provider applies origin filtering.

The included signaling server keeps presence in memory only. Restarting it
disconnects all devices and clears the roster.

## How the connection works

1. Each browser opens a WebSocket and announces a display name and device type.
2. The server broadcasts the current online-device roster.
3. A user sends a connection request; the recipient must explicitly accept it.
4. The requesting browser creates the WebRTC offer. The peers exchange the
   offer, answer, and ICE candidates through the signaling server.
5. Two reliable DataChannels carry control messages and chunked file frames.
6. Only explicitly selected files are eligible to be requested by a peer.

Transfers use bounded chunks and DataChannel backpressure. Downloads are
assembled into a Blob and saved by the browser. Image, audio, and video
previews use a progressive MediaSource path where supported, with a complete
Blob fallback where it is not.

## Browser and network limitations

- The browser sandbox requires explicit file selection.
- DataChannels are not HTTP streams and do not provide native Range requests.
- Some video containers can only start after the entire file arrives, especially
  when the container index is at the end of the file.
- Very large previews may require substantial browser memory.
- WebRTC may fail across restrictive NATs or firewalls. The default STUN
  configuration helps discover routes, but production deployments may also
  need a TURN relay configured through `NEXT_PUBLIC_ICE_SERVERS`.
- Signaling presence is not Wi-Fi scanning; it only includes browsers connected
  to the same signaling endpoint.

## Manual verification checklist

Use two browser windows or two physical devices to verify:

- Both devices appear and disappear from **Nearby devices** as sockets connect
  and disconnect.
- Connection request, explicit accept, reject, timeout, and disconnect states.
- WebRTC connection reaches **Connected** before file actions are enabled.
- Image, video, audio, and document metadata appears remotely.
- Small and large chunked downloads show progress and speed.
- Preview transfers retrieve bytes from the remote peer and release object URLs
  when closed.
- Adding or removing a shared file refreshes the remote file list.
