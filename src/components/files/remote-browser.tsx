"use client";

/**
 * Browses the files a connected device has chosen to share.
 *
 * The list arrives over the DataChannel as soon as the connection opens and is
 * refreshed automatically when the other side adds or removes files (they send
 * a `files-changed` ping — no polling).
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/ui/glyphs";
import { DownloadIcon, PlayIcon, SpinnerIcon } from "@/components/ui/icons";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  categoryHasGrid,
  formatBytes,
  isDisplayableImage,
  isPlayableAudio,
  isPlayableVideo,
  shortTypeLabel,
} from "@/lib/utils/format";
import { useArtifacts, useRemoteFiles } from "@/hooks/use-share-go";
import type { FileCategory } from "@/types/files";
import type { SharedFileMetaLite } from "@/types/webrtc";

type PreviewKind = "image" | "video" | "audio" | null;

/** Can this be previewed inline without downloading the whole file first? */
function previewKind(file: SharedFileMetaLite): PreviewKind {
  if (isDisplayableImage(file.mimeType)) return "image";
  if (isPlayableVideo(file.mimeType)) return "video";
  if (isPlayableAudio(file.mimeType)) return "audio";
  return null;
}

export interface RemoteBrowserProps {
  peerId: string;
  onPreview: (meta: SharedFileMetaLite) => void;
  onDownload: (meta: SharedFileMetaLite) => void;
}

export function RemoteBrowser({ peerId, onPreview, onDownload }: RemoteBrowserProps) {
  const remote = useRemoteFiles(peerId);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const files = remote?.files ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? files.filter(
          (file) =>
            file.name.toLowerCase().includes(needle) ||
            (file.path ?? "").toLowerCase().includes(needle),
        )
      : files;

    return CATEGORY_ORDER.map((category) => ({
      category,
      files: filtered.filter((file) => file.category === category),
    })).filter((group) => group.files.length > 0);
  }, [remote?.files, query]);

  if (!remote) {
    return (
      <div className="flex flex-col items-center gap-2.5 px-6 py-14 text-center">
        <SpinnerIcon className="size-6 text-ink-faint" />
        <p className="text-sm text-ink-muted">Waiting for the shared file list…</p>
      </div>
    );
  }

  if (remote.files.length === 0) {
    return (
      <div className="px-6 py-14 text-center">
        <p className="text-sm font-medium text-ink-muted">
          {remote.peerName} is not sharing any files yet
        </p>
        <p className="mx-auto mt-1.5 max-w-[38ch] text-xs leading-relaxed text-ink-faint">
          They need to pick files on their device first. This list updates on its own the
          moment they do.
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          type="search"
          placeholder="Filter by name…"
          aria-label="Filter shared files"
          className="focus-ring h-10 min-w-0 flex-1 rounded-xl border border-hairline bg-surface-2 px-3 text-sm text-ink placeholder:text-ink-faint"
        />
        <span className="shrink-0 text-xs text-ink-faint">
          {remote.files.length} file{remote.files.length === 1 ? "" : "s"} ·{" "}
          {formatBytes(remote.files.reduce((sum, file) => sum + file.size, 0))}
        </span>
      </div>

      {groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-faint">Nothing matches “{query}”.</p>
      ) : null}

      <div className="space-y-7">
        {groups.map((group) => (
          <FileGroup
            key={group.category}
            peerId={peerId}
            category={group.category}
            files={group.files}
            onPreview={onPreview}
            onDownload={onDownload}
          />
        ))}
      </div>
    </div>
  );
}

