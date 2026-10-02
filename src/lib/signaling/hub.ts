/**
 * Server-side signaling hub.
 *
 * It does exactly what the old standalone WebSocket server did — keep a roster,
 * relay connection requests and SDP/ICE between two named devices — but it is
 * built out of plain HTTP so it can run *inside* a Next.js Route Handler. That
 * matters because it is the only shape that behaves predictably on serverless
 * platforms: a request either arrives at some instance or it does not, and no
 * instance is assumed to keep a socket open forever.
 *
 * Transport
 * ---------
 *   GET  /api/signal?session=…&name=…&type=…   server -> client (text/event-stream)
 *   POST /api/signal                             client -> server (one JSON message)
 *
 * The client opens the stream with the session token it was last handed. The
 * server answers `welcome` immediately, so there is no handshake round trip, and
 * a reconnect with a known token resumes the *same* deviceId. That is why
 * `deviceId` is still server-minted: a client can hold its own session, but it
 * can never claim to be somebody else.
 *
 * State
 * -----
 * `MemoryDirectory` is enough for `next dev` and for a single-instance
 * deployment. `RedisDirectory` (enabled by UPSTASH_REDIS_REST_URL/TOKEN) keeps
 * the roster and the message bus outside the instance, which is what makes this
 * correct when several instances run at once: any instance can accept any
 * request, and a message published by one is delivered by whichever instance is
 * holding the recipient's stream.
 *
 * No file bytes pass through any of this. They go over WebRTC DataChannels.
 */

import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";

import { parseClientSignalMessage, SIGNAL_LIMITS } from "@/lib/signaling/protocol";
import {
  CONNECTION_REQUEST_TIMEOUT_MS,
  SIGNAL_PROTOCOL_VERSION,
  type DeviceInfo,
  type DeviceType,
  type ErrorMessage,
  type ServerSignalMessage,
  type SignalErrorCode,
} from "@/types/signaling";

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Keeps proxies and platforms from dropping an idle stream. */
const HEARTBEAT_MS = 15_000;
/** Memory directory: a roster entry can never outlive the process anyway. */
const MEMORY_SESSION_TTL_MS = 90_000;
/**
 * Redis directory: a session record must outlive a couple of missed heartbeats
 * (the stream refreshes it every 15s) so a reconnect still resumes.
 */
const REDIS_SESSION_TTL_SECONDS = 60;
/** Local guard against one instance being asked to hold too many streams. */
const MAX_LOCAL_STREAMS = 64;
/** Outbound relay budget per device, so one peer cannot amplify to the rest. */
const RATE_LIMIT_MAX_MESSAGES = 240;
const RATE_LIMIT_WINDOW_MS = 10_000;

const REDIS_PREFIX = "sharego:v1";
const REDIS_BUS_CHANNEL = `${REDIS_PREFIX}:bus`;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

interface SessionRecord {
  deviceId: string;
  sessionToken: string;
  deviceName: string;
  deviceType: DeviceType;
  /**
   * Whether a stream for this session is open *right now*.
   *
   * Deliberately not the same thing as "the record exists". The record has to
   * outlive the stream so a reconnect can resume the same `deviceId`, but a
   * record whose stream is gone must not be offered to other devices: it would
   * be visible in the roster, could be sent a connection request, and would
   * swallow it (there is no stream to deliver it to) until the request timed out.
   */
  active: boolean;
  /** Only used by the in-process directory, which has no TTL of its own. */
  updatedAt?: number;
}

/** What actually travels between instances. */
type Envelope =
  | { kind: "message"; to: string | null; from: string; message: ServerSignalMessage }
  | { kind: "roster"; to: null; from: null; devices: DeviceInfo[] };

export interface OpenStreamRequest {
  /** Session token from a previous `welcome`, or `null` for a brand new device. */
  sessionToken: string | null;
  deviceName: string;
  deviceType: DeviceType;
}

