/**
 * One `RTCPeerConnection` + its two DataChannels, for one remote device.
 *
 * Negotiation follows the W3C "perfect negotiation" pattern so that a
 * simultaneous offer (glare) degrades gracefully instead of deadlocking. In the
 * normal ShareGo flow glare cannot really happen — only the *requesting* device
 * ever creates an offer, after the other side accepted — but implementing the
 * polite/impolite rollback keeps the class honest for reconnects.
 */

import type { DataPlane } from "@/lib/file-transfer/engine";
import { parseControlMessage } from "@/lib/webrtc/protocol";
import { getIceServers } from "@/lib/webrtc/config";
import {
  CONTROL_CHANNEL_LABEL,
  FILE_CHANNEL_LABEL,
  type ControlMessage,
  type PeerState,
} from "@/types/webrtc";
import type { DeviceInfo } from "@/types/signaling";

export interface PeerSessionEvents {
  onState(state: PeerState, error: string | null): void;
  /** Both channels are open: the peer can exchange files now. */
  onOpen(plane: DataPlane): void;
  onControl(message: ControlMessage): void;
  onChunk(buffer: ArrayBuffer): void;
  onClosed(reason: string): void;
  /** Human readable trace lines for the debug log. */
  onLog?(line: string): void;
}

export class PeerSession {
  readonly device: DeviceInfo;
  /** The polite peer rolls back its own offer when glare is detected. */
  readonly polite: boolean;

  private readonly pc: RTCPeerConnection;
  private readonly events: PeerSessionEvents;
  private control: RTCDataChannel | null = null;
  private file: RTCDataChannel | null = null;
  private remoteDescriptionSet = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private makingOffer = false;
  private ignoreOffer = false;
  private state: PeerState = "negotiating";
  private error: string | null = null;
  private closed = false;

  private onSendSignal: (message: {
    type: "offer" | "answer" | "ice-candidate";
    to: string;
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  }) => void = () => {};

