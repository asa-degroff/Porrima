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

  const [memoryTools, notebookStorage, memoryStorage, chatStorage] = await Promise.all([
    import("../services/memory-tools.js"),
    import("../services/notebook-storage.js"),
    import("../services/memory-storage.js"),
    import("../services/chat-storage.js"),
  ]);
  return { memoryTools, notebookStorage, memoryStorage, chatStorage };
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

describe("memory block lifecycle tools", () => {
  function fixtureBlock(id: string, overrides: Record<string, unknown> = {}) {
    const now = new Date().toISOString();
    return {
      id,
      name: "Fixture Block",
      description: "A fixture block",
      content: "Original content.",
      scope: "global" as const,
      projectId: "",
      createdAt: now,
      updatedAt: now,
      updatedBy: "agent" as const,
      supersededBy: undefined,
      supersedes: undefined,
      ...overrides,
    };
  }

  it("renames a block via update_memory_block and rejects empty names", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-block-rename-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      memoryStorage.createMemoryBlock(fixtureBlock("blk-rename-1", { name: "Old Name" }));

      const result = await memoryTools.executeMemoryTool({
        name: "update_memory_block",
        arguments: { block_id: "blk-rename-1", name: "New Name" },
      } as any, "chat-1");

      expect(result.isError).toBe(false);
      expect(result.content).toContain("name: Old Name → New Name");
      expect(memoryStorage.getMemoryBlock("blk-rename-1")?.name).toBe("New Name");

      const empty = await memoryTools.executeMemoryTool({
        name: "update_memory_block",
        arguments: { block_id: "blk-rename-1", name: "   " },
      } as any, "chat-1");
      expect(empty.isError).toBe(true);
      expect(empty.content).toContain("cannot be empty");
      expect(memoryStorage.getMemoryBlock("blk-rename-1")?.name).toBe("New Name");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("read_memory_block include_history surfaces prior content snapshots newest first", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-block-history-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      memoryStorage.createMemoryBlock(fixtureBlock("blk-hist-tool", { content: "VERSION_ONE content" }));

      await memoryTools.executeMemoryTool({
        name: "update_memory_block",
        arguments: { block_id: "blk-hist-tool", content: "VERSION_TWO content" },
      } as any, "chat-1");
      await memoryTools.executeMemoryTool({
        name: "update_memory_block",
        arguments: { block_id: "blk-hist-tool", content: "VERSION_THREE content" },
      } as any, "chat-1");

      const plain = await memoryTools.executeMemoryTool({
        name: "read_memory_block",
        arguments: { block_id: "blk-hist-tool" },
      } as any, "chat-1");
      expect(plain.content).not.toContain("Revision History");

      const withHistory = await memoryTools.executeMemoryTool({
        name: "read_memory_block",
        arguments: { block_id: "blk-hist-tool", include_history: true },
      } as any, "chat-1", { maxResultChars: 24000 });

      expect(withHistory.isError).toBe(false);
      expect(withHistory.content).toContain("VERSION_THREE content");
      expect(withHistory.content).toContain("Revision History (2 previous version(s), newest first)");
      expect(withHistory.content).toContain("VERSION_TWO content");
      expect(withHistory.content).toContain("VERSION_ONE content");
      // Newest prior snapshot renders before the oldest one.
      expect(withHistory.content.indexOf("VERSION_TWO content"))
        .toBeLessThan(withHistory.content.indexOf("VERSION_ONE content"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("read_memory_block include_history reports blocks with no prior versions", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-block-history-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      memoryStorage.createMemoryBlock(fixtureBlock("blk-no-hist"));

      const result = await memoryTools.executeMemoryTool({
        name: "read_memory_block",
        arguments: { block_id: "blk-no-hist", include_history: true },
      } as any, "chat-1");

      expect(result.isError).toBe(false);
      expect(result.content).toContain("No previous versions.");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("create_memory_block supersedes_block_id links lineage and inherits scope/project", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-block-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      memoryStorage.createMemoryBlock(fixtureBlock("blk-old-1", {
        scope: "project",
        projectId: "proj-42",
      }));

      const result = await memoryTools.executeMemoryTool({
        name: "create_memory_block",
        arguments: {
          name: "Fixture Block v2",
          description: "Replacement version",
          content: "Rewritten content.",
          supersedes_block_id: "blk-old-1",
        },
      } as any, "chat-1");

      expect(result.isError).toBe(false);
      const match = result.content.match(/Superseded \[blk-old-1\] with \[([^\]]+)\]/);
      expect(match?.[1]).toBeTruthy();
      const newId = match![1];

      const oldBlock = memoryStorage.getMemoryBlock("blk-old-1");
      expect(oldBlock?.supersededBy).toBe(newId);
      const newBlock = memoryStorage.getMemoryBlock(newId);
      expect(newBlock?.supersedes).toBe("blk-old-1");
      expect(newBlock?.scope).toBe("project");
      expect(newBlock?.projectId).toBe("proj-42");
      // Only the current version appears in listings.
      expect(memoryStorage.listMemoryBlocks({ includeInternal: true }).map((b) => b.id)).toEqual([newId]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects supersedes_block_id for missing or already-superseded targets", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-block-supersede-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      memoryStorage.createMemoryBlock(fixtureBlock("blk-chain-1"));

      const missing = await memoryTools.executeMemoryTool({
        name: "create_memory_block",
        arguments: {
          name: "Nope",
          description: "Missing target",
          content: "content",
          supersedes_block_id: "blk-does-not-exist",
        },
      } as any, "chat-1");
      expect(missing.isError).toBe(true);
      expect(missing.content).toContain("block not found: blk-does-not-exist");

      const first = await memoryTools.executeMemoryTool({
        name: "create_memory_block",
        arguments: {
          name: "Chain v2",
          description: "First replacement",
          content: "content v2",
          supersedes_block_id: "blk-chain-1",
        },
      } as any, "chat-1");
      expect(first.isError).toBe(false);
      const midId = first.content.match(/Superseded \[blk-chain-1\] with \[([^\]]+)\]/)![1];

      const second = await memoryTools.executeMemoryTool({
        name: "create_memory_block",
        arguments: {
          name: "Chain v3",
          description: "Stale-target replacement",
          content: "content v3",
          supersedes_block_id: "blk-chain-1",
        },
      } as any, "chat-1");
      expect(second.isError).toBe(true);
      expect(second.content).toContain("already superseded by");
      expect(second.content).toContain(midId);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("list_memory_blocks filters by substring query", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-block-list-query-"));
    try {
      const { memoryTools, memoryStorage } = await loadMemoryTools(homeDir);
      memoryStorage.createMemoryBlock(fixtureBlock("blk-q-1", {
        name: "Tech Stack",
        description: "Languages and frameworks",
        content: "TypeScript, React, Express.",
      }));
      memoryStorage.createMemoryBlock(fixtureBlock("blk-q-2", {
        name: "Garden Notes",
        description: "Seasonal planting log",
        content: "Tomatoes went in late this year.",
      }));

      const byName = await memoryTools.executeMemoryTool({
        name: "list_memory_blocks",
        arguments: { query: "garden" },
      } as any, "chat-1");
      expect(byName.content).toContain("[blk-q-2]");
      expect(byName.content).not.toContain("[blk-q-1]");

      const byContent = await memoryTools.executeMemoryTool({
        name: "list_memory_blocks",
        arguments: { query: "typescript" },
      } as any, "chat-1");
      expect(byContent.content).toContain("[blk-q-1]");
      expect(byContent.content).not.toContain("[blk-q-2]");

      const noMatch = await memoryTools.executeMemoryTool({
        name: "list_memory_blocks",
        arguments: { query: "zzz-no-such-term" },
      } as any, "chat-1");
      expect(noMatch.content).toContain("No memory blocks found");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

function makeArchiveFixture(overrides: {
  id?: string;
  chatId?: string;
  messages: any[];
}) {
  const messages = overrides.messages;
  return {
    id: overrides.id ?? "archive:testchat:001",
    chatId: overrides.chatId ?? "test-chat",
    sequenceNum: 1,
    messages,
    indexEntry: "test archive",
    messageCount: messages.length,
    estimatedTokens: 100,
    createdAt: "2026-08-23T00:00:00.000Z",
  };
}

describe("read_archived_context", () => {
  it("omits verbose thinking by default but keeps the conclusion within budget", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-archive-read-"));
    try {
      const { memoryTools, chatStorage } = await loadMemoryTools(homeDir);
      const hugeThinking = "THINKING_MARKER filler reasoning ".repeat(4000); // ~130KB
      chatStorage.saveArchives([makeArchiveFixture({
        messages: [
          { role: "user", content: "What did we decide about the rollout?" },
          {
            role: "assistant",
            thinking: hugeThinking,
            content: "CONCLUSION_MARKER Ship behind the flag and monitor error rates before widening.",
          },
        ],
      })]);

      const budget = 6000;
      const result = await memoryTools.executeMemoryTool({
        name: "read_archived_context",
        arguments: { archive_id: "archive:testchat:001" },
      } as any, "test-chat", { maxResultChars: budget });

      expect(result.isError).toBe(false);
      expect(result.content.length).toBeLessThanOrEqual(budget);
      expect(result.content).toContain("CONCLUSION_MARKER");
      expect(result.content).not.toContain("THINKING_MARKER");
      expect(result.content).toContain("reasoning traces omitted");
      expect(result.content).toContain("include_thinking=true");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("includes thinking when include_thinking=true", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-archive-read-"));
    try {
      const { memoryTools, chatStorage } = await loadMemoryTools(homeDir);
      chatStorage.saveArchives([makeArchiveFixture({
        messages: [
          { role: "user", content: "Trace the bug." },
          {
            role: "assistant",
            thinking: "short reasoning about the null deref",
            content: "It was a null deref in the parser.",
          },
        ],
      })]);

      const result = await memoryTools.executeMemoryTool({
        name: "read_archived_context",
        arguments: { archive_id: "archive:testchat:001", include_thinking: true },
      } as any, "test-chat", { maxResultChars: 20000 });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("short reasoning about the null deref");
      expect(result.content).not.toContain("reasoning traces omitted");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("pages large archives with offset/limit", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-archive-read-"));
    try {
      const { memoryTools, chatStorage } = await loadMemoryTools(homeDir);
      const messages = [];
      for (let i = 0; i < 5; i++) messages.push({ role: "user", content: `msg-${i}` });
      chatStorage.saveArchives([makeArchiveFixture({ messages })]);

      const result = await memoryTools.executeMemoryTool({
        name: "read_archived_context",
        arguments: { archive_id: "archive:testchat:001", offset: 1, limit: 2 },
      } as any, "test-chat", { maxResultChars: 20000 });

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Showing messages 2-3 of 5");
      expect(result.content).toContain("msg-1");
      expect(result.content).toContain("msg-2");
      expect(result.content).not.toContain("msg-0");
      expect(result.content).not.toContain("msg-3");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("keeps conclusions within a small budget even when tool results and thinking are huge", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-archive-read-"));
    try {
      const { memoryTools, chatStorage } = await loadMemoryTools(homeDir);
      const hugeResult = "TOOLRESULT_MARKER dense payload ".repeat(2000); // ~64KB
      const hugeThinking = "THINKING_MARKER filler ".repeat(1200); // ~27KB
      chatStorage.saveArchives([makeArchiveFixture({
        messages: [
          { role: "user", content: "Investigate the failure." },
          {
            role: "assistant",
            thinking: hugeThinking,
            toolCalls: [{ id: "t1", name: "bash", arguments: { command: "collect-logs" } }],
            toolResults: [{ toolCallId: "t1", toolName: "bash", content: hugeResult, isError: false }],
          },
          { role: "user", content: "And the fix?" },
          {
            role: "assistant",
            thinking: hugeThinking,
            content: "FINAL_CONCLUSION Restart the worker after clearing the poisoned cache entry.",
          },
        ],
      })]);

      const budget = 6000;
      const result = await memoryTools.executeMemoryTool({
        name: "read_archived_context",
        arguments: { archive_id: "archive:testchat:001" },
      } as any, "test-chat", { maxResultChars: budget });

      expect(result.isError).toBe(false);
      expect(result.content.length).toBeLessThanOrEqual(budget);
      expect(result.content).toContain("FINAL_CONCLUSION");
      // Bulky low-value content was trimmed away to protect the conclusion.
      expect(result.content).not.toContain("TOOLRESULT_MARKER dense payload ".repeat(100));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("stays within a tight budget across many content-heavy messages", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-archive-read-"));
    try {
      const { memoryTools, chatStorage } = await loadMemoryTools(homeDir);
      const messages = [];
      for (let i = 0; i < 12; i++) {
        messages.push({ role: "user", content: `Question ${i}: ${"context ".repeat(400)}` });
        messages.push({
          role: "assistant",
          thinking: "reasoning ".repeat(300),
          content: `Answer ${i}: ${i === 11 ? "LAST_ANSWER_MARKER the cache was poisoned." : "analysis ".repeat(300)}`,
        });
      }
      chatStorage.saveArchives([makeArchiveFixture({ messages })]);

      const budget = 8000;
      const result = await memoryTools.executeMemoryTool({
        name: "read_archived_context",
        arguments: { archive_id: "archive:testchat:001" },
      } as any, "test-chat", { maxResultChars: budget });

      expect(result.isError).toBe(false);
      expect(result.content.length).toBeLessThanOrEqual(budget);
      // The final conclusion survives the budget squeeze.
      expect(result.content).toContain("LAST_ANSWER_MARKER");
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
