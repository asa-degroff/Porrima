import { describe, expect, it } from "vitest";
import {
  applyGlobalProjectScoreMultiplier,
  applyCrossProjectScoreMultiplier,
  normalizeGlobalProjectScoreMultiplier,
  normalizeCrossProjectScoreMultiplier,
  sortByAdjustedScore,
} from "../services/memory-retrieval-scope.js";

describe("memory retrieval project scoping", () => {
  it("dampens cross-project scores without filtering them out", () => {
    const candidates = [
      { memory: { projectId: "other" }, score: 0.9 },
      { memory: { projectId: "current" }, score: 0.4 },
      { memory: {}, score: 0.3 },
    ];

    const count = applyCrossProjectScoreMultiplier(candidates, "current", 0.3);

    expect(count).toBe(1);
    expect(candidates[0].score).toBeCloseTo(0.27);
    expect(sortByAdjustedScore(candidates).map((candidate) => candidate.memory.projectId ?? "global")).toEqual([
      "current",
      "global",
      "other",
    ]);
  });

  it("allows a sufficiently specific cross-project memory to remain competitive", () => {
    const candidates = [
      { memory: { projectId: "other" }, score: 0.99 },
      { memory: { projectId: "current" }, score: 0.25 },
    ];

    applyCrossProjectScoreMultiplier(candidates, "current", 0.3);

    expect(sortByAdjustedScore(candidates)[0].memory.projectId).toBe("other");
  });

  it("normalizes invalid or out-of-range multipliers", () => {
    expect(normalizeCrossProjectScoreMultiplier(undefined)).toBe(0.3);
    expect(normalizeCrossProjectScoreMultiplier(-1)).toBe(0);
    expect(normalizeCrossProjectScoreMultiplier(2)).toBe(1);
  });

  it("dampens project-scoped memories for no-project chats when configured", () => {
    const candidates = [
      { memory: { projectId: "project-a" }, score: 0.9 },
      { memory: {}, score: 0.5 },
      { memory: { projectId: "project-b" }, score: 0.4 },
    ];

    const count = applyGlobalProjectScoreMultiplier(candidates, 0.5);

    expect(count).toBe(2);
    expect(candidates[0].score).toBeCloseTo(0.45);
    expect(candidates[2].score).toBeCloseTo(0.2);
    expect(sortByAdjustedScore(candidates).map((candidate) => candidate.memory.projectId ?? "global")).toEqual([
      "global",
      "project-a",
      "project-b",
    ]);
  });

  it("defaults global/project memory sharing to equal relevance", () => {
    expect(normalizeGlobalProjectScoreMultiplier(undefined)).toBe(1);
  });
});
