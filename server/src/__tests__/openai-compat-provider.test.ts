import { describe, expect, it } from "vitest";
import { estimatePromptTokensForProgress, readProcessedTokens } from "../services/openai-compat-provider.js";

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
