import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

import { parseClientSignalMessage } from "../src/lib/websocket/protocol";
import {
  CONNECTION_REQUEST_TIMEOUT_MS,
  SIGNAL_PROTOCOL_VERSION,
  type DeviceInfo,
  type DeviceType,
  type ServerSignalMessage,
  type SignalErrorCode,
} from "../src/types/signaling";

const MAX_FRAME_SIZE = 256 * 1024;
const RATE_LIMIT_MAX_MESSAGES = 240;
const RATE_LIMIT_WINDOW_MS = 10_000;
const SESSION_TTL_SECONDS = 45;
const POLL_INTERVAL_MS = 250;
const KEY_PREFIX = "sharego:signal:v1";

interface StoredSession {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
}

interface Session extends StoredSession {
  socket: WebSocket;
  sentCount: number;
  windowStartedAt: number;
  lastDevicesSignature: string;
}

interface Envelope {
  kind: "message";
  message: ServerSignalMessage;
}

const redis = Redis.fromEnv();
const httpServer = createServer((_request, response) => {
  response.writeHead(426, { "content-type": "text/plain" });
  response.end("This endpoint requires a WebSocket connection.");
});
const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_FRAME_SIZE });

function sessionKey(deviceId: string): string {
  return `${KEY_PREFIX}:session:${deviceId}`;
}

function mailboxKey(deviceId: string): string {
  return `${KEY_PREFIX}:mailbox:${deviceId}`;
}

function rosterKey(): string {
  return `${KEY_PREFIX}:roster`;
}

function deviceInfo(session: StoredSession): DeviceInfo {
  return {
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    deviceType: session.deviceType,
  };
}

async function getRoster(exceptId?: string): Promise<DeviceInfo[]> {
  const ids = await redis.smembers<string[]>(rosterKey());
  if (ids.length === 0) return [];

  const entries = await redis.mget<(string | null)[]>(
    ...ids.map((id) => sessionKey(id)),
  );
  const devices: DeviceInfo[] = [];
  const staleIds: string[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const raw = entries[index];
    if (!raw) {
      staleIds.push(ids[index]);
      continue;
    }
    const stored = typeof raw === "string" ? JSON.parse(raw) as StoredSession : raw;
    if (stored.deviceId !== exceptId) devices.push(deviceInfo(stored));
  }
  if (staleIds.length > 0) await redis.srem(rosterKey(), ...staleIds);
  return devices;
}

async function send(session: Session, message: ServerSignalMessage): Promise<boolean> {
  if (session.socket.readyState !== session.socket.OPEN) return false;
  const now = Date.now();
  if (now - session.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    session.sentCount = 0;
    session.windowStartedAt = now;
  }
  if (session.sentCount >= RATE_LIMIT_MAX_MESSAGES) return true;
  session.sentCount += 1;
  session.socket.send(JSON.stringify(message));
  return true;
}

async function sendError(
  session: Session,
  code: SignalErrorCode,
  message = "That request could not be completed.",
  requestId?: string,
): Promise<void> {
  await send(
    session,
    requestId
      ? { type: "error", code, message, requestId }
      : { type: "error", code, message },
  );
}

async function enqueue(deviceId: string, envelope: Envelope): Promise<void> {
  await redis.rpush(mailboxKey(deviceId), envelope);
  await redis.expire(mailboxKey(deviceId), SESSION_TTL_SECONDS);
}

async function relay(sender: Session, targetId: string, message: ServerSignalMessage): Promise<void> {
  if (targetId === sender.deviceId) {
    await sendError(sender, "self-target", "You cannot connect to yourself.");
    return;
  }
  const target = await redis.get<StoredSession>(sessionKey(targetId));
  if (!target) {
    await sendError(sender, "unknown-device", "That device is no longer on this network.");
    return;
  }
  await enqueue(targetId, { kind: "message", message });
}

