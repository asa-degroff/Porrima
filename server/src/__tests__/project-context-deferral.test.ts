import { createHash } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

function sha1(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
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

describe("chat_project_context_state storage", () => {
  const mkHomeDir = () => mkdtempSync(join(tmpdir(), "porrima-pccs-"));

  afterEach(() => {
    vi.doUnmock("os");
    vi.resetModules();
  });

  it("round-trips upsert/get and computes content_hash = sha1(content)", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertProjectContextState("chat-1", {
        source: "/work/project",
        content: "\n\n## Project Context\nCurrent project: P (proj-1)\n\nProject instructions from AGENTS.md:\nv1",
      });

      const row = mod.getProjectContextState("chat-1");
      expect(row).not.toBeNull();
      expect(row!.source).toBe("/work/project");
      expect(row!.content).toContain("v1");
      expect(row!.contentHash).toBe(sha1(row!.content));
      expect(row!.updatedAt).toBeGreaterThan(0);

      expect(mod.getProjectContextState("chat-unknown")).toBeNull();

      mod.deleteProjectContextState("chat-1");
      expect(mod.getProjectContextState("chat-1")).toBeNull();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("upsert replaces in place — one row per chat, latest values win", async () => {
    const homeDir = mkHomeDir();
    try {
      const mod = await loadMemoryStorage(homeDir);
      mod.upsertProjectContextState("chat-1", { source: "/work/a", content: "v1" });
      mod.upsertProjectContextState("chat-1", { source: "/work/b", content: "v2" });

      const row = mod.getProjectContextState("chat-1");
      expect(row!.source).toBe("/work/b");
      expect(row!.content).toBe("v2");
      expect(row!.contentHash).toBe(sha1("v2"));
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Service level — mocked storage + mutable workspace fixture
// ---------------------------------------------------------------------------

interface TestBlock {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: string;
  projectId: string | null;
  tokenEstimate: number;
}

interface ProjectContextFixture {
  agentsMd: string | null;
  workspaceLabel: string;
  projectName: string;
  failWorkspace: boolean;
  blocks: TestBlock[];
}

function mockProjectContextDeps(fixture: ProjectContextFixture) {
  const projectRows = new Map<string, { source: string; content: string }>();
  const blockRows = new Map<string, {
    globalSection: string;
    projectSection: string;
    contentHash: string;
    hasIndexedBlocks: boolean;
    globalBudget: number;
    projectBudget: number;
    updatedAt: number;
  }>();

  vi.resetModules();
  vi.doMock("../services/embeddings.js", () => ({
    embed: vi.fn(async () => [1, 0]),
    cosineSimilarity: vi.fn(() => 1),
  }));
  vi.doMock("../services/memory-storage.js", () => ({
    searchMemories: vi.fn(async () => []),
    mmrRerank: vi.fn((items: unknown[], _embedding, limit: number) => items.slice(0, limit)),
    updateMemory: vi.fn(async () => true),
    getBlockTokenBudgets: vi.fn(async () => ({ global: 3000, project: 5000 })),
    getMemoryBlocksByScope: vi.fn((scope: string, projectId?: string) =>
      fixture.blocks.filter(
        (b) => b.scope === scope && (scope !== "project" || b.projectId === projectId),
      ),
    ),
    getAllMemoryBlocks: vi.fn(() => fixture.blocks),
    isSystemManagedMemoryBlock: vi.fn(() => false),
    buildMemoryIndexText: (text: string, subject?: string) =>
      subject?.trim() ? `${subject.trim()}\n${text}` : text,
    getMemoryContextState: vi.fn(() => null),
    upsertMemoryContextState: vi.fn(),
    deleteMemoryContextState: vi.fn(),
    setMemoryContextDirty: vi.fn(),
    setAllMemoryContextDirty: vi.fn(),
    getProjectContextState: vi.fn((chatId: string) => {
      const r = projectRows.get(chatId);
      return r
        ? { chatId, source: r.source, content: r.content, contentHash: sha1(r.content), updatedAt: 0 }
        : null;
    }),
    upsertProjectContextState: vi.fn((chatId: string, s: { source: string; content: string }) => {
      projectRows.set(chatId, { source: s.source, content: s.content });
    }),
    deleteProjectContextState: vi.fn((chatId: string) => {
      projectRows.delete(chatId);
    }),
    hashMemoryBlockSections: (globalSection: string, projectSection: string) =>
      sha1(`${globalSection}\u0000${projectSection}`),
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
        contentHash: sha1(`${s.globalSection}\u0000${s.projectSection}`),
        updatedAt: 0,
      });
    }),
    deleteMemoryBlockState: vi.fn((chatId: string) => {
      blockRows.delete(chatId);
    }),
  }));
  vi.doMock("../services/reranker.js", () => ({
    RERANK_INSTRUCTIONS: { agent: "agent", system: "system", "passive-memory": "passive-memory" },
    rerank: vi.fn(async () => ({ results: [], usedModel: false, latencyMs: 0, documentCount: 0 })),
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
    readAgentsMd: vi.fn(async () => fixture.agentsMd),
  }));
  vi.doMock("../services/chat-storage.js", () => ({
    getProject: vi.fn(async (projectId: string) => ({ id: projectId, path: fixture.workspaceLabel, name: fixture.projectName })),
    getSettings: vi.fn(async () => ({})),
  }));
  vi.doMock("../services/workspace.js", () => ({
    getWorkspaceForProject: vi.fn(async () => {
      if (fixture.failWorkspace) throw new Error("workspace unreachable");
      return {
        label: fixture.workspaceLabel,
        readAgentsMd: vi.fn(async () => fixture.agentsMd),
      };
    }),
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
  const logMock = vi.fn();
  vi.doMock("../services/logger.js", () => ({ log: logMock }));

  const module = import("../services/memory-context.js");
  return { module, projectRows, blockRows, log: logMock };
}

describe("project context deferral (service)", () => {
  const CHAT = "project-chat";

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function fixture(overrides?: Partial<ProjectContextFixture>): ProjectContextFixture {
    return {
      agentsMd: "AGENTS v1 content",
      workspaceLabel: "/work/project",
      projectName: "Project",
      failWorkspace: false,
      blocks: [
        {
          id: "blk-test",
          name: "Test Block",
          description: "test block",
          content: "block v1 content",
          scope: "global",
          projectId: null,
          tokenEstimate: 8,
        },
      ],
      ...overrides,
    };
  }

  it("first build renders fresh disk content and persists the snapshot", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    const { stablePrefix } = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(stablePrefix).toContain("AGENTS v1 content");

    const row = projectRows.get(CHAT);
    expect(row).toBeDefined();
    expect(row!.source).toBe("/work/project");
    expect(row!.content).toContain("AGENTS v1 content");
    // No divergence on a first build: no notice.
    expect(mod.buildProjectContextNotice(CHAT)).toBe("");
  });

  it("resume with an edited file serves the snapshot byte-exact and flags pending", async () => {
    const f = fixture();
    const { module, projectRows, log } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    const first = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(first.stablePrefix).toContain("AGENTS v1 content");

    // File edited between sessions; simulate a porrima restart (Map cold,
    // durable rows survive).
    f.agentsMd = "AGENTS v2 content";
    mod.resetAllMemoryContextCaches();

    const resumed = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(resumed.stablePrefix).toContain("AGENTS v1 content");
    expect(resumed.stablePrefix).not.toContain("AGENTS v2 content");
    // The rest of the prefix must be byte-identical: only the section content
    // diverged, the snapshot replaces it exactly.
    expect(resumed.stablePrefix).toBe(first.stablePrefix);

    const canary = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("project context diverged"));
    expect(canary).toBeDefined();

    // Notice rides the message tail while deferred.
    expect(mod.buildProjectContextNotice(CHAT)).toContain("AGENTS.md on disk has changed");
    const anchor = mod.buildTimeAnchor([{ role: "user", content: "hi", timestamp: 1000 }], CHAT);
    expect(anchor).toContain("[time:");
    expect(anchor).toContain("next compaction");
    // Without a chatId (or unknown chat) there is no notice.
    expect(mod.buildTimeAnchor([{ role: "user", content: "hi", timestamp: 1000 }])).not.toContain("AGENTS.md");

    // Snapshot row keeps the SERVED bytes (not the disk bytes).
    expect(projectRows.get(CHAT)!.content).toContain("AGENTS v1 content");
  });

  it("resume with an unchanged file applies fresh (no divergence, no notice)", async () => {
    const f = fixture();
    const { module } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    mod.resetAllMemoryContextCaches();
    const second = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);

    expect(second.stablePrefix).toContain("AGENTS v1 content");
    expect(mod.buildProjectContextNotice(CHAT)).toBe("");
  });

  it("compaction soft reset lands the deferred change", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    f.agentsMd = "AGENTS v2 content";
    mod.resetAllMemoryContextCaches();
    const deferred = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(deferred.stablePrefix).toContain("AGENTS v1 content");
    expect(mod.buildProjectContextNotice(CHAT)).not.toBe("");

    // Compaction: drops the snapshot (and the cached entry) so the next build
    // re-reads disk. Runs even with no memory-context state row at all.
    mod.softResetMemoryContext(CHAT);
    expect(projectRows.has(CHAT)).toBe(false);

    const landed = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(landed.stablePrefix).toContain("AGENTS v2 content");
    expect(mod.buildProjectContextNotice(CHAT)).toBe("");
    expect(projectRows.get(CHAT)!.content).toContain("AGENTS v2 content");
  });

  it("compaction soft reset lands mid-conversation block edits (non-project chat, no snapshot row)", async () => {
    const f = fixture();
    const { module } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    const NO_PROJ = "no-project-chat";
    const first = await mod.buildStablePrefix(NO_PROJ);
    expect(first.stablePrefix).toContain("block v1 content");

    // A mid-conversation block write (agent tool or UI): no invalidation —
    // the new content already rides the editing chat's transcript.
    f.blocks[0].content = "block v2 content";

    // The cached stable prefix still serves the pre-edit bytes — the defer.
    const mid = await mod.buildStablePrefix(NO_PROJ);
    expect(mid.stablePrefix).toContain("block v1 content");
    expect(mid.stablePrefix).not.toContain("block v2 content");

    // Compaction: this chat has no project snapshot row, so the soft reset
    // must drop the cached stable prefix ITSELF (regression pin — before the
    // fix, only chats with an AGENTS.md snapshot re-read blocks at
    // compaction; everyone else served pre-edit bytes until synthesis or a
    // restart). The post-compaction rebuild reads CURRENT block bytes.
    mod.softResetMemoryContext(NO_PROJ);
    const landed = await mod.buildStablePrefix(NO_PROJ);
    expect(landed.stablePrefix).toContain("block v2 content");
  });

  it("workspace move (source change) applies the new workspace immediately", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);

    // Same project id, different workspace + content — not a stale-file case,
    // a deliberate move: fresh content must apply on the next rebuild.
    f.workspaceLabel = "/work/project-v2";
    f.agentsMd = "AGENTS v2 content";
    mod.resetAllMemoryContextCaches();
    const moved = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);

    expect(moved.stablePrefix).toContain("AGENTS v2 content");
    expect(moved.stablePrefix).toContain("/work/project-v2");
    expect(projectRows.get(CHAT)!.source).toBe("/work/project-v2");
    expect(mod.buildProjectContextNotice(CHAT)).toBe("");
  });

  it("hard reset drops the snapshot so the rebuild applies fresh content", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    f.agentsMd = "AGENTS v2 content";

    mod.resetMemoryContext(CHAT);
    expect(projectRows.has(CHAT)).toBe(false);

    const rebuilt = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(rebuilt.stablePrefix).toContain("AGENTS v2 content");
  });

  it("global prefix invalidation keeps the deferral (snapshot survives)", async () => {
    const f = fixture();
    const { module } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    f.agentsMd = "AGENTS v2 content";

    // Synthesis-style global invalidation: Map-only. The project snapshot must
    // survive so chats whose non-project sections rebuild byte-identical keep
    // their KV prefix.
    mod.invalidateAllStablePrefixCaches();
    const rebuilt = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(rebuilt.stablePrefix).toContain("AGENTS v1 content");
    expect(mod.buildProjectContextNotice(CHAT)).not.toBe("");
  });

  it("per-chat cache invalidation (invalidateAllCaches) drops the snapshot", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    f.agentsMd = "AGENTS v2 content";
    mod.resetAllMemoryContextCaches();

    mod.invalidateAllCaches(CHAT);
    expect(projectRows.has(CHAT)).toBe(false);
    const rebuilt = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(rebuilt.stablePrefix).toContain("AGENTS v2 content");
  });

  it("workspace read failure serves the snapshot without claiming a change", async () => {
    const f = fixture();
    const { module } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    f.failWorkspace = true;
    mod.resetAllMemoryContextCaches();

    const { stablePrefix } = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(stablePrefix).toContain("AGENTS v1 content");
    expect(mod.buildProjectContextNotice(CHAT)).toBe("");
  });

  it("non-project chats never touch the snapshot", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    const { stablePrefix } = await mod.buildStablePrefix("plain-chat");
    expect(stablePrefix).not.toContain("Project Context");
    expect(projectRows.size).toBe(0);
    expect(mod.buildProjectContextNotice("plain-chat")).toBe("");
  });

  it("preview builds render served bytes but persist nothing", async () => {
    const f = fixture();
    const { module, projectRows } = mockProjectContextDeps(f);
    const mod = await module;
    mod.resetAllMemoryContextCaches();

    // Preview for a never-delivered chat: fresh bytes shown, no snapshot write.
    const preview = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel, { preview: true });
    expect(preview.stablePrefix).toContain("AGENTS v1 content");
    expect(projectRows.size).toBe(0);

    // File edited; preview again (no row exists) — still fresh, still no write.
    f.agentsMd = "AGENTS v2 content";
    const preview2 = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel, { preview: true });
    expect(preview2.stablePrefix).toContain("AGENTS v2 content");
    expect(projectRows.size).toBe(0);

    // The previews must not have poisoned the Map cache: the next delivering
    // build re-reads disk and baselines the snapshot at its own bytes.
    const delivered = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel);
    expect(delivered.stablePrefix).toContain("AGENTS v2 content");
    expect(projectRows.get(CHAT)!.content).toContain("AGENTS v2 content");

    // With a snapshot + diverged disk, preview defers for honest display but
    // neither writes the row nor sets the Map entry (notice stays empty).
    f.agentsMd = "AGENTS v3 content";
    mod.resetAllMemoryContextCaches();
    const previewDeferred = await mod.buildStablePrefix(CHAT, "proj-1", f.workspaceLabel, { preview: true });
    expect(previewDeferred.stablePrefix).toContain("AGENTS v2 content");
    expect(mod.buildProjectContextNotice(CHAT)).toBe("");
    expect(projectRows.get(CHAT)!.content).toContain("AGENTS v2 content");
  });
});
