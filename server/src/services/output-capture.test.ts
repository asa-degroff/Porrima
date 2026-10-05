import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createOutputCapture, type CaptureSnapshot } from "./output-capture.js";
import { DEFAULT_SPILL_MAX_BYTES } from "./tool-output-store.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "porrima-capture-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("output capture", () => {
  it("passes small output through without truncation or spill", async () => {
    const capture = createOutputCapture({ limits: { maxBytes: 1024, maxLines: 100 } });
    capture.push("hello\nworld\n");
    const result = await capture.finish();
    expect(result.text).toBe("hello\nworld\n");
    expect(result.truncation.truncated).toBe(false);
    expect(result.truncation.totalBytes).toBe(12);
    expect(result.spillPath).toBeUndefined();
  });

  it("keeps the tail, reports truncation, and spills the full stream", async () => {
    const spillPath = join(await tempDir(), "bash-x.log");
    const capture = createOutputCapture({
      limits: { maxBytes: 64, maxLines: 1000 },
      spill: { path: spillPath, maxBytes: DEFAULT_SPILL_MAX_BYTES },
    });
    const full = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
    capture.push(full);
    const result = await capture.finish();

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.truncatedBy).toBe("bytes");
    expect(result.truncation.totalBytes).toBe(Buffer.byteLength(full, "utf8"));
    expect(result.text).toContain("line-99");
    expect(result.text).not.toContain("line-0\n");
    expect(result.spillPath).toBe(spillPath);
    expect(await readFile(spillPath, "utf8")).toBe(full);
  });

  it("spills the pre-truncation prefix too", async () => {
    const spillPath = join(await tempDir(), "bash-prefix.log");
    const capture = createOutputCapture({
      limits: { maxBytes: 16, maxLines: 100 },
      spill: { path: spillPath, maxBytes: DEFAULT_SPILL_MAX_BYTES },
    });
    capture.push("first-chunk ");
    capture.push("second-chunk");
    const result = await capture.finish();
    expect(result.truncation.truncated).toBe(true);
    expect(await readFile(spillPath, "utf8")).toBe("first-chunk second-chunk");
  });

  it("reassembles UTF-8 split across chunks", async () => {
    const capture = createOutputCapture({ limits: { maxBytes: 1024, maxLines: 100 } });
    const bytes = Buffer.from("héllo — 世界\n", "utf8");
    capture.push(bytes.subarray(0, 2));
    capture.push(bytes.subarray(2));
    const result = await capture.finish();
    expect(result.text).toBe("héllo — 世界\n");
  });

  it("caps the spill and marks it", async () => {
    const spillPath = join(await tempDir(), "bash-cap.log");
    const capture = createOutputCapture({
      limits: { maxBytes: 32, maxLines: 100 },
      spill: { path: spillPath, maxBytes: 1024 },
    });
    capture.push("x".repeat(5000));
    const result = await capture.finish();
    expect(result.capped).toBe(true);
    const spilled = await readFile(spillPath, "utf8");
    expect(spilled.startsWith("x".repeat(1024))).toBe(true);
    expect(spilled).toContain("spill capped at 1KB");
    expect(Buffer.byteLength(spilled, "utf8")).toBeLessThan(5000);
  });

  it("emits updates and ignores pushes after finish", async () => {
    const updates: CaptureSnapshot[] = [];
    const capture = createOutputCapture({
      limits: { maxBytes: 1024, maxLines: 100 },
      minEmitIntervalMs: 0,
      onUpdate: (view) => updates.push(view),
    });
    capture.push("a");
    capture.push("b");
    expect(updates).toHaveLength(2);
    await capture.finish();
    expect(updates).toHaveLength(3);
    capture.push("late");
    expect(updates).toHaveLength(3);
  });

  it("supports head retention", async () => {
    const capture = createOutputCapture({ limits: { maxBytes: 64, maxLines: 1000, retain: "head" } });
    const full = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
    capture.push(full);
    const result = await capture.finish();
    expect(result.text).toContain("line-0");
    expect(result.text).not.toContain("line-99");
  });

  it("signals backpressure when the spill stream is saturated", async () => {
    const spillPath = join(await tempDir(), "bash-bp.log");
    const events: boolean[] = [];
    const capture = createOutputCapture({
      limits: { maxBytes: 32, maxLines: 100 },
      spill: { path: spillPath, maxBytes: DEFAULT_SPILL_MAX_BYTES, highWaterMark: 16 },
      onBackpressure: (paused) => events.push(paused),
    });
    capture.push("y".repeat(4096));
    await capture.finish();
    expect(events).toContain(true);
  });
});
