/**
 * The transfer engine: the only component that reads or writes file bytes.
 *
 * Responsibilities
 *  - Answer a peer's `file-request` by streaming a range of a shared file
 *    (queueing when several requests arrive at once).
 *  - Own the receiving side of a transfer we asked for, routing chunks into a
 *    Blob sink (download) or a ProgressiveMediaBuffer (preview).
 *  - Keep the transfer panel and artifact store up to date.
 *  - Tear everything down cleanly when a peer disappears.
 *
 * It talks to peers through the small `DataPlane` interface, so it has no
 * dependency on `RTCPeerConnection` and could be driven by any transport.
 */

import { ArtifactStore } from "@/lib/app-store";
import { decodeChunkFrame } from "@/lib/file-transfer/frame";
import { createProgressiveMediaBuffer } from "@/lib/file-transfer/progressive-media";
import { ChunkReceiver, type IncomingTransferSink } from "@/lib/file-transfer/receiver";
import { SharedFileStore } from "@/lib/file-transfer/shared-file-store";
import { ChunkSender } from "@/lib/file-transfer/sender";
import { TransferStore } from "@/lib/file-transfer/transfer-store";
import { getTransferConfig } from "@/lib/webrtc/config";
import { createCounter } from "@/lib/utils/id";
import type { TransferPurpose } from "@/types/files";
import type { DeviceType } from "@/types/signaling";
import type { ControlMessage, SharedFileMetaLite } from "@/types/webrtc";

/** Shown when a peer goes away mid-transfer; both sides see their own wording. */
const TRANSFER_LOST = "The connection dropped before this file finished.";
/** How long a self-releasing download keeps its blob alive after auto-save. */
const SAVED_ARTIFACT_GRACE_MS = 30_000;

/** What the engine needs from a connected peer in order to move bytes. */
export interface DataPlane {
  peerId: string;
  peerName: string;
  deviceType: DeviceType;
  /** The binary channel; `ChunkSender` needs it to apply backpressure. */
  channel: RTCDataChannel;
  isOpen(): boolean;
  sendControl(message: ControlMessage): void;
  sendBytes(frame: ArrayBuffer): void;
}

/* ------------------------------------------------------------------ */
/* Internal per-transfer bookkeeping                                   */
/* ------------------------------------------------------------------ */

interface OutgoingTransfer {
  transferId: number;
  peerId: string;
  sender: ChunkSender | null;
  cancelled: boolean;
  /** Resolves once the sender finishes, so the queue can free a slot. */
  done: Promise<void>;
}

interface IncomingTransfer {
  transferId: number;
  peerId: string;
  receiver: ChunkReceiver;
  artifactId: string;
  /** Releases the MediaSource / object URL. */
  dispose: () => void;
  cancelled: boolean;
}

interface QueuedRequest {
  transferId: number;
  peerId: string;
  fileId: string;
  purpose: TransferPurpose;
  offset: number;
  length: number;
  meta: SharedFileMetaLite;
}

export interface TransferEngineOptions {
  files: SharedFileStore;
  transfers: TransferStore;
  artifacts: ArtifactStore;
}

export class TransferEngine {
  readonly files: SharedFileStore;
  readonly transfers: TransferStore;
  readonly artifacts: ArtifactStore;

  private planes = new Map<string, DataPlane>();
  private outgoing = new Map<string, OutgoingTransfer>();
  private incoming = new Map<string, IncomingTransfer>();
  private queues = new Map<string, QueuedRequest[]>();
  private releaseTimers = new Set<ReturnType<typeof setTimeout>>();
  private nextTransferId = createCounter(1);

  constructor(options: TransferEngineOptions) {
    this.files = options.files;
    this.transfers = options.transfers;
    this.artifacts = options.artifacts;
  }

  /* -------------------------------------------------------------- */
  /* Peer lifecycle                                                  */
  /* -------------------------------------------------------------- */

  registerPlane(plane: DataPlane): void {
    this.planes.set(plane.peerId, plane);
  }

