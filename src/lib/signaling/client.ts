/**
 * Browser-side signaling client.
 *
 * Deliberately dumb: it holds one server->client event stream, POSTs the odd
 * message upstream, retries with backoff, and forwards validated messages. It
 * knows nothing about WebRTC.
 *
 * Why an event stream and not a WebSocket: this has to run unchanged on `next
 * dev` and on a serverless deployment, where a request may last a bounded amount
 * of time and instances are not sticky. `EventSource` also reconnects for free,
 * and because the URL carries the session token minted in `welcome`, a reconnect
 * resumes the *same* deviceId — so a dropped stream is not a dropped identity.
 *
 * That distinction drives `onReset`: it fires only when the server hands us a
 * *different* deviceId. A blip leaves every established peer connection alone,
 * which is correct — those live on the DataChannels, not on this stream.
 */

import { readSessionToken, saveSessionToken } from "@/lib/config";
import { parseClientSignalMessage, parseServerSignalMessage } from "@/lib/signaling/protocol";
import {
  SIGNAL_PROTOCOL_VERSION,
  type ClientSignalMessage,
  type DeviceType,
  type ServerSignalMessage,
  type SignalingStatus,
  type WelcomeMessage,
} from "@/types/signaling";

/** The server pings every 15s; three missed pings means the stream is a corpse. */
const LIVENESS_TIMEOUT_MS = 45_000;
const LIVENESS_CHECK_MS = 15_000;
const MAX_BACKOFF_MS = 15_000;
/** Small buffer so "connect + immediately ask" works right after load. */
const MAX_QUEUE = 20;

export interface SignalingClientEvents {
  onStatus(status: SignalingStatus): void;
  onMessage(message: ServerSignalMessage): void;
  /** Identity was replaced: drop every RTCPeerConnection, they are all invalid. */
  onReset(reason: string): void;
  onError(message: string): void;
}

export interface SignalingClientOptions {
  /** Absolute URL of the signaling endpoint, e.g. `https://host/api/signal`. */
  url: string;
  deviceName: string;
  deviceType: DeviceType;
  events: SignalingClientEvents;
}

export class SignalingClient {
  private source: EventSource | null = null;
  private readonly options: SignalingClientOptions;
  private deviceName: string;
  private sessionToken: string | null;
  private deviceId: string | null = null;
  private status: SignalingStatus = "idle";

  private retryAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenAt = 0;
  private disposed = false;
  private queue: ClientSignalMessage[] = [];
  private warnedAboutSharedState = false;

  constructor(options: SignalingClientOptions) {
    this.options = options;
    this.deviceName = options.deviceName;
    this.sessionToken = readSessionToken(options.url);
  }

  get currentStatus(): SignalingStatus {
    return this.status;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.source) return;

    this.setStatus(this.retryAttempt === 0 ? "connecting" : "reconnecting");

    let source: EventSource;
    try {
      source = new EventSource(this.buildStreamUrl());
    } catch {
      this.scheduleReconnect("Could not reach the signaling server.");
      return;
    }
    this.source = source;

