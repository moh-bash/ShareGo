/**
 * ShareGo signaling server.
 *
 * Scope, deliberately narrow:
 *   - keep a presence list of devices,
 *   - relay connection requests / accept / reject,
 *   - relay SDP offers/answers and ICE candidates between two named devices.
 *
 * It NEVER sees a single file byte. That is the whole point: files go straight
 * device-to-device over WebRTC, and this process only introduces the two peers
 * and then steps aside. It stores nothing to disk and keeps no history.
 *
 * Run: `npm run signal`  (listens on 0.0.0.0:8080 by default)
 */

import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

import { parseClientSignalMessage } from "../src/lib/websocket/protocol";
import {
  CONNECTION_REQUEST_TIMEOUT_MS,
  SIGNAL_PROTOCOL_VERSION,
  type DeviceInfo,
  type DeviceType,
  type ServerSignalMessage,
  type SignalErrorCode,
} from "../src/types/signaling";

const PORT = readInt(process.env.SIGNALING_PORT, 8080);
const HOST = process.env.SIGNALING_HOST ?? "0.0.0.0";
/** Per-socket message rate limit, to stop a runaway client flooding peers. */
const RATE_LIMIT_MAX_MESSAGES = 240;
const RATE_LIMIT_WINDOW_MS = 10_000;
/** Upper bound on simultaneous sockets, a cheap DoS guard. */
const MAX_CONNECTIONS = 128;

interface Session {
  socket: WebSocket;
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
  /** Messages sent to this session, used for per-socket rate limiting. */
  sentCount: number;
  windowStartedAt: number;
}

/** deviceId -> session. Order is insertion order, so listings are stable. */
const sessions = new Map<string, Session>();

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function readInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

function deviceInfo(session: Session): DeviceInfo {
  return {
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    deviceType: session.deviceType,
  };
}

function listDevices(exceptId?: string): DeviceInfo[] {
  const devices: DeviceInfo[] = [];
  for (const [id, session] of sessions) {
    if (id === exceptId) continue;
    devices.push(deviceInfo(session));
  }
  return devices;
}

/**
 * Send one message. Returns false when the socket is gone, so relay code can
 * clean up the sender as well.
 */
function send(session: Session, message: ServerSignalMessage): boolean {
  if (session.socket.readyState !== session.socket.OPEN) return false;

  if (
    session.sentCount >= RATE_LIMIT_MAX_MESSAGES &&
    Date.now() - session.windowStartedAt < RATE_LIMIT_WINDOW_MS
  ) {
    return true; // Silently drop rather than amplify.
  }
  if (Date.now() - session.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    session.sentCount = 0;
    session.windowStartedAt = Date.now();
  }

  session.sentCount += 1;
  session.socket.send(JSON.stringify(message));
  return true;
}

/**
 * Each device gets the roster *without itself*, so clients never have to guess
 * which entry is "me" — the server's `welcome.deviceId` is the only identity.
 */
function broadcastDevices(): void {
  for (const session of sessions.values()) {
    send(session, { type: "devices", devices: listDevices(session.deviceId) });
  }
}

function sendError(
  sender: Session,
  code: SignalErrorCode,
  message = "That request could not be completed.",
  requestId?: string,
): void {
  const payload: ServerSignalMessage = requestId
    ? { type: "error", code, message, requestId }
    : { type: "error", code, message };
  send(sender, payload);
}

/* ------------------------------------------------------------------ */
/* Connection handling                                                 */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  // Reject oversized frames outright: signaling payloads are tiny.
  maxPayload: 256 * 1024,
});

wss.on("connection", (socket: WebSocket) => {
  if (sessions.size >= MAX_CONNECTIONS) {
    socket.close(1013, "server busy");
    return;
  }

  let session: Session | null = null;

  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    const raw = typeof data === "string" ? data : data.toString();

    const message = parseClientSignalMessage(raw);
    if (!message) {
      if (session) sendError(session, "bad-message", "That message was not valid.");
      return;
    }

    if (!session) {
      if (message.type !== "hello") {
        socket.close(1008, "hello required");
        return;
      }
      session = createSession(socket, message.deviceName, message.deviceType);
      return;
    }

    handleMessage(session, message);
  });

  socket.on("close", () => {
    if (session) removeSession(session, "closed");
  });

  socket.on("error", () => {
    if (session) removeSession(session, "error");
  });
});

