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
});
