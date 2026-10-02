/**
 * Peer manager: the state machine between "two devices can see each other" and
 * "files can flow".
 *
 * Flow (see README for the diagram):
 *
 *   A: connection-request  ─────► B  (B shows a dialog)
 *   A ◄──── connection-response(accepted)
 *   A: offer  ────────────────►  B
 *   A ◄──── answer
 *   A/B: ice-candidate ⇄
 *   both DataChannels open  ──►  "Connected ✓"
 *
 * The manager also owns the timeout for unanswered requests and the "did that
 * peer vanish?" bookkeeping, so nothing leaks when someone closes a tab.
 */

import type { DataPlane, TransferEngine } from "@/lib/file-transfer/engine";
import { PeerSession } from "@/lib/webrtc/peer-session";
import { randomId } from "@/lib/utils/id";
import { CONNECTION_REQUEST_TIMEOUT_MS, type ClientSignalMessage, type DeviceInfo, type ServerSignalMessage } from "@/types/signaling";
import type {
  ControlMessage,
  IncomingRequestSnapshot,
  PeerSnapshot,
  PeerState,
  SharedFileMetaLite,
} from "@/types/webrtc";

/** The slice of the signaling client this manager needs. */
export interface SignalSender {
  send(message: ClientSignalMessage): void;
}

export interface PeerManagerEvents {
  onDevicesChanged(devices: DeviceInfo[]): void;
  onIncomingRequest(request: IncomingRequestSnapshot): void;
  onRequestRemoved(requestId: string): void;
  onPeerChanged(peer: PeerSnapshot): void;
  onPeerRemoved(peerId: string): void;
  /** Remote shared file list arrived or changed. */
  onRemoteFiles(peerId: string, files: SharedFileMetaLite[]): void;
  /** This device's display name, for the `control-hello` handshake. */
  getSelfName(): string;
  onLog(line: string): void;
  onError(message: string): void;
}

interface PendingOutgoing {
  peerId: string;
  requestId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingIncoming {
  request: IncomingRequestSnapshot;
  timer: ReturnType<typeof setTimeout>;
}

export class PeerManager {
  private sender: SignalSender | null = null;
  private devices = new Map<string, DeviceInfo>();
  private sessions = new Map<string, PeerSession>();
  private outgoingRequests = new Map<string, PendingOutgoing>();
  private incomingRequests = new Map<string, PendingIncoming>();

  constructor(
    private readonly engine: TransferEngine,
    private readonly events: PeerManagerEvents,
  ) {}

  /* -------------------------------------------------------------- */
  /* Signaling plumbing                                             */
  /* -------------------------------------------------------------- */

  attach(sender: SignalSender): void {
    this.sender = sender;
  }

  detach(): void {
    this.sender = null;
  }

  getDevices(): DeviceInfo[] {
    return [...this.devices.values()];
  }

  /** Replace the device roster with what the server just told us. */
  setDevices(devices: DeviceInfo[]): void {
    const next = new Map(devices.map((device) => [device.deviceId, device]));
    this.devices = next;

    // A device that vanished while we were connected to it.
    for (const peerId of [...this.sessions.keys()]) {
      if (next.has(peerId)) continue;
      this.teardownPeer(peerId, "That device went offline.");
    }

    this.events.onDevicesChanged(this.getDevices());
  }

  /* -------------------------------------------------------------- */
  /* Inbound signaling                                              */
  /* -------------------------------------------------------------- */

  handleServerMessage(message: ServerSignalMessage): void {
    switch (message.type) {
      case "welcome":
        this.setDevices(message.devices);
        return;

      case "devices":
        this.setDevices(message.devices);
        return;

      case "device-left":
        this.handlePeerGone(message.deviceId, "That device closed ShareGo.");
        return;

      case "connection-request":
        this.handleIncomingRequest(message);
        return;

      case "connection-response":
        this.handleConnectionResponse(message);
        return;

      case "offer": {
        const session = this.ensureSession(message.from, true);
        void session.handleOffer(message.description);
        return;
      }

      case "answer": {
        const session = this.sessions.get(message.from.deviceId);
        if (!session) return;
        void session.handleAnswer(message.description);
        return;
      }

      case "ice-candidate": {
        const session = this.sessions.get(message.from.deviceId);
        if (!session) {
          this.events.onLog(
            `ICE candidate from an unknown device (${message.from.deviceName}); dropped.`,
          );
          return;
        }
        void session.handleCandidate(message.candidate);
        return;
      }

      case "peer-disconnected":
        this.handlePeerGone(message.from, "The other device disconnected.");
        return;

      case "error":
        this.events.onError(message.message);
        return;

      default:
        return;
    }
  }

