import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Artifact, InlineVisual } from "../types";

export type PinnedItem =
  | { kind: "artifact"; id: string; artifact: Artifact }
  | { kind: "visual"; id: string; visual: InlineVisual };

interface PinnedItemContextValue {
  pinnedItem: PinnedItem | null;
  pinArtifact: (artifact: Artifact) => void;
  pinVisual: (visual: InlineVisual) => void;
  unpin: () => void;
  isPinned: (kind: "artifact" | "visual", id: string) => boolean;
}

const PinnedItemContext = createContext<PinnedItemContextValue | null>(null);

export function PinnedItemProvider({ children }: { children: ReactNode }) {
  const [pinnedItem, setPinnedItem] = useState<PinnedItem | null>(null);

  const pinArtifact = useCallback((artifact: Artifact) => {
    setPinnedItem({ kind: "artifact", id: artifact.id, artifact });
  }, []);

  const pinVisual = useCallback((visual: InlineVisual) => {
    setPinnedItem({ kind: "visual", id: visual.id, visual });
  }, []);

  const unpin = useCallback(() => setPinnedItem(null), []);

  const isPinned = useCallback(
    (kind: "artifact" | "visual", id: string) =>
      pinnedItem?.kind === kind && pinnedItem.id === id,
    [pinnedItem]
  );

  const value = useMemo(
    () => ({ pinnedItem, pinArtifact, pinVisual, unpin, isPinned }),
    [pinnedItem, pinArtifact, pinVisual, unpin, isPinned]
  );

  return <PinnedItemContext.Provider value={value}>{children}</PinnedItemContext.Provider>;
}

export function usePinnedItem() {
  const ctx = useContext(PinnedItemContext);
  if (!ctx) throw new Error("usePinnedItem must be used inside PinnedItemProvider");
  return ctx;
}
