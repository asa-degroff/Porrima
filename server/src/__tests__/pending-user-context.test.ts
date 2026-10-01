import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../types.js";
import { isPendingNextUserContextMessage, splitNextUserContext } from "../services/pending-user-context.js";

const user = (content: string, timestamp = 1): ChatMessage => ({ role: "user", content, timestamp });
const assistant = (content: string, timestamp = 1): ChatMessage => ({ role: "assistant", content, timestamp });
const delta = (content: string, timestamp = 1): ChatMessage => ({
  role: "system",
  content,
  timestamp,
  _mergeIntoNextUserMessage: true,
});
const passive = (content: string, timestamp = 1): ChatMessage => ({
  role: "system",
  content,
  timestamp,
  _isPassiveMemoryRecall: true,
  _isSystemMessage: true,
});

describe("isPendingNextUserContextMessage", () => {
  it("recognizes marked deltas and passive recalls with text", () => {
    expect(isPendingNextUserContextMessage(delta("d"))).toBe(true);
    expect(isPendingNextUserContextMessage(passive("p"))).toBe(true);
  });

  it("rejects unmarked, empty, and non-system rows", () => {
    expect(isPendingNextUserContextMessage(user("u"))).toBe(false);
    expect(isPendingNextUserContextMessage({ role: "system", content: "plain", timestamp: 1 })).toBe(false);
    expect(isPendingNextUserContextMessage({ ...delta(""), content: "   " })).toBe(false);
    expect(isPendingNextUserContextMessage(undefined)).toBe(false);
  });
});

describe("splitNextUserContext", () => {
  it("matches the current turn's delta by content even without the marker", () => {
    const context = "[System context — updated memories]\nremembered";
    const messages: ChatMessage[] = [
      user("u0", 1),
      assistant("a0", 2),
      { role: "system", content: context, timestamp: 3 },
      user("u1", 4),
    ];

    const result = splitNextUserContext({ messages, currentUserIndex: 3, memoryDeltaContext: context });
    expect(result.persistedHistoryEnd).toBe(2);
    expect(result.systemContexts).toEqual([context]);
  });

  it("takes a structurally marked leftover delta from a prior turn", () => {
    const leftover = "[System context — updated memories]\nfrom an aborted send";
    const messages: ChatMessage[] = [user("u0", 1), assistant("a0", 2), delta(leftover, 3), user("u1", 4)];

    const result = splitNextUserContext({ messages, currentUserIndex: 3, memoryDeltaContext: "" });
    expect(result.persistedHistoryEnd).toBe(2);
    expect(result.systemContexts).toEqual([leftover]);
  });

  it("merges multiple pending rows oldest-first, matching replay order", () => {
    const messages: ChatMessage[] = [
      user("u0", 1),
      assistant("a0", 2),
      passive("recalled-context", 3),
      delta("delta-context", 4),
      user("u1", 5),
    ];

    const result = splitNextUserContext({
      messages,
      currentUserIndex: 4,
      memoryDeltaContext: "delta-context",
    });
    expect(result.persistedHistoryEnd).toBe(2);
    expect(result.systemContexts).toEqual(["recalled-context", "delta-context"]);
  });

  it("stops at the first non-pending row", () => {
    const messages: ChatMessage[] = [
      user("u0", 1),
      assistant("a0", 2),
      delta("not-attached", 3),
      assistant("a1", 4),
      delta("attached", 5),
      user("u1", 6),
    ];

    const result = splitNextUserContext({ messages, currentUserIndex: 5, memoryDeltaContext: "" });
    expect(result.persistedHistoryEnd).toBe(4);
    expect(result.systemContexts).toEqual(["attached"]);
  });

  it("leaves the history untouched when nothing pending is attached", () => {
    const messages: ChatMessage[] = [user("u0", 1), assistant("a0", 2)];
    const result = splitNextUserContext({ messages, currentUserIndex: 2, memoryDeltaContext: "" });
    expect(result.persistedHistoryEnd).toBe(2);
    expect(result.systemContexts).toEqual([]);
  });
});