export interface SubmitResult {
  ok: boolean;
  /** Present when `ok` is false, shaped so the client can forward it as-is. */
  error?: ErrorMessage;
}

/* ------------------------------------------------------------------ */
/* Directories                                                         */
/* ------------------------------------------------------------------ */

interface SignalDirectory {
  /** False for the in-process directory: other instances cannot see us. */
  readonly shared: boolean;
  open(
    sessionToken: string | null,
    deviceName: string,
    deviceType: DeviceType,
  ): Promise<SessionRecord>;
  /** Upsert + refresh the TTL. Called on open and on every heartbeat. */
  save(record: SessionRecord): Promise<void>;
  load(sessionToken: string): Promise<SessionRecord | null>;
  findByDeviceId(deviceId: string): Promise<SessionRecord | null>;
  drop(sessionToken: string): Promise<SessionRecord | null>;
  list(): Promise<DeviceInfo[]>;
  publish(envelope: Envelope): Promise<void>;
  onDelivery(handler: (envelope: Envelope) => void): () => void;
  /** Called when the first local stream opens / the last one closes. */
  setActive(active: boolean): Promise<void>;
}

/** A stream this instance is holding open, plus its relay budget. */
interface LiveSession {
  readonly record: SessionRecord;
  readonly closed: boolean;
  write(message: ServerSignalMessage): void;
  heartbeat(): void;
  dispose(): void;
  sentCount: number;
  windowStartedAt: number;
}

/* ------------------------------------------------------------------ */
/* SSE framing                                                         */
/* ------------------------------------------------------------------ */

/** `JSON.stringify` never emits a raw newline, so one `data:` line is enough. */
function encodeFrame(message: ServerSignalMessage): string {
  return `data: ${JSON.stringify(message)}\n\n`;
}

function encodeHeartbeat(): string {
  return `event: ping\ndata: {}\n\n`;
}

/* ------------------------------------------------------------------ */
/* Hub                                                                 */
/* ------------------------------------------------------------------ */

export class HubBusyError extends Error {
  constructor() {
    super("Too many signaling streams on this instance.");
    this.name = "HubBusyError";
  }
}

export class SignalingHub {
  private readonly directory: SignalDirectory;
  /** Streams this instance happens to own. Keyed by session token. */
  private readonly streams = new Map<string, LiveSession>();
  private readonly stopDelivery: () => void;

  constructor(directory: SignalDirectory) {
    this.directory = directory;
    this.stopDelivery = directory.onDelivery((envelope) => this.deliver(envelope));
  }

  get shared(): boolean {
    return this.directory.shared;
  }

