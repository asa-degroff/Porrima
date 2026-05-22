import { describe, expect, it } from "vitest";
import { estimatePromptTokensForProgress } from "../services/openai-compat-provider.js";

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
