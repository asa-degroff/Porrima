import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllLlamaCacheResidency,
  clearLlamaCacheResidencyTarget,
  getLlamaChatLastRequestDigest,
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

function recordChatRun(chatId: string, requestDigest: string): void {
  markLlamaCacheResidencyStarted({
    chatId,
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    contextWindow: CONTEXT_WINDOW,
    bindingMode: "enforced",
    slotId: 0,
  });

  recordLlamaCacheResidencyRun({
    chatId,
    baseUrl: BASE_URL,
    modelId: MODEL_ID,
    contextWindow: CONTEXT_WINDOW,
    bindingMode: "enforced",
    slotId: 0,
    timings: { prompt_n: 100, prompt_ms: 25 },
    cache: {
      cachePrompt: true,
      cacheMode: "cache_prompt",
      requestDigest,
      requestMessageCount: 2,
      requestCharCount: 1000,
      containsImages: false,
      reportedPromptTokens: 100,
      promptEvalTokens: 0,
      inferredCachedTokens: 100,
      inferredCacheHitRatio: 1,
    },
  });
}

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

describe("getLlamaChatLastRequestDigest", () => {
  it("returns the digest recorded by the last completed run", () => {
    recordChatRun("chat-a", "digest-1");
    expect(
      getLlamaChatLastRequestDigest({
        chatId: "chat-a",
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toBe("digest-1");

    recordChatRun("chat-a", "digest-2");
    expect(
      getLlamaChatLastRequestDigest({
        chatId: "chat-a",
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toBe("digest-2");
  });

  it("returns undefined when no chat record exists", () => {
    recordBaselineWarm();
    expect(
      getLlamaChatLastRequestDigest({
        chatId: "missing",
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toBeUndefined();
  });

  it("is scoped to the chat target kind and pool", () => {
    recordChatRun("chat-a", "digest-1");

    // Different pool (context window) does not see the record.
    expect(
      getLlamaChatLastRequestDigest({
        chatId: "chat-a",
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW + 1,
      }),
    ).toBeUndefined();

    // The baseline record lives under a different target kind, so a chat
    // lookup for its id finds nothing.
    recordBaselineWarm();
    expect(
      getLlamaChatLastRequestDigest({
        chatId: NEW_AGENT_CHAT_BASELINE_CACHE_ID,
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toBeUndefined();
  });

  it("survives a started-but-not-yet-completed run", () => {
    recordChatRun("chat-a", "digest-1");
    markLlamaCacheResidencyStarted({
      chatId: "chat-a",
      baseUrl: BASE_URL,
      modelId: MODEL_ID,
      contextWindow: CONTEXT_WINDOW,
      bindingMode: "enforced",
      slotId: 0,
    });
    expect(
      getLlamaChatLastRequestDigest({
        chatId: "chat-a",
        baseUrl: BASE_URL,
        modelId: MODEL_ID,
        contextWindow: CONTEXT_WINDOW,
      }),
    ).toBe("digest-1");
  });
});
