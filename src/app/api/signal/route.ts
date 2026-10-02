/**
 * The signaling endpoint.
 *
 * Two methods on one route, because that is what survives a serverless platform:
 *
 *   GET  — opens a `text/event-stream` and keeps it open for as long as the
 *          platform allows. The server pushes the roster, connection requests
 *          and SDP/ICE down it. The browser's `EventSource` reconnects on its
 *          own, and the session token in the URL makes that a *resume*, not a
 *          new identity.
 *   POST — carries exactly one client message upstream. Fire and forget from the
 *          client's point of view; failures come back down the stream.
 *
 * `X-Accel-Buffering: no` and `no-transform` are load-bearing: a proxy that
 * buffers an event stream turns realtime signaling into a polling loop that only
 * flushes when the buffer fills.
 *
 * The route is deliberately unauthenticated and CORS-open — any device on the
 * network may join, which is the same trust model the WebSocket server had.
 * Nothing but peer introductions crosses here; file bytes never do.
 */

import { getSignalingHub, HubBusyError, type OpenStreamRequest } from "@/lib/signaling/hub";
import { SIGNAL_LIMITS } from "@/lib/signaling/protocol";
import type { DeviceType } from "@/types/signaling";

/** Room for a long-lived stream on platforms that cap function duration. */
export const maxDuration = 300;

const DEVICE_TYPES: readonly DeviceType[] = ["phone", "tablet", "desktop", "unknown"];

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const openRequest: OpenStreamRequest = {
    sessionToken: readSessionToken(url.searchParams.get("session")),
    deviceName: readDeviceName(url.searchParams.get("name")),
    deviceType: readDeviceType(url.searchParams.get("type")),
  };

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await getSignalingHub().openStream(openRequest, request.signal);
  } catch (error) {
    if (error instanceof HubBusyError) {
      return new Response("Signaling is at capacity, try again in a moment.", {
        status: 503,
        headers: { ...CORS_HEADERS, "retry-after": "5" },
      });
    }
    throw error;
  }

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  const hub = getSignalingHub();

  let sessionToken: string | null;
  let body: unknown;
  try {
    const raw = await readBody(request);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const envelope = parsed as Record<string, unknown>;
    sessionToken = readSessionToken(
      typeof envelope.session === "string" ? envelope.session : null,
    );
    if (!sessionToken) throw new Error("missing session");
    body = envelope.message;
  } catch {
    return json({ ok: false }, 400);
  }

  const result = await hub.submit(sessionToken, body);
  return json({ ok: result.ok, error: result.error ?? null }, 200);
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

/** Reject an oversized body before parsing it into memory. */
async function readBody(request: Request): Promise<string> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > SIGNAL_LIMITS.maxFrameBytes) {
    throw new Error("body too large");
  }
  const raw = await request.text();
  if (raw.length > SIGNAL_LIMITS.maxFrameBytes) throw new Error("body too large");
  return raw;
}

/** Only a token we minted is worth resuming; anything else gets a new session. */
function readSessionToken(value: string | null): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9-]{36}$/.test(value) ? value : null;
}

function readDeviceName(value: string | null): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return "This device";
  return trimmed.slice(0, SIGNAL_LIMITS.maxNameLength);
}

function readDeviceType(value: string | null): DeviceType {
  return typeof value === "string" && (DEVICE_TYPES as readonly string[]).includes(value)
    ? (value as DeviceType)
    : "unknown";
}