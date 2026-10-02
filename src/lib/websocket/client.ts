/**
 * Browser-side signaling client.
 *
 * Deliberately dumb: it opens a socket, says who we are, retries with backoff,
 * and forwards validated messages. It knows nothing about WebRTC.
 *
 * Reconnect behaviour:
 *  - exponential backoff with jitter, capped at 15s,
 *  - heartbeat ping every 20s so a silently dead socket is noticed,
 *  - `onReset` callback so the peer manager can drop every RTCPeerConnection
 *    (they are all invalid once the signaling session is gone).
 */

import { parseClientSignalMessage } from "@/lib/websocket/protocol";
import {
  SIGNAL_PROTOCOL_VERSION,
  type ClientSignalMessage,
  type DeviceType,
  type ServerSignalMessage,
  type SignalingStatus,
} from "@/types/signaling";

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 15_000;

export interface SignalingClientEvents {
  onStatus(status: SignalingStatus): void;
  onMessage(message: ServerSignalMessage): void;
  /** The socket was lost (closed or errored): tear down peer state. */
  onReset(reason: string): void;
  onError(message: string): void;
}

export interface SignalingClientOptions {
  url: string;
  deviceName: string;
  deviceType: DeviceType;
  events: SignalingClientEvents;
}

export class SignalingClient {
  private socket: WebSocket | null = null;
  private options: SignalingClientOptions;
  private deviceName: string;
  private status: SignalingStatus = "idle";

  private retryAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Never let `send()` run before the socket is open. */
  private queue: ClientSignalMessage[] = [];

  constructor(options: SignalingClientOptions) {
    this.options = options;
    this.deviceName = options.deviceName;
  }

  get currentStatus(): SignalingStatus {
    return this.status;
  }

  connect(): void {
    if (this.disposed) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    this.setStatus(this.retryAttempt === 0 ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch {
      this.scheduleReconnect("Could not reach the signaling server.");
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.retryAttempt = 0;
      this.setStatus("online");
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: SIGNAL_PROTOCOL_VERSION,
          deviceName: this.deviceName,
          deviceType: this.options.deviceType,
        }),
      );
      this.flushQueue();
      this.startHeartbeat();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) return;

      if (parsed.type === "welcome") {
        if (parsed.protocol !== SIGNAL_PROTOCOL_VERSION) {
          this.options.events.onError(
            "This device is running a different ShareGo version than the signaling server. Restart the server.",
          );
          socket.close();
          return;
        }
        this.deviceName = parsed.deviceName;
      }
      if (parsed.type === "pong") {
        this.clearPongTimer();
        return;
      }

      this.options.events.onMessage(parsed);
    };

    socket.onerror = () => {
      // `onclose` always follows, which is where recovery happens.
    };

    socket.onclose = (event) => {
      this.stopHeartbeat();
      this.clearPongTimer();
      this.socket = null;

      if (this.disposed) return;

      this.options.events.onReset("The signaling connection dropped.");
      this.scheduleReconnect(
        event.reason
          ? `The signaling connection closed: ${event.reason}`
          : "The signaling connection closed.",
      );
    };
  }

  /** Close and stop retrying (component unmount / user action). */
  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearPongTimer();

    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onerror = null;
      this.socket.onopen = null;
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close(1000, "client closed");
      } else {
        this.socket.close();
      }
      this.socket = null;
    }
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

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }
    // Small buffer so "connect + immediately ask" works right after load.
    this.queue = [...this.queue, message].slice(-20);
  }

  private flushQueue(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) this.socket.send(JSON.stringify(message));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const at = Date.now();
      this.socket.send(JSON.stringify({ type: "ping", at }));

      // A TCP socket can stay "open" long after the network is gone.
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        this.socket?.close(4000, "heartbeat timeout");
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed) return;
    this.setStatus("reconnecting");
    this.options.events.onError(reason);

    const attempt = this.retryAttempt;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));

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

/**
 * Server -> client validation. Narrower than the client-side parser because we
 * only trust what the server sends, but we still shape-check so a buggy or
 * impersonated server cannot hand us a 10 MB "device name".
 */
function isServerMessage(value: unknown): value is ServerSignalMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "welcome" ||
    type === "devices" ||
    type === "device-left" ||
    type === "connection-request" ||
    type === "connection-response" ||
    type === "offer" ||
    type === "answer" ||
    type === "ice-candidate" ||
    type === "peer-disconnected" ||
    type === "error" ||
    type === "pong"
  );
}
