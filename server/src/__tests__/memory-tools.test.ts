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

// --- save_memory supersession test scaffolding ---

const VEC_DIM = 1024;

function vec(components: number[]): number[] {
  const v = new Array(VEC_DIM).fill(0);
  components.forEach((x, i) => { v[i] = x; });
  return v;
}

// Shared vector table — the embed mock reads from this per call, so each test
// can register vectors for its texts without re-mocking the module.
const testVectors: Record<string, number[]> = {};

async function loadMemoryToolsWithEmbedMock(homeDir: string) {
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });
  vi.doMock("../services/embeddings.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../services/embeddings.js")>();
    return {
      ...actual,
      embed: vi.fn(async (text: string) => {
        const v = testVectors[text];
        if (!v) throw new Error(`No test vector registered for: "${text}"`);
        return v;
      }),
    };
  });

  const [memoryTools, memoryStorage, memoryExtraction, memoryContext] = await Promise.all([
    import("../services/memory-tools.js"),
    import("../services/memory-storage.js"),
    import("../services/memory-extraction.js"),
    import("../services/memory-context.js"),
  ]);
  return { memoryTools, memoryStorage, memoryExtraction, memoryContext };
}

async function addFixtureMemory(
  memoryStorage: Awaited<ReturnType<typeof loadMemoryToolsWithEmbedMock>>["memoryStorage"],
  id: string,
  text: string,
  embedding: number[],
  importance = 5,
) {
  const now = new Date().toISOString();
  await memoryStorage.addMemory({
    id,
    text,
    category: "fact",
    importance,
    embedding,
    createdAt: now,
    lastAccessed: now,
    accessCount: 0,
    sourceChatId: "",
    sourceType: "explicit",
    sourceId: "",
    subject: "",
  });
}