async function handleMessage(session: Session, message: NonNullable<ReturnType<typeof parseClientSignalMessage>>): Promise<void> {
  await redis.expire(sessionKey(session.deviceId), SESSION_TTL_SECONDS);

  switch (message.type) {
    case "ping":
      await send(session, { type: "pong", at: message.at });
      return;
    case "rename":
      session.deviceName = message.deviceName;
      await redis.set(sessionKey(session.deviceId), {
        deviceId: session.deviceId,
        deviceName: session.deviceName,
        deviceType: session.deviceType,
      }, { ex: SESSION_TTL_SECONDS });
      return;
    case "connection-request":
      await relay(session, message.to, {
        type: "connection-request",
        from: deviceInfo(session),
        requestId: message.requestId,
        expiresAt: Date.now() + CONNECTION_REQUEST_TIMEOUT_MS,
      });
      return;
    case "connection-response":
      await relay(session, message.to, {
        type: "connection-response",
        from: deviceInfo(session),
        requestId: message.requestId,
        accepted: message.accepted,
      });
      return;
    case "offer":
      await relay(session, message.to, {
        type: "offer",
        from: deviceInfo(session),
        description: message.description,
      });
      return;
    case "answer":
      await relay(session, message.to, {
        type: "answer",
        from: deviceInfo(session),
        description: message.description,
      });
      return;
    case "ice-candidate":
      await relay(session, message.to, {
        type: "ice-candidate",
        from: deviceInfo(session),
        candidate: message.candidate,
      });
      return;
    case "disconnect-peer":
      await relay(session, message.to, {
        type: "peer-disconnected",
        from: session.deviceId,
      });
      return;
    default:
      return;
  }
}

async function poll(session: Session): Promise<void> {
  if (session.socket.readyState !== session.socket.OPEN) return;

  const rawMessages = await redis.lrange<Envelope>(mailboxKey(session.deviceId), 0, -1);
  if (rawMessages.length > 0) {
    await redis.del(mailboxKey(session.deviceId));
    for (const envelope of rawMessages) {
      await send(session, envelope.message);
    }
  }

  const devices = await getRoster(session.deviceId);
  const signature = JSON.stringify(devices);
  if (signature !== session.lastDevicesSignature) {
    session.lastDevicesSignature = signature;
    await send(session, { type: "devices", devices });
  }
}

async function cleanup(session: Session): Promise<void> {
  await redis.del(sessionKey(session.deviceId));
  await redis.srem(rosterKey(), session.deviceId);
  await redis.del(mailboxKey(session.deviceId));
  await enqueueBroadcast({ type: "device-left", deviceId: session.deviceId });
  await enqueueBroadcast({ type: "peer-disconnected", from: session.deviceId });
}

async function enqueueBroadcast(message: ServerSignalMessage): Promise<void> {
  const ids = await redis.smembers<string[]>(rosterKey());
  await Promise.all(ids.map((id) => enqueue(id, { kind: "message", message })));
}

function rawToString(data: RawData): string {
  return typeof data === "string" ? data : data.toString();
}

wss.on("connection", (socket) => {
  let session: Session | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closing = false;

  const closeSession = async (reason: string): Promise<void> => {
    if (!session || closing) return;
    closing = true;
    if (pollTimer) clearInterval(pollTimer);
    await cleanup(session);
    console.info(`[sharego-signal] session ${session.deviceId} closed: ${reason}`);
  };

  socket.on("message", async (data, isBinary) => {
    if (isBinary) return;
    const message = parseClientSignalMessage(rawToString(data));
    if (!message) {
      if (session) await sendError(session, "bad-message", "That message was not valid.");
      return;
    }
    if (!session) {
      if (message.type !== "hello") {
        socket.close(1008, "hello required");
        return;
      }
      const deviceId = randomUUID();
      session = {
        deviceId,
        deviceName: message.deviceName,
        deviceType: message.deviceType,
        socket,
        sentCount: 0,
        windowStartedAt: Date.now(),
        lastDevicesSignature: "",
      };
      await redis.set(sessionKey(deviceId), {
        deviceId,
        deviceName: message.deviceName,
        deviceType: message.deviceType,
      }, { ex: SESSION_TTL_SECONDS });
      await redis.sadd(rosterKey(), deviceId);
      await send(session, {
        type: "welcome",
        protocol: SIGNAL_PROTOCOL_VERSION,
        deviceId,
        deviceName: message.deviceName,
        devices: await getRoster(deviceId),
        config: { connectionRequestTimeoutMs: CONNECTION_REQUEST_TIMEOUT_MS },
      });
      pollTimer = setInterval(() => {
        void poll(session!).catch((error: unknown) => {
          console.error("[sharego-signal] poll failed", error);
          socket.close(1011, "signaling error");
        });
      }, POLL_INTERVAL_MS);
      return;
    }
    await handleMessage(session, message);
  });
  socket.on("close", () => void closeSession("closed"));
  socket.on("error", () => void closeSession("error"));
});

export default httpServer;
