import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.doUnmock("os");
  vi.doUnmock("../services/memory-extraction.js");
  vi.doUnmock("../services/memory-storage.js");
  vi.doUnmock("../services/system-chat.js");
  vi.doUnmock("../services/image-corpus.js");
  vi.doUnmock("../services/llama-router-client.js");
  vi.doUnmock("../services/automation-scheduler.js");
  vi.doUnmock("../services/cache-warm-queue.js");
  vi.resetModules();
  vi.clearAllMocks();
});

async function loadScheduler(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  vi.doMock("../services/memory-extraction.js", () => ({
    extractDelayedMemories: vi.fn(),
    hasActiveChats: vi.fn(() => false),
    isChatActive: vi.fn(() => false),
  }));
  vi.doMock("../services/memory-storage.js", () => ({
    getLastWakeCycleAt: vi.fn(() => null),
  }));
  vi.doMock("../services/system-chat.js", () => ({
    shouldRunSystemSynthesis: vi.fn(() => false),
    runSystemSynthesis: vi.fn(),
    isSynthesisActive: vi.fn(() => false),
    runWakeCycle: vi.fn(),
    isWakeCycleActive: vi.fn(() => false),
    SYSTEM_CHAT_ID: "system",
  }));
  vi.doMock("../services/image-corpus.js", () => ({
    enrichCorpusBatchDetailed: vi.fn(),
  }));
  vi.doMock("../services/llama-router-client.js", () => ({
    normalizeRouterModelId: vi.fn((id: string) => id),
  }));
  vi.doMock("../services/automation-scheduler.js", () => ({
    startAutomationScheduler: vi.fn(),
  }));
  vi.doMock("../services/cache-warm-queue.js", () => ({
    isCacheWarmOrLlamaRuntimeBusy: vi.fn(() => false),
  }));

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/scheduler.js");
}

function makeChat(id: string): Chat {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    id,
    title: `Sel ${id}`,
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages: [],
    createdAt: now,
    lastModified: now,
  };
}

describe("findChatsNeedingDelayedExtraction selection", () => {
  it("re-selects a drained-lagging chat (watermark < stored tail) even when no new activity", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-sel-"));
    try {
      const scheduler = await loadScheduler(homeDir);
      const storage = await import("../services/chat-storage.js");

      const idle = new Date("2026-08-20T00:00:00.000Z").toISOString();
      await storage.createChat(makeChat("draining"));
      await storage.createChat(makeChat("caught-up"));
      await storage.createChat(makeChat("fresh-activity"));
      await storage.createChat(makeChat("never-run"));
      await storage.createChat(makeChat("recent-activity"));

      const db = storage.getDb();
      // All candidate chats idle well past the 30-minute threshold.
      db.prepare("UPDATE chats SET lastModified = ? WHERE id IN (?, ?, ?, ?)")
        .run(idle, "draining", "caught-up", "fresh-activity", "never-run");

      // draining: a run completed after the last activity, but the watermark
      // lags the tail (over-cap window still has substantive rows pending).
      await storage.updateChatExtractionState("draining", "2026-08-21T00:00:00.000Z", 10, 20);
      // caught-up: watermark reached the tail — nothing pending.
      await storage.updateChatExtractionState("caught-up", "2026-08-21T00:00:00.000Z", 20, 20);
      // fresh-activity: ran a day after an even older run, then new activity
      // arrived (lastModified > lastDelayedExtractionAt).
      await storage.updateChatExtractionState("fresh-activity", "2026-08-21T00:00:00.000Z", 5, 5);
      db.prepare("UPDATE chats SET lastModified = ? WHERE id = ?")
        .run("2026-08-27T00:00:00.000Z", "fresh-activity");
      // never-run: no extraction state at all.
      // recent-activity: lagging watermark but activity within the idle
      // threshold (10 minutes ago) — must be excluded by the idle gate.
      await storage.updateChatExtractionState("recent-activity", "2026-08-28T00:00:00.000Z", 10, 20);
      db.prepare("UPDATE chats SET lastModified = ? WHERE id = ?")
        .run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), "recent-activity");

      const ids = await scheduler.findChatsNeedingDelayedExtraction(30 * 60 * 1000);

      expect(ids).toContain("draining");
      expect(ids).toContain("fresh-activity");
      expect(ids).toContain("never-run");
      expect(ids).not.toContain("caught-up");
      expect(ids).not.toContain("recent-activity");

      storage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("persists the tail through updateChatExtractionState", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-sel-"));
    try {
      vi.resetModules();
      vi.doMock("os", async (importOriginal) => {
        const actual = await importOriginal<typeof import("os")>();
        return { ...actual, homedir: () => homeDir };
      });
      mkdirSync(join(homeDir, ".porrima"), { recursive: true });
      const storage = await import("../services/chat-storage.js");

      await storage.createChat(makeChat("tail-chat"));
      await storage.updateChatExtractionState("tail-chat", "2026-08-28T12:00:00.000Z", 12, 47);

      const chat = await storage.getChat("tail-chat");
      expect(chat?.lastDelayedExtractionMessageIndex).toBe(12);
      expect(chat?.lastDelayedExtractionTailIndex).toBe(47);

      storage.closeChatDb();
    } finally {
      vi.doUnmock("os");
      vi.resetModules();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