  unregisterPlane(peerId: string): void {
    this.planes.delete(peerId);
    this.queues.delete(peerId);

    for (const [key, transfer] of [...this.outgoing]) {
      if (transfer.peerId !== peerId) continue;
      transfer.cancelled = true;
      transfer.sender?.cancel();
      this.outgoing.delete(key);
    }

    for (const [key, transfer] of [...this.incoming]) {
      if (transfer.peerId !== peerId) continue;
      transfer.cancelled = true;
      transfer.receiver.cancel(TRANSFER_LOST);
      transfer.dispose();
      this.incoming.delete(key);
      // The bytes are gone, but the artifact stays so whatever is showing it
      // (a preview dialog, a progress row) can say *why* instead of silently
      // reverting to an empty "waiting for data" spinner.
      this.artifacts.patch(transfer.artifactId, {
        status: "error",
        error: TRANSFER_LOST,
      });
      this.transfers.update(peerId, transfer.transferId, {
        status: "error",
        error: TRANSFER_LOST,
        speedBytesPerSecond: 0,
      });
    }

    this.transfers.clearPeer(peerId);
  }

  /** Push our current shared file list to a newly connected peer. */
  sendFileList(peerId: string): void {
    const plane = this.planes.get(peerId);
    if (!plane?.isOpen()) return;
    plane.sendControl({ type: "file-list", files: this.files.list() });
  }

  /** Ask a peer to (re)send its shared file list. */
  requestFileList(peerId: string): void {
    const plane = this.planes.get(peerId);
    if (!plane?.isOpen()) return;
    plane.sendControl({ type: "file-list-request" });
  }

  /** Tell every connected peer our shared list changed. */
  broadcastFilesChanged(): void {
    for (const plane of this.planes.values()) {
      if (!plane.isOpen()) continue;
      plane.sendControl({ type: "files-changed" });
    }
  }

  /* -------------------------------------------------------------- */
  /* Inbound control messages                                        */
  /* -------------------------------------------------------------- */

  handleControl(peerId: string, message: ControlMessage): void {
    switch (message.type) {
      case "file-list-request":
        this.sendFileList(peerId);
        return;

      case "file-request":
        this.enqueueIncomingRequest(peerId, message);
        return;

      case "transfer-done": {
        this.incoming
          .get(TransferStore.key(peerId, message.transferId))
          ?.receiver.complete(message.bytesSent);
        return;
      }

      case "transfer-error": {
        const key = TransferStore.key(peerId, message.transferId);
        const receiver = this.incoming.get(key);
        if (receiver) {
          receiver.receiver.cancel(message.message);
          this.incoming.delete(key);
          this.transfers.update(peerId, message.transferId, {
            status: message.code === "cancelled" ? "cancelled" : "error",
            error: message.message,
            speedBytesPerSecond: 0,
          });
        } else {
          const sender = this.outgoing.get(key);
          if (sender) {
            sender.sender?.cancel();
            this.outgoing.delete(key);
            this.drainQueue(peerId);
          }
        }
        return;
      }

      case "cancel-transfer": {
        const key = TransferStore.key(peerId, message.transferId);
        const sender = this.outgoing.get(key);
        if (sender) {
          sender.cancelled = true;
          sender.sender?.cancel();
          this.outgoing.delete(key);
          this.drainQueue(peerId);
        }
        const receiver = this.incoming.get(key);
        if (receiver) {
          receiver.cancelled = true;
          receiver.receiver.cancel("Cancelled by the other device.");
          receiver.dispose();
          this.incoming.delete(key);
          this.artifacts.patch(receiver.artifactId, {
            status: "cancelled",
            error: "Cancelled by the other device.",
          });
          this.transfers.update(peerId, message.transferId, {
            status: "cancelled",
            error: null,
            speedBytesPerSecond: 0,
          });
        }
        return;
      }

      case "control-ping":
        this.planes.get(peerId)?.sendControl({ type: "control-pong", at: message.at });
        return;

      default:
        return;
    }
  }

