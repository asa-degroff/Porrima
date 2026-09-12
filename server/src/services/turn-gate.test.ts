import { describe, expect, it } from "vitest";
import {
  acquireTurn,
  getActiveTurn,
  getQueuedTurns,
  heartbeatTurnLease,
  isTurnGateBusy,
  reapStaleTurnLease,
  releaseTurn,
  turnGateStatus,
} from "./turn-gate.js";

/** Force the active lease's heartbeat into the stale past. */
function ageActiveLease(ms: number): void {
  const active = getActiveTurn();
  if (!active) throw new Error("no active lease");
  active.lastHeartbeatAt = Date.now() - ms;
}

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
    releaseTurn({ leaseId: "bogus", chatId: "chat-b", kind: "chat", acquiredAt: Date.now(), lastHeartbeatAt: Date.now() });
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

  it("serves foreground waiters before background waiters", async () => {
    const first = await acquireTurn("chat-a");
    const background = acquireTurn("__cache_warm__", {
      kind: "cache-warm",
      priority: "background",
    });
    const foreground = acquireTurn("chat-b");

    // The foreground turn jumped the background warm's place in line.
    expect(getQueuedTurns().map((t) => t.chatId)).toEqual(["chat-b", "__cache_warm__"]);

    releaseTurn(first);
    expect((await foreground).chatId).toBe("chat-b");
    expect(getActiveTurn()?.kind).toBe("chat");

    releaseTurn(getActiveTurn()!);
    expect((await background).chatId).toBe("__cache_warm__");
    // A background lease reports its kind so the client can label the wait.
    expect(turnGateStatus("__cache_warm__")?.activeKind).toBe("cache-warm");

    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("returns null status when idle", () => {
    expect(turnGateStatus()).toBeNull();
  });

  it("steals a stale lease on the next acquire and serves the queued waiter first", async () => {
    const first = await acquireTurn("chat-a");
    const queued = acquireTurn("chat-b");
    ageActiveLease(20 * 60_000); // past the default 15-min staleness window

    const steal = acquireTurn("chat-c");
    // The queued waiter is served by the steal release; the new acquirer queues.
    expect((await queued).chatId).toBe("chat-b");
    expect(getQueuedTurns().map((t) => t.chatId)).toEqual(["chat-c"]);
    expect(getActiveTurn()?.chatId).toBe("chat-b");

    // The hung holder's old lease is a no-op if it ever wakes up.
    releaseTurn(first);
    expect(getActiveTurn()?.chatId).toBe("chat-b");

    releaseTurn(getActiveTurn()!);
    expect((await steal).chatId).toBe("chat-c");
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("reaps a stale lease so the queue drains without a new acquirer", async () => {
    const first = await acquireTurn("chat-a");
    const queued = acquireTurn("chat-b");
    ageActiveLease(20 * 60_000);

    expect(reapStaleTurnLease()).toBe(true);
    expect((await queued).chatId).toBe("chat-b");

    // Nothing stale left — reap is a no-op.
    expect(reapStaleTurnLease()).toBe(false);
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("a fresh heartbeat prevents the steal", async () => {
    const first = await acquireTurn("chat-a");
    heartbeatTurnLease(first);
    const queued = acquireTurn("chat-b");

    ageActiveLease(20 * 60_000);
    heartbeatTurnLease(first); // holder just showed activity
    expect(isTurnGateBusy()).toBe(true);
    expect(turnGateStatus("chat-b")).toEqual({ activeChatId: "chat-a", position: 1, queuedCount: 1 });

    // No steal: the queued waiter stays queued and the holder keeps the lease.
    const steal = acquireTurn("chat-c");
    expect(getQueuedTurns().map((t) => t.chatId)).toEqual(["chat-b", "chat-c"]);
    expect(getActiveTurn()?.chatId).toBe("chat-a");
    // Clean up: release in FIFO order.
    releaseTurn(first);
    expect((await queued).chatId).toBe("chat-b");
    releaseTurn(getActiveTurn()!);
    expect((await steal).chatId).toBe("chat-c");
    releaseTurn(getActiveTurn()!);
    expect(isTurnGateBusy()).toBe(false);
  });

  it("treats a stale lease as not busy and absent from status", async () => {
    const first = await acquireTurn("chat-a");
    ageActiveLease(20 * 60_000);

    expect(isTurnGateBusy()).toBe(false);
    // Only a stale lease remains — the gate is effectively idle for the user
    // (no active chat to wait on; reap/steal will clear it momentarily).
    expect(turnGateStatus("chat-a")).toBeNull();

    // A stale lease does not grant false "busy" to background checks, and a
    // new acquirer takes the slot directly (steal) instead of queueing.
    const second = await acquireTurn("chat-b");
    expect(getActiveTurn()?.chatId).toBe("chat-b");
    expect(first.leaseId).not.toBe(second.leaseId);
    releaseTurn(second);
    expect(isTurnGateBusy()).toBe(false);
  });
});
