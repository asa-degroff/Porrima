import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { createOutputCapture, type CaptureSnapshot, type OutputCapture } from "./output-capture.js";
import { DEFAULT_SPILL_MAX_BYTES, createSpillPath } from "./tool-output-store.js";

/**
 * Bounded foreground-cell output.
 *
 * A cell can print as fast as the interpreter allows, and the driver emits a
 * frame per 64 KiB write. Holding every frame in an array and re-joining it on
 * each chunk is O(n^2) in bytes; a `while True: print(...)` cell can exhaust the
 * server long before its timeout. The same OutputCapture used by background jobs
 * and bash gives a bounded window plus a spill file.
 *
 * Two rules this file owns:
 *
 * 1. **Inline parts are sized to the wrapper's budget.** After this renders, the
 *    tool result goes through `wrapResult`, which head-keeps at
 *    `max(8000, contextWindow * 4 * 0.15)` characters and knows nothing about the
 *    shape of what it is cutting. If three inline parts (stdout, stderr, the
 *    last-expression repr) each took the full 100 KiB, they would total ~300 KB
 *    and the wrapper would silently amputate the tail. The parts that actually
 *    exist split the budget instead, so the composition arrives whole.
 * 2. **Pointers come first.** A spilled stream is only recoverable if the result
 *    still says where the copy is. A footer at the tail is exactly what a
 *    head-keeping truncator removes, so the pointers render as a header.
 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

export const CELL_OUTPUT_WINDOW_BYTES = 100 * 1024;
export const CELL_OUTPUT_MAX_LINES = 1_000_000; // bytes bind first for real text
export const CELL_RESULT_TEXT_LIMIT_CHARS = 100 * 1024;
/** Floor for a derived part: below this the inline window stops being useful. */
export const CELL_OUTPUT_MIN_PART_BYTES = 4 * 1024;
/** Kept out of the inline parts for the header, a traceback, and the markers. */
export const CELL_RENDER_HEADROOM_BYTES = 8 * 1024;
/** Live streaming views get their own, much smaller cap: they are re-sent on a
 *  timer while the cell runs, so the full window here is paid once per tick. */
export const CELL_VIEW_BYTES = 16 * 1024;

export interface CellOutputBudget {
  /**
   * The character budget `wrapResult` will head-keep for this result, derived
   * from the chat's effective context window. When it is absent the ceilings
   * above apply unchanged.
   */
  resultBudgetChars?: number;
  /**
   * False when a spill file would be written where the model cannot read it. The
   * store is server-local; a remote kernel's `read_file` resolves against the
   * remote workspace root. Today the driver does not spill on its own host, so a
   * remote cell's overflow is truncated honestly rather than pointed at a path
   * that resolves nowhere (see docs/design/remote-python-kernel.md §4.6).
   */
  spillAllowed?: boolean;
}

export interface CellOutputCapture {
  stdout: OutputCapture;
  stderr: OutputCapture;
  spillAllowed: boolean;
}

/**
 * How much of the wrapper's budget one inline part may occupy.
 *
 * The capture always keeps the ceiling and spills everything past it, so this is
 * purely about what is shown inline: the parts that actually exist split the
 * budget, minus a headroom for the header, a traceback, and the markers. A cell
 * that printed on stdout only gets the whole ceiling; a cell with a chatty stdout,
 * a chatty stderr, and a large repr gets a third each. Allocating for the worst
 * case unconditionally would shrink the common case to buy insurance it never uses.
 *
 * `parts` counts the inline parts present at render time (1-3).
 */
export function cellInlineAllowance(budget: CellOutputBudget | undefined, parts: number): number {
  const budgetChars = budget?.resultBudgetChars;
  if (!budgetChars || budgetChars <= 0) return CELL_OUTPUT_WINDOW_BYTES;
  const share = Math.floor((budgetChars - CELL_RENDER_HEADROOM_BYTES) / Math.max(1, parts));
  return Math.max(CELL_OUTPUT_MIN_PART_BYTES, Math.min(CELL_OUTPUT_WINDOW_BYTES, share));
}

export function createCellOutputCapture(
  chatId: string,
  cellId: string,
  onUpdate: () => void,
  budget?: CellOutputBudget,
): CellOutputCapture {
  const shortId = cellId.slice(0, 8) || "cell";
  const spillAllowed = budget?.spillAllowed !== false;
  const make = (stream: "out" | "err") =>
    createOutputCapture({
      limits: {
        maxBytes: CELL_OUTPUT_WINDOW_BYTES,
        maxLines: CELL_OUTPUT_MAX_LINES,
        retain: "tail",
      },
      spill: spillAllowed
        ? {
            path: createSpillPath(chatId, "py", `${shortId}-${stream}`),
            maxBytes: DEFAULT_SPILL_MAX_BYTES,
          }
        : undefined,
      onUpdate,
    });
  return {
    stdout: make("out"),
    stderr: make("err"),
    spillAllowed,
  };
}

function pointerLine(
  stream: string,
  snapshot: CaptureSnapshot,
  allowance: number,
  uncapturedReason?: string,
): string {
  const total = snapshot.truncation.totalBytes;
  // The inline amount is what the reader actually gets: the capture window or the
  // render allowance, whichever is smaller.
  const shown = Math.min(snapshot.truncation.outputBytes, allowance);
  // The snapshot, not a caller's flag, decides whether a path may be named: a
  // promise to read_file a file that was never written is worse than none.
  const where = !snapshot.spillPath
    ? `no copy was written${uncapturedReason ? ` (${uncapturedReason})` : ""}`
    : snapshot.capped
      ? `copy capped at ${formatSize(DEFAULT_SPILL_MAX_BYTES)}, later output not captured -> ${snapshot.spillPath}`
      : `full output -> ${snapshot.spillPath}`;
  return `  ${stream}: ${formatSize(total)} total, last ${formatSize(shown)} inline; ${where}`;
}

