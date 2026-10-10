/**
 * Derives the frame for the persistent browser PiP viewer from two sources:
 *
 * - **Live** `browser_frame` events (Phase 2, docs/design/browser-observability.md):
 *   auto-captures after every browser action, plus explicit screenshots, served
 *   from the server's in-memory ring. Preferred while present — the newest
 *   visual the user is following.
 * - **Derived** from message data (Phase 1): the latest persisted
 *   `browser_screenshot` result, which reaches the client through the
 *   `tool_result` segment (live SSE, reconnect resync replay, and loaded
 *   history alike, as url-only refs from `buildPersistedToolResult`).
 *   The fallback for page loads and chats with no live stream.
 */

import { useMemo } from "react";
import type { BrowserFrameEvent, ChatMessage, ChatToolResult, ImageAttachment } from "../types";

export interface BrowserViewerFrame {
  /** The screenshot attachment — always carries a server URL (url-only after
   *  externalization; legacy base64-in-row images are skipped). */
  image: ImageAttachment;
  /** Page URL parsed from the screenshot result label, when present. */
  pageUrl: string | null;
  /** Page title parsed from the label, when present. */
  pageTitle: string | null;
  /** Timestamp of the message that carried the screenshot, or the live
   *  frame's capturedAt. */
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

/** Map a live `browser_frame` event (or resync ring snapshot) into the
 *  viewer's frame shape. Exported for tests. */
export function liveToViewerFrame(frame: BrowserFrameEvent): BrowserViewerFrame {
  return {
    image: { url: frame.imageUrl, mimeType: "image/png", name: "browser-frame" },
    pageUrl: frame.pageUrl || null,
    pageTitle: frame.pageTitle || null,
    at: frame.capturedAt,
  };
}

/**
 * Frame to show: the live stream's newest frame when one exists, otherwise
 * the newest screenshot derivable from loaded messages. Arrival order makes
 * "live present" mean "at least as fresh as any persisted screenshot" — the
 * server also pushes explicit screenshots into the ring, so the live frame
 * never trails the derived one during a watched session.
 */
export function pickViewerFrame(
  live: BrowserFrameEvent | null | undefined,
  derived: BrowserViewerFrame | null,
): BrowserViewerFrame | null {
  return live ? liveToViewerFrame(live) : derived;
}

export function useBrowserViewer(
  messages: ChatMessage[],
  liveFrame?: BrowserFrameEvent | null,
): BrowserViewerFrame | null {
  const derived = useMemo(() => findLatestFrame(messages), [messages]);
  return useMemo(() => pickViewerFrame(liveFrame, derived), [liveFrame, derived]);
}
