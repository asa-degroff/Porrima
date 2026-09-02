import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computePrefillProgress,
  estimatePromptTokensForProgress,
  promptWorkTokens,
  readProcessedTokens,
  readProcessedTokensWithSource,
  readPromptCacheTokens,
  readPromptTokens,
  extractSlotProgress,
  resolveOccupiedSlotCacheState,
} from "../services/openai-compat-provider.js";

describe("estimatePromptTokensForProgress", () => {
  it("does not count image base64 bytes as text prompt tokens", () => {
    const largeImageData = "a".repeat(1_460_000);
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Brief follow-up with an image." },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${largeImageData}` },
          },
        ],
      },
    ];

    const estimate = estimatePromptTokensForProgress(messages, undefined);

    expect(estimate).toBeDefined();
    expect(estimate).toBeLessThan(1_000);
  });

  it("keeps normal text and tool schema in the estimate", () => {
    const estimate = estimatePromptTokensForProgress(
      [{ role: "user", content: "x".repeat(330) }],
      [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    );

    expect(estimate).toBeGreaterThan(100);
  });
});

describe("readProcessedTokens", () => {
  it("prefers prompt-processed tokens over restored slot context tokens", () => {
    const processed = readProcessedTokens({
      n_tokens: 8192,
      n_past: 8192,
      n_prompt_tokens: 8192,
      n_prompt_tokens_processed: 302,
    });

    expect(processed).toBe(302);
  });

  it("falls back to legacy slot token fields when processed fields are absent", () => {
    const processed = readProcessedTokens({
      n_tokens: 4096,
      n_prompt_tokens: 8192,
    });

    expect(processed).toBe(4096);
  });
});

describe("readProcessedTokensWithSource", () => {
  it("flags per-request processed fields as non-cumulative", () => {
    const reading = readProcessedTokensWithSource({
      n_prompt_tokens_processed: 302,
      n_tokens: 8192,
      n_past: 8192,
    });

    expect(reading.tokens).toBe(302);
    expect(reading.cumulativeFallback).toBe(false);
  });

  it("flags the n_tokens/n_past fallback as cumulative", () => {
    const reading = readProcessedTokensWithSource({
      n_tokens: 4096,
      n_prompt_tokens: 8192,
    });

    expect(reading.tokens).toBe(4096);
    expect(reading.cumulativeFallback).toBe(true);
  });

  it("returns no tokens when the slot reports nothing", () => {
    const reading = readProcessedTokensWithSource({});

    expect(reading.tokens).toBeUndefined();
    expect(reading.cumulativeFallback).toBe(false);
  });
});

describe("readPromptTokens", () => {
  it("uses the fallback estimate when llama.cpp reports zero prompt tokens", () => {
    const promptTokens = readPromptTokens({
      n_prompt_tokens: 0,
      n_prompt_tokens_processed: 5003,
    }, 8123);

    expect(promptTokens).toBe(8123);
  });

  it("reads cached prompt tokens from current llama.cpp slot fields", () => {
    const cachedTokens = readPromptCacheTokens({
      n_prompt_tokens: 24079,
      n_prompt_tokens_processed: 937,
      n_prompt_tokens_cache: 23142,
    });

    expect(cachedTokens).toBe(23142);
  });
});

describe("promptWorkTokens", () => {
  it("uses the uncached suffix as the prefill denominator when cache tokens are reported", () => {
    expect(promptWorkTokens(24079, 23142)).toBe(937);
  });

  it("falls back to the full prompt when no cache token count is available", () => {
    expect(promptWorkTokens(8192, undefined)).toBe(8192);
  });
});