/**
 * The pointer header. Renders only when something was truncated, and always at
 * the front of the result. Empty string when the cell's output fit inline.
 */
/**
 * The pointer header, reporting the inline amount the reader actually receives.
 * `allowance` is the render-time share from `cellInlineAllowance`; a stream is
 * announced when the capture truncated it *or* the allowance trims it further.
 */
export function renderOutputPointers(
  stdout: CaptureSnapshot,
  stderr: CaptureSnapshot,
  allowance: number,
  uncapturedReason?: string,
): string {
  const lines: string[] = [];
  const announced = (s: CaptureSnapshot) =>
    s.truncation.truncated || s.truncation.outputBytes > allowance;
  if (announced(stdout)) lines.push(pointerLine("stdout", stdout, allowance, uncapturedReason));
  if (announced(stderr)) lines.push(pointerLine("stderr", stderr, allowance, uncapturedReason));
  if (!lines.length) return "";
  // The instruction line promises a file, so it only appears when a line below it
  // actually names one. Telling the model to read_file a path that does not exist
  // is worse than telling it the output is gone.
  const hasPath = lines.some((line) => line.includes("-> "));
  const title = hasPath
    ? "[output truncated — read_file the paths below for the full streams]"
    : "[output truncated — the full streams were not captured]";
  return [title, ...lines].join("\n");
}

/** Tail windows only, stdout then stderr. No pointers: see renderOutputPointers. */
export function renderCellWindows(
  stdout: CaptureSnapshot,
  stderr: CaptureSnapshot,
  maxBytesPerStream?: number,
): string {
  const keepTail = (text: string) =>
    maxBytesPerStream && text.length > maxBytesPerStream ? text.slice(-maxBytesPerStream) : text;
  const parts: string[] = [];
  const out = keepTail(stdout.text.trimEnd());
  if (out) parts.push(out);
  const err = keepTail(stderr.text.trimEnd());
  if (err) parts.push(`[stderr] ${err}`);
  return parts.join("\n");
}

/** Settled result: pointers, then the inline windows. */
export function renderCellOutput(
  stdout: CaptureSnapshot,
  stderr: CaptureSnapshot,
  budget?: CellOutputBudget,
): string {
  const allowance = cellInlineAllowance(budget, countInlineParts(stdout, stderr));
  const header = renderOutputPointers(
    stdout,
    stderr,
    allowance,
    budget?.spillAllowed === false ? "no spill store is reachable from this kernel" : undefined,
  );
  const windows = renderCellWindows(stdout, stderr, allowance);
  if (!header) return windows;
  if (!windows) return header;
  return `${header}\n${windows}`;
}

/**
 * The capture window is 100 KiB regardless of the render allowance, so a stream
 * between the allowance and the window can be trimmed at render time without
 * having crossed the capture's spill threshold. The trimmed bytes existed only
 * in memory and the pointer could only say "no copy was written".
 *
 * Before rendering, write any such full window to a spill file so the pointer can
 * name it. Streams that already spilled are untouched (their file has the whole
 * stream), and remote kernels opt out because their `read_file` cannot reach this
 * store. A failed write leaves the honest no-copy pointer in place.
 */
export async function spillTrimmedStreams(input: {
  chatId: string;
  cellId: string;
  stdout: CaptureSnapshot;
  stderr: CaptureSnapshot;
  allowance: number;
}): Promise<{ stdout: CaptureSnapshot; stderr: CaptureSnapshot }> {
  const shortId = input.cellId.slice(0, 8) || "cell";
  const spillOne = async (
    snapshot: CaptureSnapshot,
    stream: "out" | "err",
  ): Promise<CaptureSnapshot> => {
    if (snapshot.spillPath) return snapshot;
    if (snapshot.text.length <= input.allowance) return snapshot;
    const path = createSpillPath(input.chatId, "py", `${shortId}-${stream}-trim`);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, snapshot.text, "utf-8");
      return { ...snapshot, spillPath: path };
    } catch (error) {
      console.warn(`[kernel-output] failed to spill trimmed ${stream} output:`, error);
      return snapshot;
    }
  };
  return {
    stdout: await spillOne(input.stdout, "out"),
    stderr: await spillOne(input.stderr, "err"),
  };
}

/** Inline parts present: a stream that produced nothing gets no share. */
export function countInlineParts(stdout: CaptureSnapshot, stderr: CaptureSnapshot, repr?: string | null): number {
  let parts = 0;
  if (stdout.text.trimEnd()) parts++;
  if (stderr.text.trimEnd()) parts++;
  if (repr) parts++;
  return Math.max(1, parts);
}

/**
 * A cell's last-expression repr is capped separately from stdout: a 1 MiB repr
 * would otherwise land in the model's context after the output window did its
 * job. Kept inline and head-kept — a repr is informative from the front, where a
 * print stream is informative from the end — and not spilled, because a stateful
 * kernel leaves the value bound: the marker tells the cell how to re-emit it.
 */
export function capCellResultText(text: string | null, limitChars = CELL_RESULT_TEXT_LIMIT_CHARS): string | null {
  if (!text || text.length <= limitChars) return text;
  const marker = `\n... [result truncated: ${formatSize(limitChars)} of ${formatSize(
    text.length,
  )} kept from the front. The value is still bound in the namespace — re-emit a slice (repr(x)[:5000]) or write it to a file and read_file it]`;
  const keep = Math.max(0, limitChars - marker.length);
  return `${text.slice(0, keep)}${marker}`;
}
