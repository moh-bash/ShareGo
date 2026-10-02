"use client";

/**
 * Thin, focused hooks over the engine. Components subscribe to exactly the
 * slice they render, so a 4 MB/s progress tick only re-renders the transfer
 * panel rather than the whole app.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useEngine } from "@/components/providers/share-go-provider";
import type { EngineSnapshot } from "@/lib/engine";
import type { Artifact } from "@/lib/app-store";
import type { SharedFile } from "@/types/files";
import type { TransferRecord } from "@/types/files";

/* ------------------------------------------------------------------ */
/* Engine level                                                        */
/* ------------------------------------------------------------------ */

export function useEngineSnapshot(): EngineSnapshot {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}

export function useIdentity() {
  return useEngineSnapshot().identity;
}

export function useSignaling() {
  return useEngineSnapshot().signaling;
}

export function useDevices() {
  return useEngineSnapshot().devices;
}

export function useIncomingRequests() {
  return useEngineSnapshot().incomingRequests;
}

export function usePeers() {
  return useEngineSnapshot().peers;
}

/** Remote shared files for one peer (undefined until the list arrives). */
export function useRemoteFiles(peerId: string | null) {
  const { remoteFiles } = useEngineSnapshot();
  return peerId ? remoteFiles[peerId] : undefined;
}

/* ------------------------------------------------------------------ */
/* High frequency stores                                               */
/* ------------------------------------------------------------------ */

export function useTransfers(): TransferRecord[] {
  const engine = useEngine();
  return useSyncExternalStore(
    engine.transfers.subscribe,
    engine.transfers.getSnapshot,
    engine.transfers.getSnapshot,
  );
}

export function useArtifacts(): Artifact[] {
  const engine = useEngine();
  return useSyncExternalStore(
    engine.artifacts.subscribe,
    engine.artifacts.getSnapshot,
    engine.artifacts.getSnapshot,
  );
}

export function useArtifact(artifactId: string | null): Artifact | undefined {
  const artifacts = useArtifacts();
  return useMemo(
    () => artifacts.find((artifact) => artifact.id === artifactId),
    [artifacts, artifactId],
  );
}

/** The artifact backing a preview of this file, if one has been started. */
export function usePreviewArtifact(
  peerId: string,
  fileId: string | null,
): Artifact | undefined {
  const artifacts = useArtifacts();
  return useMemo(
    () =>
      fileId
        ? artifacts.find(
            (artifact) =>
              artifact.peerId === peerId &&
              artifact.fileId === fileId &&
              artifact.purpose === "preview",
          )
        : undefined,
    [artifacts, peerId, fileId],
  );
}

/** The artifact backing a "download this file" request, if there is one. */
export function useDownloadArtifact(
  peerId: string | null,
  fileId: string | null,
): Artifact | undefined {
  const artifacts = useArtifacts();
  return useMemo(
    () =>
      peerId && fileId
        ? artifacts.find(
            (artifact) =>
              artifact.peerId === peerId &&
              artifact.fileId === fileId &&
              artifact.purpose === "download",
          )
        : undefined,
    [artifacts, peerId, fileId],
  );
}

export function useSharedFiles(): SharedFile[] {
  const engine = useEngine();
  return useSyncExternalStore(
    engine.files.subscribe,
    engine.files.getSnapshot,
    engine.files.getSnapshot,
  );
}

export function useToasts() {
  const engine = useEngine();
  return useSyncExternalStore(
    engine.toasts.subscribe,
    engine.toasts.getSnapshot,
    engine.toasts.getSnapshot,
  );
}

/* ------------------------------------------------------------------ */
/* Actions (stable callbacks)                                          */
/* ------------------------------------------------------------------ */

/**
 * File pickers must be triggered from a real user gesture, so the `<input>` is
 * rendered by `MyFilesPanel` and this hook only owns the handlers.
 */
export function useFileActions() {
  const engine = useEngine();

  const addFiles = useCallback(
    (list: FileList | File[] | null) => {
      if (!list) return;
      engine.addFiles(Array.from(list));
    },
    [engine],
  );

  const removeFile = useCallback((fileId: string) => engine.removeFile(fileId), [engine]);
  const clearFiles = useCallback(() => engine.clearFiles(), [engine]);

  return { addFiles, removeFile, clearFiles };
}

export function usePeerActions() {
  const engine = useEngine();
  return useMemo(
    () => ({
      connect: (deviceId: string) => engine.requestConnection(deviceId),
      respond: (requestId: string, accepted: boolean) =>
        engine.respondToRequest(requestId, accepted),
      disconnect: (deviceId: string) => engine.disconnectPeer(deviceId),
    }),
    [engine],
  );
}

export function useTransferActions() {
  const engine = useEngine();
  return useMemo(
    () => ({
      cancel: (peerId: string, transferId: number) =>
        engine.cancelTransfer(peerId, transferId),
      save: (artifactId: string) => engine.saveArtifact(artifactId),
      release: (artifactId: string) => engine.releaseArtifact(artifactId),
    }),
    [engine],
  );
}