  /** Inbound binary frame on the `file` channel. */
  handleChunk(peerId: string, buffer: ArrayBuffer): void {
    const frame = decodeChunkFrame(buffer);
    if (!frame) return;

    const transfer = this.incoming.get(TransferStore.key(peerId, frame.transferId));
    if (!transfer) return; // Late chunk for a cancelled transfer; ignore it.

    void transfer.receiver.acceptChunk(frame.sequence, frame.payload);
  }

  /* -------------------------------------------------------------- */
  /* Outbound: serve a peer's request                                */
  /* -------------------------------------------------------------- */

  private enqueueIncomingRequest(
    peerId: string,
    message: {
      transferId: number;
      fileId: string;
      purpose: TransferPurpose;
      offset: number;
      length: number;
    },
  ): void {
    const plane = this.planes.get(peerId);
    if (!plane) return;

    const key = TransferStore.key(peerId, message.transferId);
    if (this.outgoing.has(key)) return; // Duplicate request; ignore.

    const file = this.files.get(message.fileId);
    if (!file) {
      plane.sendControl({
        type: "transfer-error",
        transferId: message.transferId,
        code: "unknown-file",
        message: "That file is no longer shared on this device.",
      });
      return;
    }

    const length = Math.min(message.length, file.size - message.offset);
    if (length <= 0) {
      plane.sendControl({
        type: "transfer-error",
        transferId: message.transferId,
        code: "io-error",
        message: "The requested range is outside the file.",
      });
      return;
    }

    const queue = this.queues.get(peerId) ?? [];
    queue.push({
      transferId: message.transferId,
      peerId,
      fileId: message.fileId,
      purpose: message.purpose,
      offset: message.offset,
      length,
      meta: {
        fileId: file.fileId,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        lastModified: file.lastModified,
        path: file.path,
        category: file.category,
      },
    });
    this.queues.set(peerId, queue);
    this.drainQueue(peerId);
  }

  private activeSendCount(peerId: string): number {
    let count = 0;
    for (const transfer of this.outgoing.values()) {
      if (transfer.peerId === peerId) count += 1;
    }
    return count;
  }

  /** Start queued requests while we are below the concurrency limit. */
  private drainQueue(peerId: string): void {
    const config = getTransferConfig();
    const queue = this.queues.get(peerId);
    if (!queue || queue.length === 0) return;

    while (this.activeSendCount(peerId) < config.maxConcurrentSends && queue.length > 0) {
      const request = queue.shift();
      if (request) this.startSend(request);
    }
    this.queues.set(peerId, queue);
  }

  private startSend(request: QueuedRequest): void {
    const plane = this.planes.get(request.peerId);
    const file = this.files.get(request.fileId);
    if (!plane || !file) return;

    const { transferId, peerId } = request;
    const key = TransferStore.key(peerId, transferId);

    this.transfers.update(peerId, transferId, {
      peerName: plane.peerName,
      fileId: file.fileId,
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
      category: file.category,
      purpose: request.purpose,
      direction: "send",
      status: "streaming",
      error: null,
      startedAt: Date.now(),
    });

    const transfer: OutgoingTransfer = {
      transferId,
      peerId,
      sender: null,
      cancelled: false,
      done: Promise.resolve(),
    };
    this.outgoing.set(key, transfer);

    const sender = new ChunkSender({
      transferId,
      channel: plane.channel,
      file: file.file,
      offset: request.offset,
      length: request.length,
      onProgress: (bytesSent, speed) => {
        this.transfers.update(peerId, transferId, {
          transferredBytes: bytesSent,
          speedBytesPerSecond: speed,
          status: "streaming",
        });
      },
      onDone: (bytesSent) => {
        this.outgoing.delete(key);
        this.transfers.update(peerId, transferId, {
          status: "complete",
          transferredBytes: bytesSent,
          speedBytesPerSecond: 0,
        });
        plane.sendControl({ type: "transfer-done", transferId, bytesSent });
        this.drainQueue(peerId);
      },
      onError: (error) => {
        this.outgoing.delete(key);
        this.transfers.update(peerId, transferId, {
          status: "error",
          error: error.message,
          speedBytesPerSecond: 0,
        });
        plane.sendControl({
          type: "transfer-error",
          transferId,
          code: "io-error",
          message: error.message,
        });
        this.drainQueue(peerId);
      },
    });

    transfer.sender = sender;
    transfer.done = sender.run().then(() => {
      if (!this.outgoing.has(key)) return;
      // Sender stopped without onDone/onError (e.g. the channel closed).
      this.outgoing.delete(key);
      this.drainQueue(peerId);
    });
  }

