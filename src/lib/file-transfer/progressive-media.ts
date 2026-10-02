/**
 * Progressive media buffer — the piece that makes "preview without downloading
 * the whole file first" actually work.
 *
 * There are two strategies, chosen at runtime:
 *
 * 1. `MediaSource` (MSE) — we append arriving chunks straight into a
 *    `SourceBuffer` that a `<video>`/`<audio>` element is already playing from.
 *    Playback starts as soon as the container header (ftyp/moov, or an Ogg/WebM
 *    header) has arrived. This is the good path.
 *
 * 2. Blob fallback — accumulate chunks in memory and hand out an object URL
 *    once the transfer completes. Correct, but the user waits for the whole
 *    file. Used when the MIME type is not supported by the browser's MSE
 *    implementation.
 *
 * Known limitation (documented in the README): MSE can only start playback
 * early if the container header is at the *front* of the file. MP4s written by
 * ffmpeg without `-movflags +faststart` put `moov` at the end, so those buffer
 * completely before playing — we cannot seek inside them without a real range
 * request protocol. The abstraction below already accepts byte ranges, so
 * adding `file-range-request` later does not require changing the player.
 */

import type { IncomingTransferSink } from "@/lib/file-transfer/receiver";

export type ProgressiveMediaMode = "mse" | "buffered";

