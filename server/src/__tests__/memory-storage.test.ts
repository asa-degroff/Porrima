import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMemoryStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  return import("../services/memory-storage.js");
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("memory block storage", () => {
  it("updates global blocks without binding a null projectId", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const { createMemoryBlock, getMemoryBlock, updateMemoryBlock } = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();

      createMemoryBlock({
        id: "blk-global-test",
        name: "Global Test",
        description: "A global block",
        content: "Before",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      expect(updateMemoryBlock("blk-global-test", { content: "After" })).toBe(true);

      const updated = getMemoryBlock("blk-global-test");
      expect(updated?.content).toBe("After");
      expect(updated?.projectId).toBe("");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("lists blocks by query tokens across punctuation and content", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const { createMemoryBlock, listMemoryBlocks } = await loadMemoryStorage(homeDir);
      const now = new Date().toISOString();

      createMemoryBlock({
        id: "blk-website-test",
        name: "porrima.cc Website",
        description: "Astro project documentation",
        content: "Header uses an inverted corner SVG.",
        scope: "project",
        projectId: "project-1",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      expect(listMemoryBlocks({ query: "porrima website" }).map((b) => b.id)).toContain("blk-website-test");
      expect(listMemoryBlocks({ query: "inverted corner" }).map((b) => b.id)).toContain("blk-website-test");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("renames stale memories.json when a newer memory database exists", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-storage-"));
    try {
      const storage = await loadMemoryStorage(homeDir);
      const now = new Date("2026-05-24T00:00:00.000Z").toISOString();
      await storage.addMemory({
        id: "mem-current",
        text: "Current memory in SQLite",
        category: "fact",
        importance: 3,
        embedding: new Array(storage.DEFAULT_VEC_DIMENSION).fill(0),
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
      });
      await storage.setLastSynthesis(now);
      storage.closeMemoryDb();

      const memoryDir = join(homeDir, ".porrima", "memory");
      const jsonPath = join(memoryDir, "memories.json");
      writeFileSync(jsonPath, JSON.stringify({
        memories: [],
        lastSynthesis: "2026-03-01T00:00:00.000Z",
      }));

      storage.getDb();

      expect(existsSync(jsonPath)).toBe(false);
      expect(readdirSync(memoryDir).some((file) => file.startsWith("memories.json.stale-"))).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
