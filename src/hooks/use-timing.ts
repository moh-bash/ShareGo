"use client";

import { useSyncExternalStore } from "react";

/**
 * A shared one-second clock.
 *
 * Countdowns ("expires in 8 seconds") and relative timestamps ("2m ago") both
 * need the current time *during render*, but `Date.now()` in render is an impure
 * read: it produces a different answer on every render and breaks hydration.
 *
 * So the clock lives outside React. A single interval drives it and notifies
 * subscribers, which means N components showing time share one timer, and
 * `getSnapshot` returns a cached value as the API requires.
 */

const TICK_MS = 1000;

let currentTime = 0;
let timer: number | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (timer === null) {
    currentTime = Date.now();
    timer = window.setInterval(() => {
      currentTime = Date.now();
      for (const listener of listeners) listener();
    }, TICK_MS);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

/** Never subscribe on the server; `0` keeps hydration output deterministic. */
function getServerSnapshot(): number {
  return 0;
}

/** Current time, re-rendering the caller once per second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => currentTime, getServerSnapshot);
}

/**
 * Live "seconds remaining" for the connection request timeout.
 * Returns `null` when there is no deadline.
 */
export function useCountdown(expiresAt: number | null): number | null {
  const now = useNow();
  if (expiresAt === null) return null;
  return Math.max(0, expiresAt - now);
}

/** "12s ago" style relative time for the activity log. */
export function useRelativeTime(at: number | null): string {
  const now = useNow();
  return at === null ? "" : formatRelative(at, now);
}

function formatRelative(at: number, now: number): string {
  // `now === 0` means "before the first tick", i.e. during prerender/hydration.
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}