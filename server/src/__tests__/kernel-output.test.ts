import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CELL_OUTPUT_MIN_PART_BYTES,
  CELL_OUTPUT_WINDOW_BYTES,
  CELL_RESULT_TEXT_LIMIT_CHARS,
  CELL_VIEW_BYTES,
  capCellResultText,
  cellInlineAllowance,
  countInlineParts,
  createCellOutputCapture,
  renderCellOutput,
  renderCellWindows,
  renderOutputPointers,
  spillTrimmedStreams,
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
    expect(rendered.startsWith("[output truncated")).toBe(true);
    expect(rendered).toContain("read_file the paths below");

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
    expect(rendered).not.toContain("read_file");

    capture.stdout.dispose();
    capture.stderr.dispose();
  });

  it("caps a large last-expression result without spilling it", () => {
    const big = "x".repeat(CELL_RESULT_TEXT_LIMIT_CHARS * 2);
    const capped = capCellResultText(big);
    expect(capped).toBeTruthy();
    expect(capped!.length).toBeLessThanOrEqual(CELL_RESULT_TEXT_LIMIT_CHARS);
    expect(capped).toContain("result truncated");
    // The marker is the recovery path: a stateful kernel still holds the value.
    expect(capped).toContain("still bound in the namespace");
    expect(capCellResultText("small")).toBe("small");
    expect(capCellResultText(null)).toBeNull();
  });
});

