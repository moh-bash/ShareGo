"use client";

import { LockIcon, SpinnerIcon, WifiIcon, WifiOffIcon } from "@/components/ui/icons";
import type { SignalingStatus } from "@/types/signaling";

const STATUS_COPY: Record<SignalingStatus, { label: string; tone: string }> = {
  idle: { label: "Starting…", tone: "text-ink-faint" },
  connecting: { label: "Connecting…", tone: "text-ink-muted" },
  online: { label: "On the local network", tone: "text-positive" },
  reconnecting: { label: "Reconnecting…", tone: "text-caution" },
  offline: { label: "Offline", tone: "text-negative" },
};

/**
 * The privacy promise made visible: when a peer is connected we are on a direct
 * peer-to-peer link, so the lock icon is not decoration.
 */
export function SignalingStatusPill({ status }: { status: SignalingStatus }) {
  const copy = STATUS_COPY[status];
  const online = status === "online";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2/70 px-2.5 py-1 text-xs font-medium ${copy.tone}`}
      title={`Signaling server: ${status}`}
    >
      {online ? (
        <WifiIcon className="size-3.5" />
      ) : status === "offline" ? (
        <WifiOffIcon className="size-3.5" />
      ) : (
        <SpinnerIcon className="size-3.5" />
      )}
      <span className="hidden sm:inline">{copy.label}</span>
    </span>
  );
}

export function DirectConnectionBadge({ peerName }: { peerName: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-positive/12 px-2.5 py-1 text-xs font-medium text-positive">
      <LockIcon className="size-3.5" />
      <span className="truncate">Connected directly to {peerName}</span>
    </span>
  );
}