  /* -------------------------------------------------------------- */
  /* Inbound: request a file from a peer                            */
  /* -------------------------------------------------------------- */

  /**
   * Start receiving `meta` from `peerId`. Returns the artifact id.
   *
   * `disposeAfterSave` marks a download nobody is going to look at again: the
   * remote browser's Download button. The bytes are handed to the browser's
   * download manager and the artifact is dropped, because the only thing that
   * can still reference it would have to be an open preview dialog, and that
   * dialog asks for its own copy. Without this, every download keeps a full Blob
   * and a live object URL for the lifetime of the tab.
   */
  requestFile(
    peerId: string,
    meta: SharedFileMetaLite,
    purpose: TransferPurpose,
    options?: { disposeAfterSave?: boolean },
  ): string {
    const plane = this.planes.get(peerId);
    if (!plane?.isOpen()) {
      throw new Error("That device is not connected right now.");
    }

    const transferId = this.nextTransferId();
    const key = TransferStore.key(peerId, transferId);
    const artifactId = key;
    const category = meta.category;

    // Previews stream into MediaSource when possible; downloads always
    // assemble a Blob so the browser can save it.
    const media = createProgressiveMediaBuffer({
      mimeType: meta.mimeType,
      prefer: purpose === "preview" ? "mse" : "buffered",
    });

    this.artifacts.set(
      artifactId,
      {
        id: artifactId,
        key,
        peerId,
        peerName: plane.peerName,
        fileId: meta.fileId,
        name: meta.name,
        mimeType: meta.mimeType,
        size: meta.size,
        category,
        purpose,
        mode: media.mode,
        url: media.url,
        status: "streaming",
        bytesReceived: 0,
        error: null,
      },
      () => media.destroy(),
    );

    const sink: IncomingTransferSink = {
      write: (chunk) => media.write(chunk),
      end: () => media.end(),
      abort: (reason) => {
        media.abort(reason);
        this.artifacts.patch(artifactId, { status: "error", error: reason });
      },
    };

    const receiver = new ChunkReceiver({
      transferId,
      expectedBytes: meta.size,
      sink,
      onProgress: (bytesReceived, speed) => {
        this.transfers.update(peerId, transferId, {
          transferredBytes: bytesReceived,
          speedBytesPerSecond: speed,
          status: "streaming",
        });
        this.artifacts.patch(artifactId, { bytesReceived });
      },
      onComplete: () => {
        this.incoming.delete(key);
        this.transfers.update(peerId, transferId, {
          status: "complete",
          transferredBytes: meta.size,
          speedBytesPerSecond: 0,
        });
        // The MSE URL is stable; the blob URL only exists now.
        this.artifacts.patch(artifactId, {
          status: "complete",
          url: media.url,
          bytesReceived: meta.size,
        });
        // A download the user explicitly asked for should land in their
        // downloads folder without a second click. Previews never do this —
        // nobody wants a previewed file silently saved.
        if (purpose === "download") {
          this.saveArtifact(artifactId);
          if (options?.disposeAfterSave) this.releaseAfterSave(artifactId);
        }
      },
      onError: (error) => {
        this.incoming.delete(key);
        this.transfers.update(peerId, transferId, {
          status: "error",
          error: error.message,
          speedBytesPerSecond: 0,
        });
      },
    });

    this.incoming.set(key, {
      transferId,
      peerId,
      receiver,
      artifactId,
      dispose: () => media.destroy(),
      cancelled: false,
    });

    this.transfers.update(peerId, transferId, {
      peerName: plane.peerName,
      fileId: meta.fileId,
      name: meta.name,
      size: meta.size,
      mimeType: meta.mimeType,
      category,
      purpose,
      direction: "receive",
      status: "pending",
      error: null,
      startedAt: Date.now(),
    });

    plane.sendControl({
      type: "file-request",
      transferId,
      fileId: meta.fileId,
      purpose,
      offset: 0,
      length: meta.size,
    });

    return artifactId;
  }

