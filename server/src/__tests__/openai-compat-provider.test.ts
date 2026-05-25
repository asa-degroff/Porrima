import { describe, expect, it } from "vitest";
import {
  estimatePromptTokensForProgress,
  promptWorkTokens,
  readProcessedTokens,
  readPromptCacheTokens,
  readPromptTokens,
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