function createSession(socket: WebSocket, deviceName: string, deviceType: DeviceType): Session {
  const session: Session = {
    socket,
    // Ids are minted here, never accepted from the client, so a device cannot
    // impersonate another one on the same signaling server.
    deviceId: randomUUID(),
    deviceName,
    deviceType,
    sentCount: 0,
    windowStartedAt: Date.now(),
  };
  sessions.set(session.deviceId, session);

  send(session, {
    type: "welcome",
    protocol: SIGNAL_PROTOCOL_VERSION,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    devices: listDevices(session.deviceId),
    config: { connectionRequestTimeoutMs: CONNECTION_REQUEST_TIMEOUT_MS },
  });

  broadcastDevices();
  log(`+ ${session.deviceName} (${session.deviceType}) joined — ${sessions.size} online`);

  return session;
}

function removeSession(session: Session, reason: string): void {
  if (!sessions.has(session.deviceId)) return;
  sessions.delete(session.deviceId);

  // Tell everyone two things: the roster changed, and this peer is gone.
  for (const peer of sessions.values()) {
    send(peer, { type: "device-left", deviceId: session.deviceId });
    send(peer, { type: "peer-disconnected", from: session.deviceId });
  }

  log(`- ${session.deviceName} left (${reason}) — ${sessions.size} online`);
  log(`  remaining: ${listDevices().map((device) => device.deviceName).join(", ") || "none"}`);
}

/* ------------------------------------------------------------------ */
/* Message routing                                                     */
/* ------------------------------------------------------------------ */

function handleMessage(sender: Session, message: ReturnType<typeof parseClientSignalMessage>): void {
  if (!message) return;

  switch (message.type) {
    case "ping":
      send(sender, { type: "pong", at: message.at });
      return;

    case "rename": {
      sender.deviceName = message.deviceName;
      broadcastDevices();
      return;
    }

    case "connection-request": {
      if (message.to === sender.deviceId) {
        sendError(sender, "self-target", "You cannot connect to yourself.", message.requestId);
        return;
      }
      const target = sessions.get(message.to);
      if (!target) {
        sendError(
          sender,
          "unknown-device",
          "That device is no longer on this network.",
          message.requestId,
        );
        return;
      }
      send(target, {
        type: "connection-request",
        from: deviceInfo(sender),
        requestId: message.requestId,
        expiresAt: Date.now() + CONNECTION_REQUEST_TIMEOUT_MS,
      });
      return;
    }

    case "connection-response": {
      const target = sessions.get(message.to);
      if (!target) return;
      send(target, {
        type: "connection-response",
        from: deviceInfo(sender),
        requestId: message.requestId,
        accepted: message.accepted,
      });
      return;
    }

    case "offer": {
      const target = sessions.get(message.to);
      if (!target) return;
      send(target, { type: "offer", from: deviceInfo(sender), description: message.description });
      return;
    }

    case "answer": {
      const target = sessions.get(message.to);
      if (!target) return;
      send(target, { type: "answer", from: deviceInfo(sender), description: message.description });
      return;
    }

    case "ice-candidate": {
      const target = sessions.get(message.to);
      if (!target) return;
      send(target, {
        type: "ice-candidate",
        from: deviceInfo(sender),
        candidate: message.candidate,
      });
      return;
    }

    case "disconnect-peer": {
      const target = sessions.get(message.to);
      if (!target) return;
      send(target, { type: "peer-disconnected", from: sender.deviceId });
      return;
    }

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      addresses.push(entry.address);
    }
  }
  return addresses;
}

function log(line: string): void {
  console.log(`[sharego-signal] ${line}`);
}

wss.on("listening", () => {
  const lan = lanAddresses();
  log("signaling server ready");
  log(`  local:   ws://localhost:${PORT}`);
  for (const address of lan) {
    log(`  network: ws://${address}:${PORT}   <- open this on your phone`);
  }
  log("no file data passes through this process; it only introduces peers.");
});

wss.on("error", (error) => {
  console.error(`[sharego-signal] ${error.message}`);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("shutting down");
    for (const session of sessions.values()) {
      session.socket.close(1001, "server shutting down");
    }
    wss.close(() => process.exit(0));
  });
}