  private handlePeerGone(deviceId: string, reason: string): void {
    const outgoing = [...this.outgoingRequests.values()].find(
      (entry) => entry.peerId === deviceId,
    );
    if (outgoing) this.cancelOutgoingRequest(outgoing.requestId);

    for (const [requestId, entry] of [...this.incomingRequests]) {
      if (entry.request.deviceId !== deviceId) continue;
      clearTimeout(entry.timer);
      this.incomingRequests.delete(requestId);
      this.events.onRequestRemoved(requestId);
    }

    if (this.sessions.has(deviceId)) this.teardownPeer(deviceId, reason);

    if (this.devices.delete(deviceId)) {
      this.events.onDevicesChanged(this.getDevices());
    }
  }

  private handleIncomingRequest(message: {
    from: DeviceInfo;
    requestId: string;
    expiresInMs: number;
  }): void {
    // One dialog per device: a second request replaces the first.
    for (const [requestId, entry] of [...this.incomingRequests]) {
      if (entry.request.deviceId !== message.from.deviceId) continue;
      clearTimeout(entry.timer);
      this.incomingRequests.delete(requestId);
      this.events.onRequestRemoved(requestId);
    }

    // The server sends a *duration*, never an absolute deadline: the two devices
    // rarely agree on the wall clock, and a skewed clock would either expire the
    // dialog instantly or leave it open forever.
    const receivedAt = Date.now();
    const expiresAt = receivedAt + message.expiresInMs;

    const request: IncomingRequestSnapshot = {
      requestId: message.requestId,
      deviceId: message.from.deviceId,
      deviceName: message.from.deviceName,
      deviceType: message.from.deviceType,
      receivedAt,
      expiresAt,
    };

    const timer = setTimeout(() => {
      this.incomingRequests.delete(message.requestId);
      this.events.onRequestRemoved(message.requestId);
      this.events.onLog("A connection request expired before it was answered.");
    }, Math.max(0, expiresAt - receivedAt));

    this.incomingRequests.set(message.requestId, { request, timer });
    this.events.onIncomingRequest(request);
  }

  private handleConnectionResponse(message: {
    from: DeviceInfo;
    requestId: string;
    accepted: boolean;
  }): void {
    const pending = this.outgoingRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.outgoingRequests.delete(message.requestId);

    if (!message.accepted) {
      this.removePeer(message.from.deviceId);
      this.events.onError(`${message.from.deviceName} declined the connection.`);
      return;
    }

    const session = this.ensureSession(message.from, false);
    session.setState("negotiating", null);
  }

  /* -------------------------------------------------------------- */
  /* Outbound actions                                               */
  /* -------------------------------------------------------------- */

  /** Ask a device to connect. Nothing is negotiated until they accept. */
  requestConnection(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device || !this.sender) return;

    const existing = this.sessions.get(deviceId);
    if (existing?.currentState === "connected" || existing?.currentState === "negotiating") {
      return;
    }
    if (this.sessions.has(deviceId)) return;

    const requestId = randomId(14);
    const timer = setTimeout(() => {
      this.outgoingRequests.delete(requestId);
      this.removePeer(deviceId);
      this.events.onError(
        `${device.deviceName} did not answer the connection request in time.`,
      );
    }, CONNECTION_REQUEST_TIMEOUT_MS);

    this.outgoingRequests.set(requestId, { peerId: deviceId, requestId, timer });

    // Show "requesting" immediately; the session starts on acceptance.
    this.upsertPeer(device, "requesting", null);

    this.sender.send({ type: "connection-request", to: deviceId, requestId });
  }

  respondToRequest(requestId: string, accepted: boolean): void {
    const entry = this.incomingRequests.get(requestId);
    if (!entry || !this.sender) return;

    clearTimeout(entry.timer);
    this.incomingRequests.delete(requestId);
    this.events.onRequestRemoved(requestId);

    this.sender.send({
      type: "connection-response",
      to: entry.request.deviceId,
      requestId,
      accepted,
    });

    if (accepted) {
      const device = this.devices.get(entry.request.deviceId);
      if (device) this.upsertPeer(device, "negotiating", null);
    }
  }

  /** Tear down a connection on purpose; the peer is notified over signaling. */
  disconnect(peerId: string): void {
    const device = this.devices.get(peerId);
    if (device && this.sender) {
      this.sender.send({ type: "disconnect-peer", to: peerId });
    }

    const outgoing = [...this.outgoingRequests.values()].find(
      (entry) => entry.peerId === peerId,
    );
    if (outgoing) this.cancelOutgoingRequest(outgoing.requestId);

    this.teardownPeer(peerId, "You disconnected this device.");
    this.events.onLog(`Disconnected from ${device?.deviceName ?? "device"}.`);
  }

