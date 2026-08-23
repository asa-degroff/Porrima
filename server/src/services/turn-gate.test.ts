import { describe, expect, it } from "vitest";
import {
  acquireTurn,
  getActiveTurn,
  getQueuedTurns,
  isTurnGateBusy,
  releaseTurn,
  turnGateStatus,
} from "./turn-gate.js";

describe("turn-gate", () => {
  it("grants immediately when idle and releases back to idle", async () => {
    expect(isTurnGateBusy()).toBe(false);
    const lease = await acquireTurn("chat-a");
    expect(lease.chatId).toBe("chat-a");
    expect(getActiveTurn()?.leaseId).toBe(lease.leaseId);
    expect(isTurnGateBusy()).toBe(true);

    releaseTurn(lease);
    expect(getActiveTurn()).toBeNull();
    expect(isTurnGateBusy()).toBe(false);
  });

  it("queues concurrent turns in FIFO order", async () => {
    const first = await acquireTurn("chat-a");
    const second = acquireTurn("chat-b");
    const third = acquireTurn("chat-c");

    expect(getQueuedTurns().map((t) => t.chatId)).toEqual(["chat-b", "chat-c"]);
    expect(turnGateStatus("chat-b")).toEqual({ activeChatId: "chat-a", position: 1, queuedCount: 2 });
    expect(turnGateStatus("chat-c")).toEqual({ activeChatId: "chat-a", position: 2, queuedCount: 2 });

    releaseTurn(first);
    expect((await second).chatId).toBe("chat-b");
    expect(getActiveTurn()?.chatId).toBe("chat-b");

    releaseTurn(await second);
    expect((await third).chatId).toBe("chat-c");
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("rejects a queued waiter when its signal aborts and skips it on grant", async () => {
    const first = await acquireTurn("chat-a");
    const controller = new AbortController();
    const aborted = acquireTurn("chat-b", { signal: controller.signal });
    const survivor = acquireTurn("chat-c");

    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    expect(getQueuedTurns().map((t) => t.chatId)).toEqual(["chat-c"]);

    releaseTurn(first);
    expect((await survivor).chatId).toBe("chat-c");
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const first = await acquireTurn("chat-a");
    const controller = new AbortController();
    controller.abort();
    await expect(acquireTurn("chat-b", { signal: controller.signal })).rejects.toBeDefined();
    expect(getQueuedTurns()).toEqual([]);
    releaseTurn(first);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("ignores stale or foreign lease releases", async () => {
    const first = await acquireTurn("chat-a");
    const second = acquireTurn("chat-b");
    releaseTurn({ leaseId: "bogus", chatId: "chat-b", acquiredAt: Date.now() });
    expect(getActiveTurn()?.chatId).toBe("chat-a");
    expect(getQueuedTurns()).toHaveLength(1);

    releaseTurn(first);
    expect((await second).chatId).toBe("chat-b");
    // Releasing the first lease again must not unseat the second.
    releaseTurn(first);
    expect(getActiveTurn()?.chatId).toBe("chat-b");
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("notifies remaining waiters when a waiter ahead is cancelled", async () => {
    const first = await acquireTurn("chat-a");
    const controller = new AbortController();
    const updates: Array<{ position: number; queuedCount: number }> = [];
    const cancelled = acquireTurn("chat-b", { signal: controller.signal });
    const watcher = acquireTurn("chat-c", {
      onQueueUpdate: (info) => updates.push({ position: info.position, queuedCount: info.queuedCount }),
    });

    // Initial enqueue notification.
    expect(updates).toEqual([{ position: 2, queuedCount: 2 }]);

    controller.abort();
    await expect(cancelled).rejects.toBeDefined();
    // Position advanced after the waiter ahead was removed.
    expect(updates.at(-1)).toEqual({ position: 1, queuedCount: 1 });

    releaseTurn(first);
    expect((await watcher).chatId).toBe("chat-c");
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("returns null status when idle", () => {
    expect(turnGateStatus()).toBeNull();
  });
});
