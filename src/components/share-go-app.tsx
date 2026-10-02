"use client";

/**
 * App shell.
 *
 * Layout strategy:
 *  - `lg` and up: two columns. Left = what this device shares + who is nearby.
 *    Right = what the connected device shares. Transfers live under the left
 *    column, where a desktop user naturally looks.
 *  - below `lg`: a single pane with a bottom tab bar. This is a genuinely
 *    different layout (thumb-reachable tabs, one task per screen), not a
 *    squeezed version of the desktop grid.
 */

import { useMemo, useState } from "react";
import { AppHeader } from "@/components/layout/app-header";
import { ConnectionRequestDialog } from "@/components/connection/connection-request-dialog";
import { SettingsSheet } from "@/components/connection/settings-sheet";
import { DeviceList } from "@/components/devices/device-list";
import { FilePreviewDialog } from "@/components/files/file-preview-dialog";
import { MyFilesPanel } from "@/components/files/my-files-panel";
import { RemoteBrowser } from "@/components/files/remote-browser";
import { Button } from "@/components/ui/button";
import { DeviceGlyphBadge } from "@/components/ui/glyphs";
import { FolderIcon, InfoIcon, UploadIcon } from "@/components/ui/icons";
import { ToastRegion } from "@/components/ui/toast-region";
import { ActiveTransferCount, TransferPanel } from "@/components/transfer/transfer-panel";
import {
  useEngineSnapshot,
  useToasts,
  useTransfers,
} from "@/hooks/use-share-go";
import { useEngine } from "@/components/providers/share-go-provider";
import type { SharedFileMetaLite } from "@/types/webrtc";

type MobileTab = "devices" | "files" | "transfers";

