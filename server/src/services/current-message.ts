import type { ChatMessage } from "../types.js";

/**
 * Identity-based current-message resolution for the send route.
 *
 * A save that rebases against a concurrent append inserts the preserved row
 * after the writer's own row, so `messages.length - 1` is no longer "the
 * message this request is answering". The row the request pushed (or reused)
 * is tracked as an object and resolved by its durable `_rowId`; the
 * positional tail is the fallback only when no row is tracked.
 *
 * Kept as a pure function so the interleaved-rebase shape is unit-testable
 * without the HTTP route (plan test 11).
 */

/**
 * Index of the row this request is answering. Resolves by `_rowId` when the
 * tracked row is still in the array; falls back to the tail.
 */
export function resolveCurrentMessageIndex(
  messages: ChatMessage[],
  currentRow?: ChatMessage,
): number {
  if (currentRow?._rowId) {
    const idx = messages.findIndex((m) => m._rowId === currentRow!._rowId);
    if (idx >= 0) return idx;
  }
  return messages.length - 1;
}

/**
 * The row whose frozen `[time:]` anchor this turn's wire prompt must reuse —
 * the row this request pushed, or the tail when nothing is tracked. Resolving
 * by identity (not position) keeps the wire prompt and the persisted history
 * byte-identical when a rebase moved the row.
 */
export function resolveTrailingRow(
  messages: ChatMessage[],
  currentRow?: ChatMessage,
): ChatMessage | undefined {
  if (currentRow && messages.includes(currentRow)) return currentRow;
  return messages[messages.length - 1];
}

export type EditTargetSource = "rowId" | "sequence" | "index";

export interface EditTargetResolution {
  /** -1 when no candidate resolves within the loaded messages. */
  index: number;
  via: EditTargetSource;
}

/**
 * Resolve an /edit target against the currently loaded messages. Prefers the
 * durable `_rowId` (stable across rebases and truncations) over the legacy
 * dense `_rowSequence` (moves whenever rows are inserted or edited away) and
 * the absolute UI index (last resort). Returns index -1 when nothing
 * resolves — callers must fail closed rather than guess, because an edit is a
 * destructive truncation.
 */
export function resolveEditTargetIndex(
  messages: ChatMessage[],
  target: { rowId?: string; sequence?: number; index?: number },
): EditTargetResolution {
  const hasRowId = typeof target.rowId === "string" && target.rowId.length > 0;
  const hasSequence = Number.isInteger(target.sequence);

  if (hasRowId) {
    const idx = messages.findIndex((m) => m._rowId === target.rowId);
    if (idx >= 0) return { index: idx, via: "rowId" };
  }
  if (hasSequence) {
    const idx = messages.findIndex((m, i) => (m._rowSequence ?? i) === target.sequence);
    if (idx >= 0) return { index: idx, via: "sequence" };
  }
  if (typeof target.index === "number" && target.index >= 0 && target.index < messages.length) {
    return { index: target.index, via: "index" };
  }
  return { index: -1, via: hasRowId ? "rowId" : hasSequence ? "sequence" : "index" };
}
