/**
 * Chunked file *receiver*.
 *
 * Collects binary chunks into memory and hands them to a sink. The sink is
 * either a plain `Blob` builder (downloads) or a `ProgressiveMediaBuffer`
 * (previews), which is how we get "play while it is still arriving" without
 * pretending a DataChannel is a seekable HTTP stream.
 */

import { SpeedMeter } from "@/lib/file-transfer/speed";

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
    }
  }

  /** The sender confirmed the last chunk; flush the sink. */
  complete(): void {
    if (this.done) return;

    if (this.bytesReceived !== this.expectedBytes) {
      this.fail(
        new Error(
          `Transfer ended early: received ${this.bytesReceived} of ${this.expectedBytes} bytes.`,
        ),
      );
      return;
    }
    this.finish();
  }

  cancel(reason = "cancelled"): void {
    if (this.done) return;
    this.done = true;
    this.sink.abort(reason);
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;

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
    this.sink.abort(error.message);
    this.onError?.(error);
  }
}
