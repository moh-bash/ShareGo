/**
 * Signaling protocol: the *only* thing that ever travels over the WebSocket.
 *
 * Rules that must not be broken:
 *  1. File bytes are NEVER sent here. They go over a WebRTC DataChannel.
 *  2. The server never trusts a client supplied `from` / `deviceId`; it always
 *     stamps those from the authenticated socket session.
 *  3. Everything is validated at runtime (see `lib/websocket/protocol.ts`)
 *     because this is untrusted input from the network.
 */

export const SIGNAL_PROTOCOL_VERSION = 1;

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
  | "unknown-device"
  | "target-required"
  | "self-target"
  | "already-connected"
  | "request-expired"
  | "too-many-requests"
  | "rate-limited"
  | "internal";

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

/** First message a socket sends; the server answers with `welcome`. */
export interface HelloMessage {
  type: "hello";
  protocol: number;
  deviceName: string;
  deviceType: DeviceType;
}

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

export interface PingMessage {
  type: "ping";
  at: number;
}

export type ClientSignalMessage =
  | HelloMessage
  | RenameMessage
  | ConnectionRequestMessage
  | ConnectionResponseMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | DisconnectPeerMessage
  | PingMessage;

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
  /** Server generated. Every socket gets a fresh id, so ids are ephemeral. */
  deviceId: string;
  deviceName: string;
  /** Everyone else currently on this signaling server. */
  devices: DeviceInfo[];
  config: {
    connectionRequestTimeoutMs: number;
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
  expiresAt: number;
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

export interface PongMessage {
  type: "pong";
  at: number;
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
  | ErrorMessage
  | PongMessage;

/* ------------------------------------------------------------------ */
/* Client side connection status                                       */
/* ------------------------------------------------------------------ */

export type SignalingStatus =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline";
