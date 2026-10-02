"use client";

import { Button } from "@/components/ui/button";
import { DeviceGlyphBadge } from "@/components/ui/glyphs";
import { CheckIcon, SpinnerIcon, WifiOffIcon } from "@/components/ui/icons";
import { ProgressBar } from "@/components/ui/progress-bar";
import { useEngineSnapshot, usePeerActions } from "@/hooks/use-share-go";
import { DEVICE_TYPE_LABELS } from "@/lib/utils/device";
import type { DeviceInfo } from "@/types/signaling";
import type { PeerState } from "@/types/webrtc";

/**
 * Nearby devices list.
 *
 * The server roster includes devices that are merely *visible*; connecting is a
 * two-step handshake because a stranger on the same coffee-shop Wi-Fi must never
 * be able to pull files without an explicit accept.
 */
export function DeviceList({ compact = false }: { compact?: boolean }) {
  const { devices, peers } = useEngineSnapshot();
  const { connect } = usePeerActions();

  if (devices.length === 0) {
    return <EmptyDeviceList compact={compact} />;
  }

  return (
    <ul className={compact ? "space-y-2" : "space-y-2.5"}>
      {devices.map((device) => {
        const peer = peers[device.deviceId];
        return (
          <li key={device.deviceId}>
            <DeviceCard
              device={device}
              state={peer?.state ?? "idle"}
              error={peer?.error ?? null}
              onConnect={() => connect(device.deviceId)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function EmptyDeviceList({ compact }: { compact?: boolean }) {
  return (
    <div className="panel-inset flex flex-col items-center gap-2.5 px-4 py-7 text-center">
      <span className="grid size-11 place-items-center rounded-xl border border-dashed border-hairline text-ink-faint">
        <WifiOffIcon className="size-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-ink-muted">No other devices yet</p>
        <p className="mt-1 max-w-[26ch] text-xs leading-relaxed text-ink-faint">
          Open ShareGo on another phone or laptop connected to the same Wi-Fi. It will
          appear here within a second.
        </p>
      </div>
      {compact ? null : <LoadingHint />}
    </div>
  );
}

function LoadingHint() {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-ink-faint">
      <SpinnerIcon className="size-3" />
      listening on the signaling server
    </p>
  );
}

const STATE_LABEL: Partial<Record<PeerState, string>> = {
  requesting: "Requesting…",
  negotiating: "Connecting…",
  connected: "Connected",
  disconnected: "Reconnecting…",
  failed: "Failed",
  closed: "Disconnected",
};

export function DeviceCard({
  device,
  state,
  error,
  onConnect,
}: {
  device: DeviceInfo;
  state: PeerState;
  error: string | null;
  onConnect: () => void;
}) {
  const busy = state === "requesting" || state === "negotiating" || state === "connected";
  const label = DEVICE_TYPE_LABELS[device.deviceType];

  return (
    <div className="panel-inset animate-rise flex items-center gap-3 px-3 py-3 transition-colors hover:border-accent/30">
      <DeviceGlyphBadge type={device.deviceType} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{device.deviceName}</p>
        <p className="truncate text-xs text-ink-faint">{label}</p>

        {state === "negotiating" || state === "requesting" ? (
          <div className="mt-2">
            <ProgressBar
              value={0}
              label={STATE_LABEL[state] ?? ""}
              indeterminate
              size="sm"
            />
          </div>
        ) : null}
        {error ? (
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-negative">{error}</p>
        ) : null}
      </div>

      {state === "connected" ? (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-positive/12 px-2.5 py-1 text-xs font-medium text-positive">
          <CheckIcon className="size-3.5" />
          Connected
        </span>
      ) : (
        <Button
          variant={busy ? "subtle" : "primary"}
          size="sm"
          disabled={busy}
          onClick={onConnect}
          className="shrink-0"
        >
          {busy ? <SpinnerIcon className="size-4" /> : null}
          {STATE_LABEL[state] === "Requesting…" ? "Waiting" : "Connect"}
        </Button>
      )}
    </div>
  );
}
