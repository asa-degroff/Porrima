import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Memory } from "../types.js";

// The service module binds its DB path at import time (paths.ts reads
// PORRIMA_DATA_DIR during evaluation), so point it at a temp dir BEFORE
// importing. Static imports in this test file must not touch reranker-stats.js;
// everything goes through a post-setup dynamic import.
let dataDir = "";
type RerankerStatsModule = typeof import("../services/reranker-stats.js");
let stats: RerankerStatsModule;

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    text: "Body text",
    category: "fact",
    importance: 7,
    embedding: [],
    createdAt: "2026-01-02T03:04:05.000Z",
    lastAccessed: "2026-01-02T03:04:05.000Z",
    accessCount: 0,
    subject: "Subject line",
    durability: "durable",
    ...overrides,
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "porrima-reranker-selected-"));
  process.env.PORRIMA_DATA_DIR = dataDir;
  stats = await import("../services/reranker-stats.js");
});

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Temp dirs are disposable; cleanup failure is harmless.
  }
});

describe("buildSelectedResult", () => {
  it("projects the memory metadata the stats UI renders", () => {
    const result = stats.buildSelectedResult(
      memory({ projectId: "proj-1", supersededBy: "mem-0" }),
      0.87,
      3,
    );

    expect(result).toEqual({
      text: "Body text",
      score: 0.87,
      id: "mem-1",
      subject: "Subject line",
      category: "fact",
      importance: 7,
      createdAt: "2026-01-02T03:04:05.000Z",
      projectId: "proj-1",
      durability: "durable",
      supersededBy: "mem-0",
      docIndex: 3,
    });
  });

  it("drops blank subjects and omitted document indices", () => {
    const result = stats.buildSelectedResult(memory({ subject: "   " }), 0.5);

    expect(result.subject).toBeUndefined();
    expect(result.docIndex).toBeUndefined();
  });
});