  get localStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Register (or resume) a device and return the body to hand back to the
   * caller. Everything downstream is driven by `ReadableStream.cancel`, which is
   * the platform's "the client is gone" signal; `signal` is the belt-and-braces
   * path for platforms that surface the disconnect there instead.
   */
  async openStream(
    request: OpenStreamRequest,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    if (this.streams.size >= MAX_LOCAL_STREAMS) {
      throw new HubBusyError();
    }

    const record = await this.directory.open(
      request.sessionToken,
      request.deviceName,
      request.deviceType,
    );

    // A token that reconnects while its old stream is somehow still alive
    // (double tab, half-open connection): the newest stream wins, so a device
    // never receives the same message twice.
    const previous = this.streams.get(record.sessionToken);
    if (previous) previous.dispose();

    const { stream, session } = this.createLocalSession(record);
    this.streams.set(record.sessionToken, session);

    if (signal) {
      const abort = () => {
        session.dispose();
        void this.closeLocal(record.sessionToken, session);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }

    await this.directory.setActive(true);
    // Fresh TTL on every open; the heartbeat keeps it fresh from here on.
    await this.directory.save(record);

    session.write({
      type: "welcome",
      protocol: SIGNAL_PROTOCOL_VERSION,
      deviceId: record.deviceId,
      sessionToken: record.sessionToken,
      deviceName: record.deviceName,
      devices: await this.rosterFor(record.deviceId),
      config: {
        connectionRequestTimeoutMs: CONNECTION_REQUEST_TIMEOUT_MS,
        sharedDirectory: this.directory.shared,
      },
    });

    await this.broadcastRoster();
    return stream;
  }

  /** Client -> server: resolve the session, validate, route. */
  async submit(sessionToken: string, raw: unknown): Promise<SubmitResult> {
    const record = await this.directory.load(sessionToken);
    if (!record) {
      return {
        ok: false,
        error: signalError(
          "unknown-session",
          "This device's signaling session expired. Reload to join again.",
        ),
      };
    }

    const message = parseClientSignalMessage(raw);
    if (!message) {
      return { ok: false, error: signalError("bad-message", "That message was not valid.") };
    }

    await this.route(record, message);
    return { ok: true };
  }

  async dispose(): Promise<void> {
    for (const session of [...this.streams.values()]) {
      session.dispose();
      await this.directory.drop(session.record.sessionToken);
    }
    this.streams.clear();
    this.stopDelivery();
    await this.directory.setActive(false);
  }

  /* ---------------------------------------------------------------- */
  /* Local stream lifecycle                                           */
  /* ---------------------------------------------------------------- */

  private createLocalSession(record: SessionRecord): {
    stream: ReadableStream<Uint8Array>;
    session: LiveSession;
  } {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const writeRaw = (text: string): boolean => {
      if (closed || !controller) return false;
      try {
        controller.enqueue(encoder.encode(text));
        return true;
      } catch {
        // The consumer went away between our check and the write.
        return false;
      }
    };

    const teardown = () => {
      void this.closeLocal(record.sessionToken, session);
    };

    const session: LiveSession = {
      record,
      sentCount: 0,
      windowStartedAt: Date.now(),
      get closed() {
        return closed;
      },
      write(message) {
        const now = Date.now();
        if (now - session.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
          session.sentCount = 0;
          session.windowStartedAt = now;
        }
        if (session.sentCount >= RATE_LIMIT_MAX_MESSAGES) return; // Dropped, not amplified.

        session.sentCount += 1;
        writeRaw(encodeFrame(message));
      },
      heartbeat() {
        writeRaw(encodeHeartbeat());
      },
      dispose() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        // Close the response so the socket is released. Without this a stream
        // that was replaced by a reconnect would stay open, holding a connection
        // and a request slot for as long as the platform allows.
        try {
          controller?.close();
        } catch {
          // Already cancelled or errored by the platform.
        }
        controller = null;
      },
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (streamController) => {
        controller = streamController;
        // A comment frame flushes the headers through proxies that would
        // otherwise sit on an empty body.
        writeRaw(`: sharego signaling v${SIGNAL_PROTOCOL_VERSION}\n\n`);
        heartbeatTimer = setInterval(() => {
          if (session.closed) {
            teardown();
            return;
          }
          session.heartbeat();
          void this.directory.save(record);
        }, HEARTBEAT_MS);
      },
      cancel: () => {
        session.dispose();
        teardown();
      },
    });

