// Block digest: the slim, deterministic per-block summary carried into the
// extraction session's user turn (not the system prompt) so block edits never
// invalidate a warm session's cached KV prefix.

import { describe, it, expect } from "vitest";
import {
  formatBlockDigest,
  buildExtractionSystemPrompt,
  type BlockDigestBlock,
} from "../services/memory-extraction.js";

function makeBlock(over: Partial<BlockDigestBlock> = {}): BlockDigestBlock {
  return {
    name: "Block A",
    description: "A one-line description",
    content: "x".repeat(400),
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "blk-a",
    ...over,
  };
}

describe("formatBlockDigest", () => {
  it("returns an empty digest when there are no blocks", () => {
    expect(formatBlockDigest([])).toEqual({ text: "", hash: "", blockCount: 0 });
  });

  it("is byte-stable regardless of input order", () => {
    const a = makeBlock({ name: "Alpha", id: "blk-a", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeBlock({ name: "Beta", id: "blk-b", createdAt: "2026-02-01T00:00:00.000Z" });
    const c = makeBlock({ name: "Gamma", id: "blk-c", createdAt: "2026-03-01T00:00:00.000Z" });
    const first = formatBlockDigest([a, b, c]);
    expect(first.text).toBe(formatBlockDigest([c, a, b]).text);
    expect(first.hash).toBe(formatBlockDigest([b, c, a]).hash);
  });

  it("sorts blocks by createdAt", () => {
    const later = makeBlock({ name: "Later", id: "blk-z", createdAt: "2026-03-01T00:00:00.000Z" });
    const earlier = makeBlock({ name: "Earlier", id: "blk-a", createdAt: "2026-01-01T00:00:00.000Z" });
    const text = formatBlockDigest([later, earlier]).text;
    expect(text.indexOf("- Earlier —")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("- Earlier —")).toBeLessThan(text.indexOf("- Later —"));
  });

  it("breaks createdAt ties by id", () => {
    const b2 = makeBlock({ name: "B", id: "blk-2", createdAt: "2026-01-01T00:00:00.000Z" });
    const b1 = makeBlock({ name: "A", id: "blk-1", createdAt: "2026-01-01T00:00:00.000Z" });
    const text = formatBlockDigest([b2, b1]).text;
    expect(text.indexOf("- A —")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("- A —")).toBeLessThan(text.indexOf("- B —"));
  });

  it("caps total size and marks omissions", () => {
    const blocks = Array.from({ length: 60 }, (_, i) =>
      makeBlock({
        name: `Block ${i}`,
        id: `blk-${i}`,
        createdAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        content: "y".repeat(400),
      }),
    );
    const digest = formatBlockDigest(blocks);
    expect(digest.blockCount).toBe(60);
    expect(digest.text.length).toBeLessThanOrEqual(12000 + 64);
    expect(digest.text).toMatch(/\[\+\d+ more block\(s\) omitted for budget\]/);
  });

  it("changes its hash when a block's content changes", () => {
    const base = [makeBlock(), makeBlock({ name: "B", id: "blk-b" })];
    const edited = [makeBlock(), makeBlock({ name: "B", id: "blk-b", content: "y".repeat(400) })];
    expect(formatBlockDigest(base).hash).not.toBe(formatBlockDigest(edited).hash);
  });
});

describe("buildExtractionSystemPrompt", () => {
  it("does not embed the block digest (the system prompt is the stable KV prefix)", async () => {
    const prompt = await buildExtractionSystemPrompt("some-project");
    expect(prompt).not.toContain("Existing Knowledge Blocks");
  });
});
