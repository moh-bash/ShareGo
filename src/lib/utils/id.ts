/** Small id/misc helpers. Kept dependency free on purpose. */

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Short, URL-safe random id. Used for connection request ids and local file
 * ids. `crypto.randomUUID` is available in every browser we target, but this
 * also works in the signaling server / older Safari without a polyfill.
 */
export function randomId(length = 12): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return out;
}

/** Namespace so a peer-supplied fileId can never collide with a local one. */
export function newFileId(): string {
  return `f_${randomId(16)}`;
}

/**
 * Monotonic-ish counter used for `transferId`.
 *
 * Returns `start` first: the previous version incremented before returning, so
 * a counter created with `createCounter(1)` handed out `2` and silently skipped
 * an id.
 */
export function createCounter(start = 1): () => number {
  let value = start;
  return () => {
    const current = value;
    value += 1;
    return current;
  };
}

/**
 * Best-effort human name for the current device, so a fresh user sees
 * something friendlier than "device-7f2a".
 */
export function guessDeviceName(): string {
  if (typeof navigator === "undefined") return "This device";

  const ua = navigator.userAgent;
  const platform = /Android/i.test(ua)
    ? "Android Phone"
    : /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua) || /iPod/i.test(ua)
        ? "iPad"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows PC"
            : /CrOS/i.test(ua)
              ? "ChromeOS"
              : /Linux/i.test(ua)
                ? "Linux PC"
                : "This device";

  return platform;
}
