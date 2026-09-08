import { describe, expect, it } from "vitest";
import { scanRecoveryRowRepresentation } from "../services/chat-storage.js";

/**
 * Mid-turn crash recovery must not reconstruct turn content that per-iteration
 * persistence already committed. The incident that motivated this: a turn
 * ended with a passive-recall injection row (role "system") after the last
 * assistant row, the lastMsg-only check missed the committed rows, and
 * recovery re-added the ENTIRE turn (39 tool calls, 130k chars of thinking)
 * from the cumulative pending-state accumulators — inflating the context
 * estimate by ~60k tokens until pre-send compaction fired with the LLM's
 * real context far below the trigger.
 */

function toolCall(id: string) {
  return { id, name: "bash", arguments: {} };
}

function assistantRow(opts: {
  toolCalls?: Array<{ id: string }>;
  inProgress?: boolean;
}): { role: "assistant"; _inProgress?: boolean; toolCalls?: ReturnType<typeof toolCall>[] } {
  return {
    role: "assistant",
    ...(opts.inProgress ? { _inProgress: true } : {}),
    ...(opts.toolCalls?.length ? { toolCalls: opts.toolCalls.map((tc) => toolCall(tc.id)) } : {}),
  };
}

function injectionRow() {
  return { role: "system" as const, toolCalls: undefined };
}

describe("scanRecoveryRowRepresentation", () => {
  it("reports nothing missing when the whole turn is already persisted across segment rows", () => {
    // The incident shape: per-iteration rows hold all 3 tool calls, and a
    // passive-recall injection row sits last (role "system").
    const rows = [
      { role: "user" as const },
      assistantRow({ toolCalls: [{ id: "tc-1" }] }),
      injectionRow(),
      assistantRow({ toolCalls: [{ id: "tc-2" }] }),
      assistantRow({ toolCalls: [{ id: "tc-3" }] }),
      injectionRow(),
    ];
    const pending = [{ id: "tc-1" }, { id: "tc-2" }, { id: "tc-3" }];
    const result = scanRecoveryRowRepresentation(rows, pending);
    expect(result.missingToolCalls).toEqual([]);
  });

  it("reports the genuinely unpersisted tail when rows lag the accumulators", () => {
    const rows = [assistantRow({ toolCalls: [{ id: "tc-1" }] })];
    const pending = [{ id: "tc-1" }, { id: "tc-2" }, { id: "tc-3" }];
    const result = scanRecoveryRowRepresentation(rows, pending);
    expect(result.missingToolCalls.map((tc) => tc.id)).toEqual(["tc-2", "tc-3"]);
  });

  it("finds a stale _inProgress row even when an injection row follows it", () => {
    const rows = [
      assistantRow({ toolCalls: [{ id: "tc-1" }], inProgress: true }),
      injectionRow(),
    ];
    const result = scanRecoveryRowRepresentation(rows, [{ id: "tc-1" }]);
    expect(result.missingToolCalls).toEqual([]);
    expect(result.staleInProgressRowIdx).toBe(0);
  });

  it("respects the scan window — tool calls in old rows still count via dedupe gap only within window", () => {
    // 90 rows; the first 10 (oldest) carry tc-old — outside the 80-row window.
    const rows: Array<{ role: "assistant" | "user"; toolCalls?: ReturnType<typeof toolCall>[] }> = [];
    for (let i = 0; i < 10; i++) rows.push(assistantRow({ toolCalls: [{ id: `tc-old-${i}` }] }));
    for (let i = 0; i < 80; i++) rows.push({ role: "user" as const });
    const result = scanRecoveryRowRepresentation(rows, [{ id: "tc-old-0" }], 80);
    // Outside the window: reported missing (defensive — pending state only
    // ever holds the current turn, so this cannot happen in practice).
    expect(result.missingToolCalls.map((tc) => tc.id)).toEqual(["tc-old-0"]);
  });

  it("handles empty rows and empty pending lists", () => {
    expect(scanRecoveryRowRepresentation([], [{ id: "tc-1" }]).missingToolCalls).toEqual([{ id: "tc-1" }]);
    expect(scanRecoveryRowRepresentation([assistantRow({ toolCalls: [{ id: "tc-1" }] })], []).missingToolCalls).toEqual([]);
    expect(scanRecoveryRowRepresentation([], []).staleInProgressRowIdx).toBe(-1);
  });
});
