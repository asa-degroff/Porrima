/**
 * Turn-engine phase 1 tests (docs/design/turn-engine.md §7).
 *
 * Fixture-driven tests for the unified estimator (path selection,
 * self-gating, anchor+postUsage arithmetic, char fallback, error
 * degradation), table-driven guard tests, the canonical forensics rows for
 * the end-of-turn trigger mapping, and the shadow-mode comparison.
 *
 * The HTTP boundary (countLlamaTextTokens) is mocked; everything else — the
 * breakdown, the self-gating filter, the exact-delta arithmetic — is the
 * real production code path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types.js";
import {
  COMPACTION_HARD_CAP_RATIO,
  COMPACTION_TRIGGER_RATIO,
  endOfTurnNeedsCompaction,
  estimateContextBreakdown,
  estimateContextTokens,
  estimateHardCapTokens,
} from "../services/compaction.js";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { countLlamaTextTokens, estimateTextTokens } from "../services/token-count.js";
import {
  comparePressureShadow,
  evaluateTurnGuards,
  estimateContextPressure,
  type PressureEstimate,
} from "../services/context-pressure.js";

vi.mock("../services/token-count.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/token-count.js")>();
  return {
    ...actual,
    countLlamaTextTokens: vi.fn(),
  };
});

const mockCount = countLlamaTextTokens as unknown as ReturnType<typeof vi.fn>;

const WINDOW = 100_000;
const SYSTEM_PROMPT = "You are a test system prompt.";
const TOOLS: unknown = [
  { name: "read_file", description: "Read a file", parameters: { path: { type: "string" } } },
];

/** Plain prose, guaranteed over minChars, not dense (char estimate ≈ chars/4). */
function proseResult(minChars: number): string {
  const unit = "The estimator consolidates the context pressure path for long turns. ";
  return unit.repeat(Math.ceil(minChars / unit.length) + 1);
}

const EXACT_OPTS = { baseUrl: "http://127.0.0.1:8080", modelId: "qwen3.8-27b", chatId: "chat-test", phase: "tool_loop" };

function userMsg(text: string): ChatMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistantWithUsage(totalTokens: number, toolResults?: ChatMessage["toolResults"]): ChatMessage {
  return {
    role: "assistant",
    content: "",
    thinking: "",
    usage: { input: totalTokens - 50, output: 50, totalTokens },
    timestamp: 2,
    toolCalls: toolResults
      ? toolResults.map((r) => ({ id: r.toolCallId, name: r.toolName ?? "read_file", arguments: { path: "/x" } }))
      : undefined,
    toolResults,
  };
}

function textResult(content: string, id = "call_1"): NonNullable<ChatMessage["toolResults"]>[number] {
  return { toolCallId: id, toolName: "read_file", content, isError: false };
}

function toolResultMessage(
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
): ToolResultMessage {
  return { role: "toolResult", toolCallId: "call_1", toolName: "read_file", content, isError: false, timestamp: 3 };
}

beforeEach(() => {
  mockCount.mockReset();
});