describe("prefill progress computation", () => {
  // These tests validate the key fix: effective processed tokens (delta from
  // baseline) and effective prompt tokens (stable estimate) produce correct
  // progress ratios even when llama.cpp reports n_prompt_tokens that grows
  // during prefill (matching n_prompt_tokens_processed), which would
  // otherwise cause both numerator and denominator to track the same value
  // and always show 100%.

  function simulateProgressPolls(
    slotData: { processedTokens: number; promptTokens: number; cachedPromptTokens?: number }[],
    estimatedPromptTokens: number | undefined,
    opts: { exactPromptTokens?: number; useDeltaBaseline?: boolean } = {},
  ): { processedTokens?: number; promptTokens?: number; progress?: number }[] {
    const results: { processedTokens?: number; promptTokens?: number; progress?: number }[] = [];
    let firstProcessedTokens: number | undefined;

    for (const { processedTokens: raw, promptTokens: slotPromptTokens, cachedPromptTokens } of slotData) {
      // Mimics startLlamaPrefillMonitor: firstProcessedTokens is set BEFORE
      // computing effective delta, so first poll gives delta = 0.
      if (firstProcessedTokens === undefined) {
        firstProcessedTokens = raw;
      }

      results.push(computePrefillProgress({
        rawProcessedTokens: raw,
        slotPromptTokens,
        cachedPromptTokens,
        estimatedPromptTokens,
        exactPromptTokens: opts.exactPromptTokens,
        firstProcessedTokens,
        useDeltaBaseline: opts.useDeltaBaseline,
      }));
    }

    return results;
  }

  it("produces correct progress when n_prompt_tokens tracks n_prompt_tokens_processed (the 100% bug)", () => {
    // Simulates the bug scenario: both fields grow in lockstep.
    // Old behavior: 4100/4100, 7000/7000, 10000/10000 (always 100%)
    // New behavior with delta + estimate: 0/10000, 2900/10000, 5800/10000
    const polls = simulateProgressPolls(
      [
        { processedTokens: 4100, promptTokens: 4100 },  // Both growing together
        { processedTokens: 7000, promptTokens: 7000 },  // Both still equal
        { processedTokens: 10000, promptTokens: 10000 }, // Final: both at total
      ],
      10000, // Stable estimated prompt tokens
    );

    // First poll: delta = 4100 - 4100 = 0
    expect(polls[0].processedTokens).toBe(0);
    expect(polls[0].promptTokens).toBe(10000);
    expect(polls[0].progress).toBeCloseTo(0);

    // Second poll: delta = 7000 - 4100 = 2900
    expect(polls[1].processedTokens).toBe(2900);
    expect(polls[1].promptTokens).toBe(10000);
    expect(polls[1].progress).toBeCloseTo(0.29);

    // Third poll: delta = 10000 - 4100 = 5900
    expect(polls[2].processedTokens).toBe(5900);
    expect(polls[2].promptTokens).toBe(10000);
    expect(polls[2].progress).toBeCloseTo(0.59);
  });

  it("handles warm cache with n_tokens fallback correctly", () => {
    // Total prompt: ~10000 tokens. Cache holds ~4000. New work: ~6000.
    // n_tokens fallback starts at cached context (4000) and grows to total (10000).
    // Delta extracts only new work. Denominator = estimate - cached = 10000 - 4000 = 6000.
    // Progress should reach ~100% when prefill completes.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 4000, promptTokens: 10000, cachedPromptTokens: 4000 },
        { processedTokens: 6000, promptTokens: 10000, cachedPromptTokens: 4000 },
        { processedTokens: 10000, promptTokens: 10000, cachedPromptTokens: 4000 },
      ],
      10000, // Estimated total prompt tokens
    );

    // First poll: delta = 4000 - 4000 = 0, denominator = 10000 - 4000 = 6000
    expect(polls[0].processedTokens).toBe(0);
    expect(polls[0].promptTokens).toBe(6000);
    expect(polls[0].progress).toBeCloseTo(0);

    // Second poll: delta = 6000 - 4000 = 2000
    expect(polls[1].processedTokens).toBe(2000);
    expect(polls[1].progress).toBeCloseTo(2000 / 6000, 2);

    // Third poll: delta = 10000 - 4000 = 6000, reaches 100%
    expect(polls[2].processedTokens).toBe(6000);
    expect(polls[2].progress).toBeCloseTo(1.0);
  });

  it("works correctly when slot data provides distinct processed/prompt values", () => {
    // When llama.cpp correctly provides n_prompt_tokens (total) and
    // n_prompt_tokens_processed (partial), delta tracking still works.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 0, promptTokens: 10000 },     // Start of prefill
        { processedTokens: 5000, promptTokens: 10000 },  // Mid-prefill
        { processedTokens: 10000, promptTokens: 10000 }, // Done
      ],
      10000,
    );

    expect(polls[0].processedTokens).toBe(0);
    expect(polls[0].progress).toBeCloseTo(0);

    expect(polls[1].processedTokens).toBe(5000);
    expect(polls[1].progress).toBeCloseTo(0.5);

    expect(polls[2].processedTokens).toBe(10000);
    expect(polls[2].progress).toBeCloseTo(1.0);
  });

  it("falls back to raw prompt tokens when estimate is unavailable", () => {
    // When estimatedPromptTokens is undefined, promptTokens comes from slot data.
    // The bug (always 100%) would still occur, but the delta at least gives
    // some idea of progress.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 4100, promptTokens: 4100 },
        { processedTokens: 7000, promptTokens: 7000 },
      ],
      undefined, // No estimate available
    );

    // With no estimate and growing promptTokens, we get delta/delta ≈ 100%
    // This is the degraded case — still broken but no worse than before.
    // In practice, estimates are always available since they're pre-computed.
    expect(polls[0].promptTokens).toBe(4100);
    expect(polls[1].promptTokens).toBe(7000);
  });

  it("warm cache progress reaches 100% when denominator subtracts cached tokens", () => {
    // Regression test: without subtracting cachedPromptTokens from the estimate,
    // the denominator (total estimate) would be larger than the numerator (delta =
    // only uncached work), capping the progress bar well below 100%.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 5000, promptTokens: 10000, cachedPromptTokens: 5000 },
        { processedTokens: 7500, promptTokens: 10000, cachedPromptTokens: 5000 },
        { processedTokens: 10000, promptTokens: 10000, cachedPromptTokens: 5000 },
      ],
      10000, // Estimate = total prompt size, NOT just uncached work
    );

    // Denominator = 10000 - 5000 = 5000 (actual work remaining)
    expect(polls[0].promptTokens).toBe(5000);
    expect(polls[0].progress).toBeCloseTo(0);

    expect(polls[1].processedTokens).toBe(2500); // 7500 - 5000
    expect(polls[1].progress).toBeCloseTo(0.5);

    // Reaches 100% — not capped at 50% like it would be without cache subtraction
    expect(polls[2].processedTokens).toBe(5000); // 10000 - 5000
    expect(polls[2].progress).toBeCloseTo(1.0);
  });

  it("estimates with some inaccuracy still produce useful progress", () => {
    // Even if the estimate is off by ~20%, progress is still meaningful.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 200, promptTokens: 200 },
        { processedTokens: 5000, promptTokens: 5000 },
        { processedTokens: 8000, promptTokens: 8000 },
      ],
      12000, // Overestimate by 20%
    );

    expect(polls[0].processedTokens).toBe(0);  // delta from baseline
    expect(polls[0].progress).toBeCloseTo(0);

    expect(polls[1].processedTokens).toBe(4800);  // 5000 - 200
    expect(polls[1].progress).toBeCloseTo(4800 / 12000, 2);

    expect(polls[2].processedTokens).toBe(7800);  // 8000 - 200
    expect(polls[2].progress).toBeCloseTo(7800 / 12000, 2);

    // Progress reaches ~65% when actual prefill completes,
    // then transitions to decode phase — much better than always 100%
  });

  it("prefers the slot-reported total over the estimate when it is ahead of the processed count", () => {
    // The estimate undershot (80K vs a real 88.8K prompt). Once the slot
    // reports the true total, it becomes the denominator — progress stays
    // honest instead of pinning at 100% while the estimate is overtaken.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 0, promptTokens: 88816 },
        { processedTokens: 45000, promptTokens: 88816 },
        { processedTokens: 88816, promptTokens: 88816 },
      ],
      80638, // pre-request char estimate (too low)
    );

    expect(polls[0].promptTokens).toBe(88816);
    expect(polls[1].promptTokens).toBe(88816);
    expect(polls[1].progress).toBeCloseTo(45000 / 88816, 2);
    // Final poll: slot total equals processed (not strictly ahead) so it is
    // no longer trustworthy, but the estimate floor keeps the ratio at 1.0
    // instead of overshooting.
    expect(polls[2].processedTokens).toBe(88816);
    expect(polls[2].promptTokens).toBeGreaterThanOrEqual(88816);
    expect(polls[2].progress).toBeCloseTo(1.0);
  });

  it("floors the denominator at the processed delta when the estimate undershoots", () => {
    // No slot total available (build reports nothing during prefill) and the
    // estimate is 20% low. Without the floor, processed runs past the
    // denominator and the UI renders "processed > prompt" with progress
    // pinned at 100%; with it, the denominator tracks the proven minimum.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 0, promptTokens: 0 },
        { processedTokens: 9000, promptTokens: 0 },
        { processedTokens: 12000, promptTokens: 0 },
      ],
      10000, // estimate; actual prompt turns out to be 12000
    );

    expect(polls[0].promptTokens).toBe(10000);
    expect(polls[1].promptTokens).toBe(10000);
    expect(polls[1].progress).toBeCloseTo(0.9);

    // Processed crossed the estimate: denominator is floored at processed,
    // so promptTokens >= processedTokens always holds.
    expect(polls[2].promptTokens).toBe(12000);
    expect(polls[2].progress).toBeCloseTo(1.0);
  });

  it("keeps the denominator stable at the exact prompt count while the slot total grows in chunks", () => {
    // Real llama.cpp behavior (observed on b10617): prefill runs in
    // batch-sized chunks and n_prompt_tokens only reports the chunk frontier
    // (42 → 4138 → 8234 → ... → 28714), with n_prompt_tokens_processed
    // trailing one chunk behind. Without the exact count, the denominator
    // grows every chunk and the ratio never settles. The exact
    // /apply-template + /tokenize count is stable from the first poll, and
    // the per-request processed field is used raw (no delta baseline), so
    // progress starts at the true value and reaches exactly 100%.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 42, promptTokens: 4138 },
        { processedTokens: 4138, promptTokens: 8234 },
        { processedTokens: 8234, promptTokens: 12330 },
        { processedTokens: 28714, promptTokens: 28714 },
      ],
      87000, // char estimate (deliberately far off for this content)
      { exactPromptTokens: 28714, useDeltaBaseline: false },
    );

    for (const poll of polls) {
      expect(poll.promptTokens).toBe(28714);
    }
    expect(polls[0].processedTokens).toBe(42);
    expect(polls[0].progress).toBeCloseTo(42 / 28714, 4);
    expect(polls[1].progress).toBeCloseTo(4138 / 28714, 3);
    expect(polls[3].processedTokens).toBe(28714);
    expect(polls[3].progress).toBeCloseTo(1.0);
  });

  it("does not undercount the numerator when the first poll lands mid-prefill", () => {
    // The delta baseline subtracts the first observed count; with an exact
    // denominator and a per-request processed field that starts at the
    // request's own work, the raw count is the accurate numerator even when
    // polling starts late.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 5000, promptTokens: 8234 },
        { processedTokens: 12330, promptTokens: 16426 },
      ],
      10000,
      { exactPromptTokens: 28714, useDeltaBaseline: false },
    );

    expect(polls[0].processedTokens).toBe(5000);
    expect(polls[0].progress).toBeCloseTo(5000 / 28714, 3);
    expect(polls[1].progress).toBeCloseTo(12330 / 28714, 3);
  });

  it("subtracts cached tokens from the exact denominator on warm prefills", () => {
    // Warm request: the processed field counts only the uncached work, so
    // the denominator must match. Progress reaches 100% when the suffix is
    // done, not when the full prompt size is re-processed.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 0, promptTokens: 4138, cachedPromptTokens: 23142 },
        { processedTokens: 468, promptTokens: 4138, cachedPromptTokens: 23142 },
        { processedTokens: 937, promptTokens: 4138, cachedPromptTokens: 23142 },
      ],
      24079,
      { exactPromptTokens: 24079, useDeltaBaseline: false },
    );

    expect(polls[0].promptTokens).toBe(937);
    expect(polls[0].progress).toBeCloseTo(0);
    expect(polls[1].progress).toBeCloseTo(468 / 937, 2);
    expect(polls[2].progress).toBeCloseTo(1.0);
  });

  it("keeps the legacy estimate path untouched when no exact count is available", () => {
    // Exact count failed (server busy / unsupported): the previous
    // delta + estimate behavior still applies.
    const polls = simulateProgressPolls(
      [
        { processedTokens: 4100, promptTokens: 4100 },
        { processedTokens: 7000, promptTokens: 7000 },
      ],
      10000,
    );

    expect(polls[0].processedTokens).toBe(0);
    expect(polls[0].promptTokens).toBe(10000);
    expect(polls[1].processedTokens).toBe(2900);
    expect(polls[1].promptTokens).toBe(10000);
  });
});

