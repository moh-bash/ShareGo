import { clamp } from "@/lib/utils/format";

export interface ProgressBarProps {
  /** 0..1 */
  value: number;
  label: string;
  tone?: "accent" | "positive" | "negative" | "muted";
  size?: "sm" | "md";
  /** Rendered on the right of the track, e.g. "72%". */
  trailing?: string;
  indeterminate?: boolean;
}

const TONES = {
  accent: "bg-accent",
  positive: "bg-positive",
  negative: "bg-negative",
  muted: "bg-ink-faint",
} as const;

export function ProgressBar({
  value,
  label,
  tone = "accent",
  size = "md",
  trailing,
  indeterminate = false,
}: ProgressBarProps) {
  const pct = clamp(value, 0, 1) * 100;

  return (
    <div className="w-full">
      {trailing ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <span className="text-xs text-ink-faint">{label}</span>
          <span className="font-mono text-xs text-ink-muted tabular-nums">{trailing}</span>
        </div>
      ) : null}

      <div
        className="relative w-full overflow-hidden rounded-full bg-surface-3"
        style={{ height: size === "sm" ? 5 : 8 }}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(pct)}
      >
        {indeterminate ? (
          <div className="animate-indeterminate absolute inset-y-0 w-1/3 rounded-full bg-ink-faint" />
        ) : (
          <div
            className={`h-full rounded-full transition-[width] duration-200 ease-out ${TONES[tone]}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
