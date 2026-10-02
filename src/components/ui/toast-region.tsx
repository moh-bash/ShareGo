"use client";

import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from "./icons";
import type { ToastMessage } from "@/types/files";

const TONES = {
  info: { icon: InfoIcon, accent: "text-accent" },
  success: { icon: CheckIcon, accent: "text-positive" },
  error: { icon: AlertIcon, accent: "text-negative" },
} as const;

/** Fixed notification stack. `aria-live` announces new toasts politely. */
export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-60 flex flex-col items-center gap-2 px-4 pb-24 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:items-end sm:pb-0"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((toast) => {
        const tone = TONES[toast.tone];
        const Icon = tone.icon;
        return (
          <div
            key={toast.id}
            className="panel animate-rise pointer-events-auto flex w-full max-w-sm items-start gap-3 px-4 py-3 shadow-xl shadow-black/40"
          >
            <Icon className={`mt-0.5 size-5 shrink-0 ${tone.accent}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{toast.title}</p>
              {toast.description ? (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  {toast.description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss notification"
              className="focus-ring -mr-1 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-ink-faint transition-colors hover:text-ink"
            >
              <CloseIcon className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