    source.onmessage = (event: MessageEvent) => {
      this.lastSeenAt = Date.now();
      this.handleFrame(event.data);
    };
    // Named frame the client uses only to prove the stream is still alive.
    source.addEventListener("ping", () => {
      this.lastSeenAt = Date.now();
    });
    source.onerror = () => {
      // `EventSource` never says *why*. Take the retry into our own hands so the
      // backoff is ours and the status we report is honest.
      const wasOnline = this.status === "online";
      this.closeSource();
      this.scheduleReconnect(
        wasOnline
          ? "The signaling stream dropped; reconnecting."
          : "Could not reach the signaling server.",
      );
    };
  }

  /** Close and stop retrying (component unmount / user action). */
  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.stopLiveness();
    this.closeSource();
    this.queue = [];
    this.setStatus("offline");
  }

  setDeviceName(deviceName: string): void {
    this.deviceName = deviceName;
    this.send({ type: "rename", deviceName });
  }

  send(message: ClientSignalMessage): void {
    if (this.disposed) return;

    // Validate our own outgoing message too: it catches integration bugs in
    // development rather than letting a malformed frame reach the server.
    if (!parseClientSignalMessage(message)) {
      console.warn("[sharego] refusing to send an invalid signaling message", message);
      return;
    }

    // Before `welcome` there is no session to post as, so hold it briefly.
    if (!this.sessionToken) {
      this.queue = [...this.queue, message].slice(-MAX_QUEUE);
      return;
    }
    void this.post(message);
  }

  /* ---------------------------------------------------------------- */
  /* Stream                                                            */
  /* ---------------------------------------------------------------- */

  private buildStreamUrl(): string {
    const url = new URL(this.options.url);
    if (this.sessionToken) url.searchParams.set("session", this.sessionToken);
    url.searchParams.set("name", this.deviceName);
    url.searchParams.set("type", this.options.deviceType);
    return url.toString();
  }

  private handleFrame(raw: unknown): void {
    const message = parseServerSignalMessage(raw);
    if (!message) return;

    if (message.type === "welcome") {
      this.handleWelcome(message);
      return;
    }
    this.options.events.onMessage(message);
  }

  private handleWelcome(message: WelcomeMessage): void {
    // The protocol number is echoed back precisely so a version skew between the
    // page and the deployment is visible instead of mysteriously non-functional.
    if (message.protocol !== SIGNAL_PROTOCOL_VERSION) {
      this.options.events.onError(
        "This device is running a different ShareGo version than the signaling server. Reload both.",
      );
      this.closeSource();
      this.setStatus("offline");
      return;
    }

    const identityChanged = this.deviceId !== null && this.deviceId !== message.deviceId;
    this.deviceId = message.deviceId;
    this.deviceName = message.deviceName;

    // The server rotates the token when it could not honour the one we sent.
    // Persist it so the *next* connection resumes this identity — but do NOT
    // reopen the stream: it is already authenticated, and closing it would drop
    // the session we just established. `buildStreamUrl` reads the new token on
    // any later reconnect.
    if (this.sessionToken !== message.sessionToken) {
      this.sessionToken = message.sessionToken;
      saveSessionToken(this.options.url, message.sessionToken);
    }

    if (!message.config.sharedDirectory && !this.warnedAboutSharedState) {
      this.warnedAboutSharedState = true;
      this.options.events.onError(
        "This deployment has no shared signaling state, so it only pairs devices that land on the same server instance. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to fix that.",
      );
    }

    this.retryAttempt = 0;
    this.setStatus("online");
    this.startLiveness();
    this.flushQueue();

    if (identityChanged) {
      this.options.events.onReset("The signaling session was replaced.");
    }
    this.options.events.onMessage(message);
  }

  private closeSource(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    // Detach first: `close()` must not be mistaken for a network failure.
    source.onmessage = null;
    source.onerror = null;
    try {
      source.close();
    } catch {
      // Already closed.
    }
  }

  /* ---------------------------------------------------------------- */
  /* Upstream                                                          */
  /* ---------------------------------------------------------------- */

  private async post(message: ClientSignalMessage): Promise<void> {
    const session = this.sessionToken;
    if (!session) return;

    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ session, message }),
      });

      if (!response.ok) {
        this.options.events.onError(
          `The signaling server rejected a message (${response.status}).`,
        );
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      if (typeof payload !== "object" || payload === null) return;

      const result = payload as { ok?: unknown; error?: unknown };
      if (result.ok !== false) return;

      const error = parseServerSignalMessage(result.error);
      if (error) this.options.events.onMessage(error);

      if (error?.type === "error" && error.code === "unknown-session") {
        // The token is gone server-side (redeploy, long sleep). Start clean.
        this.sessionToken = null;
        saveSessionToken(this.options.url, null);
        this.closeSource();
        this.scheduleReconnect("The signaling session expired; rejoining.");
      }
    } catch {
      // The stream is almost certainly down too and will resync the roster.
      this.options.events.onError("Could not send a message to the signaling server.");
    }
  }

  private flushQueue(): void {
    if (!this.sessionToken) return;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) void this.post(message);
  }

  /* ---------------------------------------------------------------- */
  /* Liveness + retry                                                  */
  /* ---------------------------------------------------------------- */

  private startLiveness(): void {
    this.stopLiveness();
    this.lastSeenAt = Date.now();
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastSeenAt <= LIVENESS_TIMEOUT_MS) return;
      this.closeSource();
      this.scheduleReconnect("The signaling stream went quiet; reconnecting.");
    }, LIVENESS_CHECK_MS);
  }

  private stopLiveness(): void {
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private scheduleReconnect(reason: string | null, delayOverrideMs?: number): void {
    if (this.disposed) return;
    this.stopLiveness();
    this.setStatus("reconnecting");
    if (reason) this.options.events.onError(reason);

    const attempt = this.retryAttempt;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    const delay =
      delayOverrideMs ?? Math.round(base * (0.7 + Math.random() * 0.6));

    this.retryAttempt = Math.min(this.retryAttempt + 1, 8);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: SignalingStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.events.onStatus(status);
  }
}