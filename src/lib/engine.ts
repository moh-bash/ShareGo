/**
 * The ShareGo engine: one plain object that owns the signaling socket, every
 * peer connection, the shared file list, transfers and notifications.
 *
 * Why not React state for all of this? Progress ticks 4-10x/second per file and
 * ICE callbacks fire constantly. Keeping that in a framework-agnostic store and
 * exposing a single immutable snapshot through `useSyncExternalStore` means:
 *   - components only re-render when something they render actually changed,
 *   - WebRTC callbacks never capture stale React state,
 *   - the whole networking layer is testable without a DOM.
 */

import { ArtifactStore, ToastStore } from "@/lib/app-store";
import { resolveSignalingUrl, saveSignalingUrl } from "@/lib/config";
import { TransferEngine } from "@/lib/file-transfer/engine";
import { SharedFileStore } from "@/lib/file-transfer/shared-file-store";
import { TransferStore } from "@/lib/file-transfer/transfer-store";
import { detectDeviceType } from "@/lib/utils/device";
import { guessDeviceName } from "@/lib/utils/id";
import { PeerManager } from "@/lib/webrtc/peer-manager";
import { SignalingClient } from "@/lib/websocket/client";
import type { ToastMessage, TransferPurpose } from "@/types/files";
import type { DeviceInfo, DeviceType, SignalingStatus } from "@/types/signaling";
import type { IncomingRequestSnapshot, PeerSnapshot, SharedFileMetaLite } from "@/types/webrtc";

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  id: number;
  at: number;
  level: LogLevel;
  text: string;
}

export interface RemoteFilesSnapshot {
  peerId: string;
  peerName: string;
  files: SharedFileMetaLite[];
  updatedAt: number;
}

export interface EngineSnapshot {
  identity: {
    deviceId: string | null;
    deviceName: string;
    deviceType: DeviceType;
  };
  signaling: {
    status: SignalingStatus;
    url: string;
  };
  devices: DeviceInfo[];
  peers: Record<string, PeerSnapshot>;
  incomingRequests: IncomingRequestSnapshot[];
  remoteFiles: Record<string, RemoteFilesSnapshot>;
  log: LogLine[];
}

const MAX_LOG_LINES = 60;
const NAME_STORAGE_KEY = "sharego.deviceName";

export class ShareGoEngine {
  readonly files = new SharedFileStore();
  readonly transfers = new TransferStore();
  readonly artifacts = new ArtifactStore();
  readonly toasts = new ToastStore();

  private readonly transferEngine: TransferEngine;
  private readonly peerManager: PeerManager;
  private signaling: SignalingClient | null = null;

  /* ----- mutable state; `getSnapshot()` composes the published object ----- */
  private deviceId: string | null = null;
  private deviceName = "This device";
  private signalingStatus: SignalingStatus = "idle";
  private signalingUrl = "";
  private devices: DeviceInfo[] = [];
  private peers: Record<string, PeerSnapshot> = {};
  private incomingRequests: IncomingRequestSnapshot[] = [];
  private remoteFiles: Record<string, RemoteFilesSnapshot> = {};
  private log: LogLine[] = [];

  private snapshot: EngineSnapshot;
  private dirty = false;
  private listeners = new Set<() => void>();
  private logCounter = 0;

