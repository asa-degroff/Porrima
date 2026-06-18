import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../types.js";
import type { MemoryBlock } from "../services/memory-storage.js";

function block(overrides: Partial<MemoryBlock>): MemoryBlock {
  return {
    id: overrides.id || "block-1",
    name: overrides.name || "Block",
    description: overrides.description || "A test block.",
    content: overrides.content || "Block content.",
    scope: overrides.scope || "global",
    projectId: overrides.projectId || "",
    createdAt: overrides.createdAt || new Date(0).toISOString(),
    updatedAt: overrides.updatedAt || new Date(0).toISOString(),
    updatedBy: overrides.updatedBy || "agent",
    tokenEstimate: overrides.tokenEstimate ?? 100,
    blockType: overrides.blockType || "note",
    ...overrides,
  };
}

function memory(overrides: Partial<Memory>): Memory {
  return {
    id: overrides.id || "memory-1",
    text: overrides.text || "Remember this context.",
    category: overrides.category || "context",
    importance: overrides.importance ?? 5,
    embedding: overrides.embedding || [1, 0],
    createdAt: overrides.createdAt || new Date(0).toISOString(),
    lastAccessed: overrides.lastAccessed || new Date(0).toISOString(),
    accessCount: overrides.accessCount ?? 0,
    ...overrides,
  };
}

function expectInOrder(text: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    expect(index, `missing marker: ${marker}`).toBeGreaterThanOrEqual(0);
    expect(index, `marker out of order: ${marker}`).toBeGreaterThan(previous);
    previous = index;
  }
}

