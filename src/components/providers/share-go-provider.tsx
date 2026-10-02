"use client";

/**
 * Creates the single `ShareGoEngine` for the whole app and keeps its lifetime
 * tied to the React tree.
 *
 * `useState(() => new ShareGoEngine())` (not `useRef`, not a module-level
 * singleton) means: exactly one engine per mounted tab, created lazily, and
 * disposed on unmount so sockets and peer connections never outlive the page.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ShareGoEngine } from "@/lib/engine";

const ShareGoContext = createContext<ShareGoEngine | null>(null);

export function ShareGoProvider({ children }: { children: ReactNode }) {
  const [engine] = useState(() => new ShareGoEngine());

  useEffect(() => {
    engine.start();
    return () => engine.dispose();
  }, [engine]);

  return <ShareGoContext.Provider value={engine}>{children}</ShareGoContext.Provider>;
}

export function useEngine(): ShareGoEngine {
  const engine = useContext(ShareGoContext);
  if (!engine) {
    throw new Error("useEngine must be used inside <ShareGoProvider>.");
  }
  return engine;
}