afterEach(() => {
  vi.doUnmock("os");
  vi.doUnmock("../services/embeddings.js");
  vi.resetModules();
  for (const key of Object.keys(testVectors)) delete testVectors[key];
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

  it("rejects update_memory_block content over the limit without mutating", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-memory-tools-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      const now = new Date().toISOString();

      memoryStorage.createMemoryBlock({
        id: "blk-limit-test",
        name: "Limit Test",
        description: "Overflow rejection behavior",
        content: "Original content.",
        scope: "global",
        projectId: "",
        createdAt: now,
        updatedAt: now,
        updatedBy: "agent",
        supersededBy: undefined,
        supersedes: undefined,
      });

      const result = await memoryTools.executeMemoryTool({
        name: "update_memory_block",
        arguments: { block_id: "blk-limit-test", content: "x".repeat(7000) },
      } as any, "chat-1");

      // Rejected with the exact overage — no truncation, no superseding block.
      expect(result.isError).toBe(true);
      expect(result.content).toContain("character limit");
      expect(result.content).toContain("1000 over");
      expect(memoryStorage.getMemoryBlock("blk-limit-test")?.content).toBe("Original content.");
      expect(memoryStorage.listMemoryBlocks({ includeInternal: true }).map((b) => b.id)).toEqual(["blk-limit-test"]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("save_memory supersession", () => {
  const OLD_TEXT = "The main llama.cpp server runs on port 32100 with flash attention and tensor split";
  const NEW_TEXT = "The main llama.cpp server runs on port 8080 with flash attention and tensor split";
  const MID_TEXT = "The extraction server runs on port 32101 with a quantized 9B model";
  // ~6% token overlap with OLD_TEXT — high enough for isNearDuplicate (≥0.82)
  const DUP_TEXT = `${OLD_TEXT} mode`;

  // L2 distance OLD→NEW is sqrt(0.02² + 0.02²) ≈ 0.028 → similarity 1 - d ≈ 0.972 (≥ 0.95 threshold)
  const V_OLD = vec([1, 0, 0, 0]);
  const V_NEW = vec([1.02, 0.02, 0, 0]);
  // Orthogonal — similarity far below threshold against either of the above
  const V_MID = vec([0, 1, 0, 0]);

  function saveMemoryArgs(text: string, extra: Record<string, unknown> = {}, importance = 5) {
    return { text, category: "fact", importance, ...extra };
  }

  it("supersedes an existing memory when supersedeMemoryId is provided", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryToolsWithEmbedMock(homeDir);
      testVectors[OLD_TEXT] = V_OLD;
      testVectors[NEW_TEXT] = V_NEW;
      await addFixtureMemory(memoryStorage, "mem-old-1", OLD_TEXT, V_OLD);

      const result = await memoryTools.executeMemoryTool({
        name: "save_memory",
        arguments: saveMemoryArgs(NEW_TEXT, { supersedeMemoryId: "mem-old-1" }, 6),
      } as any, "");

      expect(result.isError).toBe(false);
      const match = result.content.match(/Superseded \[mem-old-1\] with \[([^\]]+)\]/);
      expect(match?.[1]).toBeTruthy();
      const newId = match![1];

      const oldMemory = await memoryStorage.getMemoryById("mem-old-1");
      expect(oldMemory?.supersededBy).toBe(newId);
      const newMemory = await memoryStorage.getMemoryById(newId);
      expect(newMemory?.text).toBe(NEW_TEXT);
      expect(newMemory?.supersedes).toBe("mem-old-1");
      expect(newMemory?.supersededBy).toBeUndefined();
      expect(newMemory?.importance).toBe(6);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects supersedeMemoryId when the target does not exist", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryToolsWithEmbedMock(homeDir);

      const result = await memoryTools.executeMemoryTool({
        name: "save_memory",
        arguments: saveMemoryArgs(NEW_TEXT, { supersedeMemoryId: "mem-nope" }),
      } as any, "");

      expect(result.isError).toBe(true);
      expect(result.content).toContain("memory not found: mem-nope");
      expect(await memoryStorage.getMemoryCount()).toBe(0);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects supersedeMemoryId when the target is already superseded, pointing at the current version", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryToolsWithEmbedMock(homeDir);
      testVectors[OLD_TEXT] = V_OLD;
      testVectors[MID_TEXT] = V_MID;
      testVectors[NEW_TEXT] = V_NEW;
      await addFixtureMemory(memoryStorage, "mem-chain-1", OLD_TEXT, V_OLD);

      const first = await memoryTools.executeMemoryTool({
        name: "save_memory",
        arguments: saveMemoryArgs(MID_TEXT, { supersedeMemoryId: "mem-chain-1" }),
      } as any, "");
      expect(first.isError).toBe(false);
      const midId = first.content.match(/Superseded \[mem-chain-1\] with \[([^\]]+)\]/)![1];

      const second = await memoryTools.executeMemoryTool({
        name: "save_memory",
        arguments: saveMemoryArgs(NEW_TEXT, { supersedeMemoryId: "mem-chain-1" }),
      } as any, "");

      expect(second.isError).toBe(true);
      expect(second.content).toContain("already superseded by");
      expect(second.content).toContain(midId);
      expect(await memoryStorage.getMemoryCount()).toBe(2);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("reports near-duplicates loudly with the target ID and a supersede hint", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryToolsWithEmbedMock(homeDir);
      testVectors[OLD_TEXT] = V_OLD;
      testVectors[DUP_TEXT] = V_NEW;
      await addFixtureMemory(memoryStorage, "mem-dup-1", OLD_TEXT, V_OLD, 5);

      const result = await memoryTools.executeMemoryTool({
        name: "save_memory",
        arguments: saveMemoryArgs(DUP_TEXT, {}, 9),
      } as any, "");

      expect(result.isError).toBe(false);
      expect(result.content).toContain("near-duplicate of existing memory [mem-dup-1]");
      expect(result.content).toContain("supersedeMemoryId: mem-dup-1");
      // No new row; the existing memory's importance was bumped.
      expect(await memoryStorage.getMemoryCount()).toBe(1);
      const after = await memoryStorage.getMemoryById("mem-dup-1");
      expect(after?.importance).toBe(9);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("never treats a superseded (tombstoned) memory as a duplicate candidate", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryToolsWithEmbedMock(homeDir);
      testVectors[OLD_TEXT] = V_OLD;
      testVectors[NEW_TEXT] = V_MID;
      testVectors[DUP_TEXT] = V_NEW;
      await addFixtureMemory(memoryStorage, "mem-tomb-1", OLD_TEXT, V_OLD);
      await addFixtureMemory(memoryStorage, "mem-tomb-2", NEW_TEXT, V_MID);
      const linked = await memoryStorage.createSupersessionLink("mem-tomb-2", "mem-tomb-1", 1.0);
      expect(linked).toBe(true);

      // DUP_TEXT is a near-duplicate of the now-tombstoned mem-tomb-1.
      // Without the tombstone filter it would be skipped and would bump the
      // dead row's importance; with it, a live memory is saved.
      const result = await memoryTools.executeMemoryTool({
        name: "save_memory",
        arguments: saveMemoryArgs(DUP_TEXT),
      } as any, "");

      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/^Saved memory \[/);
      expect(await memoryStorage.getMemoryCount()).toBe(3);
      const tomb = await memoryStorage.getMemoryById("mem-tomb-1");
      expect(tomb?.importance).toBe(5);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("renders memory IDs in context memory lines so they are addressable", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-supersede-"));
    try {
      const { memoryContext } = await loadMemoryToolsWithEmbedMock(homeDir);
      const line = memoryContext.formatRetrievedMemoryForContext({
        memory: {
          id: "mem-fmt-1",
          text: "Asa prefers TypeScript",
          category: "preference",
          importance: 7,
          createdAt: "2026-08-14T12:00:00.000Z",
        },
        score: 0.91,
      } as any, undefined);
      expect(line).toBe("- [mem-fmt-1] Asa prefers TypeScript [preference, importance: 7/10, saved: 2026-08-14]");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
