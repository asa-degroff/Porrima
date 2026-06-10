import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadImageCorpus(dataDir: string) {
  vi.resetModules();
  process.env.PORRIMA_DATA_DIR = dataDir;
  return import("../services/image-corpus.js");
}

afterEach(() => {
  delete process.env.PORRIMA_DATA_DIR;
  vi.doUnmock("../services/embeddings.js");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("image corpus embeddings", () => {
  it("stores embeddings using the corpus vector table dimension instead of a hard-coded size", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-image-corpus-"));
    try {
      const corpus = await loadImageCorpus(dataDir);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      corpus.rebuildCorpusVecTable(3);
      expect(corpus.getCorpusVecDimension()).toBe(3);

      await corpus.addCorpusEntry({
        id: "image-1",
        type: "generated",
        imagePath: "image-1",
        prompt: "dynamic vector dimensions",
        description: "",
        elements: { themes: ["test"] },
        promptEmbedding: [1, 0],
        createdAt: 1,
        updatedAt: 1,
      });

      let count = corpus.getCorpusDb().prepare("SELECT COUNT(*) AS c FROM vec_corpus").get() as { c: number };
      expect(count.c).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("vector length 2"));

      await corpus.updateCorpusEntry("image-1", { promptEmbedding: [1, 0, 0] });

      count = corpus.getCorpusDb().prepare("SELECT COUNT(*) AS c FROM vec_corpus").get() as { c: number };
      expect(count.c).toBe(1);
      const entry = await corpus.getCorpusEntry("image-1");
      expect(entry?.promptEmbedding).toEqual([1, 0, 0]);
      corpus.closeCorpusDb();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("counts only entries that enrichment actually changes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-image-corpus-"));
    try {
      vi.doMock("../services/embeddings.js", () => ({
        embed: vi.fn(async () => [0, 1, 0]),
      }));
      const corpus = await loadImageCorpus(dataDir);
      corpus.rebuildCorpusVecTable(3);

      await corpus.addCorpusEntry({
        id: "image-2",
        type: "analyzed",
        imagePath: "image-2",
        description: "A description-only analyzed image.",
        elements: { themes: ["analysis"] },
        createdAt: 1,
        updatedAt: 1,
      });

      const first = await corpus.enrichCorpusBatchDetailed(1);
      expect(first).toMatchObject({
        processed: 1,
        changed: 1,
        embedded: 1,
        extractedElements: 0,
      });

      const second = await corpus.enrichCorpusBatchDetailed(1);
      expect(second).toMatchObject({
        processed: 0,
        changed: 0,
        embedded: 0,
        extractedElements: 0,
      });
      corpus.closeCorpusDb();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