    return { stream, session };
  }

  private async closeLocal(sessionToken: string, session: LiveSession): Promise<void> {
    // A stream that was *replaced* (reconnect on the same token) still fires
    // `cancel` when the old response is reaped. Without this identity check that
    // late teardown would dispose the live session and drop the record the new
    // stream is using — which is how one client ends up reconnecting forever,
    // minting a new deviceId each time.
    if (this.streams.get(sessionToken) !== session) return;

    this.streams.delete(sessionToken);
    session.dispose();

    // The directory record is deliberately *not* dropped: it carries the TTL that
    // lets a reconnect resume the same deviceId. It is only marked inactive, so
    // it leaves the roster immediately and stops accepting relayed messages,
    // while a client that reconnects with the token resumes the same identity.
    session.record.active = false;
    await this.directory.save(session.record);

    for (const other of this.streams.values()) {
      other.write({ type: "device-left", deviceId: session.record.deviceId });
      other.write({ type: "peer-disconnected", from: session.record.deviceId });
    }

    await this.broadcastRoster();

    if (this.streams.size === 0) await this.directory.setActive(false);
  }

  /* ---------------------------------------------------------------- */
  /* Roster + routing                                                 */
  /* ---------------------------------------------------------------- */

  private async rosterFor(exceptDeviceId: string | null): Promise<DeviceInfo[]> {
    const devices = await this.directory.list();
    return devices
      .filter((device) => device.deviceId !== exceptDeviceId)
      .slice(0, SIGNAL_LIMITS.maxDevices);
  }

  /** One `list()` + one `publish()` per change, not one per connected device. */
  private async broadcastRoster(): Promise<void> {
    const devices = await this.directory.list();
    await this.directory.publish({ kind: "roster", to: null, from: null, devices });
  }

  /** Hand an envelope to whichever streams happen to live on this instance. */
  private deliver(envelope: Envelope): void {
    for (const session of [...this.streams.values()]) {
      if (session.closed) continue;

      if (envelope.kind === "roster") {
        session.write({
          type: "devices",
          devices: envelope.devices
            .filter((device) => device.deviceId !== session.record.deviceId)
            .slice(0, SIGNAL_LIMITS.maxDevices),
        });
        continue;
      }

      // `to === null` means "everyone except the sender".
      if (envelope.to === null) {
        if (session.record.deviceId === envelope.from) continue;
      } else if (session.record.deviceId !== envelope.to) {
        continue;
      }
      session.write(envelope.message);
    }
  }

  private async route(
    record: SessionRecord,
    message: NonNullable<ReturnType<typeof parseClientSignalMessage>>,
  ): Promise<void> {
    switch (message.type) {
      case "rename": {
        record.deviceName = message.deviceName;
        await this.directory.save(record);
        await this.broadcastRoster();
        return;
      }

      case "connection-request": {
        if (message.to === record.deviceId) {
          this.replyError(
            record,
            "self-target",
            "You cannot connect to yourself.",
            message.requestId,
          );
          return;
        }
        if (!(await this.directory.findByDeviceId(message.to))) {
          this.replyError(
            record,
            "unknown-device",
            "That device is no longer on this network.",
            message.requestId,
          );
          return;
        }
        await this.relay(record, message.to, {
          type: "connection-request",
          from: toDeviceInfo(record),
          requestId: message.requestId,
          // Relative on purpose: the two devices rarely share a wall clock.
          expiresInMs: CONNECTION_REQUEST_TIMEOUT_MS,
        });
        return;
      }

      case "connection-response": {
        if (!(await this.directory.findByDeviceId(message.to))) return;
        await this.relay(record, message.to, {
          type: "connection-response",
          from: toDeviceInfo(record),
          requestId: message.requestId,
          accepted: message.accepted,
        });
        return;
      }

      case "offer":
      case "answer":
      case "ice-candidate": {
        if (!(await this.directory.findByDeviceId(message.to))) return;
        // `from` is stamped here, never taken from the client.
        await this.relay(record, message.to, { ...message, from: toDeviceInfo(record) });
        return;
      }

      case "disconnect-peer": {
        if (!(await this.directory.findByDeviceId(message.to))) return;
        await this.relay(record, message.to, {
          type: "peer-disconnected",
          from: record.deviceId,
        });
        return;
      }

      default:
        return;
    }
  }

  private relay(record: SessionRecord, to: string, message: ServerSignalMessage): Promise<void> {
    return this.directory.publish({ kind: "message", to, from: record.deviceId, message });
  }

  /**
   * Errors go straight to the caller rather than through the bus: there is no
   * guarantee this instance owns the caller's stream.
   */
  private replyError(
    record: SessionRecord,
    code: SignalErrorCode,
    message: string,
    requestId?: string,
  ): void {
    this.streams.get(record.sessionToken)?.write(signalError(code, message, requestId));
  }
}