export function ShareGoApp() {
  const engine = useEngine();
  const { peers, identity } = useEngineSnapshot();
  const transfers = useTransfers();
  const toasts = useToasts();

  const [tab, setTab] = useState<MobileTab>("devices");
  const [preview, setPreview] = useState<SharedFileMetaLite | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const connectedPeer = useMemo(
    () => Object.values(peers).find((peer) => peer.state === "connected") ?? null,
    [peers],
  );
  const pendingPeer = useMemo(
    () =>
      Object.values(peers).find(
        (peer) => peer.state === "negotiating" || peer.state === "requesting",
      ) ?? null,
    [peers],
  );

  const activeTransfers = transfers.filter(
    (item) => item.status === "streaming" || item.status === "pending",
  ).length;

  function startTransfer(meta: SharedFileMetaLite, purpose: "preview" | "download") {
    if (!connectedPeer) {
      engine.notify({ tone: "error", title: "No connected device to fetch that file from." });
      return null;
    }
    return engine.requestFile(connectedPeer.deviceId, meta, purpose);
  }

  return (
    <div className="relative flex min-h-dvh flex-col">
      <div className="app-backdrop" aria-hidden="true" />

      <AppHeader onOpenSettings={() => setSettingsOpen(true)} />

      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-4 pb-28 pt-4 sm:px-6 lg:pb-8">
        <div className="grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)] lg:items-start">
          {/* ---------------- Left column ---------------- */}
          <div className="space-y-4">
            <div className={panelVisibility(tab, "devices", "block")}>
              <section className="panel p-4 sm:p-5" aria-labelledby="devices-heading">
                <header className="mb-3 flex items-baseline justify-between gap-3">
                  <h2 id="devices-heading" className="text-sm font-semibold text-ink">
                    Nearby devices
                  </h2>
                  <span className="text-xs text-ink-faint">same Wi-Fi</span>
                </header>
                <DeviceList />
              </section>
            </div>

            <div className={panelVisibility(tab, "files", "block")}>
              <MyFilesPanel />
            </div>

            <div className={panelVisibility(tab, "transfers", "hidden lg:block")}>
              <section className="panel overflow-hidden" aria-labelledby="transfers-heading">
                <span id="transfers-heading" className="sr-only">
                  Transfers
                </span>
                <TransferPanel direction="all" />
              </section>
            </div>
          </div>

          {/* ---------------- Right column ---------------- */}
          <div className={panelVisibility(tab, "devices", "block")}>
            <section className="panel min-h-[24rem] overflow-hidden" aria-label="Shared files from the connected device">
              {connectedPeer ? (
                <>
                  <header className="flex flex-wrap items-center gap-3 border-b border-hairline px-4 py-3.5 sm:px-5">
                    <DeviceGlyphBadge type={connectedPeer.deviceType} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {connectedPeer.deviceName}
                      </p>
                      <p className="flex items-center gap-1.5 text-xs text-positive">
                        <span className="size-1.5 rounded-full bg-positive" />
                        Connected directly · encrypted
                      </p>
                    </div>
                  </header>

                  <RemoteBrowser
                    peerId={connectedPeer.deviceId}
                    onPreview={setPreview}
                    onDownload={(meta) => {
                      setTab("transfers");
                      startTransfer(meta, "download");
                    }}
                  />
                </>
              ) : pendingPeer ? (
                <ConnectingState name={pendingPeer.deviceName} />
              ) : (
                <IdleState isSelf={Boolean(identity.deviceId)} />
              )}
            </section>
          </div>
        </div>
      </main>

      {/* ---------------- Mobile tab bar ---------------- */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-canvas/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden"
        aria-label="Sections"
      >
        <ul className="mx-auto flex max-w-lg">
          <TabButton
            active={tab === "devices"}
            onClick={() => setTab("devices")}
            icon={<FolderIcon className="size-5" />}
            label="Devices"
          />
          <TabButton
            active={tab === "files"}
            onClick={() => setTab("files")}
            icon={<UploadIcon className="size-5" />}
            label="My files"
          />
          <TabButton
            active={tab === "transfers"}
            onClick={() => setTab("transfers")}
            icon={<InfoIcon className="size-5" />}
            label="Transfers"
            badge={activeTransfers}
          />
        </ul>
      </nav>

      {/* ---------------- Overlays ---------------- */}
      <ConnectionRequestDialog />
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ToastRegion toasts={toasts} onDismiss={(id) => engine.dismissToast(id)} />

      <FilePreviewDialog
        meta={preview}
        peerId={connectedPeer?.deviceId ?? ""}
        startTransfer={startTransfer}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function panelVisibility(active: MobileTab, tab: MobileTab, desktop: string): string {
  // On mobile only the selected tab is shown; on desktop everything is.
  return `${desktop} ${active === tab ? "block" : "hidden"}`;
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  badge = 0,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <li className="flex-1">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        className={`focus-ring flex h-16 w-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
          active ? "text-accent" : "text-ink-faint hover:text-ink-muted"
        }`}
      >
        <span className="relative">
          {icon}
          <ActiveTransferCount count={badge} />
        </span>
        {label}
      </button>
    </li>
  );
}

function ConnectingState({ name }: { name: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
      <span className="grid size-14 place-items-center rounded-2xl border border-hairline bg-surface-2 text-accent">
        <InfoIcon className="size-6 animate-pulse" />
      </span>
      <div>
        <p className="text-sm font-medium text-ink">Connecting to {name}…</p>
        <p className="mx-auto mt-1.5 max-w-[40ch] text-xs leading-relaxed text-ink-muted">
          Exchanging connection details and finding the fastest local route. This normally
          takes under a second on the same network.
        </p>
      </div>
    </div>
  );
}

function IdleState({ isSelf }: { isSelf: boolean }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-20 text-center">
      <span className="grid size-16 place-items-center rounded-2xl border border-dashed border-hairline text-ink-faint">
        <InfoIcon className="size-7" />
      </span>
      <div className="max-w-[42ch]">
        <p className="text-base font-medium text-ink">No device connected</p>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
          {isSelf
            ? "Pick a device from the list and send a connection request. The other device has to accept before anything can be shared."
            : "ShareGo could not reach the signaling server yet. Check that it is running, then open Settings to set its address."}
        </p>
      </div>
      <Button variant="secondary" onClick={() => window.location.reload()}>
        Retry
      </Button>
    </div>
  );
}
