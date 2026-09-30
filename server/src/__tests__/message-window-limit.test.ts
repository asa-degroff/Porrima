import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGE_WINDOW_LIMIT,
  MAX_MESSAGE_WINDOW_LIMIT,
  parseMessageLimit,
  resolveMessageLimit,
} from "../utils/message-window.js";

/**
 * Guards the shared `messageLimit` contract now that
 * `/api/chat/status/:chatId?includeWindow=1` reads a message window as part
 * of the liveness probe. That route is on the reconnect hot path, and a
 * mis-parse would either fetch the whole chat history (no limit) or silently
 * fetch nothing.
 */
describe("message window limit parsing", () => {
  it("clamps to the shared maximum", () => {
    expect(parseMessageLimit("200")).toBe(200);
    expect(parseMessageLimit("99999")).toBe(MAX_MESSAGE_WINDOW_LIMIT);
  });

  it("rejects non-positive, non-numeric and non-string values", () => {
    expect(parseMessageLimit("0")).toBeUndefined();
    expect(parseMessageLimit("-5")).toBeUndefined();
    expect(parseMessageLimit("abc")).toBeUndefined();
    expect(parseMessageLimit(undefined)).toBeUndefined();
    expect(parseMessageLimit(200)).toBeUndefined(); // numbers are not query strings
  });

  it("falls back to the default window when the param is absent or unusable", () => {
    expect(resolveMessageLimit(undefined)).toBe(DEFAULT_MESSAGE_WINDOW_LIMIT);
    expect(resolveMessageLimit("nonsense")).toBe(DEFAULT_MESSAGE_WINDOW_LIMIT);
    expect(resolveMessageLimit("0")).toBe(DEFAULT_MESSAGE_WINDOW_LIMIT);
    expect(resolveMessageLimit("5000")).toBe(MAX_MESSAGE_WINDOW_LIMIT);
    expect(resolveMessageLimit("50")).toBe(50);
  });

  it("keeps the default aligned with the client page size", () => {
    // The client requests MESSAGE_PAGE_SIZE = 200 (client/src/hooks/useChat.ts)
    // and INITIAL_MESSAGE_LIMIT = 200 (client/src/App.tsx). If one of those
    // moves, the probe would fall back to a different window than the normal
    // chat load and the two paths would disagree on messageOffset.
    expect(DEFAULT_MESSAGE_WINDOW_LIMIT).toBe(200);
  });
});
