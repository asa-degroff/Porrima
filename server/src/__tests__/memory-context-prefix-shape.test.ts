import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, Memory } from "../types.js";
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
    subject: overrides.subject || "",
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
    buildMemoryIndexText: (text: string, subject?: string) =>
      subject?.trim() ? `${subject.trim()}\n${text}` : text,
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

describe("time anchor", () => {
  const ANCHOR_RE = /\[time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]$/;
  const SPLIT_ANCHOR_RE = /\n\n\[time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]$/;

  it("builds a bare [time:] anchor for recent chats", async () => {
    mockMemoryContextDeps({});
    const { buildTimeAnchor } = await import("../services/memory-context.js");
    const now = Date.now();

    const anchor = buildTimeAnchor([
      { role: "user", content: "earlier", timestamp: now - 5 * 60_000 },
      { role: "user", content: "current", timestamp: now - 30_000 },
    ]);

    // Anchor carries the timestamp…
    expect(anchor).toMatch(ANCHOR_RE);
    // …with no gap clause when the last exchange was recent (< 1h).
    expect(anchor).not.toContain("resumed after");
  });

  it("reports the idle gap when the chat was resumed after more than an hour", async () => {
    mockMemoryContextDeps({});
    const { buildTimeAnchor } = await import("../services/memory-context.js");
    const now = Date.now();

    const anchor = buildTimeAnchor([
      // Last real exchange: 3d 4h ago.
      { role: "user", content: "old", timestamp: now - (3 * 24 + 4) * 60 * 60_000 },
      { role: "assistant", content: "old reply", timestamp: now - (3 * 24 + 4) * 60 * 60_000 },
      // Current turn's row (pushed before the build) — must be skipped.
      { role: "user", content: "current", timestamp: now - 10_000 },
    ]);

    expect(anchor).toMatch(/resumed after 3d 4h\]$/);
  });

  it("keeps the system prompt byte-identical between turns (anchor not in system prompt)", async () => {
    mockMemoryContextDeps({});
    const { buildSplitAugmentedPrompt, resetAllMemoryContextCaches } = await import("../services/memory-context.js");
    resetAllMemoryContextCaches();
    const now = Date.now();
    const messages: ChatMessage[] = [{ role: "user", content: "hi", timestamp: now - 5 * 60_000 }];

    const first = await buildSplitAugmentedPrompt("Base prompt.", messages, "stable-chat", undefined, "agent");
    const second = await buildSplitAugmentedPrompt("Base prompt.", messages, "stable-chat", undefined, "agent");

    // The anchor must NOT live in the system prompt — it's appended to the
    // trailing user message instead so the changing timestamp doesn't break
    // the LCP mid-prompt. The system prompt is fully byte-stable.
    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.systemPrompt).not.toMatch(ANCHOR_RE);
    expect(first.systemPrompt).not.toContain("[time:");
  });

  it("returns the anchor separately (trailing placement), not in the system prompt", async () => {
    mockMemoryContextDeps({});
    const { buildSplitAugmentedPrompt, buildTimeAnchor, resetAllMemoryContextCaches } = await import("../services/memory-context.js");
    resetAllMemoryContextCaches();
    const now = Date.now();
    const messages: ChatMessage[] = [{ role: "user", content: "hi", timestamp: now - 5 * 60_000 }];

    const split = await buildSplitAugmentedPrompt("Base prompt.", messages, "anchor-chat", undefined, "agent");
    const anchor = buildTimeAnchor(messages);

    expect(split.systemPrompt).not.toContain("[time:");
    expect(anchor).toMatch(SPLIT_ANCHOR_RE);
  });
});

describe("persisted time anchors in replay", () => {
  function mockAgentDeps(): void {
    vi.resetModules();
    vi.doMock("../services/models.js", () => ({
      createPiModelFromProvider: vi.fn(),
      discoverAllModels: vi.fn(async () => []),
      getExtractionRoute: vi.fn(),
    }));
    vi.doMock("../services/llm-provider.js", () => ({
      streamLlamaCpp: vi.fn(),
    }));
    vi.doMock("../services/llama-router-client.js", () => ({
      normalizeRouterModelId: vi.fn((id: string) => id),
    }));
    vi.doMock("../services/user-image-storage.js", () => ({
      hydrateUserImageAttachments: vi.fn(async (images: unknown[]) => images),
    }));
    vi.doMock("../services/tool-result-image-storage.js", () => ({
      hydrateToolResultImageAttachments: vi.fn(async (results: unknown[]) => results),
    }));
  }

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("re-appends each user row's frozen time anchor during replay", async () => {
    mockAgentDeps();
    const { chatMessagesToPiMessages } = await import("../services/agent.js");
    const anchorA = "\n\n[time: 2026-08-20 10:00 UTC]";
    const anchorB = "\n\n[time: 2026-08-21 11:30 UTC]";

    const pi = chatMessagesToPiMessages(
      [
        { role: "user", content: "first question", timestamp: 1000, timeAnchor: anchorA },
        { role: "assistant", content: "first answer", timestamp: 2000 },
        { role: "user", content: "second question", timestamp: 3000, timeAnchor: anchorB },
      ],
      "test-model",
    );

    expect(pi).toHaveLength(3);
    expect(pi[0].role).toBe("user");
    expect(pi[0].content).toBe(`first question${anchorA}`);
    expect(pi[2].content).toBe(`second question${anchorB}`);
  });

  it("keeps turn N's replayed history a byte-prefix of turn N+1's", async () => {
    mockAgentDeps();
    const { chatMessagesToPiMessages } = await import("../services/agent.js");
    const anchorA = "\n\n[time: 2026-08-20 10:00 UTC]";

    // Turn N wire prompt ended with: u1 + frozen anchor.
    const turnN = chatMessagesToPiMessages(
      [{ role: "user", content: "u1", timestamp: 1000, timeAnchor: anchorA }],
      "test-model",
    );
    // Turn N+1 replays the same row from storage — identical bytes.
    const turnNPlusOne = chatMessagesToPiMessages(
      [
        { role: "user", content: "u1", timestamp: 1000, timeAnchor: anchorA },
        { role: "assistant", content: "r1", timestamp: 2000 },
        { role: "user", content: "u2", timestamp: 3000, timeAnchor: "\n\n[time: 2026-08-20 10:05 UTC]" },
      ],
      "test-model",
    );

    expect(JSON.stringify(turnNPlusOne[0])).toBe(JSON.stringify(turnN[0]));
  });

  it("leaves rows without a stored anchor untouched (legacy chats)", async () => {
    mockAgentDeps();
    const { chatMessagesToPiMessages } = await import("../services/agent.js");

    const pi = chatMessagesToPiMessages(
      [{ role: "user", content: "legacy row", timestamp: 1000 }],
      "test-model",
    );

    expect(pi[0].content).toBe("legacy row");
  });

  it("appends the anchor after merged system contexts, matching live prompt shape", async () => {
    mockAgentDeps();
    const { chatMessagesToPiMessages } = await import("../services/agent.js");
    const anchor = "\n\n[time: 2026-08-21 12:00 UTC]";

    const pi = chatMessagesToPiMessages(
      [
        { role: "system", content: "[System context — updated memories]\nNew memory text.", timestamp: 900 },
        { role: "user", content: "question", timestamp: 1000, timeAnchor: anchor },
      ],
      "test-model",
    );

    expect(pi).toHaveLength(1);
    expect(pi[0].content).toBe(`[System context — updated memories]\nNew memory text.\n\nquestion${anchor}`);
  });
});
