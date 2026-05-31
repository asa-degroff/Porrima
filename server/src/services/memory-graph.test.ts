import { describe, expect, it } from "vitest";
import { buildMemoryGraph, type MemoryGraphEntry } from "./memory-graph.js";

function memory(
  id: string,
  embedding: number[],
  overrides: Partial<MemoryGraphEntry> = {}
): MemoryGraphEntry {
  return {
    id,
    text: `Memory ${id}`,
    category: "fact",
    importance: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastAccessed: "2026-01-01T00:00:00.000Z",
    accessCount: 0,
    sourceChatId: "",
    embedding,
    ...overrides,
  };
}

describe("memory graph builder", () => {
  it("builds bounded semantic links without duplicate undirected edges", () => {
    const graph = buildMemoryGraph(
      [
        memory("a", [1, 0]),
        memory("b", [0.98, 0.02]),
        memory("c", [0, 1]),
        memory("d", [0.02, 0.98]),
      ],
      { minSimilarity: 0.95, neighbors: 1 }
    );

    const semanticLinks = graph.links.filter((link) => link.type === "semantic");

    expect(semanticLinks).toHaveLength(2);
    expect(semanticLinks.map((link) => `${link.source}:${link.target}`).sort()).toEqual([
      "a:b",
      "c:d",
    ]);
    expect(graph.clusters.map((cluster) => cluster.size).sort((a, b) => b - a)).toEqual([2, 2]);
  });

  it("adds lineage links without merging semantic clusters", () => {
    const graph = buildMemoryGraph(
      [
        memory("old", [1, 0], { supersededBy: "new" }),
        memory("new", [0, 1], { supersedes: "old" }),
      ],
      { minSimilarity: 0.95, neighbors: 2 }
    );

    expect(graph.links).toEqual([
      { source: "old", target: "new", similarity: 1, type: "lineage" },
    ]);
    expect(graph.clusters).toHaveLength(2);
  });

  it("keeps memories without embeddings as isolated nodes", () => {
    const graph = buildMemoryGraph([
      memory("embedded", [1, 0]),
      {
        ...memory("missing", []),
        embedding: undefined,
      },
    ]);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.stats.embedded).toBe(1);
    expect(graph.nodes.find((node) => node.id === "missing")?.hasEmbedding).toBe(false);
  });

  it("reports focused graph metadata when built from a search result set", () => {
    const graph = buildMemoryGraph(
      [memory("match", [1, 0])],
      { total: 10, limit: 5, capped: false, mode: "focused", query: "project notes" }
    );

    expect(graph.stats.mode).toBe("focused");
    expect(graph.stats.query).toBe("project notes");
    expect(graph.stats.total).toBe(10);
    expect(graph.stats.shown).toBe(1);
    expect(graph.stats.capped).toBe(false);
  });
});
