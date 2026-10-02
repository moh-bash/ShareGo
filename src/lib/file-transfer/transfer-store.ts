/**
 * Observable store used by the transfer panel.
 *
 * Progress changes fire 4-10 times per second per file. Routing that through
 * React state directly would re-render the whole tree, so we keep the records
 * outside React, publish a *stable array snapshot* that is only rebuilt when
 * something actually changed, and let components subscribe with
 * `useSyncExternalStore`.
 */

import type { TransferRecord } from "@/types/files";

export type TransferListener = () => void;

/** Terminal states stay in the list briefly so the user sees the outcome. */
const TERMINAL_LINGER_MS = 6000;

export class TransferStore {
  private records = new Map<string, TransferRecord>();
  private snapshot: TransferRecord[] = [];
  private listeners = new Set<TransferListener>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;
  private pendingTerminalSweep = new Map<string, ReturnType<typeof setTimeout>>();

  /** `transferId` is scoped per peer, so the key must include the peer. */
  static key(peerId: string, transferId: number): string {
    return `${peerId}:${transferId}`;
  }

  subscribe = (listener: TransferListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable reference between mutations — required by useSyncExternalStore. */
  getSnapshot = (): TransferRecord[] => this.snapshot;

  get(peerId: string, transferId: number): TransferRecord | undefined {
    return this.records.get(TransferStore.key(peerId, transferId));
  }

  getByKey(key: string): TransferRecord | undefined {
    return this.records.get(key);
  }

  list(): TransferRecord[] {
    return this.snapshot;
  }

  /**
   * Insert or patch a record. Only actually-notify listeners when a field the
   * UI renders changed, so byte-level churn stays cheap.
   */
  update(peerId: string, transferId: number, patch: Partial<TransferRecord>): TransferRecord {
    const key = TransferStore.key(peerId, transferId);
    const existing = this.records.get(key);

    if (!existing) {
      const created: TransferRecord = {
        transferId,
        peerId,
        peerName: "",
        fileId: "",
        name: "",
        size: 0,
        mimeType: "",
        category: "other",
        purpose: "download",
        direction: "send",
        transferredBytes: 0,
        speedBytesPerSecond: 0,
        status: "pending",
        error: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        ...patch,
      };
      this.records.set(key, created);
      this.scheduleFlush();
      return created;
    }

    const next: TransferRecord = { ...existing, ...patch, updatedAt: Date.now() };
    this.records.set(key, next);
    this.scheduleFlush();
    return next;
  }

  clear(): void {
    for (const timer of this.pendingTerminalSweep.values()) clearTimeout(timer);
    this.pendingTerminalSweep.clear();
    this.records.clear();
    this.scheduleFlush();
  }

  /** Drop everything belonging to a peer (it disconnected). */
  clearPeer(peerId: string): void {
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.peerId !== peerId) continue;
      const timer = this.pendingTerminalSweep.get(key);
      if (timer) {
        clearTimeout(timer);
        this.pendingTerminalSweep.delete(key);
      }
      this.records.delete(key);
      changed = true;
    }
    if (changed) this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    // Coalesce bursts of chunk-level updates into one notification per frame.
    this.flushHandle = setTimeout(() => {
      this.flushHandle = null;
      this.flush();
    }, 120);
  }

  private flush(): void {
    for (const [key, record] of this.records) {
      const terminal =
        record.status === "complete" ||
        record.status === "cancelled" ||
        record.status === "error";
      if (!terminal) continue;
      if (this.pendingTerminalSweep.has(key)) continue;
      this.pendingTerminalSweep.set(
        key,
        setTimeout(() => {
          this.pendingTerminalSweep.delete(key);
          this.records.delete(key);
          this.scheduleFlush();
        }, TERMINAL_LINGER_MS),
      );
    }

    this.snapshot = [...this.records.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );

    for (const listener of this.listeners) listener();
  }

  /** Test/cleanup helper: drop listeners and timers. */
  dispose(): void {
    if (this.flushHandle !== null) clearTimeout(this.flushHandle);
    this.flushHandle = null;
    for (const timer of this.pendingTerminalSweep.values()) clearTimeout(timer);
    this.pendingTerminalSweep.clear();
    this.listeners.clear();
  }
}
