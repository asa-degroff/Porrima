import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Memory } from "../types.js";

function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: overrides.id || "memory-1",
    text: overrides.text || "Remember the active topic.",
    category: overrides.category || "context",
    importance: overrides.importance ?? 5,
    embedding: overrides.embedding || [1, 0],
    createdAt: overrides.createdAt || new Date(0).toISOString(),
    lastAccessed: overrides.lastAccessed || new Date(0).toISOString(),
    accessCount: overrides.accessCount ?? 0,
    subject: overrides.subject || "",
    ...overrides,
  };
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

describe("memory_context_state storage", () => {
  const mkHomeDir = () => mkdtempSync(join(tmpdir(), "porrima-mcs-"));

  afterEach(() => {
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("round-trips upsert/get and computes section_hash = sha1(section)", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertMemoryContextState("chat-1", {
        frozenSection: "## Frozen\n- [f1] fact one",
        frozenIds: ["f1"],
        deltaIds: [],
        dirty: false,
      });

      const row = mod.getMemoryContextState("chat-1");
      expect(row).not.toBeNull();
      expect(row!.frozenSection).toBe("## Frozen\n- [f1] fact one");
      expect(row!.sectionHash).toBe(
        sha1("## Frozen\n- [f1] fact one")
      );
      expect(row!.frozenIds).toEqual(["f1"]);
      expect(row!.deltaIds).toEqual([]);
      expect(row!.dirty).toBe(false);
      expect(row!.updatedAt).toBeGreaterThan(0);

      expect(mod.getMemoryContextState("chat-unknown")).toBeNull();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("upsert replaces in place — one row per chat, latest values win", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertMemoryContextState("chat-1", {
        frozenSection: "v1",
        frozenIds: ["f1"],
        deltaIds: [],
        dirty: false,
      });
      mod.upsertMemoryContextState("chat-1", {
        frozenSection: "v2",
        frozenIds: ["f1", "f2"],
        deltaIds: ["d1"],
        dirty: true,
      });

      const row = mod.getMemoryContextState("chat-1");
      expect(row!.frozenSection).toBe("v2");
      expect(row!.sectionHash).toBe(sha1("v2"));
      expect(row!.frozenIds).toEqual(["f1", "f2"]);
      expect(row!.deltaIds).toEqual(["d1"]);
      expect(row!.dirty).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("delete removes the row; setMemoryContextDirty is a no-op for unknown chats", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertMemoryContextState("chat-1", {
        frozenSection: "s",
        frozenIds: [],
        deltaIds: [],
        dirty: false,
      });
      mod.deleteMemoryContextState("chat-1");
      expect(mod.getMemoryContextState("chat-1")).toBeNull();

      // Must not create a row.
      mod.setMemoryContextDirty("chat-unknown");
      expect(mod.getMemoryContextState("chat-unknown")).toBeNull();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("setMemoryContextDirty flips an existing row; setAllMemoryContextDirty flips all", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertMemoryContextState("chat-1", {
        frozenSection: "s1", frozenIds: [], deltaIds: [], dirty: true,
      });
      mod.upsertMemoryContextState("chat-2", {
        frozenSection: "s2", frozenIds: [], deltaIds: [], dirty: false,
      });

      mod.setMemoryContextDirty("chat-2");
      expect(mod.getMemoryContextState("chat-1")!.dirty).toBe(true);
      expect(mod.getMemoryContextState("chat-2")!.dirty).toBe(true);

      mod.upsertMemoryContextState("chat-2", {
        frozenSection: "s2", frozenIds: [], deltaIds: [], dirty: false,
      });
      mod.setAllMemoryContextDirty();
      expect(mod.getMemoryContextState("chat-1")!.dirty).toBe(true);
      expect(mod.getMemoryContextState("chat-2")!.dirty).toBe(true);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Service level — mocked storage emulating real row semantics
// ---------------------------------------------------------------------------

interface EmulatedRow {
  frozenSection: string;
  frozenIds: string[];
  deltaIds: string[];
  dirty: boolean;
}

function mockStorageModule(rows: Map<string, EmulatedRow>) {
  const get = (chatId: string) => {
    const r = rows.get(chatId);
    if (!r) return null;
    return {
      chatId,
      frozenSection: r.frozenSection,
      sectionHash: sha1(r.frozenSection),
      frozenIds: [...r.frozenIds],
      deltaIds: [...r.deltaIds],
      dirty: r.dirty,
      updatedAt: 0,
    };
  };
  return {
    searchMemories: vi.fn(async (_e: unknown, _l: unknown, _n: unknown, q: string) => {
      // Deterministic retrieval: "frozen" queries see the frozen memory only,
      // "new prompt" queries see frozen + a new memory.
      const frozen = [{ memory: memory({ id: "f1", text: "Frozen topic memory." }), score: 0.9 }];
      return q.includes("new prompt")
        ? [...frozen, { memory: memory({ id: "n1", text: "New prompt memory." }), score: 0.8 }]
        : frozen;
    }),
    mmrRerank: vi.fn((items: unknown[], _e: unknown, limit: number) => items.slice(0, limit)),
    updateMemory: vi.fn(async () => true),
    getMemoryBlocksByScope: vi.fn(() => []),
    getAllMemoryBlocks: vi.fn(() => []),
    isSystemManagedMemoryBlock: vi.fn(() => false),
    buildMemoryIndexText: (text: string, subject?: string) =>
      subject?.trim() ? `${subject.trim()}\n${text}` : text,
    getMemoryContextState: vi.fn(get),
    upsertMemoryContextState: vi.fn((chatId: string, s: EmulatedRow) => {
      rows.set(chatId, {
        frozenSection: s.frozenSection,
        frozenIds: [...s.frozenIds],
        deltaIds: [...s.deltaIds],
        dirty: s.dirty,
      });
    }),
    deleteMemoryContextState: vi.fn((chatId: string) => {
      rows.delete(chatId);
    }),
    setMemoryContextDirty: vi.fn((chatId: string) => {
      const r = rows.get(chatId);
      if (r) r.dirty = true;
    }),
    setAllMemoryContextDirty: vi.fn(() => {
      for (const r of rows.values()) r.dirty = true;
    }),
  };
}

async function loadMemoryContext(rows: Map<string, EmulatedRow>) {
  vi.resetModules();
  const mocks = mockStorageModule(rows);
  vi.doMock("../services/embeddings.js", () => ({
    embed: vi.fn(async () => [1, 0]),
    cosineSimilarity: vi.fn(() => 1),
  }));
  vi.doMock("../services/memory-storage.js", () => mocks);
  vi.doMock("../services/reranker.js", () => ({
    RERANK_INSTRUCTIONS: {
      agent: "agent",
      quick: "quick",
      system: "system",
      "passive-memory": "passive-memory",
    },
    rerank: vi.fn(async (_q: string, documents: string[]) => ({
      results: documents.map((_, index) => ({ index, score: 0.8 - index * 0.05 })),
      usedModel: false,
      latencyMs: 0,
      documentCount: documents.length,
      topN: documents.length,
      totalTokens: 0,
      scoreMin: documents.length ? 0.75 : 0,
      scoreMax: documents.length ? 0.8 : 0,
      scoreMedian: documents.length ? 0.8 : 0,
    })),
  }));
  vi.doMock("../services/reranker-stats.js", () => ({
    recordRerankerStats: vi.fn(),
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
    getProject: vi.fn(async () => null),
    getSettings: vi.fn(async () => ({})),
  }));
  vi.doMock("../services/workspace.js", () => ({
    getWorkspaceForProject: vi.fn(),
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
  const logMock = vi.fn();
  vi.doMock("../services/logger.js", () => ({ log: logMock }));

  const mod = await import("../services/memory-context.js");
  return { mod, mocks, log: logMock };
}

describe("memory context persistence (service)", () => {
  const SECTION = "## Frozen section marker — exact bytes";
  const seedRow = (rows: Map<string, EmulatedRow>, overrides?: Partial<EmulatedRow>) => {
    rows.set("chat-1", {
      frozenSection: SECTION,
      frozenIds: ["f1"],
      deltaIds: [],
      dirty: false,
      ...overrides,
    });
  };
  const build = (
    mod: Awaited<ReturnType<typeof loadMemoryContext>>["mod"],
    messages: ChatMessage[],
    options?: { skipMemoryRetrieval?: boolean },
  ) =>
    mod.buildSplitAugmentedPrompt("Base prompt.", messages, "chat-1", undefined, "agent", undefined, options);
  const firstTurnMsgs: ChatMessage[] = [{ role: "user", content: "frozen topic", timestamp: 1000 }];

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("restores the persisted section byte-exact on hydrate — Case 2, no retrieval, canary log", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks, log } = await loadMemoryContext(rows);

    const first = await build(mod, firstTurnMsgs);
    expect(first.systemPrompt.endsWith(SECTION)).toBe(true);
    expect(first.systemPrompt).not.toContain("Frozen topic memory."); // the section is the persisted string, not a re-roll
    expect(first.memoriesMessage).toBe("");
    expect(mocks.searchMemories).not.toHaveBeenCalled();

    const second = await build(mod, [...firstTurnMsgs, { role: "assistant", content: "ok", timestamp: 2000 }]);
    expect(sha1(second.systemPrompt)).toBe(sha1(first.systemPrompt));

    const canary = log.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes("restored frozen set"));
    expect(canary).toBeDefined();
    expect(canary).toContain("1 frozen + 0 delta");
    expect(canary).toContain(sha1(SECTION));
  });

  it("with no row: Case 1 rolls and writes the row (write point 1)", async () => {
    const rows = new Map<string, EmulatedRow>();
    const { mod, mocks } = await loadMemoryContext(rows);

    const result = await build(mod, firstTurnMsgs);
    expect(result.systemPrompt).toContain("Frozen topic memory.");

    expect(mocks.upsertMemoryContextState).toHaveBeenCalledOnce();
    const row = rows.get("chat-1")!;
    expect(row).toBeDefined();
    expect(row.frozenIds).toEqual(["f1"]);
    expect(row.deltaIds).toEqual([]);
    expect(row.dirty).toBe(false);
    // The persisted section is the exact suffix of the system prompt —
    // restore later must return these bytes, nothing derived from them.
    expect(result.systemPrompt.endsWith(row.frozenSection)).toBe(true);
    expect(row.frozenSection).toContain("- [f1] Frozen topic memory.");
    expect(mocks.upsertMemoryContextState.mock.calls[0][0]).toBe("chat-1");
  });

  it("dirty row + new memories: Case 3 keeps the section, grows delta_ids, dirty=0 (write point 2)", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows, { dirty: true });
    const { mod, mocks } = await loadMemoryContext(rows);

    const result = await build(mod, [
      ...firstTurnMsgs,
      { role: "assistant", content: "ok", timestamp: 2000 },
      { role: "user", content: "new prompt", timestamp: 3000 },
    ]);

    expect(result.systemPrompt.endsWith(SECTION)).toBe(true);
    expect(result.memoriesMessage).toContain("New prompt memory.");
    expect(result.memoriesMessage).not.toContain("Frozen topic memory.");

    const row = rows.get("chat-1")!;
    expect(row.deltaIds).toEqual(["n1"]);
    expect(row.dirty).toBe(false);
    expect(row.frozenIds).toEqual(["f1"]);
    expect(mocks.upsertMemoryContextState).toHaveBeenCalled();
  });

  it("invalidateMemoriesCache: Map entry persists dirty; empty Map lands on the row (write point 3)", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks } = await loadMemoryContext(rows);

    // Map empty (simulates post-restart): fall through to the row.
    mod.invalidateMemoriesCache("chat-1");
    expect(mocks.setMemoryContextDirty).toHaveBeenCalledWith("chat-1");
    expect(rows.get("chat-1")!.dirty).toBe(true);

    // Now hydrate and invalidate with a live Map entry.
    await build(mod, firstTurnMsgs);
    expect(rows.get("chat-1")!.dirty).toBe(false); // restored dirty, Case 3 consumed it
    expect(rows.get("chat-1")!.deltaIds).toEqual([]); // "frozen topic" query retrieves only the frozen memory
    mod.invalidateMemoriesCache("chat-1");
    const lastUpsert = mocks.upsertMemoryContextState.mock.calls.at(-1)!;
    expect(lastUpsert[1].dirty).toBe(true);
  });

  it("invalidateAllMemoriesCaches bulk-updates rows (write point 4)", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows, { dirty: false });
    rows.set("chat-2", { frozenSection: "S2", frozenIds: ["f9"], deltaIds: [], dirty: false });
    const { mod, mocks } = await loadMemoryContext(rows);

    mod.invalidateAllMemoriesCaches();
    expect(mocks.setAllMemoryContextDirty).toHaveBeenCalledOnce();
    expect(rows.get("chat-1")!.dirty).toBe(true);
    expect(rows.get("chat-2")!.dirty).toBe(true);
  });

  it("markMemoryDeltaInjected persists delta_ids (write point 5)", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks } = await loadMemoryContext(rows);

    // No Map state yet → no-op, no persist.
    mod.markMemoryDeltaInjected("chat-1", ["x"]);
    expect(mocks.upsertMemoryContextState).not.toHaveBeenCalled();
    expect(rows.get("chat-1")!.deltaIds).toEqual([]);

    await build(mod, firstTurnMsgs); // hydrate
    mod.markMemoryDeltaInjected("chat-1", ["p1", "p2"]);
    const lastUpsert = mocks.upsertMemoryContextState.mock.calls.at(-1)!;
    expect(lastUpsert[1].deltaIds).toContain("p1");
    expect(lastUpsert[1].deltaIds).toContain("p2");
    expect(rows.get("chat-1")!.deltaIds).toContain("p1");
  });

  it("resetMemoryContext deletes the row; next build is Case 1", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks } = await loadMemoryContext(rows);

    mod.resetMemoryContext("chat-1");
    expect(mocks.deleteMemoryContextState).toHaveBeenCalledWith("chat-1");
    expect(rows.get("chat-1")).toBeUndefined();

    await build(mod, firstTurnMsgs);
    expect(rows.get("chat-1")).toBeDefined(); // re-rolled and re-persisted
  });

  it("invalidateAllCaches keeps the frozen state (Map + row) and clears derived caches", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks } = await loadMemoryContext(rows);

    await build(mod, firstTurnMsgs); // hydrate + Case 2
    mod.invalidateAllCaches("chat-1");
    expect(mocks.deleteMemoryContextState).not.toHaveBeenCalled();

    const next = await build(mod, [...firstTurnMsgs, { role: "assistant", content: "ok", timestamp: 2000 }]);
    expect(next.systemPrompt.endsWith(SECTION)).toBe(true);
    expect(mocks.searchMemories).not.toHaveBeenCalled(); // still Case 2 — no re-roll
  });

  it("skipMemoryRetrieval does not hydrate (no row read, no section in prompt)", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks } = await loadMemoryContext(rows);

    const result = await build(mod, firstTurnMsgs, { skipMemoryRetrieval: true });
    expect(mocks.getMemoryContextState).not.toHaveBeenCalled();
    expect(result.systemPrompt).not.toContain(SECTION);
    expect(mocks.searchMemories).not.toHaveBeenCalled();
  });

  it("hydrate failure warns and falls back to Case 1 (never worse than pre-fix)", async () => {
    const rows = new Map<string, EmulatedRow>();
    seedRow(rows);
    const { mod, mocks } = await loadMemoryContext(rows);
    (mocks.getMemoryContextState as any).mockImplementation(() => {
      throw new Error("simulated db failure");
    });

    const result = await build(mod, firstTurnMsgs);
    expect(result.systemPrompt).toContain("Frozen topic memory."); // re-rolled
    expect(mocks.searchMemories).toHaveBeenCalled();
  });
});
