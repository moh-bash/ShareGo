/**
 * Runtime validation for every message that crosses a trust boundary.
 *
 * Both the browser client and the signaling route handler import these helpers,
 * so there is exactly one definition of "what a valid message looks like".
 * Parsers return `null` instead of throwing — callers decide what to do with
 * garbage, and they never let a rejected message reach application state.
 */

import { CONNECTION_REQUEST_TIMEOUT_MS, type ClientSignalMessage, type DeviceInfo, type DeviceType, type ServerSignalMessage, type SignalErrorCode } from "@/types/signaling";

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
  return readString(source, key, SIGNAL_LIMITS.maxIdLength);
}

/** Session tokens are minted by the server as UUIDs and echoed back in a URL. */
function readToken(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9-]{36}$/.test(value) ? value : null;
}

/**
 * Absolute deadlines are unusable across devices (see `expiresInMs`), and the
 * server only ever sends sane durations. Clamp anyway: a hostile or buggy
 * server must not be able to pin a dialog open forever or close it instantly.
 */
function readDuration(source: Record<string, unknown>, key: string, max: number): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return max;
  return Math.min(max, Math.max(0, value));
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
  if (typeof sdp !== "string" || sdp.length > SIGNAL_LIMITS.maxSdpLength) return null;

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
    if (raw.length > SIGNAL_LIMITS.maxFrameBytes) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  switch (value.type) {
    case "rename": {
      const deviceName = readString(value, "deviceName", SIGNAL_LIMITS.maxNameLength);
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
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Server -> Client                                                    */
/* ------------------------------------------------------------------ */

/**
 * The same job as `parseClientSignalMessage`, for the other direction. The
 * stream is plain HTTP, so a malformed frame is just as possible here: a proxy,
 * a captive portal, a stale deployment, or a compromised server.
 */
export function parseServerSignalMessage(raw: unknown): ServerSignalMessage | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > SIGNAL_LIMITS.maxFrameBytes) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;

  switch (value.type) {
    case "welcome": {
      const deviceId = readId(value, "deviceId");
      const sessionToken = readToken(value, "sessionToken");
      const deviceName = readString(value, "deviceName", SIGNAL_LIMITS.maxNameLength);
      const devices = readDevices(value.devices, SIGNAL_LIMITS.maxDevices);
      if (!deviceId || !sessionToken || !deviceName || !devices) return null;
      if (!isRecord(value.config)) return null;
      const timeout = value.config.connectionRequestTimeoutMs;
      if (typeof timeout !== "number" || !Number.isFinite(timeout)) return null;
      return {
        type: "welcome",
        protocol: readProtocol(value.protocol),
        deviceId,
        sessionToken,
        deviceName,
        devices,
        config: {
          connectionRequestTimeoutMs: timeout,
          sharedDirectory: value.config.sharedDirectory === true,
        },
      };
    }
    case "devices": {
      const devices = readDevices(value.devices, SIGNAL_LIMITS.maxDevices);
      if (!devices) return null;
      return { type: "devices", devices };
    }
    case "device-left": {
      const deviceId = readId(value, "deviceId");
      return deviceId ? { type: "device-left", deviceId } : null;
    }
    case "connection-request": {
      const from = readDeviceInfo(value.from);
      const requestId = readId(value, "requestId");
      if (!from || !requestId) return null;
      return {
        type: "connection-request",
        from,
        requestId,
        expiresInMs: readDuration(
          value,
          "expiresInMs",
          SIGNAL_LIMITS.connectionRequestTimeoutMs,
        ),
      };
    }
    case "connection-response": {
      const from = readDeviceInfo(value.from);
      const requestId = readId(value, "requestId");
      if (!from || !requestId || typeof value.accepted !== "boolean") return null;
      return { type: "connection-response", from, requestId, accepted: value.accepted };
    }
    case "offer":
    case "answer": {
      const from = readDeviceInfo(value.from);
      const description = readSessionDescription(value, "description");
      if (!from || !description || description.type !== value.type) return null;
      return { type: value.type, from, description };
    }
    case "ice-candidate": {
      const from = readDeviceInfo(value.from);
      const candidate = readIceCandidate(value, "candidate");
      if (!from || !candidate) return null;
      return { type: "ice-candidate", from, candidate };
    }
    case "peer-disconnected": {
      const from = readId(value, "from");
      return from ? { type: "peer-disconnected", from } : null;
    }
    case "error": {
      const code = value.code;
      if (typeof code !== "string" || !ERROR_CODES.has(code)) return null;
      const message = readString(value, "message", 200);
      if (!message) return null;
      const requestId = readId(value, "requestId");
      return requestId
        ? { type: "error", code: code as SignalErrorCode, message, requestId }
        : { type: "error", code: code as SignalErrorCode, message };
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Shared limits                                                       */
/* ------------------------------------------------------------------ */

const ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "bad-message",
  "name-required",
  "unknown-session",
  "unknown-device",
  "target-required",
  "self-target",
  "already-connected",
  "request-expired",
  "too-many-requests",
  "rate-limited",
  "server-busy",
  "internal",
]);

export const SIGNAL_LIMITS = {
  maxNameLength: 64,
  maxIdLength: 64,
  maxSdpLength: 128 * 1024,
  /** Signaling frames are tiny; anything larger is hostile or a bug. */
  maxFrameBytes: 256 * 1024,
  /** Upper bound on the roster, so one client cannot ask us to build a huge array. */
  maxDevices: 64,
  connectionRequestTimeoutMs: CONNECTION_REQUEST_TIMEOUT_MS,
} as const;

function readProtocol(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readDeviceInfo(value: unknown): DeviceInfo | null {
  if (!isRecord(value)) return null;
  const deviceId = readId(value, "deviceId");
  const deviceName = readString(value, "deviceName", SIGNAL_LIMITS.maxNameLength);
  if (!deviceId || !deviceName) return null;
  return { deviceId, deviceName, deviceType: readDeviceType(value) };
}

function readDevices(value: unknown, max: number): DeviceInfo[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > max) return null;

  const devices: DeviceInfo[] = [];
  for (const entry of value) {
    const info = readDeviceInfo(entry);
    if (!info) return null;
    devices.push(info);
  }
  return devices;
}