function toDeviceInfo(record: SessionRecord): DeviceInfo {
  return {
    deviceId: record.deviceId,
    deviceName: record.deviceName,
    deviceType: record.deviceType,
  };
}

function signalError(code: SignalErrorCode, message: string, requestId?: string): ErrorMessage {
  return requestId
    ? { type: "error", code, message, requestId }
    : { type: "error", code, message };
}

/* ------------------------------------------------------------------ */
/* In-process directory                                                */
/* ------------------------------------------------------------------ */

/**
 * Used by `next dev` and by any single-instance deployment. State lives in this
 * module's memory, so it disappears on restart — clients notice, reconnect with
 * their token, and the hub mints them a fresh identity.
 */
class MemoryDirectory implements SignalDirectory {
  readonly shared = false;
  private readonly sessions = new Map<string, SessionRecord>();
  private handler: ((envelope: Envelope) => void) | null = null;

  async open(
    sessionToken: string | null,
    deviceName: string,
    deviceType: DeviceType,
  ): Promise<SessionRecord> {
const existing = sessionToken ? this.sessions.get(sessionToken) : null;
    if (existing) {
      existing.deviceName = deviceName;
      existing.deviceType = deviceType;
      existing.active = true;
      existing.updatedAt = Date.now();
      return existing;
    }

    const record: SessionRecord = {
      deviceId: randomUUID(),
      sessionToken: randomUUID(),
      deviceName,
      deviceType,
      active: true,
      updatedAt: Date.now(),
    };
    this.sessions.set(record.sessionToken, record);
    this.expire();
    return record;
  }

  async save(record: SessionRecord): Promise<void> {
    record.updatedAt = Date.now();
    this.sessions.set(record.sessionToken, record);
    this.expire();
  }

