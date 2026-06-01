import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  flushTokenEstimateObservability,
  recordContextEstimateObservation,
  recordToolResultExactTokenEstimate,
} from "../services/token-estimate-observability.js";

let tempDir: string | null = null;

afterEach(async () => {
  delete process.env.TOKEN_ESTIMATE_OBSERVABILITY;
  delete process.env.TOKEN_ESTIMATE_OBSERVABILITY_PATH;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("token estimate observability", () => {
  it("writes hash-only tool-result exact-count samples when enabled", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "porrima-token-estimates-"));
    const logPath = join(tempDir, "token-estimates.jsonl");
    process.env.TOKEN_ESTIMATE_OBSERVABILITY = "1";
    process.env.TOKEN_ESTIMATE_OBSERVABILITY_PATH = logPath;

    const content = "secret raw tool output\n".repeat(10);
    recordToolResultExactTokenEstimate({
      chatId: "chat-1",
      phase: "tool_loop",
      modelId: "model-1",
      label: "m1.toolResult0",
      toolName: "read_file",
      content,
      exactTokens: 25,
      exactElapsedMs: 7,
      exactCached: false,
    });
    await flushTokenEstimateObservability();

    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain("secret raw tool output");
    const sample = JSON.parse(log.trim());
    expect(sample.sampleType).toBe("tool_result_exact");
    expect(sample.contentHash).toMatch(/^[a-f0-9]{16}$/);
    expect(sample.toolName).toBe("read_file");
    expect(sample.exactTokens).toBe(25);
    expect(sample.ratioEstimateToExact).toBeGreaterThan(0);
  });

  it("records context estimate observations for next-call input comparisons", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "porrima-token-estimates-"));
    const logPath = join(tempDir, "token-estimates.jsonl");
    process.env.TOKEN_ESTIMATE_OBSERVABILITY = "1";
    process.env.TOKEN_ESTIMATE_OBSERVABILITY_PATH = logPath;

    recordContextEstimateObservation({
      chatId: "chat-1",
      modelId: "model-1",
      sourceIteration: 1,
      observedIteration: 2,
      sourceStopReason: "toolUse",
      observedStopReason: "stop",
      estimatedInputTokens: 12_000,
      displayEstimatedInputTokens: 9_000,
      approximateTokens: 12_000,
      exactToolResultCount: 1,
      exactDelta: 0,
      signedExactDelta: -3_000,
      selectedEstimatePath: "usage_anchor",
      pathAEstimateTokens: 12_000,
      pathBEstimateTokens: 10_500,
      lastUsageInputTokens: 7_800,
      lastUsageOutputTokens: 200,
      lastUsageTotalTokens: 8_000,
      postUsageAdditionalTokens: 4_000,
      toolCallCount: 1,
      toolResultCount: 1,
      contextWindow: 32_768,
      observedInputTokens: 8_000,
      observedOutputTokens: 200,
      observedTotalTokens: 8_200,
    });
    await flushTokenEstimateObservability();

    const sample = JSON.parse((await readFile(logPath, "utf8")).trim());
    expect(sample.sampleType).toBe("context_estimate_observed");
    expect(sample.ratioEstimateToObserved).toBe(1.5);
    expect(sample.ratioDisplayEstimateToObserved).toBe(1.125);
    expect(sample.selectedEstimatePath).toBe("usage_anchor");
    expect(sample.pathAEstimateTokens).toBe(12_000);
    expect(sample.pathBEstimateTokens).toBe(10_500);
    expect(sample.lastUsageTotalTokens).toBe(8_000);
  });
});
