"use client";

/**
 * Live transfer panel: one row per direction per file, with progress, speed and
 * a cancel button. This is the "is it actually working?" panel — during
 * development it is the first thing you watch.
 */

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { CategoryBadge } from "@/components/ui/glyphs";
import {
  ArrowLeftIcon,
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  UploadIcon,
} from "@/components/ui/icons";
import { ProgressBar } from "@/components/ui/progress-bar";
import { formatBytes, formatPercent, formatSpeed } from "@/lib/utils/format";
import { useTransferActions, useTransfers } from "@/hooks/use-share-go";
import type { TransferRecord, TransferStatus } from "@/types/files";

const STATUS_TONE: Record<TransferStatus, "accent" | "positive" | "negative" | "muted"> = {
  pending: "muted",
  streaming: "accent",
  complete: "positive",
  cancelled: "muted",
  error: "negative",
};

const STATUS_LABEL: Record<TransferStatus, string> = {
  pending: "Waiting",
  streaming: "",
  complete: "Complete",
  cancelled: "Cancelled",
  error: "Failed",
};

export function TransferPanel({
  direction,
  onClearAll,
}: {
  direction: "send" | "receive" | "all";
  onClearAll?: () => void;
}) {
  const transfers = useTransfers();

  const rows = useMemo(() => {
    const filtered =
      direction === "all" ? transfers : transfers.filter((item) => item.direction === direction);
    // Active first, then most recent.
    return [...filtered].sort((a, b) => {
      const rank = (item: TransferRecord) =>
        item.status === "streaming" || item.status === "pending" ? 0 : 1;
      return rank(a) - rank(b) || b.startedAt - a.startedAt;
    });
  }, [transfers, direction]);

  if (rows.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-ink-muted">No transfers yet</p>
        <p className="mx-auto mt-1 max-w-[34ch] text-xs leading-relaxed text-ink-faint">
          Connect a device, then preview or download something. Progress and speed show up
          here while bytes move.
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Transfers
        </h2>
        {onClearAll ? (
          <button
            type="button"
            onClick={onClearAll}
            className="focus-ring rounded-md text-xs text-ink-faint transition-colors hover:text-ink"
          >
            Clear finished
          </button>
        ) : null}
      </div>

      <ul className="space-y-2">
        {rows.map((transfer) => (
          <li key={`${transfer.peerId}:${transfer.transferId}`}>
            <TransferRow transfer={transfer} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TransferRow({ transfer }: { transfer: TransferRecord }) {
  const { cancel } = useTransferActions();
  const active = transfer.status === "streaming" || transfer.status === "pending";
  const ratio = transfer.size > 0 ? transfer.transferredBytes / transfer.size : 0;

  return (
    <article className="panel-inset flex items-start gap-3 px-3 py-2.5">
      <CategoryBadge category={transfer.category} className="mt-0.5 size-9" />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm text-ink" title={transfer.name}>
            <span className="mr-1.5 inline-flex align-[-2px] text-ink-faint">
              {transfer.direction === "send" ? (
                <UploadIcon className="size-3.5" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
            </span>
            {transfer.name || "file"}
          </p>
          <p className="shrink-0 font-mono text-[11px] tabular-nums text-ink-muted">
            {active ? formatPercent(ratio) : STATUS_LABEL[transfer.status]}
          </p>
        </div>

        <div className="mt-1.5">
          <ProgressBar
            value={ratio}
            label={STATUS_LABEL[transfer.status] || (transfer.direction === "send" ? "Sending" : "Receiving")}
            tone={STATUS_TONE[transfer.status]}
            size="sm"
            indeterminate={transfer.status === "pending"}
            trailing={`${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.size)}`}
          />
        </div>

        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
          <span>{transfer.peerName}</span>
          {active ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{formatSpeed(transfer.speedBytesPerSecond)}</span>
            </>
          ) : null}
          {transfer.error ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-negative">{transfer.error}</span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 items-center">
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Cancel transfer of ${transfer.name}`}
            onClick={() => cancel(transfer.peerId, transfer.transferId)}
            className="px-2"
          >
            <CloseIcon className="size-4" />
          </Button>
        ) : transfer.status === "complete" ? (
          <span className="grid size-9 place-items-center text-positive">
            <CheckIcon className="size-4.5" />
          </span>
        ) : (
          <span className="grid size-9 place-items-center text-ink-faint">
            <CloseIcon className="size-4" />
          </span>
        )}
      </div>
    </article>
  );
}

/** Compact count badge for the mobile tab bar. */
export function ActiveTransferCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-1 inline-grid min-w-5 place-items-center rounded-full bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-canvas">
      {count}
    </span>
  );
}

/** Small back button used by the mobile tab views. */
export function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} icon={<ArrowLeftIcon className="size-4" />}>
      Back
    </Button>
  );
}