describe("budget coordination with the tool-result wrapper", () => {
  // wrapResult head-keeps at max(8000, contextWindow * 4 * 0.15) characters.
  const BUDGET_262K = Math.floor(262144 * 4 * 0.15); // 157,286
  const BUDGET_128K = Math.floor(128000 * 4 * 0.15); // 76,800

  it("splits the wrapper budget across the parts that actually exist", () => {
    // No budget known: the standalone ceiling, unchanged.
    expect(cellInlineAllowance(undefined, 1)).toBe(CELL_OUTPUT_WINDOW_BYTES);
    // One part: the ceiling still fits, so the common case keeps all 100 KB.
    expect(cellInlineAllowance({ resultBudgetChars: BUDGET_262K }, 1)).toBe(CELL_OUTPUT_WINDOW_BYTES);
    // Two and three parts: split, with headroom left for header + traceback + markers.
    expect(cellInlineAllowance({ resultBudgetChars: BUDGET_262K }, 2)).toBe(74_547);
    expect(cellInlineAllowance({ resultBudgetChars: BUDGET_262K }, 3)).toBe(49_698);
    // A small context window shrinks the parts instead of overflowing the wrapper.
    expect(cellInlineAllowance({ resultBudgetChars: BUDGET_128K }, 2)).toBe(34_304);
    // A huge window never grows past the ceiling; a tiny one keeps a usable floor.
    expect(cellInlineAllowance({ resultBudgetChars: 4_000_000 }, 3)).toBe(CELL_OUTPUT_WINDOW_BYTES);
    expect(cellInlineAllowance({ resultBudgetChars: 1000 }, 3)).toBe(CELL_OUTPUT_MIN_PART_BYTES);
  });

  it("counts only the parts that produced something", () => {
    const empty = { text: "", truncation: { truncated: false, truncatedBy: null, totalBytes: 0, outputBytes: 0, outputLines: 0, maxBytes: 0, maxLines: 0 } } as any;
    const filled = { text: "x".repeat(10), truncation: { truncated: false, truncatedBy: null, totalBytes: 10, outputBytes: 10, outputLines: 1, maxBytes: 0, maxLines: 0 } } as any;
    expect(countInlineParts(filled, empty)).toBe(1);
    expect(countInlineParts(filled, filled)).toBe(2);
    expect(countInlineParts(filled, filled, "repr")).toBe(3);
    expect(countInlineParts(empty, empty, null)).toBe(1);
  });

  it("keeps the full inline window when only one stream is chatty", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat-b", "cell-00000001", () => {}, {
      resultBudgetChars: BUDGET_262K,
    });
    capture.stdout.push("a".repeat(300 * 1024));
    const snapshot = await capture.stdout.finish();

    // The capture holds the ceiling regardless of the budget; the budget decides
    // how much of that ceiling is shown inline.
    expect(snapshot.truncation.maxBytes).toBe(CELL_OUTPUT_WINDOW_BYTES);
    const rendered = renderCellOutput(snapshot, await capture.stderr.finish(), {
      resultBudgetChars: BUDGET_262K,
    });
    expect(rendered).toContain("last 100KB inline");
    expect(rendered.length).toBeLessThanOrEqual(BUDGET_262K);
    capture.stdout.dispose();
    capture.stderr.dispose();
  });

  /**
   * The referee for the composition bug: three full inline parts used to total
   * ~300KB against a 157KB wrapper budget, and the head-keep cut landed wherever
   * it landed — usually through a spill pointer. Splitting the budget keeps the
   * pointers and every part inside the number the wrapper will keep.
   */
  it("composes a whole three-part result under the wrapper budget", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat-c", "cell-00000002", () => {}, {
      resultBudgetChars: BUDGET_262K,
    });
    capture.stdout.push("o".repeat(3 * 1024 * 1024));
    capture.stderr.push("e".repeat(3 * 1024 * 1024));
    const stdout = await capture.stdout.finish();
    const stderr = await capture.stderr.finish();

    // settlePending's shape: allowance, pointers, windows, then the capped repr.
    const repr = "r".repeat(2_000_000);
    const allowance = cellInlineAllowance({ resultBudgetChars: BUDGET_262K }, countInlineParts(stdout, stderr, repr));
    const pointers = renderOutputPointers(stdout, stderr, allowance);
    const windows = renderCellWindows(stdout, stderr, allowance);
    const resultText = capCellResultText(repr, allowance);
    const content = [pointers, windows, resultText].filter((p) => p).join("\n");

    expect(content.length).toBeLessThanOrEqual(BUDGET_262K);
    expect(allowance).toBe(49_698);
    // Both recovery paths are inside the first kilobyte — head-keeping cannot
    // reach them without taking the pointers with them.
    const head = content.slice(0, 1024);
    expect(head).toContain(stdout.spillPath!);
    expect(head).toContain(stderr.spillPath!);
    expect(head).toContain("last 49KB inline");
    expect(content).toContain("[stderr]");

    capture.stdout.dispose();
    capture.stderr.dispose();
  });

  it("spills a sub-ceiling stream when the render allowance trims it", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat-trim", "cell-00000006", () => {}, {
      resultBudgetChars: BUDGET_262K,
    });
    capture.stdout.push("s".repeat(80 * 1024));
    capture.stderr.push("e".repeat(1024));
    const stdout = await capture.stdout.finish();
    const stderr = await capture.stderr.finish();

    // Under the capture ceiling, so the capture itself wrote no spill file.
    expect(stdout.truncation.truncated).toBe(false);
    expect(stdout.spillPath).toBeUndefined();

    const allowance = cellInlineAllowance({ resultBudgetChars: BUDGET_262K }, 2);
    expect(allowance).toBe(74_547);
    const spilled = await spillTrimmedStreams({
      chatId: "chat-trim",
      cellId: "cell-00000006",
      stdout,
      stderr,
      allowance,
    });

    expect(spilled.stdout.spillPath).toBeTruthy();
    expect(spilled.stderr.spillPath).toBeUndefined();
    expect(readFileSync(spilled.stdout.spillPath!, "utf8").length).toBe(80 * 1024);

    const content = [
      renderOutputPointers(spilled.stdout, spilled.stderr, allowance),
      renderCellWindows(spilled.stdout, spilled.stderr, allowance),
    ].join("\n");
    expect(content.startsWith("[output truncated")).toBe(true);
    expect(content).toContain(spilled.stdout.spillPath!);
    expect(content.length).toBeLessThanOrEqual(BUDGET_262K);

    capture.stdout.dispose();
    capture.stderr.dispose();
  });

  it("caps a live streaming view far below the settled window", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat-v", "cell-00000003", () => {});
    capture.stdout.push("v".repeat(300 * 1024));
    capture.stderr.push("w".repeat(300 * 1024));
    const view = renderCellWindows(capture.stdout.snapshot(), capture.stderr.snapshot(), CELL_VIEW_BYTES);
    const settled = renderCellWindows(await capture.stdout.finish(), await capture.stderr.finish());
    expect(view.length).toBeLessThanOrEqual(CELL_VIEW_BYTES * 2 + 16);
    expect(settled.length).toBeGreaterThan(view.length);
    capture.stdout.dispose();
    capture.stderr.dispose();
  });
});

describe("spill placement honesty across hosts", () => {
  /**
   * A remote kernel's read_file resolves against the remote workspace root, so a
   * pointer into the server-local store names a file the cell cannot reach. With
   * spilling disabled the result says so plainly instead of lying about a path.
   */
  it("names no path when the spill would be unreachable", async () => {
    process.env.PORRIMA_TOOL_OUTPUT_DIR = makeTempDir();
    const capture = createCellOutputCapture("chat-r", "cell-00000004", () => {}, { spillAllowed: false });
    capture.stdout.push("x".repeat(300 * 1024));

    const snapshot = await capture.stdout.finish();
    expect(snapshot.truncation.truncated).toBe(true);
    expect(snapshot.spillPath).toBeUndefined();
    expect(existsSync(join(process.env.PORRIMA_TOOL_OUTPUT_DIR!, "chat-r"))).toBe(false);

    const pointers = renderOutputPointers(snapshot, await capture.stderr.finish(), CELL_OUTPUT_WINDOW_BYTES, "the kernel runs on another host");
    expect(pointers).toContain("no copy was written (the kernel runs on another host)");
    expect(pointers).not.toContain(".porrima");
    expect(pointers).not.toContain("read_file");

    capture.stdout.dispose();
    capture.stderr.dispose();
  });
});
