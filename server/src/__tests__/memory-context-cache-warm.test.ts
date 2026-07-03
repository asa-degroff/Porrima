import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../types.js";

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

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("memory context after cache warming", () => {
  it("keeps the warmed prefix but forces retrieval for the next real user prompt", async () => {
    const oldMemory = memory({ id: "old", text: "Old topic memory." });
    const newMemory = memory({ id: "new", text: "New prompt memory." });
    const searchQueries: string[] = [];

    vi.resetModules();
    vi.doMock("../services/embeddings.js", () => ({
      embed: vi.fn(async () => [1, 0]),
      cosineSimilarity: vi.fn(() => 1),
    }));
    vi.doMock("../services/memory-storage.js", () => ({
      searchMemories: vi.fn(async (_embedding, _limit, _now, searchQuery: string) => {
        searchQueries.push(searchQuery);
        return searchQuery.includes("new prompt")
          ? [
              { memory: oldMemory, score: 0.8 },
              { memory: newMemory, score: 0.7 },
            ]
          : [{ memory: oldMemory, score: 0.8 }];
      }),
      mmrRerank: vi.fn((items: unknown[], _embedding, limit: number) => items.slice(0, limit)),
      updateMemory: vi.fn(async () => true),
      getMemoryBlocksByScope: vi.fn(() => []),
      getAllMemoryBlocks: vi.fn(() => []),
      isSystemManagedMemoryBlock: vi.fn(() => false),
    }));
    vi.doMock("../services/reranker.js", () => ({
      RERANK_INSTRUCTIONS: {
        agent: "agent",
        quick: "quick",
        system: "system",
        "passive-memory": "passive-memory",
      },
      rerank: vi.fn(async (_query: string, documents: string[]) => ({
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
    vi.doMock("../services/logger.js", () => ({
      log: vi.fn(),
    }));

    const {
      buildSplitAugmentedPrompt,
      invalidateMemoriesCache,
      resetAllMemoryContextCaches,
    } = await import("../services/memory-context.js");

    resetAllMemoryContextCaches();
    const warmed = await buildSplitAugmentedPrompt(
      "Base prompt.",
      [{ role: "user", content: "old topic", timestamp: 1000 }],
      "chat-1",
      undefined,
      "agent",
    );

    expect(warmed.systemPrompt).toContain("Old topic memory.");
    expect(warmed.memoriesMessage).toBe("");

    invalidateMemoriesCache("chat-1");

    const nextTurn = await buildSplitAugmentedPrompt(
      "Base prompt.",
      [
        { role: "user", content: "old topic", timestamp: 1000 },
        { role: "assistant", content: "Old answer.", timestamp: 2000 },
        { role: "user", content: "new prompt", timestamp: 3000 },
      ],
      "chat-1",
      undefined,
      "agent",
    );

    expect(searchQueries).toHaveLength(2);
    expect(searchQueries[1]).toContain("new prompt");
    expect(nextTurn.systemPrompt).toContain("Old topic memory.");
    expect(nextTurn.systemPrompt).not.toContain("New prompt memory.");
    expect(nextTurn.memoriesMessage).toContain("New prompt memory.");
  });
});
