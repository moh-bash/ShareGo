/**
 * Chunked file *sender* with real backpressure.
 *
 * Why this class exists: `RTCDataChannel.send()` returns immediately and queues
 * bytes in the browser's send buffer. A naive `while (offset < size) send(chunk)`
 * on a 500 MB file will queue half a gigabyte in memory and kill the tab (or
 * the receiving device). So before each chunk we check `bufferedAmount` and
 * yield until the browser drains the queue.
 *
 * `bufferedamountlow` is the event-based way to do that; we also poll as a
 * fallback because Safari does not always fire it promptly.
 */

import { encodeChunkFrame } from "@/lib/file-transfer/frame";
import { SpeedMeter } from "@/lib/file-transfer/speed";
import { getTransferConfig } from "@/lib/webrtc/config";

export interface ChunkSenderOptions {
  transferId: number;
  channel: RTCDataChannel;
  file: File | Blob;
  /** Absolute offset into the blob where this transfer starts. */
  offset: number;
  /** Number of bytes to send (may be less than the remaining blob size). */
  length: number;
  onProgress?: (bytesSent: number, speedBytesPerSecond: number) => void;
  onDone?: (bytesSent: number) => void;
  onError?: (error: Error) => void;
}

export class ChunkSender {
  private readonly transferId: number;
  private readonly channel: RTCDataChannel;
  private readonly blob: Blob;
  private readonly offset: number;
  private readonly length: number;
  private readonly meter = new SpeedMeter();

  private bytesSent = 0;
  private sequence = 0;
  private cancelled = false;
  private waiters: Array<() => void> = [];
  private detach: Array<() => void> = [];
  private finished = false;

  constructor(private readonly options: ChunkSenderOptions) {
    this.transferId = options.transferId;
    this.channel = options.channel;
    this.blob = options.file;
    this.offset = options.offset;
    this.length = Math.min(options.length, options.file.size - options.offset);
  }

  get bytesSentSoFar(): number {
    return this.bytesSent;
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    this.resolveWaiters();
    this.release();
  }

  /**
   * Start streaming. Resolves when the whole range has been handed to the
   * DataChannel (and therefore also handed to the network), or when cancelled.
   */
  async run(): Promise<void> {
    const config = getTransferConfig();

    try {
      while (this.bytesSent < this.length) {
        if (this.cancelled) return;
        if (this.channel.readyState !== "open") {
          throw new Error("The peer connection closed before the file finished sending.");
        }

        // ---- backpressure gate -------------------------------------------
        // Once more than HIGH_WATER_MARK bytes are queued in the send buffer,
        // stop producing and wait for the browser to drain it. Without this a
        // fast sender would balloon memory and starve the receive loop.
        while (this.channel.bufferedAmount > config.highWaterMark) {
          if (this.cancelled) return;
          await this.waitForDrain();
        }
        // ------------------------------------------------------------------

        const remaining = this.length - this.bytesSent;
        const size = Math.min(config.chunkSize, remaining);
        const start = this.offset + this.bytesSent;

        // `Blob.slice` is lazy: no bytes are copied until `arrayBuffer()`.
        const slice = this.blob.slice(start, start + size);
        const buffer = await slice.arrayBuffer();

        if (this.cancelled) return;

        const frame = encodeChunkFrame(this.transferId, this.sequence, buffer);
        this.channel.send(frame);

        this.bytesSent += buffer.byteLength;
        this.sequence += 1;

        const speed = this.meter.update(this.bytesSent);
        this.options.onProgress?.(this.bytesSent, speed);
      }

      if (this.cancelled) return;
      this.finished = true;
      this.release();
      this.options.onDone?.(this.bytesSent);
    } catch (error) {
      this.finished = true;
      this.resolveWaiters();
      this.release();
      if (!this.cancelled) {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /** Resolves as soon as the send buffer drops to the low water mark. */
  private waitForDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      let poll: ReturnType<typeof setInterval> | null = null;
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        this.channel.removeEventListener("bufferedamountlow", done);
        if (poll !== null) clearInterval(poll);
        resolve();
      };

      this.channel.addEventListener("bufferedamountlow", done);

      // Fallback poll: some browsers are lazy about firing bufferedamountlow.
      poll = setInterval(() => {
        if (this.channel.bufferedAmount <= getTransferConfig().lowWaterMark) done();
      }, 50);

      this.waiters.push(done);
    });
  }

  private resolveWaiters(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private release(): void {
    for (const off of this.detach) off();
    this.detach = [];
  }
}
