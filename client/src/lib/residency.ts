import type { CacheResidency } from "../api/client";

// ---------------------------------------------------------------------------
// Shared llama.cpp prompt-cache residency visuals.
//
// Every sidebar surface that can hold cache-slot residency (global chat rows,
// project chat rows, the system chat row, and the new-chat baseline button)
// must use these helpers so the ring highlight stays consistent.
// ---------------------------------------------------------------------------

/** Amber ring + glow — chat holds a resident prompt cache slot. */
export const RESIDENCY_RING_AMBER = "ring-1 ring-amber-400/35 shadow-[0_0_8px_rgba(251,191,36,0.12)]";

/** Purple variant — used when the row is also the last-active chat, matching its accent styling. */
export const RESIDENCY_RING_PURPLE = "ring-1 ring-purple-400/40 shadow-[0_0_8px_rgba(168,85,247,0.15)]";

/**
 * Ring/glow classes for a sidebar element with observed cache-slot residency.
 * Returns "" when there is no residency to show.
 */
export function residencyHighlightClass(residency?: CacheResidency | null, lastActive = false): string {
  if (!residency) return "";
  return lastActive ? RESIDENCY_RING_PURPLE : RESIDENCY_RING_AMBER;
}

/**
 * Human-readable tooltip for a residency record, e.g.
 * "Cache warm - last hit 98.2% - slot 1".
 */
export function formatCacheResidencyTitle(residency?: CacheResidency | null): string | undefined {
  if (!residency) return undefined;
  const parts = [residency.active ? "Cache active" : "Cache warm"];
  if (typeof residency.inferredCacheHitRatio === "number") {
    parts.push(`last hit ${(residency.inferredCacheHitRatio * 100).toFixed(1)}%`);
  }
  if (typeof residency.slotId === "number") {
    parts.push(`slot ${residency.slotId}`);
  } else {
    parts.push(`${residency.bindingMode} slot selection`);
  }
  return parts.join(" - ");
}
