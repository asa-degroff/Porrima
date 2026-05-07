import { mkdtempSync, rmSync } from "fs";
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
    const homeDir = mkdtempSync(join(tmpdir(), "quje-memory-storage-"));
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
});