describe("estimateContextPressure — path selection", () => {
  it("char fallback when no anchor exists anywhere (path 4)", async () => {
    const messages: ChatMessage[] = [
      userMsg("Summarize the log."),
      { role: "assistant", content: "Here is the summary.", timestamp: 2 },
    ];

    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
    });

    const breakdown = estimateContextBreakdown(messages, SYSTEM_PROMPT, TOOLS);
    expect(est.selectedPath).toBe("char_estimate");
    expect(est.rawUsageTotal).toBe(0);
    expect(est.errors).toEqual([]);
    expect(est.estimatedTokens).toBe(breakdown.estimatedTokens);
    expect(est.refinedTokens).toBe(breakdown.estimatedTokens);
    expect(est.hardCapTokens).toBe(breakdown.estimatedTokens);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("row-scanned usage anchor without exact capability (path 3)", async () => {
    const messages: ChatMessage[] = [
      userMsg("Summarize the log."),
      assistantWithUsage(40_000),
    ];

    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
    });

    const breakdown = estimateContextBreakdown(messages, SYSTEM_PROMPT, TOOLS);
    expect(est.selectedPath).toBe("usage_anchor");
    expect(est.rawUsageTotal).toBe(40_000);
    expect(est.estimatedTokens).toBe(breakdown.estimatedTokens);
    expect(est.refinedTokens).toBe(breakdown.displayTokens);
    expect(est.hardCapTokens).toBe(estimateHardCapTokens(breakdown.estimatedTokens, breakdown.displayTokens, true));
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("live anchor arithmetic: usage + ceil(postUsageChars/4), text only (path 2)", async () => {
    const big = proseResult(8_000);
    const messages: ChatMessage[] = [
      userMsg("Read the file."),
      { role: "assistant", content: "", timestamp: 2 },
    ];
    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      lastUsageTotal: 60_000,
      postUsageToolResults: [
        toolResultMessage([
          { type: "text", text: big },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ]),
      ],
    });

    const expected = 60_000 + Math.ceil(big.length / 4);
    const breakdown = estimateContextBreakdown(messages, SYSTEM_PROMPT, TOOLS);
    expect(est.selectedPath).toBe("usage_anchor");
    expect(est.rawUsageTotal).toBe(60_000);
    expect(est.refinedTokens).toBe(expected);
    expect(est.estimatedTokens).toBe(Math.max(breakdown.estimatedTokens, expected));
    expect(mockCount).not.toHaveBeenCalled();
  });

  it("live anchor wins over the exact capability — exact is ignored (path 2, not 1)", async () => {
    const big = proseResult(8_000);
    const messages: ChatMessage[] = [
      userMsg("Read the file."),
      { role: "assistant", content: "", timestamp: 2 },
    ];
    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      lastUsageTotal: 60_000,
      postUsageToolResults: [toolResultMessage([{ type: "text", text: big }])],
      exact: EXACT_OPTS,
    });

    expect(mockCount).not.toHaveBeenCalled();
    expect(est.selectedPath).toBe("usage_anchor");
    expect(est.refinedTokens).toBe(60_000 + Math.ceil(big.length / 4));
  });
});

describe("estimateContextPressure — exact path (path 1)", () => {
  function fixtureWithBigResult(): { messages: ChatMessage[]; content: string } {
    const content = proseResult(16_000);
    const messages: ChatMessage[] = [
      userMsg("Read the big file."),
      assistantWithUsage(50_050, [textResult(content)]),
    ];
    return { messages, content };
  }

  it("tokenizes a >=16k-char result even when far from the limit", async () => {
    const { messages, content } = fixtureWithBigResult();
    const breakdown = estimateContextBreakdown(messages, SYSTEM_PROMPT, TOOLS);
    expect(breakdown.estimatedTokens / WINDOW).toBeLessThan(0.7); // self-gate must NOT be the near-limit rule

    const approxContent = estimateTextTokens(content, "tool_result");
    const exactTokens = approxContent + 250;
    mockCount.mockResolvedValue({ tokens: exactTokens, elapsedMs: 3, cached: false });

    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      exact: EXACT_OPTS,
    });

    expect(mockCount).toHaveBeenCalledTimes(1);
    expect(mockCount.mock.calls[0][0]).toBe(EXACT_OPTS.baseUrl);
    expect(mockCount.mock.calls[0][1]).toBe(EXACT_OPTS.modelId);
    expect(mockCount.mock.calls[0][2]).toBe(content);
    expect(est.selectedPath).toBe("exact");
    expect(est.exactToolResultCount).toBe(1);
    expect(est.exactDelta).toBe(exactTokens - approxContent);
    expect(est.signedExactDelta).toBe(exactTokens - approxContent);
    expect(est.estimatedTokens).toBe(breakdown.estimatedTokens + (exactTokens - approxContent));
    expect(est.refinedTokens).toBe(Math.max(0, breakdown.displayTokens + (exactTokens - approxContent)));
  });

  it("self-gating: no exact HTTP for a small result far from the limit", async () => {
    const messages: ChatMessage[] = [
      userMsg("Read the small file."),
      assistantWithUsage(50_050, [textResult("a small result")]),
    ];

    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      exact: EXACT_OPTS,
    });

    expect(mockCount).not.toHaveBeenCalled();
    expect(est.exactToolResultCount).toBe(0);
    expect(est.selectedPath).toBe("usage_anchor");
    expect(est.estimatedTokens).toBe(estimateContextBreakdown(messages, SYSTEM_PROMPT, TOOLS).estimatedTokens);
  });

  it("self-gating: at most 12 candidates are tokenized", async () => {
    const results = Array.from({ length: 15 }, (_, i) => textResult(proseResult(16_000), `call_${i}`));
    const messages: ChatMessage[] = [
      userMsg("Read many files."),
      assistantWithUsage(50_050, results),
    ];
    mockCount.mockResolvedValue({ tokens: 4_000, elapsedMs: 1, cached: false });

    await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      exact: EXACT_OPTS,
    });

    expect(mockCount).toHaveBeenCalledTimes(12);
  });

  it("error degradation: a failed count is recorded and the estimate falls back to approximate", async () => {
    const { messages } = fixtureWithBigResult();
    mockCount.mockRejectedValue(new Error("boom"));

    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      exact: EXACT_OPTS,
    });

    expect(est.errors).toHaveLength(1);
    expect(est.errors[0]).toContain("boom");
    expect(est.exactToolResultCount).toBe(0);
    expect(est.exactDelta).toBe(0);
    expect(est.estimatedTokens).toBe(estimateContextBreakdown(messages, SYSTEM_PROMPT, TOOLS).estimatedTokens);
    expect(est.selectedPath).toBe("usage_anchor"); // not "exact" — no exact count landed
  });

  it("mixed: one success and one failure still reports the exact path", async () => {
    const a = proseResult(16_000);
    const b = proseResult(17_000);
    const messages: ChatMessage[] = [
      userMsg("Read two files."),
      assistantWithUsage(50_050, [textResult(a, "call_a"), textResult(b, "call_b")]),
    ];
    // The exact path sorts candidates by approximate tokens descending, so
    // `b` (the larger) is counted first and `a` second.
    mockCount
      .mockResolvedValueOnce({ tokens: estimateTextTokens(b, "tool_result") + 100, elapsedMs: 1, cached: false })
      .mockRejectedValueOnce(new Error("boom-a"));

    const est = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
      exact: EXACT_OPTS,
    });

    expect(est.exactToolResultCount).toBe(1);
    expect(est.errors).toHaveLength(1);
    expect(est.selectedPath).toBe("exact");
    expect(est.exactDelta).toBe(100);
  });
});

