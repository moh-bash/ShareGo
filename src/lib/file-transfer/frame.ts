/**
 * Binary framing for the `file` DataChannel.
 *
 * A frame is a fixed 9 byte header followed by raw file bytes. We use a header
 * instead of JSON per chunk because at 64 KB chunks a JSON envelope would add
 * ~50 bytes of escaping work for every chunk on the main thread.
 *
 * ```
 *  byte  0      kind        (u8)   — 1 = file chunk
 *  bytes 1..4   transferId  (u32)  — assigned by the sender
 *  bytes 5..8   sequence     (u32)  — 0-based chunk counter
 *  bytes 9..    payload
 * ```
 */

import { FRAME_HEADER_BYTES, FRAME_KIND_CHUNK } from "@/types/webrtc";

export interface ChunkFrame {
  transferId: number;
  sequence: number;
  payload: Uint8Array<ArrayBuffer>;
}

/** Reused header scratch space to avoid allocating a DataView per chunk. */
const headerBytes = new Uint8Array(FRAME_HEADER_BYTES);
const headerView = new DataView(headerBytes.buffer);

export function encodeChunkFrame(
  transferId: number,
  sequence: number,
  payload: ArrayBuffer | Uint8Array,
): ArrayBuffer {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const frame = new Uint8Array(FRAME_HEADER_BYTES + bytes.byteLength);

  headerView.setUint8(0, FRAME_KIND_CHUNK);
  headerView.setUint32(1, transferId, false);
  headerView.setUint32(5, sequence, false);
  frame.set(headerBytes, 0);
  frame.set(bytes, FRAME_HEADER_BYTES);

  return frame.buffer;
}

export function decodeChunkFrame(buffer: ArrayBuffer): ChunkFrame | null {
  if (buffer.byteLength < FRAME_HEADER_BYTES) return null;

  const view = new DataView(buffer);
  if (view.getUint8(0) !== FRAME_KIND_CHUNK) return null;

  const transferId = view.getUint32(1, false);
  const sequence = view.getUint32(5, false);
  const payload = new Uint8Array(buffer, FRAME_HEADER_BYTES);

  return { transferId, sequence, payload };
}
