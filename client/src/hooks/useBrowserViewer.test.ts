import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatToolResult, MessageSegment } from "../types";
import { findLatestFrame } from "./useBrowserViewer";

const IMAGE_URL = "/api/tool-result-images/img-1/image.png";

function screenshotResult(overrides?: Partial<ChatToolResult>): ChatToolResult {
  return {
    toolCallId: "call-1",
    toolName: "browser_screenshot",
    content: `Screenshot of https://example.com/page — "Example Page" (1280x800, viewport)`,
    isError: false,
    images: [{ url: IMAGE_URL, mimeType: "image/png", name: "browser-screenshot" }],
    ...overrides,
  };
}

function assistantMessage(partial: Partial<ChatMessage> & { timestamp: number }): ChatMessage {
  return { role: "assistant", content: "", ...partial } as ChatMessage;
}

function toolResultSegments(results: ChatToolResult[]): MessageSegment[] {
  return results.map((toolResult, i) => ({ seq: i + 1, type: "tool_result", toolResult }));
}

describe("findLatestFrame", () => {
  it("returns null for chats without browser screenshots", () => {
    const messages = [
      assistantMessage({
        timestamp: 1,
        segments: toolResultSegments([
          { ...screenshotResult(), toolName: "browser_navigate" },
          { ...screenshotResult(), toolName: "read_pdf" },
        ]),
      }),
    ];
    expect(findLatestFrame(messages)).toBeNull();
  });

  it("extracts frame url plus page url/title from the result label", () => {
    const frame = findLatestFrame([assistantMessage({ timestamp: 5, segments: toolResultSegments([screenshotResult()]) })]);
    expect(frame).not.toBeNull();
    expect(frame!.image.url).toBe(IMAGE_URL);
    expect(frame!.pageUrl).toBe("https://example.com/page");
    expect(frame!.pageTitle).toBe("Example Page");
    expect(frame!.at).toBe(5);
  });

  it("tolerates results whose content is not the standard label", () => {
    const frame = findLatestFrame([
      assistantMessage({ timestamp: 2, segments: toolResultSegments([screenshotResult({ content: "Screenshot captured" })]) }),
    ]);
    expect(frame!.pageUrl).toBeNull();
    expect(frame!.pageTitle).toBeNull();
  });

  it("scans newest message first", () => {
    const newerUrl = "/api/tool-result-images/img-2/image.png";
    const frame = findLatestFrame([
      assistantMessage({ timestamp: 1, segments: toolResultSegments([screenshotResult()]) }),
      assistantMessage({ timestamp: 2, segments: toolResultSegments([screenshotResult({ images: [{ url: newerUrl, mimeType: "image/png", name: "x" }] })]) }),
    ]);
    expect(frame!.image.url).toBe(newerUrl);
    expect(frame!.at).toBe(2);
  });

  it("scans newest segment first within a message", () => {
    const secondUrl = "/api/tool-result-images/img-3/image.png";
    const frame = findLatestFrame([
      assistantMessage({
        timestamp: 3,
        segments: toolResultSegments([
          screenshotResult(),
          screenshotResult({ toolCallId: "call-2", images: [{ url: secondUrl, mimeType: "image/png", name: "x" }] }),
        ]),
      }),
    ]);
    expect(frame!.image.url).toBe(secondUrl);
  });

  it("skips error results and url-less images", () => {
    const frame = findLatestFrame([
      assistantMessage({ timestamp: 1, segments: toolResultSegments([screenshotResult({ isError: true })]) }),
      assistantMessage({ timestamp: 2, segments: toolResultSegments([screenshotResult({ images: [{ mimeType: "image/png", name: "data-only" }] })]) }),
    ]);
    expect(frame).toBeNull();
  });

  it("falls back to flat toolResults for rows without segments", () => {
    const frame = findLatestFrame([
      assistantMessage({ timestamp: 7, toolResults: [screenshotResult()] }),
    ]);
    expect(frame!.image.url).toBe(IMAGE_URL);
  });

  it("ignores user-role messages", () => {
    const messages: ChatMessage[] = [
      { ...assistantMessage({ timestamp: 1 }), role: "user", segments: toolResultSegments([screenshotResult()]) },
    ];
    expect(findLatestFrame(messages)).toBeNull();
  });
});
