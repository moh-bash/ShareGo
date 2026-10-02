/**
 * Runtime validation for every message that crosses a trust boundary.
 *
 * Both the browser client and the Node signaling server import these helpers,
 * so there is exactly one definition of "what a valid message looks like".
 * Parsers return `null` instead of throwing — callers decide what to do with
 * garbage, and they never let a rejected message reach application state.
 */

import { CONNECTION_REQUEST_TIMEOUT_MS, type ClientSignalMessage, type DeviceType } from "@/types/signaling";

/* ------------------------------------------------------------------ */
/* Primitive guards                                                    */
/* ------------------------------------------------------------------ */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

function readTimestamp(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

const DEVICE_TYPES: readonly DeviceType[] = [
  "phone",
  "tablet",
  "desktop",
  "unknown",
];

function readDeviceType(source: Record<string, unknown>): DeviceType {
  const value = source.deviceType;
  return typeof value === "string" && (DEVICE_TYPES as readonly string[]).includes(value)
    ? (value as DeviceType)
    : "unknown";
}

/** Device ids and request ids are opaque tokens, keep them tight. */
function readId(source: Record<string, unknown>, key: string): string | null {
  return readString(source, key, 64);
}

/* ------------------------------------------------------------------ */
/* SDP / ICE shapes                                                    */
/* ------------------------------------------------------------------ */

/**
 * We do not fully validate SDP (the browser must do that anyway), we only make
 * sure it is the right *shape* so a hostile peer cannot make us allocate
 * megabytes of strings or reach into prototype fields.
 */
function readSessionDescription(
  source: Record<string, unknown>,
  key: string,
): RTCSessionDescriptionInit | null {
  const value = source[key];
  if (!isRecord(value)) return null;

  const type = value.type;
  if (type !== "offer" && type !== "answer" && type !== "pranswer" && type !== "rollback") {
    return null;
  }
  const sdp = value.sdp;
  if (typeof sdp !== "string" || sdp.length > 128 * 1024) return null;

  const description: RTCSessionDescriptionInit = { type, sdp };
  return description;
}

function readIceCandidate(source: Record<string, unknown>, key: string): RTCIceCandidateInit | null {
  const value = source[key];
  if (!isRecord(value)) return null;

  const candidate = value.candidate;
  // A null/absent candidate is legal: it signals end-of-candidates.
  if (candidate === null || candidate === undefined) {
    return { candidate: "" };
  }
  if (typeof candidate !== "string" || candidate.length > 4096) return null;

  const result: RTCIceCandidateInit = { candidate };
  const sdpMid = value.sdpMid;
  const sdpMLineIndex = value.sdpMLineIndex;
  if (typeof sdpMid === "string") result.sdpMid = sdpMid.slice(0, 64);
  if (typeof sdpMLineIndex === "number" && Number.isFinite(sdpMLineIndex)) {
    result.sdpMLineIndex = sdpMLineIndex;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Client -> Server                                                    */
/* ------------------------------------------------------------------ */

/** Returns a parsed message, or `null` if anything about it is off. */
export function parseClientSignalMessage(raw: unknown): ClientSignalMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 256 * 1024) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  switch (value.type) {
    case "hello": {
      const deviceName = readString(value, "deviceName", 64);
      if (!deviceName) return null;
      return {
        type: "hello",
        protocol: 1,
        deviceName,
        deviceType: readDeviceType(value),
      };
    }
    case "rename": {
      const deviceName = readString(value, "deviceName", 64);
      if (!deviceName) return null;
      return { type: "rename", deviceName };
    }
    case "connection-request": {
      const to = readId(value, "to");
      const requestId = readId(value, "requestId");
      if (!to || !requestId) return null;
      return { type: "connection-request", to, requestId };
    }
    case "connection-response": {
      const to = readId(value, "to");
      const requestId = readId(value, "requestId");
      if (typeof value.accepted !== "boolean") return null;
      if (!to || !requestId) return null;
      return { type: "connection-response", to, requestId, accepted: value.accepted };
    }
    case "offer": {
      const to = readId(value, "to");
      const description = readSessionDescription(value, "description");
      if (!to || !description || description.type !== "offer") return null;
      return { type: "offer", to, description };
    }
    case "answer": {
      const to = readId(value, "to");
      const description = readSessionDescription(value, "description");
      if (!to || !description || description.type !== "answer") return null;
      return { type: "answer", to, description };
    }
    case "ice-candidate": {
      const to = readId(value, "to");
      const candidate = readIceCandidate(value, "candidate");
      if (!to || !candidate) return null;
      return { type: "ice-candidate", to, candidate };
    }
    case "disconnect-peer": {
      const to = readId(value, "to");
      if (!to) return null;
      return { type: "disconnect-peer", to };
    }
    case "ping": {
      return { type: "ping", at: readTimestamp(value, "at") };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Shared limits (also used by the WebSocket validation)               */
/* ------------------------------------------------------------------ */

export const SIGNAL_LIMITS = {
  maxNameLength: 64,
  maxIdLength: 64,
  maxSdpLength: 128 * 1024,
  connectionRequestTimeoutMs: CONNECTION_REQUEST_TIMEOUT_MS,
  /** A device may keep at most this many unanswered requests in flight. */
  maxPendingRequestsPerDevice: 8,
} as const;