describe("buildOpenAICompatChatBody", () => {
  // chat-storage opens app.db relative to the OS homedir at import time, so
  // redirect homedir to a temp dir before dynamically importing the provider.
  let tempHomeDir: string | null = null;

  afterEach(() => {
    vi.doUnmock("os");
    vi.resetModules();
    if (tempHomeDir) {
      rmSync(tempHomeDir, { recursive: true, force: true });
      tempHomeDir = null;
    }
  });

  async function loadProviderWithTempHome() {
    tempHomeDir = mkdtempSync(join(tmpdir(), "porrima-oai-compat-"));
    mkdirSync(join(tempHomeDir, ".porrima"), { recursive: true });
    vi.doMock("os", async (importOriginal) => {
      const actual = await importOriginal<typeof import("os")>();
      return {
        ...actual,
        homedir: () => tempHomeDir!,
      };
    });
    return import("../services/openai-compat-provider.js");
  }

  it("strips media markers from replayed tool-call arguments and results", async () => {
    const { buildOpenAICompatChatBody } = await loadProviderWithTempHome();
    const model = {
      id: "test-model",
      api: "openai-completions",
      provider: "openai-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
      input: ["text"],
      reasoning: false,
    };
    const context = {
      systemPrompt: "You are helpful.",
      messages: [
        {
          role: "assistant",
          provider: "openai-completions",
          api: "openai-completions",
          model: "test-model",
          stopReason: "toolUse",
          usage: { input: 0, output: 0 },
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "write_file",
              arguments: {
                path: "template.txt",
                content: "img: <|vision_start|><|image_pad|><|vision_end|>",
              },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "write_file",
          content: [{ type: "text", text: "wrote <__image__> ok" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    const { body } = await buildOpenAICompatChatBody(model as any, context as any);

    const assistantMsg = body.messages.find((m: any) => m.role === "assistant");
    const argsJson = assistantMsg.tool_calls[0].function.arguments;
    expect(argsJson).not.toContain("<|image_pad|>");
    // Arguments stay valid JSON after stripping.
    expect(JSON.parse(argsJson).content).toBe("img: ");

    const toolMsg = body.messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toBe("wrote  ok");
  });
});

describe("extractSlotProgress", () => {
  it("extracts token counts from a processing slot", () => {
    const payload = [
      {
        id: 0,
        is_processing: true,
        n_prompt_tokens: 8192,
        n_prompt_tokens_processed: 2048,
        n_prompt_tokens_cache: 4096,
      },
    ];
    const snapshot = extractSlotProgress(payload, undefined, 10000);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.processedTokens).toBe(2048);
    expect(snapshot!.processedCumulativeFallback).toBe(false);
    expect(snapshot!.fullPromptTokens).toBe(8192);
    expect(snapshot!.slotReportedPromptTokens).toBe(8192);
    expect(snapshot!.cachedPromptTokens).toBe(4096);
    // promptTokens = promptWorkTokens(8192, 4096) = 4096
    expect(snapshot!.promptTokens).toBe(4096);
  });

  it("surfaces the cumulative-fallback flag when only legacy fields are reported", () => {
    const payload = [
      {
        id: 0,
        is_processing: true,
        n_tokens: 4096,
        n_prompt_tokens: 10000,
      },
    ];
    const snapshot = extractSlotProgress(payload, undefined, 10000);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.processedTokens).toBe(4096);
    expect(snapshot!.processedCumulativeFallback).toBe(true);
  });

  it("keeps slotReportedPromptTokens undefined when the slot reports no total", () => {
    // fullPromptTokens falls back to the pre-request estimate for cache-state
    // heuristics, but the reported-only field must stay undefined so the
    // progress math never mistakes the estimate for a server measurement.
    const payload = [
      {
        id: 0,
        is_processing: true,
        n_prompt_tokens: 0,
        n_prompt_tokens_processed: 5477,
      },
    ];
    const snapshot = extractSlotProgress(payload, undefined, 10000);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.fullPromptTokens).toBe(10000);
    expect(snapshot!.slotReportedPromptTokens).toBeUndefined();
  });

  it("selects the slot with the most processed tokens when no preferred slot", () => {
    const payload = [
      { id: 0, is_processing: true, n_prompt_tokens_processed: 500, n_prompt_tokens: 10000 },
      { id: 1, is_processing: true, n_prompt_tokens_processed: 3000, n_prompt_tokens: 10000 },
    ];
    const snapshot = extractSlotProgress(payload, undefined, 10000);

    // Should pick the slot with most processed tokens
    expect(snapshot!.processedTokens).toBe(3000);
    expect(snapshot!.slotId).toBe(1);
  });

  it("prefers the specified slot even if another slot has more progress", () => {
    const payload = [
      { id: 0, is_processing: true, n_prompt_tokens_processed: 500, n_prompt_tokens: 10000 },
      { id: 1, is_processing: true, n_prompt_tokens_processed: 3000, n_prompt_tokens: 10000 },
    ];
    const snapshot = extractSlotProgress(payload, 0, 10000);

    expect(snapshot!.processedTokens).toBe(500);
    expect(snapshot!.slotId).toBe(0);
  });

  it("returns null when no slots are processing", () => {
    const payload = [
      { id: 0, is_processing: false, n_prompt_tokens: 0 },
    ];
    const snapshot = extractSlotProgress(payload, undefined, 10000);

    expect(snapshot).toBeNull();
  });
});

describe("resolveOccupiedSlotCacheState", () => {
  it("trusts occupancy when no request digest is available (legacy callers)", () => {
    expect(resolveOccupiedSlotCacheState({ lastRequestDigest: "abc" })).toBe("hot");
    expect(resolveOccupiedSlotCacheState({})).toBe("hot");
  });

  it("reports hot only when the resident run matches the outgoing request", () => {
    expect(
      resolveOccupiedSlotCacheState({ lastRequestDigest: "abc", requestDigest: "abc" }),
    ).toBe("hot");
  });

  it("reports cold when the resident run is a different request", () => {
    expect(
      resolveOccupiedSlotCacheState({ lastRequestDigest: "abc", requestDigest: "def" }),
    ).toBe("cold");
  });

  it("reports cold when there is no residency record to verify against", () => {
    expect(
      resolveOccupiedSlotCacheState({ lastRequestDigest: undefined, requestDigest: "abc" }),
    ).toBe("cold");
  });
});
