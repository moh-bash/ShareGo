/**
 * Tunables for the WebRTC data plane.
 *
 * Everything is overridable through `NEXT_PUBLIC_*` env vars (see `.env.example`)
 * so you can tune chunk size / high water mark for a constrained link without
 * touching code. Values are read once and cached: reading `process.env` in the
 * browser is inlined at build time by Next.js, so it is effectively a constant.
 */

function readIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface TransferConfig {
  /** Bytes per binary frame. 64 KB is a good default for a LAN. */
  chunkSize: number;
  /**
   * Stop producing chunks once the DataChannel send buffer exceeds this many
   * bytes. 4 MB keeps memory flat without stalling on a fast link.
   */
  highWaterMark: number;
  /** Resume once the send buffer drains to this. */
  lowWaterMark: number;
  /** How long to wait for an inbound `file-request` to be satisfied. */
  maxConcurrentSends: number;
}

let cached: TransferConfig | null = null;

export function getTransferConfig(): TransferConfig {
  if (cached) return cached;

  const chunkSize = readIntEnv(process.env.NEXT_PUBLIC_TRANSFER_CHUNK_SIZE, 64 * 1024);
  const highWaterMark = readIntEnv(
    process.env.NEXT_PUBLIC_TRANSFER_HIGH_WATER_MARK,
    4 * 1024 * 1024,
  );

  cached = {
    chunkSize,
    highWaterMark,
    lowWaterMark: Math.max(64 * 1024, Math.floor(highWaterMark / 4)),
    maxConcurrentSends: readIntEnv(process.env.NEXT_PUBLIC_MAX_CONCURRENT_TRANSFERS, 4),
  };
  return cached;
}

/* ------------------------------------------------------------------ */
/* ICE servers                                                         */
/* ------------------------------------------------------------------ */

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * On a single LAN, host candidates are enough and no STUN server is required —
 * that is the whole point of this app. A public STUN server is configured as a
 * default so the same build still works if you try it across networks.
 *
 * There is no TURN relay by default: it needs a paid/self-hosted server and
 * would break the "nothing leaves your network" promise. Set
 * `NEXT_PUBLIC_ICE_SERVERS` to a JSON array if you add one.
 */
export function getIceServers(): RTCIceServer[] {
  const raw = process.env.NEXT_PUBLIC_ICE_SERVERS?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as IceServerConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed as RTCIceServer[];
      }
    } catch {
      console.warn(
        "[sharego] NEXT_PUBLIC_ICE_SERVERS is not valid JSON, falling back to defaults.",
      );
    }
  }

  const stun = process.env.NEXT_PUBLIC_STUN_URL?.trim() || "stun:stun.l.google.com:19302";
  return [{ urls: stun }];
}

/**
 * ICE can take several seconds when two devices only learn about each other
 * through the signaling server. We ask for a moderate pool and, more
 * importantly, we never gate the UI on `icegatheringstate === "complete"` —
 * host candidates trickle in immediately and are usually enough on a LAN.
 */
export const ICE_SERVER_COUNT = 1;
