/**
 * Chunked file *receiver*.
 *
 * Collects binary chunks into memory and hands them to a sink. The sink is
 * either a plain `Blob` builder (downloads) or a `ProgressiveMediaBuffer`
 * (previews), which is how we get "play while it is still arriving" without
 * pretending a DataChannel is a seekable HTTP stream.
 */

import { SpeedMeter } from "@/lib/file-transfer/speed";

/**
 * How long to keep waiting for payload bytes after `transfer-done` has overtaken
 * them. Generous, because it only runs while a transfer is genuinely in flight.
 */
const DRAIN_TIMEOUT_MS = 15_000;

export interface IncomingTransferSink {
  /** Called for every chunk, in arrival order. */
  write(chunk: Uint8Array): void | Promise<void>;
  /** Called exactly once, after the final chunk. */
  end(): void | Promise<void>;
  /** Aborted by the user or by a peer error. */
  abort(reason: string): void;
}

export interface ChunkReceiverOptions {
  transferId: number;
  expectedBytes: number;
  sink: IncomingTransferSink;
  onProgress?: (bytesReceived: number, speedBytesPerSecond: number) => void;
  onComplete?: () => void;
  onError?: (error: Error) => void;
}

export class ChunkReceiver {
  readonly transferId: number;
  private readonly meter = new SpeedMeter();
  private readonly sink: IncomingTransferSink;
  private readonly expectedBytes: number;

  private bytesReceived = 0;
  private nextSequence = 0;
  private done = false;
  private onProgress: ChunkReceiverOptions["onProgress"];
  private onComplete: ChunkReceiverOptions["onComplete"];
  private onError: ChunkReceiverOptions["onError"];
  /** Serialises sink writes: SourceBuffer.appendBuffer cannot overlap. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Bytes the sender said it sent, while we are still waiting for them. */
  private drainUntil: number | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ChunkReceiverOptions) {
    this.transferId = options.transferId;
    this.expectedBytes = options.expectedBytes;
    this.sink = options.sink;
    this.onProgress = options.onProgress;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
  }

  get bytesReceivedSoFar(): number {
    return this.bytesReceived;
  }

  /**
   * Handle one binary frame. `sequence` gaps mean the DataChannel dropped or
   * reordered something, which cannot happen on an ordered channel — so a gap
   * means a protocol bug and we abort loudly rather than writing a corrupt file.
   */
  async acceptChunk(sequence: number, payload: Uint8Array): Promise<void> {
    if (this.done) return;

    if (sequence !== this.nextSequence) {
      this.fail(
        new Error(
          `Received chunk ${sequence} while waiting for ${this.nextSequence}. The transfer was interrupted.`,
        ),
      );
      return;
    }
    this.nextSequence += 1;

    this.bytesReceived += payload.byteLength;
    this.writeChain = this.writeChain.then(() => this.sink.write(payload));

    this.onProgress?.(this.bytesReceived, this.meter.update(this.bytesReceived));

    try {
      await this.writeChain;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (this.bytesReceived >= this.expectedBytes) {
      this.finish();
      return;
    }

    // `transfer-done` may already have arrived over the control channel. Keep
    // draining until the sender's byte count arrives, or the stall timeout fires.
    if (this.drainUntil !== null && this.bytesReceived >= this.drainUntil) {
      this.fail(
        new Error(
          `Transfer ended early: received ${this.bytesReceived} of ${this.expectedBytes} bytes.`,
        ),
      );
    }
  }

  /**
   * The sender confirmed it handed every byte to the DataChannel.
   *
   * This message arrives on the *control* channel while the payload arrives on
   * the *file* channel. Two channels are two independent ordered streams with no
   * ordering between them, and the control channel is empty, so this arrives
   * first whenever the sender still had file bytes queued — which is exactly the
   * interesting case, because a sender only has a backlog if it was pushing
   * large chunks quickly. Treating the message as "the bytes are all here" made
   * transfers of a few hundred kilobytes fail at whatever power-of-two boundary
   * the backlog happened to sit at.
   *
   * So it is advisory: it tells us how many bytes to expect, and we wait for
   * them. `expectedBytes` remains the authority on whether the file was complete.
   */
  complete(bytesSent: number): void {
    if (this.done) return;

    if (this.bytesReceived >= this.expectedBytes) {
      this.finish();
      return;
    }

    // The sender sent fewer bytes than it advertised: a genuine truncation, and
    // waiting cannot help.
    if (bytesSent <= this.bytesReceived) {
      this.fail(
        new Error(
          `Transfer ended early: received ${this.bytesReceived} of ${this.expectedBytes} bytes.`,
        ),
      );
      return;
    }

    // More bytes are on the file channel than have arrived. Let the chunks land.
    this.drainUntil = bytesSent;
    if (this.drainTimer === null) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (this.done || this.drainUntil === null) return;
        this.fail(
          new Error(
            `Transfer stalled: received ${this.bytesReceived} of ${this.drainUntil} bytes.`,
          ),
        );
      }, DRAIN_TIMEOUT_MS);
    }
  }

  cancel(reason = "cancelled"): void {
    if (this.done) return;
    this.done = true;
    this.clearDrain();
    this.sink.abort(reason);
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.clearDrain();

    this.writeChain
      .then(() => this.sink.end())
      .then(() => this.onComplete?.())
      .catch((error) => {
        this.sink.abort(error instanceof Error ? error.message : String(error));
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private fail(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.clearDrain();
    this.sink.abort(error.message);
    this.onError?.(error);
  }

  private clearDrain(): void {
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.drainUntil = null;
  }
}