  constructor(device: DeviceInfo, polite: boolean, events: PeerSessionEvents) {
    this.device = device;
    this.polite = polite;
    this.events = events;

    this.pc = new RTCPeerConnection({
      // A single LAN connection needs no STUN at all; the default list keeps
      // the build working if you try it across networks.
      iceServers: getIceServers(),
      // Two DataChannels are created immediately, so bundling them onto one
      // transport keeps the connection to a single 5-tuple.
      bundlePolicy: "max-bundle",
    });

    this.pc.onicecandidate = (event) => {
      // `null` candidate == end-of-candidates; peers need it to finish.
      this.emitCandidate(event.candidate ? event.candidate.toJSON() : null);
    };

    this.pc.onnegotiationneeded = () => {
      void this.negotiate();
    };

    this.pc.onconnectionstatechange = () => {
      this.handleConnectionState();
    };

    this.pc.ondatachannel = (event) => {
      this.attachChannel(event.channel);
    };

    if (!polite) {
      // The initiator owns the DataChannels. Creating them here is what fires
      // `negotiationneeded`, which produces the first offer.
      this.attachChannel(this.pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true }));
      this.attachChannel(
        this.pc.createDataChannel(FILE_CHANNEL_LABEL, { ordered: true }),
      );
    }
  }

  get currentState(): PeerState {
    return this.state;
  }

  /* ---------------------------------------------------------------- */
  /* Signaling in                                                     */
  /* ---------------------------------------------------------------- */

  private emitCandidate(candidate: RTCIceCandidateInit | null): void {
    this.onSendSignal({
      type: "ice-candidate",
      to: this.device.deviceId,
      candidate: candidate ?? { candidate: "" },
    });
  }

  /** Wire the session to the signaling transport. */
  setSignalSender(
    sender: (message: {
      type: "offer" | "answer" | "ice-candidate";
      to: string;
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    }) => void,
  ): void {
    this.onSendSignal = sender;
  }

  private async negotiate(): Promise<void> {
    if (this.polite || this.closed) return;

    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      this.onSendSignal({
        type: "offer",
        to: this.device.deviceId,
        description: offer,
      });
    } catch (error) {
      this.setState("failed", describeError(error, "Could not create a connection offer."));
    } finally {
      this.makingOffer = false;
    }
  }

  async handleOffer(description: RTCSessionDescriptionInit): Promise<void> {
    try {
      // Glare: an offer arrived while we were making one. The polite peer
      // rolls back; the impolite peer ignores the incoming offer.
      const offerCollision =
        description.type === "offer" &&
        (this.makingOffer || this.pc.signalingState !== "stable");

      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        this.events.onLog?.("Ignored a colliding offer (impolite peer).");
        return;
      }

      if (offerCollision) {
        await Promise.all([
          this.pc.setLocalDescription({ type: "rollback" }),
          this.pc.setRemoteDescription(description),
        ]);
      } else {
        await this.pc.setRemoteDescription(description);
      }

      this.remoteDescriptionSet = true;
      await this.flushCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.onSendSignal({
        type: "answer",
        to: this.device.deviceId,
        description: answer,
      });
    } catch (error) {
      this.setState("failed", describeError(error, "Could not answer the connection request."));
    }
  }

  async handleAnswer(description: RTCSessionDescriptionInit): Promise<void> {
    try {
      await this.pc.setRemoteDescription(description);
      this.remoteDescriptionSet = true;
      await this.flushCandidates();
    } catch (error) {
      this.setState("failed", describeError(error, "The peer's answer could not be applied."));
    }
  }

  async handleCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    try {
      // Candidates can arrive before the description they belong to. Buffer
      // them; a missing candidate is far worse than a late one.
      if (!this.remoteDescriptionSet) {
        this.pendingCandidates.push(candidate);
        return;
      }
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // A rejected candidate is usually benign (a stale one from a torn down
      // connection), so log instead of failing the whole session.
      this.events.onLog?.(
        `Ignored an ICE candidate: ${describeError(error, "invalid candidate")}`,
      );
    }
  }

  private async flushCandidates(): Promise<void> {
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        this.events.onLog?.(
          `Dropped a queued ICE candidate: ${describeError(error, "invalid candidate")}`,
        );
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* DataChannels                                                     */
  /* ---------------------------------------------------------------- */

  private attachChannel(channel: RTCDataChannel): void {
    const isControl = channel.label === CONTROL_CHANNEL_LABEL;
    const isFile = channel.label === FILE_CHANNEL_LABEL;

    if (!isControl && !isFile) {
      // We did not create this channel; drop it rather than leaving it open.
      channel.close();
      return;
    }

    if (isControl) this.control = channel;
    else this.file = channel;

    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      if (this.isDataPlaneOpen()) {
        this.setState("connected", null);
        this.events.onOpen(this.createDataPlane());
      }
    };

    channel.onclose = () => {
      this.events.onLog?.(`Data channel "${channel.label}" closed.`);
    };

    channel.onerror = () => {
      this.events.onLog?.(`Data channel "${channel.label}" reported an error.`);
    };

    channel.onmessage = (event: MessageEvent) => {
      if (isControl) {
        if (typeof event.data !== "string") return;
        const message = parseControlMessage(event.data);
        if (message) this.events.onControl(message);
        else this.events.onLog?.("Dropped an invalid control message from the peer.");
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        this.events.onChunk(event.data);
      }
    };
  }

  private isDataPlaneOpen(): boolean {
    return this.control?.readyState === "open" && this.file?.readyState === "open";
  }

  createDataPlane(): DataPlane {
    const control = this.control;
    const file = this.file;
    if (!control || !file) {
      throw new Error("The data channels are not open yet.");
    }

    return {
      peerId: this.device.deviceId,
      peerName: this.device.deviceName,
      deviceType: this.device.deviceType,
      channel: file,
      isOpen: () => this.isDataPlaneOpen(),
      sendControl: (message: ControlMessage) => {
        if (control.readyState !== "open") return;
        control.send(JSON.stringify(message));
      },
      sendBytes: (buffer: ArrayBuffer) => {
        if (file.readyState !== "open") {
          throw new Error("The file channel closed while sending.");
        }
        file.send(buffer);
      },
    };
  }

  /** Fire-and-forget probe used by the "Connected directly" indicator. */
  ping(at: number): void {
    this.control?.send(JSON.stringify({ type: "control-ping", at } satisfies ControlMessage));
  }

  /* ---------------------------------------------------------------- */
  /* State + teardown                                                */
  /* ---------------------------------------------------------------- */

  private handleConnectionState(): void {
    if (this.closed) return;

    switch (this.pc.connectionState) {
      case "connecting":
        this.setState("negotiating", null);
        break;
      case "connected":
        // DataChannels still have to open before files can flow.
        if (this.isDataPlaneOpen()) this.setState("connected", null);
        break;
      case "disconnected":
        this.setState("disconnected", "The other device stopped responding.");
        break;
      case "failed":
        this.setState("failed", "Could not establish a direct connection. Check that both devices are on the same Wi-Fi.");
        break;
      case "closed":
        this.setState("closed", null);
        break;
      default:
        break;
    }
  }

  setState(state: PeerState, error: string | null): void {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.events.onState(state, error);
  }

  /** Full teardown: stops ICE, closes channels, drops callbacks. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;

    this.control?.close();
    this.file?.close();
    this.control = null;
    this.file = null;

    this.pc.onicecandidate = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    this.pc.close();

    this.pendingCandidates = [];
    this.state = "closed";
    this.events.onClosed(reason);
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
