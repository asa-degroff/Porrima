import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllLlamaCacheResidency,
  clearLlamaCacheResidencyTarget,
  hasLlamaCacheRecord,
  hasLlamaCacheTargetWarmRecord,
  listLlamaCacheResidency,
  markLlamaCacheResidencyFinished,
  markLlamaCacheResidencyStarted,
  NEW_AGENT_CHAT_BASELINE_CACHE_ID,
  NEW_AGENT_CHAT_BASELINE_CACHE_LABEL,
  recordLlamaCacheResidencyRun,
} from "../services/llama-cache-residency.js";

const BASE_URL = "http://llama.test";
const MODEL_ID = "demo-model";
const CONTEXT_WINDOW = 8192;

function recordBaselineWarm(): void {
  markLlamaCacheResidencyStarted({
    chatId: NEW_AGENT_CHAT_BASELINE_CACHE_ID,
    targetKind: "new-agent-chat",
    targetLabel: NEW_AGENT_CHAT_BASELINE_CACHE_LABEL,
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    contextWindow: CONTEXT_WINDOW,
    bindingMode: "auto",
  });

  recordLlamaCacheResidencyRun({
    chatId: NEW_AGENT_CHAT_BASELINE_CACHE_ID,
    targetKind: "new-agent-chat",
    targetLabel: NEW_AGENT_CHAT_BASELINE_CACHE_LABEL,
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    contextWindow: CONTEXT_WINDOW,
    bindingMode: "auto",
    timings: { prompt_n: 100, prompt_ms: 25 },
    cache: {
      cachePrompt: true,
      cacheMode: "cache_prompt",
      requestDigest: "baseline",
      requestMessageCount: 1,
      requestCharCount: 1000,
      containsImages: false,
      reportedPromptTokens: 100,
      promptEvalTokens: 0,
      inferredCachedTokens: 100,
      inferredCacheHitRatio: 1,
    },
  });
}

afterEach(() => {
  clearAllLlamaCacheResidency();
});

describe("llama cache residency targets", () => {
  it("tracks the new-chat baseline separately from real chat records", () => {
    recordBaselineWarm();

    expect(
      hasLlamaCacheTargetWarmRecord({
        chatId: NEW_AGENT_CHAT_BASELINE_CACHE_ID,
        targetKind: "new-agent-chat",
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toBe(true);
    expect(
      hasLlamaCacheRecord(
        NEW_AGENT_CHAT_BASELINE_CACHE_ID,
        BASE_URL,
        MODEL_ID,
        CONTEXT_WINDOW,
      ),
    ).toBe(false);

    const records = listLlamaCacheResidency();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      chatId: NEW_AGENT_CHAT_BASELINE_CACHE_ID,
      targetKind: "new-agent-chat",
      targetLabel: NEW_AGENT_CHAT_BASELINE_CACHE_LABEL,
      warm: true,
      active: true,
    });
  });

  it("clears only the requested target kind", () => {
    recordBaselineWarm();
    markLlamaCacheResidencyFinished(NEW_AGENT_CHAT_BASELINE_CACHE_ID, "chat");

    expect(listLlamaCacheResidency()).toHaveLength(1);

    clearLlamaCacheResidencyTarget(NEW_AGENT_CHAT_BASELINE_CACHE_ID, "new-agent-chat");

    expect(listLlamaCacheResidency()).toHaveLength(0);
  });
});
