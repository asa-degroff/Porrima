import { describe, expect, it } from "vitest";
import { sanitizeProviderText } from "../services/pi-message-utils.js";

describe("sanitizeProviderText", () => {
  it("removes embedded NUL and unsafe control characters before provider serialization", () => {
    const text = "shader error\n\u0000\nstack\tline\r\nbad\u0007char";

    expect(sanitizeProviderText(text)).toBe("shader error\n\nstack\tline\r\nbadchar");
  });

  it("removes unpaired surrogates while preserving valid pairs", () => {
    expect(sanitizeProviderText("ok \uD83D\uDE00 bad \uD800")).toBe("ok \uD83D\uDE00 bad ");
  });

  it("strips llama.cpp media marker tokens that would abort mtmd tokenization", () => {
    const template = "{{- '<|vision_start|><|image_pad|><|vision_end|>' }}";

    expect(sanitizeProviderText(template)).toBe("{{- '' }}");
    expect(sanitizeProviderText("video: <|vision_start|><|video_pad|><|vision_end|>")).toBe(
      "video: "
    );
    expect(sanitizeProviderText("generic <__image__> marker")).toBe("generic  marker");
    expect(sanitizeProviderText("<__video__><__audio__><|audio_pad|>")).toBe("");
  });

  it("leaves normal angle-bracket and pipe text untouched", () => {
    const text = "compare a|b < c > d and <|text|> plus <image> tags";

    expect(sanitizeProviderText(text)).toBe(text);
  });
});
