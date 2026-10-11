import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { sanitizeProviderText, trimMessagesToAskUser } from "../services/pi-message-utils.js";

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

describe("trimMessagesToAskUser", () => {
  const userMsg = { role: "user", content: "hello", timestamp: 1 } as Message;
  const askUserAssistant = {
    role: "assistant",
    content: [
      { type: "text", text: "Let me ask:" },
      { type: "toolCall", id: "call-ask", name: "ask_user", arguments: { question: "proceed?" } },
    ],
    timestamp: 2,
  } as unknown as Message;
  const placeholderResult = {
    role: "toolResult",
    toolCallId: "call-ask",
    toolName: "ask_user",
    content: [{ type: "text", text: "[paused for user input]" }],
    isError: false,
    timestamp: 3,
  } as unknown as Message;
  const abortedAssistant = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    timestamp: 4,
  } as unknown as Message;

  it("keeps everything through the ask_user assistant message and drops the trailing placeholder/aborted messages", () => {
    const messages = [userMsg, askUserAssistant, placeholderResult, abortedAssistant];

    const { trimmed, found } = trimMessagesToAskUser(messages);

    expect(found).toBe(true);
    expect(trimmed).toEqual([userMsg, askUserAssistant]);
    // Input array is not mutated
    expect(messages).toHaveLength(4);
  });

  it("returns found=true with no trimming when the array already ends at ask_user", () => {
    const messages = [userMsg, askUserAssistant];

    const { trimmed, found } = trimMessagesToAskUser(messages);

    expect(found).toBe(true);
    expect(trimmed).toEqual(messages);
  });

  it("reports found=false and empties the array when no ask_user assistant message exists", () => {
    // The stale-context regression: callers must NOT reuse the untrimmed array
    // here — it may contain pre-compaction history.
    const messages = [userMsg, abortedAssistant, placeholderResult];

    const { trimmed, found } = trimMessagesToAskUser(messages);

    expect(found).toBe(false);
    expect(trimmed).toEqual([]);
  });

  it("trims to the LAST ask_user assistant message when several exist", () => {
    const earlierAsk = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-earlier", name: "ask_user", arguments: {} }],
      timestamp: 0,
    } as unknown as Message;
    const messages = [earlierAsk, placeholderResult, userMsg, askUserAssistant, placeholderResult];

    const { trimmed, found } = trimMessagesToAskUser(messages);

    expect(found).toBe(true);
    expect(trimmed).toEqual([earlierAsk, placeholderResult, userMsg, askUserAssistant]);
  });
});