  async load(sessionToken: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionToken) ?? null;
  }

  async findByDeviceId(deviceId: string): Promise<SessionRecord | null> {
    for (const record of this.sessions.values()) {
      if (record.deviceId === deviceId && record.active) return record;
    }
    return null;
  }

  async drop(sessionToken: string): Promise<SessionRecord | null> {
    const record = this.sessions.get(sessionToken);
    if (!record) return null;
    this.sessions.delete(sessionToken);
    return record;
  }

  async list(): Promise<DeviceInfo[]> {
    this.expire();
    return [...this.sessions.values()].filter((record) => record.active).map(toDeviceInfo);
  }

  async publish(envelope: Envelope): Promise<void> {
    this.handler?.(envelope);
  }

  onDelivery(handler: (envelope: Envelope) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  async setActive(): Promise<void> {
    // Nothing to switch on.
  }

  private expire(): void {
    if (this.sessions.size === 0) return;
    const cutoff = Date.now() - MEMORY_SESSION_TTL_MS;
    for (const [token, record] of [...this.sessions]) {
      if ((record.updatedAt ?? 0) < cutoff) this.sessions.delete(token);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared directory (Upstash Redis)                                    */
/* ------------------------------------------------------------------ */

/**
 * Keeps presence and the message bus outside the instance.
 *
 * Each session is one key with a TTL that every heartbeat refreshes, plus a
 * reverse key so a relay can be addressed by `deviceId` from any instance. The
 * roster is that key set, so a session that dies without a clean close (tab
 * killed mid-request, instance recycled) disappears on its own instead of
 * lingering as a device nobody can connect to.
 */
class RedisDirectory implements SignalDirectory {
  readonly shared = true;
  private readonly redis: Redis;
  private handler: ((envelope: Envelope) => void) | null = null;
  private subscription: Subscriber | null = null;
  private pending: Promise<void> | null = null;
  private active = false;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private sessionKey(token: string): string {
    return `${REDIS_PREFIX}:session:${token}`;
  }

  private deviceKey(deviceId: string): string {
    return `${REDIS_PREFIX}:device:${deviceId}`;
  }

  async open(
    sessionToken: string | null,
    deviceName: string,
    deviceType: DeviceType,
  ): Promise<SessionRecord> {
    if (sessionToken) {
      const existing = await this.load(sessionToken);
      if (existing) {
        existing.deviceName = deviceName;
        existing.deviceType = deviceType;
        existing.active = true;
        await this.save(existing);
        return existing;
      }
    }

    const record: SessionRecord = {
      deviceId: randomUUID(),
      sessionToken: randomUUID(),
      deviceName,
      deviceType,
      active: true,
    };
    await this.save(record);
    return record;
  }

  async save(record: SessionRecord): Promise<void> {
    const body = JSON.stringify({
      deviceId: record.deviceId,
      sessionToken: record.sessionToken,
      deviceName: record.deviceName,
      deviceType: record.deviceType,
      active: record.active,
    });
    await this.redis
      .multi()
      .set(this.sessionKey(record.sessionToken), body, { ex: REDIS_SESSION_TTL_SECONDS })
      .set(this.deviceKey(record.deviceId), record.sessionToken, { ex: REDIS_SESSION_TTL_SECONDS })
      .sadd(`${REDIS_PREFIX}:index`, record.sessionToken)
      .exec();
  }

  async load(sessionToken: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get<string>(this.sessionKey(sessionToken));
    return typeof raw === "string" ? decodeRecord(raw) : null;
  }

  async findByDeviceId(deviceId: string): Promise<SessionRecord | null> {
    const token = await this.redis.get<string>(this.deviceKey(deviceId));
    if (typeof token !== "string") return null;
    const record = await this.load(token);
    // A session that is only being kept around so a reconnect can resume it is
    // not reachable: relaying to it would deliver nothing.
    return record?.active ? record : null;
  }

  async drop(sessionToken: string): Promise<SessionRecord | null> {
    const record = await this.load(sessionToken);
    if (!record) return null;
    await this.redis
      .multi()
      .del(this.sessionKey(sessionToken))
      .del(this.deviceKey(record.deviceId))
      .srem(`${REDIS_PREFIX}:index`, sessionToken)
      .exec();
    return record;
  }

  async list(): Promise<DeviceInfo[]> {
    const tokens = await this.redis.smembers<string[]>(`${REDIS_PREFIX}:index`);
    if (!tokens || tokens.length === 0) return [];
    if (tokens.length > SIGNAL_LIMITS.maxDevices * 4) return []; // Absurd; refuse to build it.

    const rows = await this.redis.mget<string[]>(tokens.map((token) => this.sessionKey(token)));
    const stale: string[] = [];
    const devices: DeviceInfo[] = [];

    for (let index = 0; index < tokens.length; index += 1) {
      const raw = rows[index];
      const record = typeof raw === "string" ? decodeRecord(raw) : null;
      if (record?.active) devices.push(toDeviceInfo(record));
      else stale.push(tokens[index]);
    }

    // Sessions whose stream died without a clean close expired on their own.
    if (stale.length > 0) await this.redis.srem(`${REDIS_PREFIX}:index`, ...stale);
    return devices;
  }

  async publish(envelope: Envelope): Promise<void> {
    await this.redis.publish(REDIS_BUS_CHANNEL, JSON.stringify(envelope));
  }

  onDelivery(handler: (envelope: Envelope) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  /**
   * The bus subscription is per *instance*, not per stream: one long-lived
   * upstream connection serves every stream this instance holds. It is opened
   * with the first stream and closed with the last, because holding it open
   * costs the platform a request slot for as long as it lives.
   */
  async setActive(active: boolean): Promise<void> {
    if (active === this.active) return;
    this.active = active;

    if (active) {
      if (this.pending) {
        await this.pending.catch(() => undefined);
        return;
      }
      this.pending = this.startSubscription();
      await this.pending.catch(() => undefined);
      return;
    }

    const subscription = this.subscription;
    this.subscription = null;
    this.pending = null;
    if (subscription) await subscription.unsubscribe().catch(() => undefined);
  }

  private async startSubscription(): Promise<void> {
    const subscriber = this.redis.subscribe<Envelope>([REDIS_BUS_CHANNEL]);
    this.subscription = subscriber;

    subscriber.on("message", (event) => {
      const envelope = decodeEnvelope(event.message);
      if (envelope) this.handler?.(envelope);
    });

    // Failure here degrades this instance to "local streams only" instead of
    // taking the endpoint down, but it has to be loud: cross-device pairing
    // between instances will silently not work.
    await new Promise<void>((resolve) => {
      const settle = () => resolve();
      subscriber.addEventListener("subscribe", settle, { once: true });
      subscriber.addEventListener("error", (event) => {
        console.error("[sharego] signaling bus subscription failed", event);
        settle();
      });
      // Do not hold the opening request hostage if neither ever fires.
      setTimeout(settle, 3000);
    });
  }
}

type Subscriber = ReturnType<Redis["subscribe"]>;

/* ------------------------------------------------------------------ */
/* Envelope decoding                                                   */
/* ------------------------------------------------------------------ */

function decodeRecord(raw: string): SessionRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;
  const { deviceId, sessionToken, deviceName, deviceType } = record;
  // Records written before presence was tracked have no flag; treat them as
  // active, which is what every reader assumed before the field existed.
  if (
    typeof deviceId !== "string" ||
    typeof sessionToken !== "string" ||
    typeof deviceName !== "string"
  ) {
    return null;
  }

  const type: DeviceType =
    deviceType === "phone" || deviceType === "tablet" || deviceType === "desktop"
      ? deviceType
      : "unknown";

  return {
    deviceId,
    sessionToken,
    deviceName,
    deviceType: type,
    active: record.active !== false,
  };
}

function decodeEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== "string" || raw.length > SIGNAL_LIMITS.maxFrameBytes * 2) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;

  const envelope = value as Record<string, unknown>;
  if (envelope.kind === "roster") {
    if (!Array.isArray(envelope.devices)) return null;
    const devices: DeviceInfo[] = [];
    for (const entry of envelope.devices) {
      const record = decodeRecord(JSON.stringify(entry));
      if (record) devices.push(toDeviceInfo(record));
    }
    return { kind: "roster", to: null, from: null, devices };
  }

  if (envelope.kind !== "message") return null;
  if (typeof envelope.from !== "string") return null;
  if (typeof envelope.message !== "object" || envelope.message === null) return null;

  return {
    kind: "message",
    to: typeof envelope.to === "string" ? envelope.to : null,
    from: envelope.from,
    // The bus is our own traffic; re-validating every field here would duplicate
    // the parser for no gain, and the receiving client validates anyway.
    message: envelope.message as ServerSignalMessage,
  };
}

/* ------------------------------------------------------------------ */
/* Singleton                                                           */
/* ------------------------------------------------------------------ */

const HUB_KEY = Symbol.for("sharego.signaling.hub");

/**
 * One hub per process, parked on `globalThis` so `next dev`'s hot reload cannot
 * leave a second roster behind — which would stop two windows on the same
 * machine from seeing each other after an edit.
 */
export function getSignalingHub(): SignalingHub {
  const store = globalThis as Record<symbol, SignalingHub | undefined>;
  const existing = store[HUB_KEY];
  if (existing) return existing;

  const hub = new SignalingHub(createDirectory());
  store[HUB_KEY] = hub;
  return hub;
}

function createDirectory(): SignalDirectory {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (url && token) {
    try {
      return new RedisDirectory(new Redis({ url, token }));
    } catch (error) {
      console.error(
        "[sharego] could not initialise the shared signaling directory, falling back to in-process state",
        error,
      );
    }
  } else {
    console.warn(
      "[sharego] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set, so signaling state is per-instance. That is fine for local development and for a single-instance deployment, but on a multi-instance deployment devices on different instances will not find each other.",
    );
  }
  return new MemoryDirectory();
}