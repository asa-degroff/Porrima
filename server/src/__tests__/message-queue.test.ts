import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Loads message-queue.ts against an isolated home dir so the queue files
 * live in a temp .porrima/queue — same pattern as chat-storage.test.ts.
 * Fresh import per test gives a clean in-memory queue map.
 */
async function loadQueue(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/message-queue.js");
}

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "queue-test-"));
}

const queueDirOf = (homeDir: string) => join(homeDir, ".porrima", "queue");

let home: string | undefined;

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
  if (home) {
    rmSync(home, { recursive: true, force: true });
    home = undefined;
  }
});

describe("message queue — listVisibleQueueCounts", () => {
  it("returns an empty map when there are no queues", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    expect(await mq.listVisibleQueueCounts()).toEqual(new Map());
  });

  it("counts visible in-memory messages per chat", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("a", "first");
    await mq.enqueue("a", "second");
    await mq.enqueue("b", "solo");

    const counts = await mq.listVisibleQueueCounts();
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
    expect(counts.size).toBe(2);
  });

  it("does not count hidden entries", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("a", "visible");
    await mq.enqueue("a", "repair", undefined, { hidden: true, kind: "artifact_repair" });

    let counts = await mq.listVisibleQueueCounts();
    expect(counts.get("a")).toBe(1);

    // A chat whose queue is hidden-only gets no entry at all
    await mq.enqueue("h", "repair-only", undefined, { hidden: true, kind: "artifact_repair" });
    counts = await mq.listVisibleQueueCounts();
    expect(counts.has("h")).toBe(false);
  });

  it("reads disk queues for chats not yet loaded into memory", async () => {
    home = makeHome();
    const mq = await loadQueue(home);

    // Simulate queues that survived a restart: files on disk, empty memory
    const dir = queueDirOf(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "persisted.json"),
      JSON.stringify([
        { id: "1", message: "old", timestamp: 1 },
        { id: "2", message: "older", timestamp: 2 },
      ])
    );
    writeFileSync(
      join(dir, "hidden-only.json"),
      JSON.stringify([{ id: "3", message: "repair", timestamp: 3, hidden: true, kind: "artifact_repair" }])
    );
    writeFileSync(join(dir, "corrupt.json"), "{not json");
    writeFileSync(join(dir, "not-a-queue.txt"), "ignore me");

    const counts = await mq.listVisibleQueueCounts();
    expect(counts.get("persisted")).toBe(2);
    expect(counts.has("hidden-only")).toBe(false);
    expect(counts.has("corrupt")).toBe(false);
    expect(counts.size).toBe(1);
  });

  it("prefers in-memory state over stale disk files", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("a", "truth"); // memory=1, disk=1

    // Disk drifts (a failed persist would leave it ahead of memory)
    writeFileSync(
      queueDirOf(home) + "/a.json",
      JSON.stringify([
        { id: "1", message: "truth", timestamp: 1 },
        { id: "2", message: "stale", timestamp: 2 },
        { id: "3", message: "stale", timestamp: 3 },
      ])
    );

    const counts = await mq.listVisibleQueueCounts();
    expect(counts.get("a")).toBe(1);
  });

  it("drops the entry once the queue drains", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("a", "one");
    await mq.enqueue("a", "two");
    expect((await mq.listVisibleQueueCounts()).get("a")).toBe(2);

    await mq.drainOne("a");
    expect((await mq.listVisibleQueueCounts()).get("a")).toBe(1);

    await mq.drainOne("a");
    const counts = await mq.listVisibleQueueCounts();
    expect(counts.has("a")).toBe(false);
  });
});

describe("message queue — listActiveQueueChats", () => {
  it("counts chats with fresh visible queued messages", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("a", "just sent");
    await mq.enqueue("b", "also fresh");

    const active = await mq.listActiveQueueChats();
    expect(active.sort()).toEqual(["a", "b"]);
  });

  it("ignores hidden-only queues", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("h", "repair", undefined, { hidden: true, kind: "artifact_repair" });

    expect(await mq.listActiveQueueChats()).toEqual([]);
  });

  it("does not count stranded (stale) queued messages", async () => {
    home = makeHome();
    const mq = await loadQueue(home);

    // Simulate queues that survived a restart: one abandoned, one recent
    const dir = queueDirOf(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stranded.json"),
      JSON.stringify([{ id: "1", message: "abandoned", timestamp: 1 }]),
    );
    writeFileSync(
      join(dir, "fresh.json"),
      JSON.stringify([{ id: "2", message: "recent", timestamp: Date.now() }]),
    );

    expect(await mq.listActiveQueueChats()).toEqual(["fresh"]);

    // A zero window makes even a just-now message count as stranded
    expect(await mq.listActiveQueueChats(0)).toEqual([]);
  });

  it("uses the newest visible item's timestamp for freshness", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    const dir = queueDirOf(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mixed.json"),
      JSON.stringify([
        { id: "1", message: "old visible", timestamp: 1 },
        { id: "2", message: "repair", timestamp: Date.now(), hidden: true, kind: "artifact_repair" },
      ]),
    );

    // Newest item is hidden → falls back to the old visible one → stranded
    expect(await mq.listActiveQueueChats()).toEqual([]);
  });

  it("suppresses stale disk files once the in-memory queue drains", async () => {
    home = makeHome();
    const mq = await loadQueue(home);
    await mq.enqueue("a", "one");
    expect(await mq.listActiveQueueChats()).toEqual(["a"]);

    // Simulate a failed unlink leaving the file behind after a full drain
    await mq.drainOne("a");
    writeFileSync(
      join(queueDirOf(home), "a.json"),
      JSON.stringify([{ id: "1", message: "stale file", timestamp: Date.now() }]),
    );

    expect(await mq.listActiveQueueChats()).toEqual([]);
  });
});
