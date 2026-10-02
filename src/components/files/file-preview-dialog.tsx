"use client";

/**
 * File preview.
 *
 * This is where "do not download the whole file first" has to be honest:
 *
 *  - Images, video and audio are streamed into a `MediaSource` while the
 *    transfer is still running, so playback starts as soon as the container
 *    header lands (see `lib/file-transfer/progressive-media.ts` for caveats).
 *  - Everything else (PDF, ZIP, …) has no browser-native progressive renderer,
 *    so we show the metadata plus a download action rather than pretending.
 *
 * The object URL is released when the dialog closes, otherwise a long session
 * would leak every previewed file.
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/ui/glyphs";
import { DownloadIcon, InfoIcon, SpinnerIcon } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { ProgressBar } from "@/components/ui/progress-bar";
import {
  formatBytes,
  isDisplayableImage,
  isPlayableAudio,
  isPlayableVideo,
} from "@/lib/utils/format";
import {
  useDownloadArtifact,
  usePreviewArtifact,
  useTransferActions,
} from "@/hooks/use-share-go";
import type { Artifact } from "@/lib/app-store";
import type { SharedFileMetaLite } from "@/types/webrtc";

type PreviewKind = "image" | "video" | "audio" | "document";

function kindOf(meta: SharedFileMetaLite): PreviewKind {
  if (isDisplayableImage(meta.mimeType)) return "image";
  if (isPlayableVideo(meta.mimeType)) return "video";
  if (isPlayableAudio(meta.mimeType)) return "audio";
  return "document";
}

export interface FilePreviewDialogProps {
  meta: SharedFileMetaLite | null;
  peerId: string;
  /** Starts a transfer for this file and returns the artifact id, or null. */
  startTransfer: (meta: SharedFileMetaLite, purpose: "preview" | "download") => string | null;
  onClose: () => void;
}

export function FilePreviewDialog({
  meta,
  peerId,
  startTransfer,
  onClose,
}: FilePreviewDialogProps) {
  const { release } = useTransferActions();

  // Starting the stream is a side effect on an external system (the transfer
  // engine), so it belongs in an effect. What the UI renders is then *derived*
  // from the artifact store, which means no mirrored `artifactId` state that
  // could disagree with the engine after a reconnect or an error.
  useEffect(() => {
    if (!meta) return;
    startTransfer(meta, "preview");
  }, [meta, startTransfer]);

  const artifact = usePreviewArtifact(peerId, meta?.fileId ?? null);
  const artifactId = artifact?.id ?? null;
  const download = useDownloadArtifact(peerId, meta?.fileId ?? null);
  const kind = meta ? kindOf(meta) : "document";

  // Free the received bytes when the preview closes.
  useEffect(() => {
    return () => {
      if (artifactId) release(artifactId);
    };
  }, [artifactId, release]);

  if (!meta) return null;

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={meta.name}
      description={`${formatBytes(meta.size)}${meta.mimeType ? ` · ${meta.mimeType}` : ""}`}
      headerAction={
        <Button
          variant="primary"
          size="sm"
          icon={<DownloadIcon className="size-4" />}
          disabled={download !== undefined && download.status !== "complete"}
          onClick={() => startTransfer(meta, "download")}
        >
          Download
        </Button>
      }
      footer={<PreviewFooter artifact={artifact} download={download} />}
    >
      <PreviewBody meta={meta} kind={kind} artifact={artifact} />
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

function PreviewBody({
  meta,
  kind,
  artifact,
}: {
  meta: SharedFileMetaLite;
  kind: PreviewKind;
  artifact: Artifact | undefined;
}) {
  const url = artifact?.url ?? null;
  const error = artifact?.error ?? null;

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <InfoIcon className="size-6 text-negative" />
        <p className="text-sm text-ink">{error}</p>
        <p className="max-w-[40ch] text-xs leading-relaxed text-ink-faint">
          The transfer stopped before this file could be shown. Downloading it directly
          usually still works.
        </p>
      </div>
    );
  }

  if (kind === "document") {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
        <CategoryBadge category={meta.category as never} className="size-16" />
        <div>
          <p className="text-sm font-medium text-ink">No inline preview for this format</p>
          <p className="mx-auto mt-1.5 max-w-[42ch] text-xs leading-relaxed text-ink-faint">
            Browsers cannot render {meta.mimeType || "this file type"} straight from a
            peer-to-peer stream. Download it and open it with whatever app you normally
            use.
          </p>
        </div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center">
        <SpinnerIcon className="size-6 text-ink-faint" />
        <p className="text-sm text-ink-muted">Preparing {meta.name}…</p>
        <p className="max-w-[40ch] text-xs leading-relaxed text-ink-faint">
          {artifact?.mode === "buffered"
            ? "This browser cannot stream this format, so ShareGo buffers the whole file before showing it."
            : "Playback starts as soon as enough of the file has arrived."}
        </p>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className="grid place-items-center bg-black/35 p-4">
        {/* The bytes came from a peer over WebRTC, so `next/image`
            optimisation (which expects an HTTP source) does not apply here. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={meta.name}
          className="max-h-[60dvh] w-auto max-w-full rounded-lg object-contain shadow-xl"
        />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="grid place-items-center bg-black p-4">
        <video
          key={url}
          src={url}
          controls
          autoPlay
          playsInline
          className="max-h-[60dvh] w-auto max-w-full rounded-lg"
        />
      </div>
    );
  }

  return (
    <div className="grid place-items-center bg-black/25 px-6 py-12">
      <audio key={url} src={url} controls autoPlay className="w-full max-w-xl" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

function PreviewFooter({
  artifact,
  download,
}: {
  artifact: Artifact | undefined;
  download: Artifact | undefined;
}) {
  const { save } = useTransferActions();
  const progress = artifact && artifact.size > 0 ? artifact.bytesReceived / artifact.size : 0;
  const done = artifact?.status === "complete";

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-[12rem] flex-1">
        <ProgressBar
          value={progress}
          label={done ? "Preview ready" : "Receiving preview"}
          trailing={
            artifact
              ? `${formatBytes(artifact.bytesReceived)} / ${formatBytes(artifact.size)}`
              : undefined
          }
          tone={done ? "positive" : "accent"}
          indeterminate={artifact?.status === "pending"}
        />
      </div>

      {download && download.status === "complete" ? (
        <Button
          variant="secondary"
          size="sm"
          icon={<DownloadIcon className="size-4" />}
          onClick={() => save(download.id)}
        >
          Saved — save again
        </Button>
      ) : download ? (
        <p className="text-[11px] text-ink-faint">
          Downloading in the background…
        </p>
      ) : null}
    </div>
  );
}
