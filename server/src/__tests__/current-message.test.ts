import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { resolveCurrentMessageIndex, resolveEditTargetIndex, resolveTrailingRow } from "../services/current-message.js";

/**
 * Plan test 11 — route-level current-message tracking by id.
 *
 * The send route resolves "the message this request is answering" by the
 * pushed row's durable `_rowId`, never by `messages.length - 1`: after a save
 * rebases around a concurrent append, the preserved row sits at the tail and
 * the positional fallback would treat it as the current message (wrong context
 * split, wrong replay-merge target, wrong frozen time anchor).
 */

function row(content: string, rowId?: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return { role, content, timestamp: 1, _rowId: rowId } as ChatMessage;
}

const ORIGIN_USER = row("u1", "a");
const ORIGIN_ASSISTANT = row("a1", "b", "assistant");
const CURRENT_USER = row("u2", "c");
const PRESERVED_POST = row("[Agent from other chat] post", "p");
const REPAIR_PROMPT = row("repair prompt", "r", "system");
const MEMORY_DELTA_CONTENT = "[System context — updated memories]";

function appendDeltaBefore(messages: ChatMessage[], anchor: ChatMessage): void {
  const insertAt = Math.max(0, resolveCurrentMessageIndex(messages, anchor));
  messages.splice(insertAt, 0, row(MEMORY_DELTA_CONTENT, undefined, "system"));
}

describe("current-message resolution (id-anchored, route-level)", () => {
  it("resolves the current row by id when a preserved append landed after it (interleaved rebase shape)", () => {
    // After the writer's save rebased: its user row is no longer last.
    const messages = [ORIGIN_USER, ORIGIN_ASSISTANT, CURRENT_USER, PRESERVED_POST];
    expect(resolveCurrentMessageIndex(messages, CURRENT_USER)).toBe(2);
    expect(resolveTrailingRow(messages, CURRENT_USER)).toBe(CURRENT_USER);
  });

  it("keeps the memory-delta splice immediately before the user row under the interleave (replay-merge invariant)", () => {
    const messages = [ORIGIN_USER, ORIGIN_ASSISTANT, CURRENT_USER, PRESERVED_POST];
    const insertAt = Math.max(0, resolveCurrentMessageIndex(messages, CURRENT_USER));
    const delta = row("[System context — updated memories]", undefined, "system");
    messages.splice(insertAt, 0, delta);

    expect(messages.map((m) => m.content)).toEqual([
      "u1",
      "a1",
      "[System context — updated memories]",
      "u2",
      "[Agent from other chat] post",
    ]);
    const userIdx = messages.findIndex((m) => m._rowId === "c");
    expect(messages[userIdx - 1]?.role).toBe("system");
    expect(messages[userIdx - 1]?.content).toBe("[System context — updated memories]");
  });

  it("resolves by id when the rebase interleaved before the user row (both interleave timings)", () => {
    // A preserved row can also land mid-array, between origins and the user row.
    const messages = [ORIGIN_USER, PRESERVED_POST, CURRENT_USER];
    expect(resolveCurrentMessageIndex(messages, CURRENT_USER)).toBe(2);
    const insertAt = Math.max(0, resolveCurrentMessageIndex(messages, CURRENT_USER));
    const delta = row("[System context — updated memories]", undefined, "system");
    messages.splice(insertAt, 0, delta);
    const userIdx = messages.findIndex((m) => m._rowId === "c");
    expect(messages[userIdx - 1]?.content).toBe("[System context — updated memories]");
    expect(messages[userIdx + 1]).toBeUndefined(); // user row still last after the delta
  });

  it("falls back to the tail when no current row is tracked (dedup branch)", () => {
    const messages = [ORIGIN_USER, ORIGIN_ASSISTANT];
    expect(resolveCurrentMessageIndex(messages, undefined)).toBe(1);
    expect(resolveTrailingRow(messages, undefined)).toBe(ORIGIN_ASSISTANT);
  });

  it("falls back to the tail when the tracked row is no longer in the array", () => {
    const messages = [ORIGIN_USER, PRESERVED_POST];
    expect(resolveCurrentMessageIndex(messages, CURRENT_USER)).toBe(1);
    expect(resolveTrailingRow(messages, CURRENT_USER)).toBe(PRESERVED_POST);
  });

  it("resolves a pushed system row (repair route) and keeps the delta before it", () => {
    const messages = [ORIGIN_USER, ORIGIN_ASSISTANT, REPAIR_PROMPT];
    appendDeltaBefore(messages, REPAIR_PROMPT);

    expect(messages.map((m) => m.content)).toEqual([
      "u1",
      "a1",
      MEMORY_DELTA_CONTENT,
      "repair prompt",
    ]);
    const repairIdx = messages.indexOf(REPAIR_PROMPT);
    expect(messages[repairIdx - 1]?.content).toBe(MEMORY_DELTA_CONTENT);
  });

  it("resolves the repair row when a preserved append landed after it", () => {
    // The repair row's save rebased around a concurrent append, leaving the
    // append at the tail; the delta must still land before the repair row.
    const messages = [ORIGIN_USER, ORIGIN_ASSISTANT, REPAIR_PROMPT, PRESERVED_POST];
    appendDeltaBefore(messages, REPAIR_PROMPT);

    expect(messages.map((m) => m.content)).toEqual([
      "u1",
      "a1",
      MEMORY_DELTA_CONTENT,
      "repair prompt",
      "[Agent from other chat] post",
    ]);
  });
});

