/**
 * Derives the "latest browser screenshot" for the persistent PiP viewer from
 * the chat's message data. No dedicated event stream: browser_screenshot
 * results already reach the client through the `tool_result` segment (live
 * SSE, reconnect resync replay, and loaded history all carry the same
 * url-only image refs persisted by `buildPersistedToolResult`).
 *
 * Phase 2 (docs/design/browser-observability.md) will add server-pushed
 * `browser_frame` events after every browser action; this hook's output shape
 * is what that live frame will slot into.
 */

import { useMemo } from "react";
import type { ChatMessage, ChatToolResult, ImageAttachment } from "../types";

export interface BrowserViewerFrame {
  /** The screenshot attachment — always carries a server URL (url-only after
   *  externalization; legacy base64-in-row images are skipped). */
  image: ImageAttachment;
  /** Page URL parsed from the screenshot result label, when present. */
  pageUrl: string | null;
  /** Page title parsed from the label, when present. */
  pageTitle: string | null;
  /** Timestamp of the message that carried the screenshot. */
  at: number;
}

/** Hoisted so the reverse scan never recompiles it (label from
 *  browser-tools.ts: `Screenshot of <url> — "<title>" (WxH, viewport)`). */
const SCREENSHOT_LABEL_RE = /^Screenshot of (\S+) — "(.*)" \(\d+x\d+/m;

function extractFrame(result: ChatToolResult, at: number): BrowserViewerFrame | null {
  if (result.toolName !== "browser_screenshot" || result.isError) return null;
  const image = result.images?.find((img) => img.url);
  if (!image) return null;
  const label = SCREENSHOT_LABEL_RE.exec(result.content || "");
  return {
    image,
    pageUrl: label?.[1] ?? null,
    pageTitle: label?.[2] ?? null,
    at,
  };
}

/** Newest-first scan; exported (besides the hook) for direct unit testing. */
export function findLatestFrame(messages: ChatMessage[]): BrowserViewerFrame | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    // Ordered segments are canonical (live-flushed and persisted alike); the
    // flat toolResults array is the fallback for rows without segments.
    if (msg.segments?.length) {
      for (let j = msg.segments.length - 1; j >= 0; j--) {
        const seg = msg.segments[j];
        if (seg.type !== "tool_result" || !seg.toolResult) continue;
        const frame = extractFrame(seg.toolResult, msg.timestamp);
        if (frame) return frame;
      }
    } else if (msg.toolResults?.length) {
      for (let j = msg.toolResults.length - 1; j >= 0; j--) {
        const frame = extractFrame(msg.toolResults[j], msg.timestamp);
        if (frame) return frame;
      }
    }
  }
  return null;
}

/**
 * Latest browser screenshot in the loaded message window, recomputed when the
 * messages array changes. Reverse scan with early exit: the common case finds
 * the frame in the most recent assistant message or returns null quickly.
 */
export function useBrowserViewer(messages: ChatMessage[]): BrowserViewerFrame | null {
  return useMemo(() => findLatestFrame(messages), [messages]);
}
