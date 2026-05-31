import { describe, expect, it } from "vitest";
import type { ImageCorpusEntry } from "./image-corpus.js";
import {
  CLUSTER_ALGORITHM_VERSION,
  SIMILARITY_THRESHOLD,
  clusterMapNeedsRebuild,
} from "./cluster-engine.js";
import { generateClusterName, type ClusterMap } from "./cluster-storage.js";

function entry(
  id: string,
  elements: Record<string, string[]>,
  promptEmbedding: number[] = [1, 0]
): ImageCorpusEntry {
  return {
    id,
    type: "generated",
    imagePath: id,
    description: "",
    elements,
    promptEmbedding,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("image corpus clustering", () => {
  it("rebuilds cluster maps created with the old broad threshold", () => {
    const corpus = [entry("image-1", { themes: ["cyberpunk"] })];
    const oldMap: ClusterMap = {
      clusters: [
        {
          id: "cluster-1",
          name: "Cyberpunk Scene",
          centroid: [1, 0],
          memberIds: ["image-1"],
          dominantElements: {
            themes: ["cyberpunk"],
            settings: [],
            characters: [],
            concepts: [],
            styles: [],
          },
          variance: 0,
          size: 1,
          createdAt: Date.now(),
          lastUsed: 0,
        },
      ],
      similarityThreshold: 0.85,
      corpusSize: 1,
      lastRebuilt: Date.now(),
    };

    expect(clusterMapNeedsRebuild(oldMap, corpus)).toBe(true);

    expect(
      clusterMapNeedsRebuild(
        {
          ...oldMap,
          similarityThreshold: SIMILARITY_THRESHOLD,
          algorithmVersion: CLUSTER_ALGORITHM_VERSION,
        },
        corpus
      )
    ).toBe(false);
  });

  it("does not use a low-support setting as the name for a mixed cluster", () => {
    const members = [
      entry("1", { themes: ["cyberpunk"], settings: ["towering skyscrapers"] }),
      entry("2", { themes: ["cyberpunk"], settings: ["alien tundra"] }),
      entry("3", { themes: ["cyberpunk"], settings: ["industrial hangar"] }),
      entry("4", { themes: ["cyberpunk"], settings: ["pyramid ruins"] }),
      entry("5", { themes: ["cyberpunk"], settings: ["control room"] }),
      entry("6", { themes: ["cyberpunk"], settings: ["salt flat"] }),
      entry("7", { themes: ["sci-fi"], settings: ["forest canopy"] }),
      entry("8", { themes: ["sci-fi"], settings: ["cargo ship"] }),
      entry("9", { themes: ["noir"], settings: ["city alley"] }),
      entry("10", { themes: ["mystical"], settings: ["mirror floor"] }),
    ];

    const name = generateClusterName(members);

    expect(name).toBe("Mixed Cyberpunk");
    expect(name).not.toContain("Towering");
  });

  it("uses a shared subject when it represents the cluster", () => {
    const members = [
      entry("1", { themes: ["sci-fi"], settings: ["snowy landing strip"] }),
      entry("2", { themes: ["sci-fi"], settings: ["snowy landing strip"] }),
      entry("3", { themes: ["sci-fi"], settings: ["snowy landing strip"] }),
      entry("4", { themes: ["sci-fi"], settings: ["industrial gantry"] }),
      entry("5", { themes: ["sci-fi"], settings: ["snowy landing strip"] }),
    ];

    expect(generateClusterName(members)).toBe("Sci-fi Snowy Landing Strip");
  });

  it("does not duplicate the theme when the shared subject already contains it", () => {
    const members = [
      entry("1", { themes: ["cyberpunk"], settings: ["cyberpunk city street at night"] }),
      entry("2", { themes: ["cyberpunk"], settings: ["cyberpunk city street at night"] }),
      entry("3", { themes: ["cyberpunk"], settings: ["cyberpunk city street at night"] }),
      entry("4", { themes: ["cyberpunk"], settings: ["cyberpunk city street at night"] }),
    ];

    expect(generateClusterName(members)).toBe("Cyberpunk City Street At Night");
  });
});