  constructor() {
    this.transferEngine = new TransferEngine({
      files: this.files,
      transfers: this.transfers,
      artifacts: this.artifacts,
    });

    this.peerManager = new PeerManager(this.transferEngine, {
      onDevicesChanged: (devices) => {
        this.devices = devices;
        this.invalidate();
      },
      onIncomingRequest: (request) => {
        this.incomingRequests = [...this.incomingRequests, request];
        this.invalidate();
      },
      onRequestRemoved: (requestId) => {
        this.incomingRequests = this.incomingRequests.filter(
          (request) => request.requestId !== requestId,
        );
        this.invalidate();
      },
      onPeerChanged: (peer) => {
        const previous = this.peers[peer.deviceId];
        this.peers = {
          ...this.peers,
          [peer.deviceId]: {
            ...peer,
            // Keep the original "connected at" so the UI can show uptime.
            connectedAt:
              peer.state === "connected"
                ? (previous?.connectedAt ?? peer.connectedAt ?? Date.now())
                : null,
          },
        };
        this.invalidate();
      },
      onPeerRemoved: (peerId) => {
        const peers = { ...this.peers };
        delete peers[peerId];

        const remoteFiles = { ...this.remoteFiles };
        delete remoteFiles[peerId];

        this.peers = peers;
        this.remoteFiles = remoteFiles;
        this.invalidate();
      },
      onRemoteFiles: (peerId, files) => {
        const peerName =
          this.peers[peerId]?.deviceName ??
          this.devices.find((device) => device.deviceId === peerId)?.deviceName ??
          "This device";
        this.remoteFiles = {
          ...this.remoteFiles,
          [peerId]: { peerId, peerName, files, updatedAt: Date.now() },
        };
        this.invalidate();
      },
      getSelfName: () => this.deviceName,
      onLog: (line) => this.appendLog("info", line),
      onError: (message) => {
        this.appendLog("warn", message);
        this.toasts.push({ tone: "error", title: message });
      },
    });

    this.snapshot = this.buildSnapshot();
  }

  /* ---------------------------------------------------------------- */
  /* Store plumbing                                                   */
  /* ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EngineSnapshot => {
    if (this.dirty) this.flush();
    return this.snapshot;
  };

  /** Mark the snapshot stale and coalesce notifications into one microtask. */
  private invalidate(): void {
    this.dirty = true;
    queueMicrotask(() => {
      if (this.dirty) this.flush();
    });
  }