describe("end-of-turn trigger mapping — canonical forensics rows", () => {
  // The module contract: end-of-turn drives 0.80 on
  // max(rawUsageTotal, estimatedTokens). These are the 14-day forensics
  // cases (doc §7) pinned against the real predicate.
  const rows = [
    {
      name: "dead-band case: raw 84.8% / refined 85.3% — estimate drives, fires at 0.80",
      lastUsage: 84_800,
      estimatedTokens: 85_300,
      hitContextLimit: false,
      fires: true,
      driving: 85_300,
    },
    {
      name: "both signals under 0.80 — quiet",
      lastUsage: 78_000,
      estimatedTokens: 79_500,
      hitContextLimit: false,
      fires: false,
      driving: 79_500,
    },
    {
      name: "raw >100% (system-chat forensics case)",
      lastUsage: 102_000,
      estimatedTokens: 90_000,
      hitContextLimit: false,
      fires: true,
      driving: 102_000,
    },
    {
      name: "estimate >100% with a stale anchor (post-compaction)",
      lastUsage: 10_000,
      estimatedTokens: 103_000,
      hitContextLimit: false,
      fires: true,
      driving: 103_000,
    },
    {
      name: "hitContextLimit short-circuits the ratio",
      lastUsage: 0,
      estimatedTokens: 0,
      hitContextLimit: true,
      fires: true,
      driving: 0,
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const out = endOfTurnNeedsCompaction({
        lastUsage: row.lastUsage,
        estimatedTokens: row.estimatedTokens,
        contextWindow: WINDOW,
        hitContextLimit: row.hitContextLimit,
      });
      expect(out.needsCompaction).toBe(row.fires);
      expect(out.drivingTokens).toBe(row.driving);
    });
  }
});

describe("evaluateTurnGuards", () => {
  const base = {
    iterations: 1,
    maxIterations: 12,
  };

  it("total cap boundary: max-1 passes, max stops", () => {
    expect(evaluateTurnGuards({ ...base, iterations: base.maxIterations - 1 }).stop).toBeUndefined();
    const out = evaluateTurnGuards({ ...base, iterations: base.maxIterations });
    expect(out.stop?.reason).toBe("iteration_limit");
    expect(out.stop?.scope).toBe("total");
    expect(out.stop?.warning).toBe(`Stopped — reached ${base.maxIterations} iteration limit`);
  });

  it("per-segment cap stops below the total cap", () => {
    const out = evaluateTurnGuards({
      ...base,
      iterations: 5,
      perSegmentIterations: 3,
      maxIterationsPerSegment: 3,
    });
    expect(out.stop?.reason).toBe("iteration_limit");
    expect(out.stop?.scope).toBe("segment");
    expect(out.stop?.warning).toBe(`Stopped — reached 3 iteration limit for this phase`);
  });

  it("precedence: the total cap beats the segment cap", () => {
    const out = evaluateTurnGuards({
      ...base,
      iterations: base.maxIterations,
      perSegmentIterations: 3,
      maxIterationsPerSegment: 3,
    });
    expect(out.stop?.reason).toBe("iteration_limit");
    expect(out.stop?.scope).toBe("total"); // not "segment" — total is checked first
    expect(out.stop?.warning).toBe(`Stopped — reached ${base.maxIterations} iteration limit`); // not "for this phase"
  });
});

