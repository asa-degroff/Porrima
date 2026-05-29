import { describe, expect, it } from "vitest";
import {
  estimatePromptTokensForProgress,
  promptWorkTokens,
  readProcessedTokens,
  readPromptCacheTokens,
  readPromptTokens,
  extractSlotProgress,
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
  ): { processedTokens: number | undefined; promptTokens: number | undefined; progress: number | undefined }[] {
    const results: { processedTokens: number | undefined; promptTokens: number | undefined; progress: number | undefined }[] = [];
    let firstProcessedTokens: number | undefined;

    for (const { processedTokens: raw, promptTokens: rawPrompt, cachedPromptTokens } of slotData) {
      // Mimics startLlamaPrefillMonitor: firstProcessedTokens is set BEFORE
      // computing effective delta, so first poll gives delta = 0.
      if (firstProcessedTokens === undefined) {
        firstProcessedTokens = raw;
      }

      // Denominator: stable estimate, adjusted by cached tokens when available
      // so it represents actual work remaining (uncached suffix).
      const effectivePromptTokens = estimatedPromptTokens != null
        ? (cachedPromptTokens != null
            ? Math.max(1, estimatedPromptTokens - cachedPromptTokens)
            : estimatedPromptTokens)
        : rawPrompt;

      // Delta from first observed value (mimics startLlamaPrefillMonitor baseline tracking)
      const effectiveProcessedTokens = raw !== undefined && firstProcessedTokens !== undefined
        ? Math.max(0, raw - firstProcessedTokens)
        : raw;

      const progress = effectiveProcessedTokens !== undefined && effectivePromptTokens !== undefined && effectivePromptTokens > 0
        ? Math.max(0, Math.min(1, effectiveProcessedTokens / effectivePromptTokens))
        : undefined;

      results.push({
        processedTokens: effectiveProcessedTokens,
        promptTokens: effectivePromptTokens,
        progress,
      });
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
    expect(snapshot!.fullPromptTokens).toBe(8192);
    expect(snapshot!.cachedPromptTokens).toBe(4096);
    // promptTokens = promptWorkTokens(8192, 4096) = 4096
    expect(snapshot!.promptTokens).toBe(4096);
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
