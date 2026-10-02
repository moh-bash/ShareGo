/**
 * File related domain types.
 *
 * A "shared file" is a file the local user has *explicitly* picked with a file
 * input (see `SharedFileStore`). The browser sandbox never lets us walk the
 * filesystem, so this list is the entire universe of what we are willing to
 * hand to a peer.
 */

export type FileCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "archive"
  | "other";

/**
 * Serializable description of a shared file. This is what travels over the
 * WebRTC control DataChannel, so it must stay JSON-safe and must never contain
 * the `File` handle itself.
 */
export interface SharedFileMeta {
  /** Server-issued style id, unique within the sending device's session. */
  fileId: string;
  name: string;
  /** Size in bytes. */
  size: number;
  mimeType: string;
  /** `File.lastModified`, epoch millis. */
  lastModified: number;
  /**
   * Relative path when the user picked a folder (via `webkitdirectory`),
   * otherwise `null`. Only used for display/grouping on the receiver.
   */
  path: string | null;
  category: FileCategory;
}

/** A shared file together with the local handle used to read its bytes. */
export interface SharedFile extends SharedFileMeta {
  file: File;
}

export type TransferDirection = "send" | "receive";

export type TransferStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "cancelled"
  | "error";

/** Why we are moving a file: a preview player, or a save-to-disk download. */
export type TransferPurpose = "preview" | "download";

/**
 * A single row in the transfer panel. One row per direction per file: the
 * sender sees a `send` row, the receiver a `receive` row.
 */
export interface TransferRecord {
  /** Monotonic counter, scoped to the peer that created it. */
  transferId: number;
  peerId: string;
  peerName: string;
  fileId: string;
  name: string;
  size: number;
  mimeType: string;
  category: FileCategory;
  purpose: TransferPurpose;
  direction: TransferDirection;
  transferredBytes: number;
  /** Smoothed bytes/second, 0 until enough samples arrive. */
  speedBytesPerSecond: number;
  status: TransferStatus;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface ToastMessage {
  id: string;
  tone: "info" | "success" | "error";
  title: string;
  description?: string;
}