function FileGroup({
  peerId,
  category,
  files,
  onPreview,
  onDownload,
}: {
  peerId: string;
  category: FileCategory;
  files: SharedFileMetaLite[];
  onPreview: (meta: SharedFileMetaLite) => void;
  onDownload: (meta: SharedFileMetaLite) => void;
}) {
  const asGrid = categoryHasGrid(category);

  return (
    <section aria-label={CATEGORY_LABELS[category]}>
      <div className="mb-3 flex items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
          {CATEGORY_LABELS[category]}
        </h3>
        <span className="h-px flex-1 bg-hairline" />
        <span className="font-mono text-[11px] text-ink-faint">{files.length}</span>
      </div>

      {asGrid ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {files.map((file) => (
            <li key={file.fileId}>
              <FileTile
                peerId={peerId}
                file={file}
                onPreview={onPreview}
                onDownload={onDownload}
              />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {files.map((file) => (
            <li key={file.fileId}>
              <FileRow
                peerId={peerId}
                file={file}
                onPreview={onPreview}
                onDownload={onDownload}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Rows and tiles                                                      */
/* ------------------------------------------------------------------ */

function useArtifactFor(peerId: string, fileId: string) {
  const artifacts = useArtifacts();
  return useMemo(
    () => artifacts.find((item) => item.peerId === peerId && item.fileId === fileId),
    [artifacts, peerId, fileId],
  );
}

function FileActions({
  file,
  busy,
  onPreview,
  onDownload,
  layout,
}: {
  file: SharedFileMetaLite;
  busy: boolean;
  onPreview: (meta: SharedFileMetaLite) => void;
  onDownload: (meta: SharedFileMetaLite) => void;
  layout: "tile" | "row";
}) {
  const canPreview = previewKind(file) !== null;

  if (layout === "tile") {
    return (
      <div className="flex items-center gap-1.5">
        <Button
          variant={canPreview ? "secondary" : "primary"}
          size="sm"
          block
          disabled={busy}
          icon={<DownloadIcon className="size-4" />}
          onClick={() => onDownload(file)}
        >
          {busy ? "Receiving" : "Download"}
        </Button>
        {canPreview ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Preview ${file.name}`}
            onClick={() => onPreview(file)}
            className="px-2.5"
          >
            <PlayIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {canPreview ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<PlayIcon className="size-4" />}
          onClick={() => onPreview(file)}
        >
          Preview
        </Button>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        disabled={busy}
        icon={<DownloadIcon className="size-4" />}
        onClick={() => onDownload(file)}
      >
        {busy ? "Receiving" : "Download"}
      </Button>
    </div>
  );
}

function FileTile({
  peerId,
  file,
  onPreview,
  onDownload,
}: {
  peerId: string;
  file: SharedFileMetaLite;
  onPreview: (meta: SharedFileMetaLite) => void;
  onDownload: (meta: SharedFileMetaLite) => void;
}) {
  const artifact = useArtifactFor(peerId, file.fileId);
  const kind = previewKind(file);
  // A preview we already fetched doubles as the thumbnail. We deliberately do
  // NOT prefetch thumbnails for every image: opening a 500-photo folder should
  // not start 500 transfers.
  const thumbnail = kind === "image" ? (artifact?.url ?? null) : null;
  const busy = artifact !== undefined && artifact.status !== "complete";

  return (
    <article className="panel-inset animate-rise flex flex-col overflow-hidden">
      <button
        type="button"
        onClick={() => onPreview(file)}
        disabled={kind === null}
        className="focus-ring relative aspect-[4/3] w-full overflow-hidden bg-surface-3 text-left disabled:cursor-default"
      >
        {thumbnail ? (
          <>
            {/* The bytes arrive from a peer over WebRTC, so `next/image`
                optimisation (which expects an HTTP source) is not applicable. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnail}
              alt=""
              className="size-full object-cover"
              decoding="async"
            />
          </>
        ) : (
          <span className="grid size-full place-items-center text-ink-faint">
            <CategoryBadge category={file.category} className="size-12" />
          </span>
        )}

        {kind === "video" ? (
          <span className="absolute inset-0 grid place-items-center bg-canvas/25">
            <span className="grid size-11 place-items-center rounded-full bg-canvas/70 text-ink backdrop-blur-sm">
              <PlayIcon className="ml-0.5 size-5" />
            </span>
          </span>
        ) : null}

        <span className="absolute bottom-1.5 right-1.5 rounded-md bg-canvas/75 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted backdrop-blur-sm">
          {shortTypeLabel(file.mimeType, file.name)}
        </span>
      </button>

      <div className="flex flex-col gap-2 p-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink" title={file.name}>
            {file.name}
          </p>
          <p className="text-[11px] text-ink-faint">{formatBytes(file.size)}</p>
        </div>
        <FileActions
          file={file}
          busy={busy}
          onPreview={onPreview}
          onDownload={onDownload}
          layout="tile"
        />
      </div>
    </article>
  );
}

function FileRow({
  peerId,
  file,
  onPreview,
  onDownload,
}: {
  peerId: string;
  file: SharedFileMetaLite;
  onPreview: (meta: SharedFileMetaLite) => void;
  onDownload: (meta: SharedFileMetaLite) => void;
}) {
  const artifact = useArtifactFor(peerId, file.fileId);
  const busy = artifact !== undefined && artifact.status !== "complete";

  return (
    <article className="panel-inset flex items-center gap-3 px-3 py-2.5">
      <CategoryBadge category={file.category} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink" title={file.name}>
          {file.name}
        </p>
        <p className="truncate text-[11px] text-ink-faint">
          {formatBytes(file.size)} · {shortTypeLabel(file.mimeType, file.name)}
          {file.path ? ` · ${file.path}` : ""}
        </p>
      </div>
      <FileActions
        file={file}
        busy={busy}
        onPreview={onPreview}
        onDownload={onDownload}
        layout="row"
      />
    </article>
  );
}
