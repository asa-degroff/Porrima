import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadMemoryTools(homeDir: string) {
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  const [memoryTools, notebookStorage, memoryStorage] = await Promise.all([
    import("../services/memory-tools.js"),
    import("../services/notebook-storage.js"),
    import("../services/memory-storage.js"),
  ]);
  return { memoryTools, notebookStorage, memoryStorage };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("memory tools", () => {
  it("marks notebook-cycle created blocks with notebook blockType", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-tools-"));
    try {
      const { memoryTools, notebookStorage, memoryStorage } = await loadMemoryTools(homeDir);

      const result = await memoryTools.executeMemoryTool({
        name: "create_memory_block",
        arguments: {
          name: "Notebook Cycle Block",
          description: "Created from the notebook cycle",
          content: "Long-form notebook content.",
          scope: "global",
        },
      } as any, notebookStorage.NOTEBOOK_CYCLE_CHAT_ID);

      expect(result.isError).toBe(false);
      const match = result.content.match(/\[(blk-notebook-[^\]]+)\]/);
      expect(match?.[1]).toBeTruthy();

      const block = memoryStorage.getMemoryBlock(match![1]);
      expect(block?.blockType).toBe("notebook");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("orders agent notebook entries by creation time rather than update time", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-notebook-order-"));
    try {
      const { notebookStorage, memoryStorage } = await loadMemoryTools(homeDir);

      memoryStorage.createMemoryBlock({
        id: "blk-notebook-older-edited",
        name: "Older edited notebook",
        description: "Older entry edited most recently",
        content: "Older notebook content.",
        scope: "global",
        projectId: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        updatedBy: "agent",
        blockType: "notebook",
      });
      memoryStorage.createMemoryBlock({
        id: "blk-notebook-newer",
        name: "Newer notebook",
        description: "Newer entry",
        content: "Newer notebook content.",
        scope: "global",
        projectId: "",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
        updatedBy: "agent",
        blockType: "notebook",
      });

      const index = await notebookStorage.listNotebookEntries("agent");
      expect(index.entries.map((entry) => entry.id)).toEqual([
        "blk-notebook-newer",
        "blk-notebook-older-edited",
      ]);
      expect(index.lastActivityDate).toBe("2026-02-01T00:00:00.000Z");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("suggests matching blocks when update_memory_block receives a missing id", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-tools-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      const now = new Date().toISOString();

      memoryStorage.createMemoryBlock({
        id: "blk-real-website",
        name: "porrima.cc Website",
        description: "porrima.cc website — Astro, magenta theme, percolation shader",
        content: "Header uses an inverted corner perspective SVG.",
        scope: "project",
        projectId: "project-1",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      const result = await memoryTools.executeMemoryTool({
        name: "update_memory_block",
        arguments: {
          block_id: "blk-missing",
          description: "porrima website inverted corner header",
        },
      } as any, "chat-1");

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Block not found: blk-missing");
      expect(result.content).toContain("Similar active blocks:");
      expect(result.content).toContain("[blk-real-website] porrima.cc Website");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
