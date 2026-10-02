/**
 * Runtime validation for the DataChannel control protocol.
 *
 * Everything here arrives from another machine, so we treat it as hostile:
 * unknown message types are dropped, sizes are capped, and string fields are
 * truncated rather than rejected where a long value is still display-safe.
 */

import type { ControlMessage, SharedFileMetaLite, TransferErrorCode } from "@/types/webrtc";
import { coerceFileCategory } from "@/lib/utils/format";
import { isRecord } from "@/lib/signaling/protocol";

export const CONTROL_LIMITS = {
  /** A file list is capped so a peer cannot stall us with 100k entries. */
  maxFilesPerList: 2000,
  maxNameLength: 180,
  maxPathLength: 512,
  maxMimeLength: 128,
  maxIdLength: 64,
  maxErrorMessageLength: 200,
  /** Refuse to allocate a Blob larger than this (2 GiB). */
  maxTransferBytes: 2 * 1024 * 1024 * 1024,
} as const;

function readString(
  source: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | null {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function readInt(
  source: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | null {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

function readFileMeta(value: unknown): SharedFileMetaLite | null {
  if (!isRecord(value)) return null;

  const fileId = readString(value, "fileId", CONTROL_LIMITS.maxIdLength);
  const name = readString(value, "name", CONTROL_LIMITS.maxNameLength);
  if (!fileId || !name) return null;

  const size = readInt(value, "size", 0, CONTROL_LIMITS.maxTransferBytes);
  if (size === null) return null;

  const mimeType = readString(value, "mimeType", CONTROL_LIMITS.maxMimeLength) ?? "";
  const path = readString(value, "path", CONTROL_LIMITS.maxPathLength);
  // The peer chooses this string, so it is validated here rather than trusted.
  const category = coerceFileCategory(
    readString(value, "category", 32) ?? "",
    name,
    mimeType,
  );
  const lastModified =
    readInt(value, "lastModified", 0, Number.MAX_SAFE_INTEGER) ?? 0;

  return {
    fileId,
    name,
    size,
    mimeType,
    lastModified,
    path: path ?? null,
    category,
  };
}

const TRANSFER_ERROR_CODES: readonly TransferErrorCode[] = [
  "unknown-file",
  "busy",
  "too-many",
  "io-error",
  "cancelled",
  "protocol-error",
];

/** Transfer ids are u32 on the wire, so keep the same range here. */
const MAX_TRANSFER_ID = 0xffffffff;

/**
 * Parse one JSON control frame. Returns `null` for anything unrecognised or
 * malformed; the caller logs and moves on.
 */
export function parseControlMessage(raw: string): ControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;

  switch (value.type) {
    case "control-hello": {
      const deviceName = readString(value, "deviceName", CONTROL_LIMITS.maxNameLength);
      if (!deviceName) return null;
      return { type: "control-hello", protocol: 1, deviceName };
    }

    case "files-changed":
      return { type: "files-changed" };

    case "file-list-request":
      return { type: "file-list-request" };

    case "file-list": {
      const files = value.files;
      if (!Array.isArray(files)) return null;
      const parsed: SharedFileMetaLite[] = [];
      for (const entry of files.slice(0, CONTROL_LIMITS.maxFilesPerList)) {
        const meta = readFileMeta(entry);
        if (meta) parsed.push(meta);
      }
      return { type: "file-list", files: parsed };
    }

    case "file-request": {
      const transferId = readInt(value, "transferId", 1, MAX_TRANSFER_ID);
      const fileId = readString(value, "fileId", CONTROL_LIMITS.maxIdLength);
      if (transferId === null || !fileId) return null;

      const purpose = value.purpose === "download" ? "download" : "preview";
      const offset = readInt(value, "offset", 0, CONTROL_LIMITS.maxTransferBytes) ?? 0;
      const length = readInt(value, "length", 1, CONTROL_LIMITS.maxTransferBytes);
      if (length === null) return null;

      return { type: "file-request", transferId, fileId, purpose, offset, length };
    }

    case "transfer-done": {
      const transferId = readInt(value, "transferId", 1, MAX_TRANSFER_ID);
      if (transferId === null) return null;
      const bytesSent = readInt(value, "bytesSent", 0, CONTROL_LIMITS.maxTransferBytes) ?? 0;
      return { type: "transfer-done", transferId, bytesSent };
    }

    case "transfer-error": {
      const transferId = readInt(value, "transferId", 1, MAX_TRANSFER_ID);
      if (transferId === null) return null;
      const code = TRANSFER_ERROR_CODES.includes(value.code as TransferErrorCode)
        ? (value.code as TransferErrorCode)
        : "protocol-error";
      const message = readString(value, "message", CONTROL_LIMITS.maxErrorMessageLength) ?? "Transfer failed";
      return { type: "transfer-error", transferId, code, message };
    }

    case "cancel-transfer": {
      const transferId = readInt(value, "transferId", 1, MAX_TRANSFER_ID);
      if (transferId === null) return null;
      return { type: "cancel-transfer", transferId };
    }

    case "control-ping":
      return { type: "control-ping", at: typeof value.at === "number" ? value.at : Date.now() };

    case "control-pong":
      return { type: "control-pong", at: typeof value.at === "number" ? value.at : Date.now() };

    default:
      return null;
  }
}
