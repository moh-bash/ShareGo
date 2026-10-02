"use client";

/**
 * Settings + activity log.
 *
 * The signaling URL lives here because testing on a second device is the single
 * most common stumbling block: the phone has to dial the *development machine's*
 * LAN address, not `localhost`. The log is here for the same reason — when a
 * connection does not form, the WebRTC/ICE sequence should be inspectable
 * without opening devtools.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { InfoIcon } from "@/components/ui/icons";
import { Modal } from "@/components/ui/modal";
import { isValidSignalingUrl, normaliseUrl } from "@/lib/config";
import { useEngine } from "@/components/providers/share-go-provider";
import { useEngineSnapshot, useSignaling } from "@/hooks/use-share-go";
import { useRelativeTime } from "@/hooks/use-timing";
import type { LogLevel } from "@/lib/engine";

export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Unmounting while closed means the form below remounts (and re-seeds its
  // draft from the current URL) every time the sheet is opened, with no effect
  // needed to keep the two in sync.
  if (!open) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Settings & activity"
      description="Connection details and a live log of the WebRTC handshake."
      size="lg"
    >
      <SettingsForm />
    </Modal>
  );
}

function SettingsForm() {
  const engine = useEngine();
  const { identity, log } = useEngineSnapshot();
  const signaling = useSignaling();
  const [urlDraft, setUrlDraft] = useState(signaling.url);
  const [urlError, setUrlError] = useState<string | null>(null);

  function applyUrl() {
    const trimmed = urlDraft.trim();
    if (trimmed.length === 0) return;
    if (!isValidSignalingUrl(trimmed)) {
      setUrlError("That does not look like a ws:// or wss:// address.");
      return;
    }
    setUrlError(null);
    engine.changeSignalingUrl(trimmed);
    engine.notify({ tone: "info", title: "Signaling server updated", description: normaliseUrl(trimmed) });
  }

  return (
    <div className="space-y-6 px-5 py-5">
        <section aria-labelledby="settings-server">
          <h3 id="settings-server" className="text-sm font-semibold text-ink">
            Signaling server
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            ShareGo introduces devices to each other over this WebSocket server, then
            transfers files directly between them. No file data passes through it.
          </p>

          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              applyUrl();
            }}
          >
            <input
              value={urlDraft}
              onChange={(event) => {
                setUrlDraft(event.target.value);
                setUrlError(null);
              }}
              spellCheck={false}
              aria-label="Signaling server address"
              placeholder="ws://192.168.1.20:8080"
              className="focus-ring h-11 min-w-0 flex-1 rounded-xl border border-hairline bg-surface-2 px-3 font-mono text-sm text-ink placeholder:text-ink-faint"
            />
            <Button variant="primary" type="submit" disabled={urlDraft.trim() === signaling.url}>
              Reconnect
            </Button>
          </form>

          {urlError ? (
            <p className="mt-2 text-xs text-negative">{urlError}</p>
          ) : (
            <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
              <InfoIcon className="mt-px size-3.5 shrink-0" />
              <span>
                On a phone, use your computer&apos;s LAN address (for example{" "}
                <code className="font-mono text-ink-muted">ws://192.168.1.20:8080</code>). The
                signaling server prints the exact URLs when it starts.
              </span>
            </p>
          )}
        </section>

        <section aria-labelledby="settings-identity">
          <h3 id="settings-identity" className="text-sm font-semibold text-ink">
            This device
          </h3>
          <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-[9rem_1fr]">
            <dt className="text-ink-faint">Name</dt>
            <dd className="text-ink">{identity.deviceName}</dd>
            <dt className="text-ink-faint">Session id</dt>
            <dd className="truncate font-mono text-ink-muted">
              {identity.deviceId ?? "not connected"}
            </dd>
            <dt className="text-ink-faint">Signaling</dt>
            <dd className="truncate font-mono text-ink-muted">{signaling.status}</dd>
          </dl>
        </section>

        <section aria-labelledby="settings-log">
          <h3 id="settings-log" className="text-sm font-semibold text-ink">
            Activity log
          </h3>
          {log.length === 0 ? (
            <p className="mt-2 text-xs text-ink-faint">Nothing has happened yet.</p>
          ) : (
            <ol className="scroll-area mt-2 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-hairline bg-surface-2/40 p-2 font-mono text-[11px]">
              {[...log].reverse().map((line) => (
                <li key={line.id} className="flex gap-2">
                  <LogTimestamp at={line.at} />
                  <span className={LEVEL_CLASS[line.level]}>{line.text}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
  );
}

const LEVEL_CLASS: Record<LogLevel, string> = {
  info: "text-ink-muted",
  warn: "text-caution",
  error: "text-negative",
};

function LogTimestamp({ at }: { at: number }) {
  const relative = useRelativeTime(at);
  return <span className="shrink-0 text-ink-faint">{relative}</span>;
}