  /** Cancel either direction of a transfer. */
  cancelTransfer(peerId: string, transferId: number): void {
    const key = TransferStore.key(peerId, transferId);
    const plane = this.planes.get(peerId);

    const sender = this.outgoing.get(key);
    if (sender) {
      sender.cancelled = true;
      sender.sender?.cancel();
      this.outgoing.delete(key);
      this.transfers.update(peerId, transferId, {
        status: "cancelled",
        speedBytesPerSecond: 0,
      });
      this.drainQueue(peerId);
    }

    const receiver = this.incoming.get(key);
    if (receiver) {
      receiver.cancelled = true;
      receiver.receiver.cancel("You cancelled this transfer.");
      this.incoming.delete(key);
      this.artifacts.patch(receiver.artifactId, {
        status: "cancelled",
        error: "You cancelled this transfer.",
      });
      this.transfers.update(peerId, transferId, {
        status: "cancelled",
        speedBytesPerSecond: 0,
      });
    }

    if (plane?.isOpen()) {
      plane.sendControl({ type: "cancel-transfer", transferId });
    }
  }

  /**
   * Free the bytes held for a preview/download the user has closed.
   *
   * Releasing an artifact that is still streaming also cancels the transfer and
   * tells the peer to stop: otherwise the sender keeps pushing chunks into a
   * sink that throws them away, and the row in the transfer panel never
   * terminates.
   */
  releaseArtifact(artifactId: string): void {
    // An artifact id *is* the transfer key (`requestFile` sets `artifactId = key`).
    const transfer = this.incoming.get(artifactId);
    if (transfer) {
      const { peerId, transferId } = transfer;
      transfer.cancelled = true;
      transfer.receiver.cancel("You closed it.");
      transfer.dispose();
      this.incoming.delete(artifactId);
      this.transfers.update(peerId, transferId, {
        status: "cancelled",
        speedBytesPerSecond: 0,
      });

      const plane = this.planes.get(peerId);
      if (plane?.isOpen()) {
        plane.sendControl({ type: "cancel-transfer", transferId });
      }
    }

    this.artifacts.release(artifactId);
  }

  /**
   * Release an artifact after the browser has taken the bytes.
   *
   * `anchor.click()` hands the blob URL to the download manager, which may not
   * have read it yet when the call returns, so the object URL cannot be revoked
   * synchronously — doing so is the classic way to produce an empty file. The
   * grace period is only paid by downloads nothing else can reference.
   */
  private releaseAfterSave(artifactId: string): void {
    const timer = setTimeout(() => {
      this.releaseTimers.delete(timer);
      this.releaseArtifact(artifactId);
    }, SAVED_ARTIFACT_GRACE_MS);
    this.releaseTimers.add(timer);
  }

  /**
   * Hand finished bytes to the browser's download manager. The Blob is kept
   * until `releaseArtifact`, so an open preview dialog can offer "Save again".
   */
  saveArtifact(artifactId: string): boolean {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact?.url) return false;

    const anchor = document.createElement("a");
    anchor.href = artifact.url;
    anchor.download = artifact.name;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  dispose(): void {
    for (const timer of this.releaseTimers) clearTimeout(timer);
    this.releaseTimers.clear();
    for (const transfer of this.outgoing.values()) transfer.sender?.cancel();
    for (const transfer of this.incoming.values()) transfer.dispose();
    this.outgoing.clear();
    this.incoming.clear();
    this.queues.clear();
    this.planes.clear();
    this.artifacts.clear();
    this.transfers.clear();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