function mockMemoryContextDeps(options: {
  globalBlocks?: MemoryBlock[];
  projectBlocks?: MemoryBlock[];
  memories?: Memory[];
} = {}): void {
  const globalBlocks = options.globalBlocks ?? [];
  const projectBlocks = options.projectBlocks ?? [];
  const memories = options.memories ?? [];

  vi.resetModules();
  vi.doMock("../services/embeddings.js", () => ({
    embed: vi.fn(async () => [1, 0]),
    cosineSimilarity: vi.fn(() => 1),
  }));
  vi.doMock("../services/memory-storage.js", () => ({
    searchMemories: vi.fn(async () => memories.map((m) => ({ memory: m, score: 0.9 }))),
    mmrRerank: vi.fn((items: unknown[], _embedding, limit: number) => items.slice(0, limit)),
    updateMemory: vi.fn(async () => true),
    getMemoryBlocksByScope: vi.fn((scope: string, projectId?: string) => {
      if (scope === "global") return globalBlocks;
      if (scope === "project" && projectId === "proj-1") return projectBlocks;
      return [];
    }),
    isSystemManagedMemoryBlock: vi.fn((b: MemoryBlock) => b.blockType !== "note" || b.scope === "archived"),
  }));
  vi.doMock("../services/reranker.js", () => ({
    RERANK_INSTRUCTIONS: {
      agent: "agent",
      quick: "quick",
      system: "system",
      "passive-memory": "passive-memory",
    },
    rerank: vi.fn(async (_query: string, documents: string[]) => ({
      results: documents.map((_, index) => ({ index, score: 0.9 - index * 0.05 })),
      usedModel: false,
      latencyMs: 0,
      documentCount: documents.length,
      topN: documents.length,
      totalTokens: 0,
      scoreMin: documents.length ? 0.85 : 0,
      scoreMax: documents.length ? 0.9 : 0,
      scoreMedian: documents.length ? 0.9 : 0,
    })),
  }));
  vi.doMock("../services/reranker-stats.js", () => ({
    recordRerankerStats: vi.fn(),
  }));
  vi.doMock("../services/persona-store.js", () => ({
    loadPersona: vi.fn(async () => ({ content: "Persona text." })),
  }));
  vi.doMock("../services/user-store.js", () => ({
    loadUserDocument: vi.fn(async () => ({ content: "User profile." })),
  }));
  vi.doMock("../services/project-storage.js", () => ({
    readAgentsMd: vi.fn(async () => "Fallback AGENTS."),
  }));
  vi.doMock("../services/chat-storage.js", () => ({
    getProject: vi.fn(async (projectId: string) => ({ id: projectId, path: "/work/project", name: "Project" })),
    getSettings: vi.fn(async () => ({})),
  }));
  vi.doMock("../services/workspace.js", () => ({
    getWorkspaceForProject: vi.fn(async () => ({
      label: "/work/project",
      readAgentsMd: vi.fn(async () => "Project AGENTS instructions."),
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
    getZeitgeistContent: vi.fn(() => "Global zeitgeist."),
    getZeitgeistArchiveInstruction: vi.fn(() => ""),
  }));
  vi.doMock("../services/logger.js", () => ({
    log: vi.fn(),
  }));
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("memory context stable prefix shape", () => {
  it("places globally shareable context before project context and project blocks", async () => {
    mockMemoryContextDeps({
      globalBlocks: [
        block({ id: "global-loaded", name: "Global Loaded", content: "Global loaded content.", tokenEstimate: 100 }),
        block({ id: "global-indexed", name: "Global Indexed", description: "Global indexed description.", tokenEstimate: 4000 }),
      ],
      projectBlocks: [
        block({ id: "project-loaded", name: "Project Loaded", content: "Project loaded content.", scope: "project", projectId: "proj-1", tokenEstimate: 100 }),
        block({ id: "project-indexed", name: "Project Indexed", description: "Project indexed description.", scope: "project", projectId: "proj-1", tokenEstimate: 5000 }),
      ],
    });

    const { buildStablePrefix, resetAllMemoryContextCaches } = await import("../services/memory-context.js");
    resetAllMemoryContextCaches();
    const { stablePrefix } = await buildStablePrefix("Base prompt.", "project-chat", "proj-1");

    expectInOrder(stablePrefix, [
      "Base prompt.",
      "Persona text.",
      "## About the User",
      "## Memory Blocks",
      "Global loaded content.",
      "## Available Memory Blocks",
      "Global indexed description.",
      "## Continuity Context (Zeitgeist)",
      "Global zeitgeist.",
      "## Project Context",
      "Project AGENTS instructions.",
      "## Project Memory Blocks",
      "Project loaded content.",
      "## Available Project Memory Blocks",
      "Project indexed description.",
    ]);

    const beforeProjectContext = stablePrefix.slice(0, stablePrefix.indexOf("## Project Context"));
    expect(beforeProjectContext).not.toContain("Project loaded content.");
    expect(beforeProjectContext).not.toContain("Project indexed description.");
  });

  it("makes the no-project global prefix a byte-identical prefix of project prompts", async () => {
    mockMemoryContextDeps({
      globalBlocks: [
        block({ id: "global-loaded", name: "Global Loaded", content: "Global loaded content.", tokenEstimate: 100 }),
        block({ id: "global-indexed", name: "Global Indexed", description: "Global indexed description.", tokenEstimate: 4000 }),
      ],
      projectBlocks: [
        block({ id: "project-loaded", name: "Project Loaded", content: "Project loaded content.", scope: "project", projectId: "proj-1", tokenEstimate: 100 }),
      ],
    });

    const { buildStablePrefix, resetAllMemoryContextCaches } = await import("../services/memory-context.js");
    resetAllMemoryContextCaches();
    const noProject = await buildStablePrefix("Base prompt.", "new-agent-baseline");
    const project = await buildStablePrefix("Base prompt.", "project-chat", "proj-1");

    expect(project.stablePrefix.startsWith(noProject.stablePrefix)).toBe(true);
    expect(project.stablePrefix.slice(noProject.stablePrefix.length)).toContain("## Project Context");
  });

  it("adds the retrieval hint when only project blocks are indexed", async () => {
    mockMemoryContextDeps({
      projectBlocks: [
        block({ id: "project-indexed", name: "Project Indexed", description: "Project indexed description.", scope: "project", projectId: "proj-1", tokenEstimate: 6000 }),
      ],
      memories: [
        memory({ id: "memory-1", text: "The current project uses a special setup.", projectId: "proj-1" }),
      ],
    });

    const { buildSplitAugmentedPrompt, resetAllMemoryContextCaches } = await import("../services/memory-context.js");
    resetAllMemoryContextCaches();
    const split = await buildSplitAugmentedPrompt(
      "Base prompt.",
      [{ role: "user", content: "How is this project set up?", timestamp: 1000 }],
      "project-chat",
      "proj-1",
      "agent",
    );

    expect(split.systemPrompt).toContain("## Available Project Memory Blocks");
    expect(split.systemPrompt).toContain("Additional context may be available in memory blocks listed above");
    expect(split.systemPrompt).toContain("The current project uses a special setup.");
  });
});