describe("comparePressureShadow", () => {
  const emptyBreakdown = () => estimateContextBreakdown([], SYSTEM_PROMPT, TOOLS);

  function pressure(partial: {
    selectedPath: PressureEstimate["selectedPath"];
    refinedTokens: number;
    hardCapTokens?: number;
  }): PressureEstimate {
    return {
      estimatedTokens: partial.refinedTokens,
      refinedTokens: partial.refinedTokens,
      hardCapTokens: partial.hardCapTokens ?? partial.refinedTokens,
      rawUsageTotal: 0,
      selectedPath: partial.selectedPath,
      errors: [],
      contextBreakdown: emptyBreakdown(),
      exactToolResultCount: 0,
      exactDelta: 0,
      signedExactDelta: 0,
      exactElapsedMs: 0,
      approximateTokens: partial.refinedTokens,
      approximateDisplayTokens: partial.refinedTokens,
      approximateHardCapTokens: partial.refinedTokens ?? partial.refinedTokens,
    };
  }

  it("classifies fire outcomes against each path's own trigger", () => {
    // Both cross 0.85 (anchor path uses refinedTokens).
    expect(
      comparePressureShadow({ legacyEstimate: 90_000, legacyTriggerRatio: COMPACTION_TRIGGER_RATIO, pressure: pressure({ selectedPath: "usage_anchor", refinedTokens: 92_000 }), contextWindow: WINDOW }),
    ).toMatchObject({ legacyFires: true, unifiedFires: true, fire: "both", delta: 2_000 });

    // Only legacy crosses.
    expect(
      comparePressureShadow({ legacyEstimate: 90_000, legacyTriggerRatio: COMPACTION_TRIGGER_RATIO, pressure: pressure({ selectedPath: "usage_anchor", refinedTokens: 80_000 }), contextWindow: WINDOW }),
    ).toMatchObject({ fire: "legacy" });

    // Only unified crosses.
    expect(
      comparePressureShadow({ legacyEstimate: 80_000, legacyTriggerRatio: COMPACTION_TRIGGER_RATIO, pressure: pressure({ selectedPath: "usage_anchor", refinedTokens: 90_000 }), contextWindow: WINDOW }),
    ).toMatchObject({ fire: "unified" });

    // Neither crosses.
    expect(
      comparePressureShadow({ legacyEstimate: 50_000, legacyTriggerRatio: COMPACTION_TRIGGER_RATIO, pressure: pressure({ selectedPath: "usage_anchor", refinedTokens: 51_000 }), contextWindow: WINDOW }),
    ).toMatchObject({ fire: "none" });
  });

  it("char estimates drive the hard-cap ratio, never the normal trigger", () => {
    const p = pressure({ selectedPath: "char_estimate", refinedTokens: 10_000, hardCapTokens: 96_000 });
    const out = comparePressureShadow({
      legacyEstimate: 50_000,
      legacyTriggerRatio: COMPACTION_HARD_CAP_RATIO,
      pressure: p,
      contextWindow: WINDOW,
    });
    expect(out.unifiedFires).toBe(true); // 96k/100k > 0.95 via hardCapTokens
    expect(out.unifiedEstimate).toBe(96_000);
  });

  it("anchor and exact paths drive the normal trigger via refinedTokens", () => {
    const out = comparePressureShadow({
      legacyEstimate: 50_000,
      legacyTriggerRatio: COMPACTION_TRIGGER_RATIO,
      pressure: pressure({ selectedPath: "exact", refinedTokens: 86_000, hardCapTokens: 999_999 }),
      contextWindow: WINDOW,
    });
    expect(out.unifiedEstimate).toBe(86_000);
    expect(out.unifiedFires).toBe(true); // 86k/100k > 0.85, despite the absurd hardCap
  });

  it("a zero context window never fires", () => {
    const out = comparePressureShadow({
      legacyEstimate: 999_999,
      legacyTriggerRatio: COMPACTION_TRIGGER_RATIO,
      pressure: pressure({ selectedPath: "usage_anchor", refinedTokens: 999_999 }),
      contextWindow: 0,
    });
    expect(out.legacyFires).toBe(false);
    expect(out.unifiedFires).toBe(false);
    expect(out.fire).toBe("none");
  });

  it("the log line is self-evaluating (the ship criterion reads logs only)", () => {
    const out = comparePressureShadow({
      legacyEstimate: 90_000,
      legacyTriggerRatio: COMPACTION_TRIGGER_RATIO,
      pressure: pressure({ selectedPath: "usage_anchor", refinedTokens: 92_000 }),
      contextWindow: WINDOW,
    });
    expect(out.logLine).toMatch(
      /^\[context-pressure\] shadow legacy=\d+ unified=\d+ delta=-?\d+ path=(exact|usage_anchor|char_estimate) fire=(both|legacy|unified|none)$/,
    );
    expect(out.logLine).toContain("fire=both");
  });
});