export function canUseMediaSource(mimeType: string): boolean {
  if (typeof MediaSource === "undefined") return false;
  const mime = normalizeMime(mimeType);
  if (!mime) return false;
  try {
    return MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

function normalizeMime(mimeType: string): string | null {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  return mime && mime !== "application/octet-stream" ? mime : null;
}

interface MediaSourceSink extends IncomingTransferSink {
  readonly mode: ProgressiveMediaMode;
  readonly url: string | null;
  /** 0..1 once enough of the header has arrived for playback to be possible. */
  readonly readyToPlay: boolean;
  destroy(): void;
}

export interface ProgressiveMediaOptions {
  mimeType: string;
  /** Preferred handling; MSE is used when the browser supports the type. */
  prefer?: ProgressiveMediaMode;
  /** Called the first time the media element can realistically start. */
  onReady?: () => void;
  onError?: (message: string) => void;
}

export function createProgressiveMediaBuffer(
  options: ProgressiveMediaOptions,
): MediaSourceSink {
  const mime = normalizeMime(options.mimeType);
  const prefer = options.prefer ?? "mse";

  if (prefer === "mse" && mime && canUseMediaSource(mime)) {
    return new MediaSourceSinkImpl(mime, options);
  }
  return new BlobSinkImpl(mime ?? "application/octet-stream", options);
}

/* ------------------------------------------------------------------ */
/* Strategy 1: MediaSource Extensions                                  */
/* ------------------------------------------------------------------ */

class MediaSourceSinkImpl implements MediaSourceSink {
  readonly mode = "mse" as const;

  private readonly mediaSource: MediaSource;
  private readonly sourceBuffer: SourceBuffer;
  private readonly objectUrl: string;
  private bytesAppended = 0;
  private readyNotified = false;
  private destroyed = false;
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private ended = false;
  private onReady: (() => void) | undefined;
  private onError: ((message: string) => void) | undefined;

  constructor(
    private readonly mime: string,
    options: ProgressiveMediaOptions,
  ) {
    this.onReady = options.onReady;
    this.onError = options.onError;

    this.mediaSource = new MediaSource();
    // The object URL must exist before the player element is mounted, which is
    // why `url` is a plain getter rather than something set on completion.
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.sourceBuffer = this.mediaSource.addSourceBuffer(mime);
    this.sourceBuffer.mode = "segments";

    this.sourceBuffer.addEventListener("updateend", () => {
      this.flushQueue();
      this.maybeNotifyReady();
      this.finishIfDrained();
    });
    this.sourceBuffer.addEventListener("error", () => {
      this.onError?.("This browser could not play the incoming media stream.");
    });
  }

  get url(): string {
    return this.objectUrl;
  }

  get readyToPlay(): boolean {
    return this.readyNotified;
  }

  write(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.destroyed || this.ended) return;
    this.bytesAppended += chunk.byteLength;

    if (this.mediaSource.readyState !== "open" || this.sourceBuffer.updating) {
      // Never overlap `appendBuffer`: queue and drain on `updateend`.
      this.queue.push(chunk);
      return;
    }
    this.sourceBuffer.appendBuffer(chunk);
    this.maybeNotifyReady();
  }

  end(): void {
    if (this.destroyed || this.ended) return;
    this.ended = true;
    this.flushQueue();
    this.finishIfDrained();
  }

  /**
   * Close the stream, but only once every queued chunk has actually been
   * appended. Calling `endOfStream()` while appends are outstanding makes the
   * player treat a truncated file as complete, and calling it while the
   * SourceBuffer is updating throws `InvalidStateError`.
   */
  private finishIfDrained(): void {
    if (this.destroyed || !this.ended) return;
    if (this.mediaSource.readyState !== "open") return;
    if (this.sourceBuffer.updating) return;

    if (this.queue.length > 0) {
      this.flushQueue();
      return;
    }

    try {
      this.mediaSource.endOfStream();
    } catch {
      // Another `endOfStream()` already won the race; nothing left to do.
    }
  }

  abort(reason: string): void {
    if (this.destroyed) return;
    this.ended = true;
    this.queue = [];
    try {
      if (this.sourceBuffer.updating) this.sourceBuffer.abort();
    } catch {
      // The MediaSource may already be torn down; nothing useful to do.
    }
    this.onError?.(reason);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue = [];
    try {
      if (this.mediaSource.readyState === "open") this.mediaSource.endOfStream();
    } catch {
      // ignore
    }
    URL.revokeObjectURL(this.objectUrl);
  }

  private flushQueue(): void {
    if (
      this.sourceBuffer.updating ||
      this.mediaSource.readyState !== "open" ||
      this.queue.length === 0
    ) {
      return;
    }
    const next = this.queue.shift();
    if (next) this.sourceBuffer.appendBuffer(next);
  }

  /**
   * MSE does not expose "enough data buffered for playback" directly, so we use
   * the buffered range: once the player can seek/buffer at least a second, it
   * is safe to show the player controls.
   */
  private maybeNotifyReady(): void {
    if (this.readyNotified || this.destroyed) return;
    if (this.mediaSource.readyState !== "open") return;
    if (this.bytesAppended < 64 * 1024) return;

    try {
      const buffered = this.sourceBuffer.buffered;
      if (buffered.length > 0 && buffered.end(0) > 0) {
        this.readyNotified = true;
        this.onReady?.();
      }
    } catch {
      // Safari throws when querying `buffered` before the first append lands.
    }
  }
}

/* ------------------------------------------------------------------ */
/* Strategy 2: accumulate into a Blob                                 */
/* ------------------------------------------------------------------ */

class BlobSinkImpl implements MediaSourceSink {
  readonly mode = "buffered" as const;

  private readonly parts: Uint8Array<ArrayBuffer>[] = [];
  private bytesAppended = 0;
  private objectUrl: string | null = null;
  private destroyed = false;
  private onReady: (() => void) | undefined;

  constructor(
    private readonly mime: string,
    options: ProgressiveMediaOptions,
  ) {
    this.onReady = options.onReady;
  }

  get url(): string | null {
    return this.objectUrl;
  }

  /** Only "ready" once the whole file is here — see the note at the top. */
  get readyToPlay(): boolean {
    return this.objectUrl !== null;
  }

  write(chunk: Uint8Array<ArrayBuffer>): void {
    if (this.destroyed) return;
    this.parts.push(chunk);
    this.bytesAppended += chunk.byteLength;
  }

  end(): void {
    if (this.destroyed || this.objectUrl !== null) return;
    const blob = new Blob(this.parts as BlobPart[], { type: this.mime });
    this.objectUrl = URL.createObjectURL(blob);
    this.parts.length = 0;
    this.onReady?.();
  }

  abort(): void {
    if (this.destroyed) return;
    this.parts.length = 0;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.parts.length = 0;
    if (this.objectUrl !== null) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}