describe("edit target resolution (rowId > sequence > index)", () => {
  const rows: ChatMessage[] = [
    { role: "user", content: "u1", timestamp: 1, _rowId: "r-u1", _rowSequence: 0 },
    { role: "assistant", content: "a1", timestamp: 2, _rowId: "r-a1", _rowSequence: 1 },
    { role: "user", content: "u2", timestamp: 3, _rowId: "r-u2", _rowSequence: 2 },
  ];

  it("prefers the durable row id even when sequence and index are stale", () => {
    expect(resolveEditTargetIndex(rows, { rowId: "r-u2", sequence: 999, index: 0 })).toEqual({
      index: 2,
      via: "rowId",
    });
  });

  it("falls back to the sequence when the row id no longer exists (row replaced by an edit)", () => {
    expect(resolveEditTargetIndex(rows, { rowId: "r-gone", sequence: 1, index: 0 })).toEqual({
      index: 1,
      via: "sequence",
    });
  });

  it("falls back to the index when neither identity resolves", () => {
    expect(resolveEditTargetIndex(rows, { rowId: "r-gone", sequence: 99, index: 1 })).toEqual({
      index: 1,
      via: "index",
    });
  });

  it("returns -1 for an out-of-bounds index so callers fail closed", () => {
    expect(resolveEditTargetIndex(rows, { index: 3 })).toEqual({ index: -1, via: "index" });
    expect(resolveEditTargetIndex(rows, {})).toEqual({ index: -1, via: "index" });
  });

  it("matches a renumbered sequence at its shifted position (rebases renumber)", () => {
    const renumbered = rows.map((m) => ({ ...m, _rowSequence: (m._rowSequence ?? 0) + 1 }));
    expect(resolveEditTargetIndex(renumbered, { sequence: 2, index: 0 })).toEqual({
      index: 1,
      via: "sequence",
    });
  });

  it("uses the array position for rows with no pinned sequence", () => {
    const unpinned: ChatMessage[] = [
      { role: "user", content: "u1", timestamp: 1, _rowId: "r1" },
      { role: "user", content: "u2", timestamp: 2, _rowId: "r2" },
    ];
    expect(resolveEditTargetIndex(unpinned, { sequence: 1 })).toEqual({ index: 1, via: "sequence" });
  });
});