  private flush(): void {
    this.dirty = false;
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private buildSnapshot(): EngineSnapshot {
    return {
      identity: {
        deviceId: this.deviceId,
        deviceName: this.deviceName,
        deviceType: detectDeviceType(),
      },
      signaling: { status: this.signalingStatus, url: this.signalingUrl },
      devices: this.devices,
      peers: this.peers,
      incomingRequests: this.incomingRequests,
      remoteFiles: this.remoteFiles,
      log: this.log,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Identity + lifecycle                                             */
  /* ---------------------------------------------------------------- */

  /** Read persisted identity and open the signaling socket. */
  start(): void {
    if (typeof window === "undefined") return;
    if (this.signaling) return;

    this.deviceName = readStoredName() ?? guessDeviceName();
    const signalingUrl = resolveSignalingUrl();
    if (!signalingUrl) {
      this.signalingStatus = "offline";
      this.appendLog(
        "warn",
        "No signaling server is configured. Set NEXT_PUBLIC_SIGNALING_URL to a public wss:// URL.",
      );
      this.invalidate();
      return;
    }
    this.signalingUrl = signalingUrl;

    const signaling = new SignalingClient({
      url: this.signalingUrl,
      deviceName: this.deviceName,
      deviceType: detectDeviceType(),
      events: {
        onStatus: (status) => {
          this.signalingStatus = status;
          this.invalidate();
        },
        onMessage: (message) => {
          if (message.type === "welcome") {
            this.deviceId = message.deviceId;
            this.deviceName = message.deviceName;
            this.appendLog("info", `Joined the signaling server as "${this.deviceName}".`);
          }
          this.peerManager.handleServerMessage(message);
        },
        onReset: (reason) => {
          this.deviceId = null;
          this.peers = {};
          this.incomingRequests = [];
          this.remoteFiles = {};
          this.peerManager.resetAll(reason);
          this.invalidate();
        },
        onError: (message) => this.appendLog("warn", message),
      },
    });

    this.signaling = signaling;
    this.peerManager.attach(signaling);
    signaling.connect();
    this.invalidate();
  }

  dispose(): void {
    this.peerManager.dispose();
    this.signaling?.dispose();
    this.signaling = null;
    this.transferEngine.dispose();
    this.toasts.dispose();
    this.artifacts.clear();
    this.files.clear();
  }

  renameDevice(deviceName: string): void {
    const name = deviceName.trim().slice(0, 64);
    if (name.length === 0 || name === this.deviceName) return;

    this.deviceName = name;
    storeName(name);
    this.signaling?.setDeviceName(name);
    this.invalidate();
  }

  changeSignalingUrl(url: string): void {
    const next = url.trim();
    if (next.length === 0 || next === this.signalingUrl) return;

    saveSignalingUrl(next);
    this.signalingUrl = next;
    this.signaling?.dispose();
    this.signaling = null;
    this.deviceId = null;
    this.peerManager.resetAll("The signaling server address changed.");
    this.start();
  }

  /* ---------------------------------------------------------------- */
  /* Peer actions                                                     */
  /* ---------------------------------------------------------------- */

  requestConnection(deviceId: string): void {
    this.peerManager.requestConnection(deviceId);
  }

  respondToRequest(requestId: string, accepted: boolean): void {
    this.peerManager.respondToRequest(requestId, accepted);
  }

  disconnectPeer(deviceId: string): void {
    this.peerManager.disconnect(deviceId);
  }

  /* ---------------------------------------------------------------- */
  /* Files                                                            */
  /* ---------------------------------------------------------------- */

  addFiles(files: readonly File[]): void {
    const result = this.files.add(files);
    if (result.added === 0) {
      this.toasts.push({
        tone: "info",
        title: "Those files are already shared",
        description: "Nothing new was added.",
      });
      return;
    }

    this.transferEngine.broadcastFilesChanged();
    this.invalidate();
    this.toasts.push({
      tone: "success",
      title: result.added === 1 ? "1 file shared" : `${result.added} files shared`,
      description: "Connected devices can browse them now.",
    });
  }

  removeFile(fileId: string): void {
    if (!this.files.remove(fileId)) return;
    this.transferEngine.broadcastFilesChanged();
    this.invalidate();
  }

  clearFiles(): void {
    this.files.clear();
    this.transferEngine.broadcastFilesChanged();
    this.invalidate();
  }

  /** Ask a connected device to send one of its shared files. */
  requestFile(peerId: string, meta: SharedFileMetaLite, purpose: TransferPurpose): string | null {
    try {
      const artifactId = this.transferEngine.requestFile(peerId, meta, purpose);
      this.appendLog("info", `Requested "${meta.name}".`);
      return artifactId;
    } catch (error) {
      this.toasts.push({
        tone: "error",
        title: error instanceof Error ? error.message : "Could not start the transfer.",
      });
      return null;
    }
  }

  cancelTransfer(peerId: string, transferId: number): void {
    this.transferEngine.cancelTransfer(peerId, transferId);
  }

  /** Free the bytes held for a preview or a finished download. */
  releaseArtifact(artifactId: string): void {
    this.transferEngine.releaseArtifact(artifactId);
  }

  /**
   * Hand the finished bytes to the browser's download manager. The Blob is kept
   * until `releaseArtifact` so the user can save a second time.
   */
  saveArtifact(artifactId: string): void {
    this.transferEngine.saveArtifact(artifactId);
  }

  notify(message: Omit<ToastMessage, "id">): void {
    this.toasts.push(message);
  }

  dismissToast(id: string): void {
    this.toasts.dismiss(id);
  }

  private appendLog(level: LogLevel, text: string): void {
    this.logCounter += 1;
    const line: LogLine = { id: this.logCounter, at: Date.now(), level, text };
    this.log = [...this.log, line].slice(-MAX_LOG_LINES);
    this.invalidate();
  }
}

/* ------------------------------------------------------------------ */
/* Persisted device name                                               */
/* ------------------------------------------------------------------ */

function readStoredName(): string | null {
  try {
    const stored = window.localStorage.getItem(NAME_STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored.trim().slice(0, 64) : null;
  } catch {
    return null;
  }
}

function storeName(name: string): void {
  try {
    window.localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Storage blocked; the name simply will not persist.
  }
}
