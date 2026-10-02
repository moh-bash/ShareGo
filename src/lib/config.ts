/**
 * Runtime configuration.
 *
 * Resolution order for the signaling URL:
 *   1. a value the user typed into the app (persisted in localStorage) — this
 *      is what makes testing on a second device painless,
 *   2. `NEXT_PUBLIC_SIGNALING_URL` from the environment,
 *   3. derived from `window.location` for local HTTP development, so opening
 *      the app from another device on the same Wi-Fi "just works".
 *
 * HTTPS deployments must configure `NEXT_PUBLIC_SIGNALING_URL`. We cannot
 * safely infer a standalone WebSocket service from a Vercel page URL.
 */

const URL_STORAGE_KEY = "sharego.signalingUrl";
export const DEFAULT_SIGNALING_PORT = 8080;

function readStoredUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(URL_STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored.trim() : null;
  } catch {
    // Private mode / blocked storage.
    return null;
  }
}

function storeUrl(url: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (url === null) window.localStorage.removeItem(URL_STORAGE_KEY);
    else window.localStorage.setItem(URL_STORAGE_KEY, url);
  } catch {
    // Ignore: not being able to remember the URL is not fatal.
  }
}

function deriveUrlFromLocation(): string | null {
  const { protocol, hostname, port } = window.location;
  if (protocol !== "http:") return null;

  // The signaling server never runs on the same port as Next.js in dev.
  const signalingPort =
    port && port !== "3000" && port !== "3001" ? port : String(DEFAULT_SIGNALING_PORT);
  return `ws://${hostname || "localhost"}:${signalingPort}`;
}

export function resolveSignalingUrl(): string | null {
  const stored = readStoredUrl();
  if (stored) return stored;

  const fromEnv = process.env.NEXT_PUBLIC_SIGNALING_URL?.trim();
  if (fromEnv) return fromEnv;

  if (typeof window === "undefined") return null;
  return deriveUrlFromLocation();
}

/** Persist a user supplied signaling URL (Settings sheet). */
export function saveSignalingUrl(url: string | null): void {
  storeUrl(url && url.trim().length > 0 ? normaliseUrl(url.trim()) : null);
}

/**
 * Accept `localhost:8080`, `http://…`, `wss://…` and normalise everything to a
 * `ws://` / `wss://` URL, so users can paste whatever their terminal printed.
 */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim();
  if (/^wss?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  if (/^https:\/\//i.test(trimmed)) return `wss://${trimmed.slice(8).replace(/\/+$/, "")}`;
  if (/^http:\/\//i.test(trimmed)) return `ws://${trimmed.slice(7).replace(/\/+$/, "")}`;
  return `ws://${trimmed.replace(/\/+$/, "")}`;
}

export function isValidSignalingUrl(value: string): boolean {
  try {
    const url = new URL(normaliseUrl(value));
    return url.protocol === "ws:" || url.protocol === "wss:";
  } catch {
    return false;
  }
}
