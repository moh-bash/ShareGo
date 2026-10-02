import type { FileCategory } from "@/types/files";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Human readable byte size, e.g. `18.4 MB`. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(fractionDigits)} ${UNITS[unit]}`;
}

/** Transfer speed, e.g. `8.4 MB/s`. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** `0.72` -> `72%`. Clamped so a rounding overshoot never shows `101%`. */
export function formatPercent(fraction: number): string {
  const pct = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
  return `${pct}%`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg", "ico", "heic",
]);

const VIDEO_EXTENSIONS = new Set([
  "mp4", "webm", "ogv", "mov", "m4v", "mkv", "avi", "3gp",
]);

const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba",
]);

const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf",
  "csv", "json", "xml", "epub",
]);

const ARCHIVE_EXTENSIONS = new Set([
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "iso", "dmg",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Categorise by MIME type first (authoritative when the browser knows it) and
 * fall back to the file extension, because plenty of files arrive with an
 * empty or generic `type` (e.g. `application/octet-stream`).
 */
export function categoriseFile(name: string, mimeType: string): FileCategory {
  const mime = mimeType.toLowerCase().split(";")[0].trim();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  if (
    mime === "application/zip" ||
    mime === "application/x-tar" ||
    mime === "application/gzip" ||
    mime === "application/x-rar-compressed"
  ) {
    return "archive";
  }

  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  return "other";
}

/**
 * Trust-but-verify a category that arrived over the wire. The peer controls the
 * string, so anything we do not recognise is recomputed locally from the name
 * and MIME type instead of being passed straight to the UI.
 */
export function coerceFileCategory(
  value: string,
  name: string,
  mimeType: string,
): FileCategory {
  const known = CATEGORY_ORDER.includes(value as FileCategory);
  return known ? (value as FileCategory) : categoriseFile(name, mimeType);
}

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  image: "Photos",
  video: "Videos",
  audio: "Audio",
  document: "Documents",
  archive: "Archives",
  other: "Other Files",
};

export const CATEGORY_ORDER: FileCategory[] = [
  "image",
  "video",
  "audio",
  "document",
  "archive",
  "other",
];

/** True when the browser can play this type inline in a `<video>` element. */
export function isPlayableVideo(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  return (
    mime === "video/mp4" ||
    mime === "video/webm" ||
    mime === "video/ogg" ||
    mime === "video/quicktime"
  );
}

export function isPlayableAudio(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  return (
    mime === "audio/mpeg" ||
    mime === "audio/mp4" ||
    mime === "audio/aac" ||
    mime === "audio/ogg" ||
    mime === "audio/wav" ||
    mime === "audio/webm" ||
    mime === "audio/flac" ||
    mime === "audio/x-m4a"
  );
}

/** Inline previewable in an `<img>`. SVG is included, HEIC is not. */
export function isDisplayableImage(mimeType: string): boolean {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  return (
    mime === "image/jpeg" ||
    mime === "image/png" ||
    mime === "image/gif" ||
    mseSafeImage(mime)
  );
}

function mseSafeImage(mime: string): boolean {
  return (
    mime === "image/webp" ||
    mime === "image/avif" ||
    mime === "image/bmp" ||
    mime === "image/svg+xml"
  );
}

/** Categories where a thumbnail-like grid is worth rendering. */
export function categoryHasGrid(category: FileCategory): boolean {
  return category === "image" || category === "video";
}

/** `notes.pdf` -> `PDF` for the file-type badge. */
export function shortTypeLabel(mimeType: string, name: string): string {
  const mime = mimeType.toLowerCase().split(";")[0].trim();
  if (mime && mime !== "application/octet-stream") {
    const subtype = mime.slice(mime.indexOf("/") + 1);
    if (subtype) return subtype.replace(/^x-/, "").toUpperCase().slice(0, 5);
  }
  const ext = extensionOf(name);
  return ext ? ext.toUpperCase().slice(0, 5) : "FILE";
}

/** Truncate a middle-heavy path so long folder names do not break layout. */
export function truncateMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
