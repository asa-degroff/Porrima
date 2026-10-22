import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CELL_RESULT_TEXT_LIMIT_CHARS,
  capCellResultText,
  createCellOutputCapture,
  renderCellOutput,
} from "../services/kernel-output.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "porrima-kernel-output-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PORRIMA_TOOL_OUTPUT_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("foreground kernel output", () => {
  it("keeps a bounded tail and spills the full stream", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat1", "cell-12345678", () => {});
    // ~300KB through a 100KB window.
    const chunk = "line of output\n".repeat(1000);
    for (let i = 0; i < 20; i++) capture.stdout.push(chunk);

    const snapshot = await capture.stdout.finish();
    expect(snapshot.truncation.truncated).toBe(true);
    expect(snapshot.text.length).toBeLessThan(110 * 1024);
    expect(snapshot.spillPath).toBeTruthy();

    const rendered = renderCellOutput(snapshot, await capture.stderr.finish());
    expect(rendered).toContain("saved to");
    expect(rendered).toContain("read_file");

    // The spill carries the full stream, not just the window.
    expect(readFileSync(snapshot.spillPath!, "utf8").length).toBeGreaterThan(200 * 1024);

    capture.stdout.dispose();
    capture.stderr.dispose();
  });

  it("renders small stdout and stderr without a spill pointer", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat2", "cell-abcdef12", () => {});
    capture.stdout.push("hello\n");
    capture.stderr.push("warning\n");

    const rendered = renderCellOutput(
      await capture.stdout.finish(),
      await capture.stderr.finish(),
    );
    expect(rendered).toBe("hello\n[stderr] warning");
    expect(rendered).not.toContain("saved to");

    capture.stdout.dispose();
    capture.stderr.dispose();
  });

  it("caps a large last-expression result without spilling it", () => {
    const big = "x".repeat(CELL_RESULT_TEXT_LIMIT_CHARS * 2);
    const capped = capCellResultText(big);
    expect(capped).toBeTruthy();
    expect(capped!.length).toBeLessThanOrEqual(CELL_RESULT_TEXT_LIMIT_CHARS);
    expect(capped).toContain("result truncated");
    expect(capCellResultText("small")).toBe("small");
    expect(capCellResultText(null)).toBeNull();
  });
});