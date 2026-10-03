"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DeviceGlyph } from "@/components/ui/glyphs";
import { LogoMark, SettingsIcon } from "@/components/ui/icons";
import { DirectConnectionBadge, SignalingStatusPill } from "@/components/ui/status-pill";
import { useEngine } from "@/components/providers/share-go-provider";
import { useEngineSnapshot, usePeerActions, useSignaling } from "@/hooks/use-share-go";
import Image from "next/image";
import logo from "@/assets/logo.png";

/**
 * App bar: who this device is, whether the signaling link is healthy, and a
 * loud statement of the privacy model once a peer is connected.
 */
export function AppHeader({ onOpenSettings }: { onOpenSettings: () => void }) {
  const engine = useEngine();
  const { identity, peers, devices } = useEngineSnapshot();
  const signaling = useSignaling();
  const { disconnect } = usePeerActions();
  const [editingName, setEditingName] = useState(false);

  const connected = Object.values(peers).find((peer) => peer.state === "connected");

  useEffect(() => {
    if (!editingName) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditingName(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingName]);

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas/85 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 sm:px-6">
        <div className="relative">
          <Image src={logo} alt="Logo" width={150} />
        </div>

        <div className="ml-auto flex items-center gap-2">
          {connected ? (
            <>
              <DirectConnectionBadge peerName={connected.deviceName} />
              <Button
                variant="subtle"
                size="sm"
                onClick={() => disconnect(connected.deviceId)}
              >
                Disconnect
              </Button>
            </>
          ) : (
            <SignalingStatusPill status={signaling.status} />
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            aria-label="Settings and activity log"
            className="px-2.5"
          >
            <SettingsIcon className="size-5" />
          </Button>
        </div>
      </div>

      {/* Identity strip: rename inline, without a trip through settings. */}
      <div className="border-t border-hairline/70 bg-surface/40">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 text-xs sm:px-6">
          <span className="flex items-center gap-2 text-ink-muted">
            <span className="grid size-7 place-items-center rounded-lg border border-hairline bg-surface-2">
              <DeviceGlyph type={identity.deviceType} className="size-4" />
            </span>
            <span className="text-ink-faint">This device</span>
          </span>

          {editingName ? (
            <input
              key={identity.deviceName}
              defaultValue={identity.deviceName}
              maxLength={64}
              autoFocus
              aria-label="Device name"
              className="focus-ring h-8 w-48 rounded-lg border border-accent/40 bg-surface-2 px-2.5 text-sm text-ink"
              onBlur={(event) => {
                engine.renameDevice(event.target.value);
                setEditingName(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = identity.deviceName;
                  event.currentTarget.blur();
                }
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              className="focus-ring rounded-md px-1.5 py-0.5 font-medium text-ink underline decoration-hairline decoration-dotted underline-offset-4 transition-colors hover:text-accent"
            >
              {identity.deviceName}
            </button>
          )}

          <span className="hidden text-ink-faint sm:inline">
            {devices.length === 0
              ? "Waiting for another device…"
              : `${devices.length} device${devices.length === 1 ? "" : "s"} nearby`}
          </span>
        </div>
      </div>
    </header>
  );
}
