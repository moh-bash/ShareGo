/**
 * Runtime configuration.
 *
 * The signaling endpoint is an ordinary HTTP route in this app (`/api/signal`),
 * so the default is simply "same origin, same Next.js server". That is the whole
 * point of moving signaling out of a WebSocket: local development and production
 * then run the exact same code with no second process and no port juggling.
 *
 * Resolution order:
 *   1. a value the user typed into Settings (persisted in localStorage),
 *   2. `NEXT_PUBLIC_SIGNALING_URL` from the environment,
 *   3. the same-origin `/api/signal` route.
 *
 * Session tokens are stored per endpoint: they are meaningless to another
 * deployment, so switching servers must not resurrect a dead one.
 */

const URL_STORAGE_KEY = "sharego.signalingUrl";
const SESSION_KEY_PREFIX = "sharego.session:";

/** Path the signaling route is mounted at, see `src/app/api/signal/route.ts`. */
export const SIGNALING_PATH = "/api/signal";

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(key);
    return stored && stored.trim().length > 0 ? stored.trim() : null;
  } catch {
    // Private mode / blocked storage.
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Not being able to remember this is not fatal.
  }
}

/* ------------------------------------------------------------------ */
/* Endpoint URL                                                        */
/* ------------------------------------------------------------------ */

export function resolveSignalingUrl(): string | null {
  const stored = readStorage(URL_STORAGE_KEY);
  if (stored) return stored;

  const fromEnv = process.env.NEXT_PUBLIC_SIGNALING_URL?.trim();
  if (fromEnv) return normaliseUrl(fromEnv);

  if (typeof window === "undefined") return null;
  return `${window.location.origin}${SIGNALING_PATH}`;
}

/** Persist a user supplied signaling URL (Settings sheet). */
export function saveSignalingUrl(url: string | null): void {
  const trimmed = url?.trim() ?? "";
  writeStorage(URL_STORAGE_KEY, trimmed.length > 0 ? normaliseUrl(trimmed) : null);
}

/** Drop the override so the app falls back to same-origin / the environment. */
export function clearSignalingUrl(): void {
  writeStorage(URL_STORAGE_KEY, null);
}

export function hasSignalingUrlOverride(): boolean {
  return readStorage(URL_STORAGE_KEY) !== null;
}

/**
 * Accept whatever someone is likely to paste — `localhost:3000`, `https://host`,
 * an old `ws://host:8080` from a terminal, or a full endpoint URL — and return a
 * usable HTTP endpoint. A bare origin gets the signaling path appended; anything
 * with its own path is taken at face value.
 */
export function normaliseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed.length === 0) return trimmed;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return trimmed;
  }

  switch (url.protocol) {
    case "ws:":
      url.protocol = "http:";
      break;
    case "wss:":
      url.protocol = "https:";
      break;
    case "http:":
    case "https:":
      break;
    default:
      return trimmed;
  }

  // `https://host` and `https://host/` both mean "the app's own route".
  if (url.pathname === "" || url.pathname === "/") url.pathname = SIGNALING_PATH;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function isValidSignalingUrl(value: string): boolean {
  try {
    const url = new URL(normaliseUrl(value));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Session token                                                       */
/* ------------------------------------------------------------------ */

function sessionStorageKey(endpoint: string): string {
  return `${SESSION_KEY_PREFIX}${normaliseUrl(endpoint)}`;
}

/** The token the server handed us last time, so a reconnect keeps our identity. */
export function readSessionToken(endpoint: string): string | null {
  const token = readStorage(sessionStorageKey(endpoint));
  return token && /^[A-Za-z0-9-]{36}$/.test(token) ? token : null;
}

export function saveSessionToken(endpoint: string, token: string | null): void {
  writeStorage(sessionStorageKey(endpoint), token);
}