describe("path-3 shadow outcomes — the D1 decision (row anchor, no live usage)", () => {
  // Iterations where the completed message carries no usage (usageTotal = 0)
  // but the rows hold an anchor are the ONLY branch where the D1 flip can
  // change trigger outcomes: path 2's refinedTokens IS the legacy arithmetic
  // (delta 0 by construction), and path 4 agrees with legacy on number AND
  // ratio (chars at 0.95). Path 3 agrees on the number too — when the anchor
  // path dominates, breakdown.estimatedTokens === displayTokens — so the
  // entire delta is the trigger ratio: unified fires the (0.85, 0.95] band
  // that legacy's 0.95 hard-cap gate sleeps through. The shadow week's
  // anchored samples (the ≥15 sample floor) will log delta=0 by construction;
  // THESE rows are the decision the flip actually makes.

  async function shadowFor(messages: ChatMessage[]) {
    const legacyEstimate = estimateContextTokens(messages, SYSTEM_PROMPT, TOOLS);
    const pressure = await estimateContextPressure({
      messages,
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      contextWindow: WINDOW,
    });
    const comparison = comparePressureShadow({
      legacyEstimate,
      legacyTriggerRatio: COMPACTION_HARD_CAP_RATIO, // the legacy no-anchor branch's own gate
      pressure,
      contextWindow: WINDOW,
    });
    return { pressure, comparison };
  }

  const rows = [
    { name: "below the band (60%) — both quiet", tokens: 60_000, fire: "none" },
    { name: "in the band (86%) — unified fires at 0.85, legacy sleeps until 0.95", tokens: 86_000, fire: "unified" },
    { name: "exactly 0.95 — unified already fired; legacy's strict > stays quiet", tokens: 95_000, fire: "unified" },
    { name: "above the band (97%) — both fire", tokens: 97_000, fire: "both" },
  ] as const;

  for (const row of rows) {
    it(row.name, async () => {
      const messages: ChatMessage[] = [userMsg("Summarize the log."), assistantWithUsage(row.tokens)];
      const { pressure, comparison } = await shadowFor(messages);

      expect(pressure.selectedPath).toBe("usage_anchor");
      expect(pressure.rawUsageTotal).toBe(row.tokens);
      // The D1 delta is the ratio, not the estimate: both sides read the
      // identical number, so a divergent fire outcome is the 0.85-vs-0.95
      // decision and nothing else.
      expect(comparison.unifiedEstimate).toBe(comparison.legacyEstimate);
      expect(comparison.fire).toBe(row.fire);
    });
  }

  it("the number identity holds with post-anchor rows (realistic mid-phase shape)", async () => {
    // Anchor mid-phase, content appended after it: pathA = anchor +
    // post-anchor delta. pathB still trails (fixture chars are small), so the
    // anchor path dominates and both sides must again agree on the number.
    const messages: ChatMessage[] = [
      userMsg("Summarize the log."),
      assistantWithUsage(88_000),
      userMsg("Follow-up question. ".repeat(200)), // ~4_000 chars ≈ 1K tokens after the anchor
    ];
    const { pressure, comparison } = await shadowFor(messages);

    expect(pressure.selectedPath).toBe("usage_anchor");
    expect(comparison.unifiedEstimate).toBe(comparison.legacyEstimate);
    expect(comparison.unifiedEstimate).toBeGreaterThan(88_000); // anchor + post-anchor delta
    expect(comparison.fire).toBe("unified"); // ~89% sits in the (0.85, 0.95] band
  });
});
