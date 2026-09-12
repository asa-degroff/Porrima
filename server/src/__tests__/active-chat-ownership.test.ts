import { afterEach, describe, expect, it } from "vitest";
import {
  hasActiveChats,
  isChatActive,
  markChatActive,
  markChatInactive,
  touchChatActivity,
} from "../services/memory-extraction.js";

/**
 * Pins owner-scoped active-chat tracking.
 *
 * A superseded turn can reach its finally long after a newer turn took over
 * the chat (e.g. it stalled for minutes in its completion path while a slow
 * mid-turn extraction pulse retried). The stale turn must not clear the
 * newer turn's active entry — otherwise the scheduler treats the chat as
 * idle and runs automations/delayed extraction alongside the live turn.
 */

const CHAT_ID = "active-owner-chat";

afterEach(() => {
  // Unconditional cleanup (token-less release keeps that semantic).
  markChatInactive(CHAT_ID);
});

describe("owner-scoped active-chat tracking", () => {
  it("ignores a stale owner's release after a newer turn takes over", () => {
    const olderTurn = {};
    const newerTurn = {};

    markChatActive(CHAT_ID, olderTurn);
    markChatActive(CHAT_ID, newerTurn);

    markChatInactive(CHAT_ID, olderTurn);
    expect(isChatActive(CHAT_ID)).toBe(true);

    markChatInactive(CHAT_ID, newerTurn);
    expect(isChatActive(CHAT_ID)).toBe(false);
  });

  it("keeps the unconditional release for token-less callers", () => {
    markChatActive(CHAT_ID, {});
    markChatInactive(CHAT_ID);
    expect(isChatActive(CHAT_ID)).toBe(false);
  });

  it("refreshes only an existing entry", () => {
    touchChatActivity(CHAT_ID);
    expect(isChatActive(CHAT_ID)).toBe(false);

    const owner = {};
    markChatActive(CHAT_ID, owner);
    touchChatActivity(CHAT_ID);
    expect(isChatActive(CHAT_ID)).toBe(true);
    expect(hasActiveChats()).toBe(true);
  });

  it("does not let a foreign owner affect the global active check", () => {
    const owner = {};
    markChatActive(CHAT_ID, owner);
    markChatInactive(CHAT_ID, {});
    expect(hasActiveChats()).toBe(true);

    markChatInactive(CHAT_ID, owner);
    expect(hasActiveChats()).toBe(false);
  });
});
