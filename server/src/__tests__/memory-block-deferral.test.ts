import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../types.js";

function hashBlockSections(globalSection: string, projectSection: string): string {
  return createHash("sha1")
    .update(globalSection, "utf8")
    .update("\u0000", "utf8")
    .update(projectSection, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Storage level — real SQLite, tmpdir home
// ---------------------------------------------------------------------------

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

describe("chat_memory_block_state storage", () => {
  const mkHomeDir = () => mkdtempSync(join(tmpdir(), "porrima-mbs-"));

  afterEach(() => {
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("round-trips upsert/get, hashes both sections, and deletes", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertMemoryBlockState("chat-1", {
        globalSection: "\n\n## Memory Blocks\n### Global\nglobal content",
        projectSection: "\n\n## Project Memory Blocks\n### Project\nproject content",
        hasIndexedBlocks: true,
        globalBudget: 3000,
        projectBudget: 5000,
      });

      const row = mod.getMemoryBlockState("chat-1");
      expect(row).not.toBeNull();
      expect(row!.globalSection).toContain("global content");
      expect(row!.projectSection).toContain("project content");
      expect(row!.contentHash).toBe(
        hashBlockSections(row!.globalSection, row!.projectSection)
      );
      expect(row!.hasIndexedBlocks).toBe(true);
      expect(row!.globalBudget).toBe(3000);
      expect(row!.projectBudget).toBe(5000);
      expect(row!.updatedAt).toBeGreaterThan(0);

      expect(mod.getMemoryBlockState("chat-unknown")).toBeNull();

      mod.deleteMemoryBlockState("chat-1");
      expect(mod.getMemoryBlockState("chat-1")).toBeNull();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("upsert replaces in place — one row per chat, latest bytes win", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertMemoryBlockState("chat-1", {
        globalSection: "g1",
        projectSection: "p1",
        hasIndexedBlocks: true,
        globalBudget: 3000,
        projectBudget: 5000,
      });
      mod.upsertMemoryBlockState("chat-1", {
        globalSection: "g2",
        projectSection: "p2",
        hasIndexedBlocks: false,
        globalBudget: 4000,
        projectBudget: 6000,
      });

      const row = mod.getMemoryBlockState("chat-1");
      expect(row!.globalSection).toBe("g2");
      expect(row!.projectSection).toBe("p2");
      expect(row!.contentHash).toBe(hashBlockSections("g2", "p2"));
      expect(row!.hasIndexedBlocks).toBe(false);
      expect(row!.globalBudget).toBe(4000);
      expect(row!.projectBudget).toBe(6000);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Service level — mocked storage + mutable block fixture
// ---------------------------------------------------------------------------

interface TestBlock {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: "global" | "project";
  projectId: string | null;
  tokenEstimate: number;
  updatedAt: string;
}

interface BlockFixture {
  blocks: TestBlock[];
  budgets: { global: number; project: number };
  failBlocks: boolean;
}

interface BlockStateRow {
  globalSection: string;
  projectSection: string;
  contentHash: string;
  hasIndexedBlocks: boolean;
  globalBudget: number;
  projectBudget: number;
  updatedAt: number;
}

function block(overrides: Partial<TestBlock>): TestBlock {
  return {
    id: overrides.id || "blk-test",
    name: overrides.name || "Test Block",
    description: overrides.description || "test description",
    content: overrides.content || "test content",
    scope: overrides.scope || "project",
    projectId: overrides.projectId ?? "proj-1",
    tokenEstimate: overrides.tokenEstimate ?? 10,
    updatedAt: overrides.updatedAt || new Date(0).toISOString(),
    ...overrides,
  };
}

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: overrides.id || "memory-1",
    text: overrides.text || "Remembered context.",
    category: overrides.category || "context",
    importance: overrides.importance ?? 5,
    embedding: overrides.embedding || [1, 0],
    createdAt: overrides.createdAt || new Date(0).toISOString(),
    lastAccessed: overrides.lastAccessed || new Date(0).toISOString(),
    accessCount: overrides.accessCount ?? 0,
    subject: overrides.subject || "",
    durability: overrides.durability || "durable",
    ...overrides,
  };
}

function fixture(overrides?: Partial<BlockFixture>): BlockFixture {
  return {
    blocks: [
      // Newest first is the storage order. B + A fit the 100t project budget;
      // C falls to the index line.
      block({
        id: "blk-emudhra",
        name: "eMudhra",
        description: "emudhra description",
        content: "emudhra content v1",
        tokenEstimate: 35,
        updatedAt: "2026-10-23T00:00:02.000Z",
      }),
      block({
        id: "blk-implementation",
        name: "Implementation",
        description: "implementation description",
        content: "implementation content v1",
        tokenEstimate: 60,
        updatedAt: "2026-10-23T00:00:01.000Z",
      }),
      block({
        id: "blk-kernel",
        name: "Kernel",
        description: "kernel description v1",
        content: "kernel content v1",
        tokenEstimate: 10,
        updatedAt: "2026-10-23T00:00:00.000Z",
      }),
    ],
    budgets: { global: 100, project: 100 },
    failBlocks: false,
    ...overrides,
  };
}

function mockBlockDeps(f: BlockFixture) {
  const blockRows = new Map<string, BlockStateRow>();
  const logMock = vi.fn();

  vi.resetModules();
  vi.doMock("../services/embeddings.js", () => ({
    embed: vi.fn(async () => [1, 0]),
    cosineSimilarity: vi.fn(() => 1),
  }));
  vi.doMock("../services/memory-storage.js", () => ({
    searchMemories: vi.fn(async () => [
      { memory: memory({ id: "mem-1", text: "A relevant retrieved memory." }), score: 0.9 },
    ]),
    mmrRerank: vi.fn((items: unknown[], _embedding, limit: number) => items.slice(0, limit)),
    updateMemory: vi.fn(async () => true),
    getBlockTokenBudgets: vi.fn(async () => f.budgets),
    getMemoryBlocksByScope: vi.fn((scope: "global" | "project" | "archived", projectId?: string) => {
      if (f.failBlocks) throw new Error("memory blocks unavailable");
      return f.blocks
        .filter((b) => b.scope === scope && (scope !== "project" || b.projectId === projectId))
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }),
    getAllMemoryBlocks: vi.fn(() => f.blocks),
    isSystemManagedMemoryBlock: vi.fn(() => false),
    buildMemoryIndexText: (text: string, subject?: string) =>
      subject?.trim() ? `${subject.trim()}\n${text}` : text,
    getMemoryContextState: vi.fn(() => null),
    upsertMemoryContextState: vi.fn(),
    deleteMemoryContextState: vi.fn(),
    setMemoryContextDirty: vi.fn(),
    setAllMemoryContextDirty: vi.fn(),
    getProjectContextState: vi.fn(() => null),
    upsertProjectContextState: vi.fn(),
    deleteProjectContextState: vi.fn(),
    hashMemoryBlockSections: hashBlockSections,
    getMemoryBlockState: vi.fn((chatId: string) => {
      const r = blockRows.get(chatId);
      return r ? { chatId, ...r } : null;
    }),
    upsertMemoryBlockState: vi.fn((chatId: string, s: {
      globalSection: string;
      projectSection: string;
      hasIndexedBlocks: boolean;
      globalBudget: number;
      projectBudget: number;
    }) => {
      blockRows.set(chatId, {
        ...s,
        contentHash: hashBlockSections(s.globalSection, s.projectSection),
        updatedAt: 0,
      });
    }),
    deleteMemoryBlockState: vi.fn((chatId: string) => {
      blockRows.delete(chatId);
    }),
  }));
  vi.doMock("../services/reranker.js", () => ({
    RERANK_INSTRUCTIONS: { agent: "agent", system: "system", "passive-memory": "passive-memory" },
    rerank: vi.fn(async (_query: string, documents: string[]) => ({
      results: documents.length > 0 ? [{ index: 0, score: 0.9 }] : [],
      usedModel: false,
      latencyMs: 0,
      documentCount: documents.length,
      totalTokens: 0,
      scoreMin: documents.length > 0 ? 0.9 : 0,
      scoreMax: documents.length > 0 ? 0.9 : 0,
      scoreMedian: documents.length > 0 ? 0.9 : 0,
    })),
  }));
  vi.doMock("../services/reranker-stats.js", () => ({
    recordRerankerStats: vi.fn(),
    buildSelectedResult: (memory: { id: string; text: string }, score: number) => ({
      id: memory.id, text: memory.text, score,
    }),
  }));
  vi.doMock("../services/persona-store.js", () => ({
    loadPersona: vi.fn(async () => ({ content: "Persona." })),
  }));
  vi.doMock("../services/user-store.js", () => ({
    loadUserDocument: vi.fn(async () => null),
  }));
  vi.doMock("../services/project-storage.js", () => ({
    readAgentsMd: vi.fn(async () => null),
  }));
  vi.doMock("../services/chat-storage.js", () => ({
    getProject: vi.fn(async (projectId: string) => ({
      id: projectId,
      path: "/work/project",
      name: "Project",
    })),
    getSettings: vi.fn(async () => ({})),
  }));
  vi.doMock("../services/workspace.js", () => ({
    getWorkspaceForProject: vi.fn(async () => ({
      label: "/work/project",
      readAgentsMd: vi.fn(async () => null),
    })),
  }));
  vi.doMock("../services/retrieval-settings.js", () => ({
    getRetrievalBudget: vi.fn(async () => ({
      memoryContext: {
        searchQueryChars: 1000,
        rerankQueryChars: 1000,
        searchLimit: 10,
        candidatePool: 10,
        rerankDocumentLimit: 10,
        rerankTopN: 10,
      },
    })),
  }));
  vi.doMock("../services/zeitgeist.js", () => ({
    getZeitgeistContent: vi.fn(() => ""),
    getZeitgeistArchiveInstruction: vi.fn(() => ""),
  }));
  vi.doMock("../services/logger.js", () => ({ log: logMock }));

  return { module: import("../services/memory-context.js"), blockRows, log: logMock };
}

const CHAT = "project-chat";
const PROJECT = "proj-1";

describe("memory block deferral (service)", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function load(f: BlockFixture = fixture()) {
    const deps = mockBlockDeps(f);
    const mod = await deps.module;
    mod.resetAllMemoryContextCaches();
    return { ...deps, mod };
  }

  it("first build renders fresh blocks and persists the snapshot", async () => {
    const f = fixture();
    const { mod, blockRows } = await load(f);

    const { stablePrefix } = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(stablePrefix).toContain("emudhra content v1");
    expect(stablePrefix).toContain("implementation content v1");
    expect(stablePrefix).toContain("## Available Project Memory Blocks");
    expect(stablePrefix).toContain("- [blk-kernel] Kernel (project) — kernel description v1");
    expect(stablePrefix).not.toContain("kernel content v1");

    const row = blockRows.get(CHAT);
    expect(row).toBeDefined();
    expect(row!.projectSection).toContain("emudhra content v1");
    expect(row!.projectSection).toContain("kernel description v1");
    expect(row!.hasIndexedBlocks).toBe(true);
    expect(row!.globalBudget).toBe(100);
    expect(row!.projectBudget).toBe(100);
    expect(row!.contentHash).toBe(hashBlockSections(row!.globalSection, row!.projectSection));
  });

  it("a restart after a block edit serves the snapshot byte-exact, then lands at compaction", async () => {
    const f = fixture();
    const { mod, blockRows, log } = await load(f);

    const first = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(first.stablePrefix).toContain("implementation content v1");

    // The incident shape: Kernel grows and becomes the newest project block.
    // A fresh rebuild would load Kernel + eMudhra and displace Implementation.
    f.blocks.find((b) => b.id === "blk-kernel")!.content = "kernel content v2 expanded";
    f.blocks.find((b) => b.id === "blk-kernel")!.description = "kernel description v2";
    f.blocks.find((b) => b.id === "blk-kernel")!.tokenEstimate = 40;
    f.blocks.find((b) => b.id === "blk-kernel")!.updatedAt = "2026-10-23T00:00:03.000Z";

    // Process restart: Map caches gone, durable rows survive.
    mod.resetAllMemoryContextCaches();
    const resumed = await mod.buildStablePrefix(CHAT, PROJECT);

    expect(resumed.stablePrefix).toBe(first.stablePrefix);
    expect(resumed.stablePrefix).toContain("implementation content v1");
    expect(resumed.stablePrefix).not.toContain("kernel content v2 expanded");
    expect(blockRows.get(CHAT)!.projectSection).toContain("kernel description v1");
    expect(log.mock.calls.some((c) => String(c[0]).includes("memory blocks diverged"))).toBe(true);

    // Compaction is the landing point: drop the snapshot, rebuild fresh.
    mod.softResetMemoryContext(CHAT);
    expect(blockRows.has(CHAT)).toBe(false);

    const landed = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(landed.stablePrefix).toContain("kernel content v2 expanded");
    expect(landed.stablePrefix).toContain("emudhra content v1");
    expect(landed.stablePrefix).not.toContain("implementation content v1");
    expect(landed.stablePrefix).toContain("- [blk-implementation] Implementation (project) — implementation description");
  });

  it("a restart with unchanged blocks serves fresh (byte-identical) and does not flag a divergence", async () => {
    const f = fixture();
    const { mod, log } = await load(f);

    const first = await mod.buildStablePrefix(CHAT, PROJECT);
    mod.resetAllMemoryContextCaches();
    const second = await mod.buildStablePrefix(CHAT, PROJECT);

    expect(second.stablePrefix).toBe(first.stablePrefix);
    expect(log.mock.calls.some((c) => String(c[0]).includes("memory blocks diverged"))).toBe(false);
  });

  it("a budget change applies fresh immediately and updates the snapshot budgets", async () => {
    const f = fixture();
    const { mod, blockRows } = await load(f);

    await mod.buildStablePrefix(CHAT, PROJECT);
    expect(blockRows.get(CHAT)!.projectBudget).toBe(100);

    // Deliberate settings change plus an edit: the budget change is a new
    // composition decision, not a deferred content edit.
    f.blocks.find((b) => b.id === "blk-kernel")!.content = "kernel content v2 expanded";
    f.blocks.find((b) => b.id === "blk-kernel")!.updatedAt = "2026-10-23T00:00:03.000Z";
    f.budgets = { global: 100, project: 200 };

    const rebuilt = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(rebuilt.stablePrefix).toContain("kernel content v2 expanded");
    expect(rebuilt.stablePrefix).toContain("implementation content v1");
    expect(blockRows.get(CHAT)!.projectBudget).toBe(200);
  });

  it("cache invalidation that keeps the durable snapshot still defers", async () => {
    const f = fixture();
    const { mod } = await load(f);

    await mod.buildStablePrefix(CHAT, PROJECT);
    f.blocks.find((b) => b.id === "blk-kernel")!.content = "kernel content v2 expanded";

    // Map-only global invalidation (synthesis-style): the durable snapshot
    // must survive so the rebuild stays byte-identical.
    mod.invalidateAllStablePrefixCaches();
    const rebuilt = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(rebuilt.stablePrefix).not.toContain("kernel content v2 expanded");
  });

  it("hard reset and workspace moves drop the snapshot so fresh content applies", async () => {
    const f = fixture();
    const { mod, blockRows } = await load(f);

    await mod.buildStablePrefix(CHAT, PROJECT);
    const kernel = f.blocks.find((b) => b.id === "blk-kernel")!;
    kernel.content = "kernel content v2 expanded";
    kernel.tokenEstimate = 40;
    kernel.updatedAt = "2026-10-23T00:00:03.000Z";
    mod.resetAllMemoryContextCaches();
    mod.resetMemoryContext(CHAT);
    expect(blockRows.has(CHAT)).toBe(false);
    const afterHardReset = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(afterHardReset.stablePrefix).toContain("kernel content v2 expanded");

    // Move (same chat, deliberate source change): drop again.
    kernel.content = "kernel content v3";
    mod.resetAllMemoryContextCaches();
    mod.invalidateAllCaches(CHAT);
    expect(blockRows.has(CHAT)).toBe(false);
    const afterMove = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(afterMove.stablePrefix).toContain("kernel content v3");
  });

  it("preview builds consult the snapshot but never write one", async () => {
    const f = fixture();
    const { mod, blockRows } = await load(f);

    // Never delivered: preview renders fresh disk content, no baseline row.
    const preview = await mod.buildStablePrefix(CHAT, PROJECT, undefined, { preview: true });
    expect(preview.stablePrefix).toContain("emudhra content v1");
    expect(blockRows.size).toBe(0);

    // Delivery baselines the snapshot.
    const delivered = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(blockRows.has(CHAT)).toBe(true);

    // Edited between sessions: preview serves the last-applied bytes and
    // leaves the durable row untouched (delivery build does the same).
    f.blocks.find((b) => b.id === "blk-kernel")!.content = "kernel content v2 expanded";
    mod.resetAllMemoryContextCaches();
    const snapshotBefore = blockRows.get(CHAT)!;
    const previewResumed = await mod.buildStablePrefix(CHAT, PROJECT, undefined, { preview: true });
    expect(previewResumed.stablePrefix).toBe(delivered.stablePrefix);
    expect(blockRows.get(CHAT)).toEqual(snapshotBefore);
  });

  it("synthetic cache keys stay stateless", async () => {
    const f = fixture();
    const { mod, blockRows } = await load(f);

    await mod.buildStablePrefix("_default", PROJECT);
    expect(blockRows.size).toBe(0);

    const { NEW_AGENT_CHAT_BASELINE_CACHE_ID } = await import("../services/llama-cache-residency.js");
    await mod.buildStablePrefix(NEW_AGENT_CHAT_BASELINE_CACHE_ID);
    expect(blockRows.size).toBe(0);
  });

  it("the split prompt's block hint follows the snapshot, not the fresh block set", async () => {
    const f = fixture();
    const { mod } = await load(f);

    await mod.buildStablePrefix(CHAT, PROJECT);

    // Fresh blocks now all fit, so a fresh build would drop the index — but
    // the deferred snapshot still carries one, and the hint must match it.
    f.blocks.find((b) => b.id === "blk-kernel")!.tokenEstimate = 1;
    f.blocks.find((b) => b.id === "blk-implementation")!.tokenEstimate = 1;
    mod.resetAllMemoryContextCaches();

    const split = await mod.buildSplitAugmentedPrompt(
      [{ role: "user", content: "what changed?", timestamp: 1000 }],
      CHAT,
      PROJECT,
      "agent",
    );

    expect(split.systemPrompt).toContain("## Available Project Memory Blocks");
    expect(split.systemPrompt).toContain("Additional context may be available in memory blocks listed above");
  });

  it("a block-load failure serves the snapshot rather than emptying the section", async () => {
    const f = fixture();
    const { mod, blockRows } = await load(f);

    const first = await mod.buildStablePrefix(CHAT, PROJECT);
    f.failBlocks = true;
    mod.resetAllMemoryContextCaches();

    const resumed = await mod.buildStablePrefix(CHAT, PROJECT);
    expect(resumed.stablePrefix).toBe(first.stablePrefix);
    expect(blockRows.get(CHAT)).toBeDefined();
  });
});
