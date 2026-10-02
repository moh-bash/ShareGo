/**
 * Signaling protocol: the *only* thing that ever travels over the signaling
 * transport (an HTTP endpoint with a server->client SSE stream and client->server
 * POSTs — see `lib/signaling/hub.ts`).
 *
 * Rules that must not be broken:
 *  1. File bytes are NEVER sent here. They go over a WebRTC DataChannel.
 *  2. The server never trusts a client supplied `from` / `deviceId`; it always
 *     stamps those from the session it resolved for the caller.
 *  3. Everything is validated at runtime (see `lib/signaling/protocol.ts`)
 *     because this is untrusted input from the network.
 */

export const SIGNAL_PROTOCOL_VERSION = 2;

/** How long the *receiver* of a connection request keeps the dialog open. */
export const CONNECTION_REQUEST_TIMEOUT_MS = 30_000;

export type DeviceType = "phone" | "tablet" | "desktop" | "unknown";

/** Announced device record, shared with every other device on the server. */
export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  deviceType: DeviceType;
}

export type SignalErrorCode =
  | "bad-message"
  | "name-required"
  | "unknown-session"
  | "unknown-device"
  | "target-required"
  | "self-target"
  | "already-connected"
  | "request-expired"
  | "too-many-requests"
  | "rate-limited"
  | "server-busy"
  | "internal";

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

/**
 * A device is identified by opening the signaling stream (`GET`) with the
 * `session` token it was last handed. There is no `hello`: identity travels in
 * the stream URL, so the server can answer `welcome` — and start relaying —
 * without a second round trip.
 */

export interface RenameMessage {
  type: "rename";
  deviceName: string;
}

/** "I would like to talk to you" — nothing is negotiated until it is accepted. */
export interface ConnectionRequestMessage {
  type: "connection-request";
  to: string;
  requestId: string;
}

export interface ConnectionResponseMessage {
  type: "connection-response";
  to: string;
  requestId: string;
  accepted: boolean;
}

export interface OfferMessage {
  type: "offer";
  to: string;
  description: RTCSessionDescriptionInit;
}

export interface AnswerMessage {
  type: "answer";
  to: string;
  description: RTCSessionDescriptionInit;
}

export interface IceCandidateMessage {
  type: "ice-candidate";
  to: string;
  candidate: RTCIceCandidateInit;
}

/** Graceful teardown so the peer can show "left" instead of "failed". */
export interface DisconnectPeerMessage {
  type: "disconnect-peer";
  to: string;
}

export type ClientSignalMessage =
  | RenameMessage
  | ConnectionRequestMessage
  | ConnectionResponseMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | DisconnectPeerMessage;

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  /** Server generated. Stable for as long as the `sessionToken` is presented. */
  deviceId: string;
  /**
   * Secret handle for this session. Present it on the next `GET` to keep the
   * same `deviceId` across a reconnect (reloads, network blips, the platform
   * recycling the stream). Treat it like a cookie: never log it.
   */
  sessionToken: string;
  deviceName: string;
  /** Everyone else currently on this signaling server. */
  devices: DeviceInfo[];
  config: {
    connectionRequestTimeoutMs: number;
    /**
     * `false` when the deployment has no shared directory, so devices landing on
     * different server instances cannot see each other. Surfaced in the UI
     * rather than failing silently.
     */
    sharedDirectory: boolean;
  };
}

export interface DevicesMessage {
  type: "devices";
  devices: DeviceInfo[];
}

export interface DeviceLeftMessage {
  type: "device-left";
  deviceId: string;
}

export interface ConnectionRequestIncomingMessage {
  type: "connection-request";
  from: DeviceInfo;
  requestId: string;
  /**
   * Relative, never an absolute timestamp: the two devices rarely agree on the
   * wall clock, and a skewed clock would expire the dialog instantly (or never).
   */
  expiresInMs: number;
}

export interface ConnectionResponseIncomingMessage {
  type: "connection-response";
  from: DeviceInfo;
  requestId: string;
  accepted: boolean;
}

export interface OfferIncomingMessage {
  type: "offer";
  from: DeviceInfo;
  description: RTCSessionDescriptionInit;
}

export interface AnswerIncomingMessage {
  type: "answer";
  from: DeviceInfo;
  description: RTCSessionDescriptionInit;
}

export interface IceCandidateIncomingMessage {
  type: "ice-candidate";
  from: DeviceInfo;
  candidate: RTCIceCandidateInit;
}

export interface PeerDisconnectedMessage {
  type: "peer-disconnected";
  from: string;
}

export interface ErrorMessage {
  type: "error";
  code: SignalErrorCode;
  message: string;
  /** Present when the error is tied to a specific request. */
  requestId?: string;
}

export type ServerSignalMessage =
  | WelcomeMessage
  | DevicesMessage
  | DeviceLeftMessage
  | ConnectionRequestIncomingMessage
  | ConnectionResponseIncomingMessage
  | OfferIncomingMessage
  | AnswerIncomingMessage
  | IceCandidateIncomingMessage
  | PeerDisconnectedMessage
  | ErrorMessage;

/* ------------------------------------------------------------------ */
/* Client side connection status                                       */
/* ------------------------------------------------------------------ */

export type SignalingStatus =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";