  /** Called when the signaling session is replaced: everything peer related is invalid. */
  resetAll(reason: string): void {
    for (const pending of this.outgoingRequests.values()) clearTimeout(pending.timer);
    this.outgoingRequests.clear();

    for (const entry of this.incomingRequests.values()) clearTimeout(entry.timer);
    this.incomingRequests.clear();

    for (const peerId of [...this.sessions.keys()]) this.teardownPeer(peerId, reason);

    this.devices.clear();
    this.events.onDevicesChanged([]);
  }

  dispose(): void {
    this.resetAll("ShareGo was closed.");
    this.sender = null;
  }

  /* -------------------------------------------------------------- */
  /* Internals                                                     */
  /* -------------------------------------------------------------- */

  private cancelOutgoingRequest(requestId: string): void {
    const pending = this.outgoingRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.outgoingRequests.delete(requestId);
    this.removePeer(pending.peerId);
  }

  /**
   * Get (or create) the session for a device.
   *
   * `polite` marks the peer that did *not* send the offer. In practice the
   * requesting device is the impolite one (it offers), the accepting device is
   * polite. Passing `polite = true` from `ensureSession` on an inbound offer is
   * what gives the accepter its polite role.
   */
  private ensureSession(device: DeviceInfo, polite: boolean): PeerSession {
    const existing = this.sessions.get(device.deviceId);
    if (existing) return existing;

    const session = new PeerSession(device, polite, {
      onState: (state, error) => this.upsertPeer(device, state, error),
      onOpen: (plane: DataPlane) => this.handleOpen(device, plane),
      onControl: (message) => this.handleControl(device.deviceId, message),
      onChunk: (buffer) => this.engine.handleChunk(device.deviceId, buffer),
      onClosed: () => {
        this.engine.unregisterPlane(device.deviceId);
        this.events.onPeerRemoved(device.deviceId);
      },
      onLog: (line) => this.events.onLog(line),
    });

    session.setSignalSender((message) => {
      if (message.type === "offer" && message.description) {
        this.sender?.send({ type: "offer", to: device.deviceId, description: message.description });
      } else if (message.type === "answer" && message.description) {
        this.sender?.send({ type: "answer", to: device.deviceId, description: message.description });
      } else if (message.type === "ice-candidate" && message.candidate) {
        this.sender?.send({
          type: "ice-candidate",
          to: device.deviceId,
          candidate: message.candidate,
        });
      }
    });

    this.sessions.set(device.deviceId, session);
    this.upsertPeer(device, "negotiating", null);
    return session;
  }

  /**
   * Control messages are split between the file-list conversation (which belongs
   * to the manager, because it owns per-peer UI state) and the transfer engine
   * (which owns everything to do with bytes).
   */
  private handleControl(peerId: string, message: ControlMessage): void {
    switch (message.type) {
      case "file-list":
        this.events.onRemoteFiles(peerId, message.files);
        this.events.onLog(
          `${this.devices.get(peerId)?.deviceName ?? "The peer"} shared ${message.files.length} file${message.files.length === 1 ? "" : "s"}.`,
        );
        return;

      case "files-changed":
        // The peer only tells us *that* something changed; ask for the
        // authoritative list rather than guessing which entry moved.
        this.engine.requestFileList(peerId);
        return;

      default:
        this.engine.handleControl(peerId, message);
    }
  }

  private handleOpen(device: DeviceInfo, plane: DataPlane): void {
    this.engine.registerPlane(plane);
    plane.sendControl({
      type: "control-hello",
      protocol: 1,
      deviceName: this.events.getSelfName(),
    });
    // Push our file list immediately so the peer can browse without asking,
    // and ask for theirs so the pane is populated in either connection order.
    this.engine.sendFileList(device.deviceId);
    this.engine.requestFileList(device.deviceId);

    this.sessions.get(device.deviceId)?.ping(Date.now());
    this.events.onLog(`Connected directly to ${device.deviceName}.`);
  }

  private teardownPeer(peerId: string, reason: string): void {
    const session = this.sessions.get(peerId);
    this.sessions.delete(peerId);
    this.engine.unregisterPlane(peerId);

    if (session) {
      session.close(reason);
    } else {
      this.events.onPeerRemoved(peerId);
    }
  }

  private removePeer(peerId: string): void {
    this.teardownPeer(peerId, "The connection was not completed.");
  }

  private upsertPeer(
    device: DeviceInfo,
    state: PeerState,
    error: string | null,
  ): void {
    this.events.onPeerChanged({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      state,
      error,
      connectedAt: state === "connected" ? Date.now() : null,
    });
  }
}
