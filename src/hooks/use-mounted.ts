"use client";

import { useSyncExternalStore } from "react";

/**
 * True after the component has mounted on the client.
 *
 * WebRTC, `matchMedia` and `localStorage` do not exist during prerender, so the
 * few places that need them gate on this instead of crashing the server render.
 *
 * `useSyncExternalStore` with a constant snapshot is the way to express this in
 * React 19: the server snapshot is `false`, the client snapshot is `true`, and
 * the store never changes — so there is no effect and no extra render pass.
 */
const noopSubscribe = () => () => {};

export function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}