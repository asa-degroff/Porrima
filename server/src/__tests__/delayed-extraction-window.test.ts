import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";

afterEach(() => {
  vi.doUnmock("os");
  vi.doUnmock("../services/memory-storage.js");
  vi.resetModules();
});

async function loadContextBuilder(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  vi.doMock("../services/memory-storage.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/memory-storage.js")>();
    return { ...actual, getMemoriesByChatId: vi.fn(async () => []) };
  });
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/memory-extraction.js");
}

function userMsg(content: string, timestamp: number): ChatMessage {
  return { role: "user", content, timestamp };
}

function makeChat(messageCount: number, watermark: number): Chat {
  const messages: ChatMessage[] = Array.from({ length: messageCount }, (_, i) =>
    userMsg(`message ${i}`, i + 1)
  );
  return {
    id: "window-chat",
    title: "Window Test",
    type: "agent",
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages,
    createdAt: "2026-08-28T00:00:00.000Z",
    lastModified: "2026-08-28T00:00:00.000Z",
    ...(watermark >= 0 ? { lastDelayedExtractionMessageIndex: watermark } : {}),
  };
}

describe("buildDelayedExtractionContext window cap", () => {
  it("takes the OLDEST cap-many messages when the window is over cap (FIFO)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-window-"));
    try {
      const { buildDelayedExtractionContext } = await loadContextBuilder(homeDir);
      const ctx = await buildDelayedExtractionContext(makeChat(80, -1), 50);

      expect(ctx.hasNewContent).toBe(true);
      expect(ctx.truncated).toBe(true);
      expect(ctx.windowSize).toBe(80);
      expect(ctx.messages).toHaveLength(50);
      expect(ctx.messages[0].index).toBe(0);
      expect(ctx.messages[49].index).toBe(49);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("drains the remainder on the next run (watermark at last processed index)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-window-"));
    try {
      const { buildDelayedExtractionContext } = await loadContextBuilder(homeDir);
      // Run 1 processed indices 0-49 and stopped the watermark there.
      const ctx = await buildDelayedExtractionContext(makeChat(80, 49), 50);

      expect(ctx.truncated).toBe(false);
      expect(ctx.windowSize).toBe(30);
      expect(ctx.messages).toHaveLength(30);
      expect(ctx.messages[0].index).toBe(50);
      expect(ctx.messages[29].index).toBe(79);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("does not truncate when the window fits under the cap", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-window-"));
    try {
      const { buildDelayedExtractionContext } = await loadContextBuilder(homeDir);
      const ctx = await buildDelayedExtractionContext(makeChat(40, -1), 50);

      expect(ctx.truncated).toBe(false);
      expect(ctx.windowSize).toBe(40);
      expect(ctx.messages).toHaveLength(40);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("skips non-substantive rows in index space while slicing", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-window-"));
    try {
      const { buildDelayedExtractionContext } = await loadContextBuilder(homeDir);
      const chat = makeChat(60, -1);
      chat.messages[10] = { ...userMsg("synthesis trigger", 11), _isSynthesisMessage: true };
      chat.messages[55] = { ...userMsg("wake trigger", 56), _isAutomationMessage: true };

      const ctx = await buildDelayedExtractionContext(chat, 50);

      // 58 substantive of 60 rows; oldest-first slice of 50 excludes indices 50-57
      // (and the two non-substantive rows wherever they fall).
      expect(ctx.truncated).toBe(true);
      expect(ctx.windowSize).toBe(58);
      expect(ctx.messages).toHaveLength(50);
      expect(ctx.messages[0].index).toBe(0);
      const slicedIndexes = ctx.messages.map((m) => m.index);
      expect(slicedIndexes).not.toContain(10);
      expect(slicedIndexes).not.toContain(55);
      // Oldest-first: the slice ends before the newest substantive rows
      expect(Math.max(...slicedIndexes)).toBeLessThan(58);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports no new content when only non-substantive rows are past the watermark", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-delayed-window-"));
    try {
      const { buildDelayedExtractionContext } = await loadContextBuilder(homeDir);
      const chat = makeChat(10, 8);
      chat.messages[9] = { ...userMsg("synthesis trigger", 10), _isSynthesisMessage: true };

      const ctx = await buildDelayedExtractionContext(chat, 50);

      expect(ctx.hasNewContent).toBe(false);
      expect(ctx.truncated).toBe(false);
      expect(ctx.messages).toHaveLength(0);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
