/**
 * Observable store for bytes we have received and can hand to the browser.
 *
 * A "completed artifact" is either
 *   - a `Blob` + object URL (downloads, and previews the browser cannot stream), or
 *   - a `MediaSource` + object URL (progressive audio/video preview), whose URL
 *     exists from the start and grows as chunks arrive.
 *
 * URLs are revoked on `release`/`dispose` so a long session cannot leak blobs.
 */

import type { FileCategory, ToastMessage, TransferPurpose, TransferStatus } from "@/types/files";
import type { ProgressiveMediaMode } from "@/lib/file-transfer/progressive-media";

export interface Artifact {
  id: string;
  /** `peerId:transferId` — the transfer that produced it. */
  key: string;
  peerId: string;
  peerName: string;
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  category: FileCategory;
  purpose: TransferPurpose;
  mode: ProgressiveMediaMode;
  /** `null` until the bytes are playable (blob mode: until the transfer ends). */
  url: string | null;
  status: TransferStatus;
  bytesReceived: number;
  error: string | null;
}

type Listener = () => void;

export class ArtifactStore {
  private artifacts = new Map<string, Artifact>();
  private snapshot: Artifact[] = [];
  private listeners = new Set<Listener>();
  private revokers = new Map<string, () => void>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Artifact[] => this.snapshot;

  get(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  /** Most recent artifact for a (peer, file, purpose) triple. */
  findByFile(
    peerId: string,
    fileId: string,
    purpose: TransferPurpose,
  ): Artifact | undefined {
    let match: Artifact | undefined;
    for (const artifact of this.artifacts.values()) {
      if (artifact.peerId !== peerId) continue;
      if (artifact.fileId !== fileId) continue;
      if (artifact.purpose !== purpose) continue;
      if (!match || match.bytesReceived > 0) match = artifact;
    }
    return match;
  }

  set(
    id: string,
    artifact: Artifact,
    revoke?: () => void,
  ): void {
    if (revoke) this.revokers.set(id, revoke);
    this.artifacts.set(id, artifact);
    this.publish();
  }

  patch(id: string, patch: Partial<Artifact>): void {
    const existing = this.artifacts.get(id);
    if (!existing) return;
    this.artifacts.set(id, { ...existing, ...patch });
    this.publish();
  }

  /** Release one artifact and revoke its object URL. */
  release(id: string): void {
    const revoke = this.revokers.get(id);
    if (revoke) {
      revoke();
      this.revokers.delete(id);
    }
    this.artifacts.delete(id);
    this.publish();
  }

  releasePeer(peerId: string): void {
    for (const [id, artifact] of [...this.artifacts]) {
      if (artifact.peerId !== peerId) continue;
      this.release(id);
    }
  }

  clear(): void {
    for (const id of [...this.artifacts.keys()]) this.release(id);
  }

  private publish(): void {
    this.snapshot = [...this.artifacts.values()];
    for (const listener of this.listeners) listener();
  }
}

/* ------------------------------------------------------------------ */
/* Toasts (small in-app notifications)                                 */
/* ------------------------------------------------------------------ */

export class ToastStore {
  private toasts: ToastMessage[] = [];
  private snapshot: ToastMessage[] = [];
  private listeners = new Set<Listener>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ToastMessage[] => this.snapshot;

  push(message: Omit<ToastMessage, "id">, ttlMs = 4500): string {
    const id = Math.random().toString(36).slice(2, 10);
    this.toasts = [...this.toasts, { ...message, id }].slice(-4);
    this.publish();

    const timer = setTimeout(() => this.dismiss(id), ttlMs);
    this.timers.set(id, timer);
    return id;
  }

  dismiss(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.toasts = this.toasts.filter((toast) => toast.id !== id);
    this.publish();
  }

  private publish(): void {
    this.snapshot = [...this.toasts];
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.listeners.clear();
  }
}
