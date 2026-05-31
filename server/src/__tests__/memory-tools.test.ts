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
