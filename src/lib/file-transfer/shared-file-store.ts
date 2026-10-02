/**
 * The set of files this device has *explicitly* chosen to share.
 *
 * Browser security means we can never enumerate a user's disk. Everything here
 * comes from an `<input type="file">` (or a `webkitdirectory` folder pick),
 * which is the only permission primitive the web platform gives us. The list is
 * the single source of truth for what a connected peer may request.
 */

import { categoriseFile } from "@/lib/utils/format";
import { newFileId } from "@/lib/utils/id";
import type { SharedFile, SharedFileMeta } from "@/types/files";

type Listener = () => void;

export class SharedFileStore {
  private files = new Map<string, SharedFile>();
  private snapshot: SharedFile[] = [];
  private listeners = new Set<Listener>();
  private byFingerprint = new Map<string, string>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): SharedFile[] => this.snapshot;

  list(): SharedFileMeta[] {
    return this.snapshot.map(toMeta);
  }

  get(fileId: string): SharedFile | undefined {
    return this.files.get(fileId);
  }

  /**
   * Add files picked by the user. Files that are already shared (same name,
   * size and mtime) are skipped instead of duplicated, so double-clicking
   * "add files" twice is harmless.
   */
  add(incoming: readonly File[]): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;

    for (const file of incoming) {
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
      if (this.byFingerprint.has(fingerprint)) {
        skipped += 1;
        continue;
      }

      // `webkitRelativePath` is only populated by `webkitdirectory` inputs.
      const relativePath = file.webkitRelativePath || "";
      const entry: SharedFile = {
        fileId: newFileId(),
        name: file.name,
        size: file.size,
        mimeType: file.type || guessMimeFromName(file.name),
        lastModified: file.lastModified,
        path: relativePath.length > 0 ? relativePath : null,
        category: categoriseFile(file.name, file.type),
        file,
      };

      this.files.set(entry.fileId, entry);
      this.byFingerprint.set(fingerprint, entry.fileId);
      added += 1;
    }

    if (added > 0) this.publish();
    return { added, skipped };
  }

  remove(fileId: string): boolean {
    const entry = this.files.get(fileId);
    if (!entry) return false;

    this.files.delete(fileId);
    this.byFingerprint.delete(`${entry.name}:${entry.size}:${entry.lastModified}`);
    this.publish();
    return true;
  }

  clear(): void {
    if (this.files.size === 0) return;
    this.files.clear();
    this.byFingerprint.clear();
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.files.values()];
    for (const listener of this.listeners) listener();
  }
}

/** The wire metadata for a shared file (never includes the `File` handle). */
export function toMeta(entry: SharedFile): SharedFileMeta {
  return {
    fileId: entry.fileId,
    name: entry.name,
    size: entry.size,
    mimeType: entry.mimeType,
    lastModified: entry.lastModified,
    path: entry.path,
    category: entry.category,
  };
}

/**
 * Many files (especially on Windows) arrive with an empty `type`. Fall back to
 * a tiny extension table so previews and category labels still work. Browsers
 * do this internally for `img`/`video`, but not for our own category logic.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
};

export function guessMimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
