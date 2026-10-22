import { createOutputCapture, type CaptureSnapshot, type OutputCapture } from "./output-capture.js";
import { DEFAULT_SPILL_MAX_BYTES, createSpillPath, formatSpillFooter } from "./tool-output-store.js";

/**
 * Bounded foreground-cell output.
 *
 * A cell can print as fast as the interpreter allows, and the driver emits a
 * frame per 64 KiB write. Holding every frame in an array and re-joining it on
 * each chunk is O(n^2) in bytes; a `while True: print(...)` cell can exhaust
 * the server long before its timeout. The same OutputCapture used by
 * background jobs and bash gives a tail window plus a bounded spill file.
 */
export const CELL_OUTPUT_WINDOW_BYTES = 100 * 1024;
export const CELL_OUTPUT_MAX_LINES = 1_000_000; // bytes bind first for real text
export const CELL_RESULT_TEXT_LIMIT_CHARS = 100 * 1024;

export interface CellOutputCapture {
  stdout: OutputCapture;
  stderr: OutputCapture;
}

export function createCellOutputCapture(
  chatId: string,
  cellId: string,
  onUpdate: () => void,
): CellOutputCapture {
  const shortId = cellId.slice(0, 8) || "cell";
  const make = (stream: "out" | "err") =>
    createOutputCapture({
      limits: {
        maxBytes: CELL_OUTPUT_WINDOW_BYTES,
        maxLines: CELL_OUTPUT_MAX_LINES,
        retain: "tail",
      },
      spill: {
        path: createSpillPath(chatId, "py", `${shortId}-${stream}`),
        maxBytes: DEFAULT_SPILL_MAX_BYTES,
      },
      onUpdate,
    });
  return { stdout: make("out"), stderr: make("err") };
}

function spillFooter(snapshot: CaptureSnapshot): string {
  if (!snapshot.truncation.truncated || !snapshot.spillPath) return "";
  return formatSpillFooter({
    path: snapshot.spillPath,
    totalBytes: snapshot.truncation.totalBytes,
    windowBytes: snapshot.truncation.maxBytes,
    capped: snapshot.capped,
    capBytes: DEFAULT_SPILL_MAX_BYTES,
  });
}

/** Render the tail windows (stdout first, then stderr) with spill pointers. */
export function renderCellOutput(stdout: CaptureSnapshot, stderr: CaptureSnapshot): string {
  const parts: string[] = [];
  const out = stdout.text.trimEnd();
  if (out) parts.push(`${out}${spillFooter(stdout)}`);
  const err = stderr.text.trimEnd();
  if (err) parts.push(`[stderr] ${err}${spillFooter(stderr)}`);
  return parts.join("\n");
}

/**
 * A cell's last-expression repr is capped separately from stdout; a 1 MiB repr
 * would otherwise land in the model's context after the output window did its
 * job. Kept inline (not spilled) so the result stays inspectable.
 */
export function capCellResultText(text: string | null): string | null {
  if (!text || text.length <= CELL_RESULT_TEXT_LIMIT_CHARS) return text;
  const marker = `\n... [result truncated at ${
    CELL_RESULT_TEXT_LIMIT_CHARS / 1024
  }KB; ${text.length} characters total]`;
  const keep = Math.max(0, CELL_RESULT_TEXT_LIMIT_CHARS - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}