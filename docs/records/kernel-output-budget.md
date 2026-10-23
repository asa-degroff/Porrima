# Kernel Cell Output Budget — Measurements and Witnesses

Run date: 2026-10-22. Reviews commit `5c6dafaf` (foreground cell capture + spill) and
the follow-up fixes in `kernel-output.ts` / `python-kernel.ts` / `porrima_kernel.py`.

## The budgets in play

| Layer | Number | Owner |
| --- | --- | --- |
| Driver frame | 64 KiB per write | `porrima_kernel.py` `_STREAM_FRAME_TEXT_CAP` |
| Driver per-cell forwarding ceiling | 64 MiB per cell per stream (new) | `porrima_kernel.py` `_MAX_CELL_STREAM_BYTES` |
| Cell capture window | 100 KiB (unchanged) | `kernel-output.ts` `CELL_OUTPUT_WINDOW_BYTES` |
| Cell inline allowance | `min(100 KiB, (budget − 8 KiB headroom) / parts)`, floor 4 KiB (new) | `kernel-output.ts` `cellInlineAllowance` |
| Live streaming view | 16 KiB per stream (new) | `kernel-output.ts` `CELL_VIEW_BYTES` |
| Spill file | 64 MiB | `tool-output-store.ts` `DEFAULT_SPILL_MAX_BYTES` |
| Tool result wrapper | `max(8000, contextWindow * 4 * 0.15)` chars, head-kept | `agent-tools.ts` `getMaxToolResultChars` |

Wrapper budgets: 157,286 chars at a 262,144-token context window; 76,800 at 128,000.
The wrapper is the only layer that inspects the result, and it cuts from the head
without knowing what it is cutting.

## Why the allowance is split at render time, not fixed at capture time

The first version sized each part to a quarter of the budget at capture time. That fixed
the overflow and quietly made the common case worse: a cell that prints on stdout only
showed 39,321 characters inline instead of 102,400, paying for insurance it never used.
The capture now always keeps the 100 KiB ceiling and spills everything past it; the
render step splits the wrapper's budget across the parts that actually exist
(`countInlineParts`), with 8 KiB of headroom for the header, a traceback, and the markers.
Measured at a 262k window: one chatty stream → 102,400 inline (unchanged); two → 74,547
each; three → 49,698 each. The suite pins both directions — a witness that hardcodes
`countInlineParts` to 3 fails the single-stream test, so over-shrinking is as guarded as
overflow.

## What the pre-fix shape measured

Before the fix each inline part used the 100 KiB ceiling independently:

- stdout window 102,400 + footer + stderr window 102,400 + footer + repr 102,400 ≈ **307 KB**
  against a 157,286-char wrapper budget.
- The cut landed after stdout's window and footer, mid-stderr: the stderr spill pointer
  and the whole repr were removed.
- On the error path `formatError` puts the traceback first and the output after, so the
  same cut removed the stderr pointer, and the error branch's own marker
  (`[Error output truncated: NKB → MKB]`) names no spill file at all.
- At a 128k context window the wrapper budget (76,800) is smaller than a single
  ceiling-sized window (102,400): a cell that spilled **one** stream lost its own pointer.

## Witnesses

Each fix was reverted to the shape it replaced and the suite re-run. All five fail.

| Mutation | Test | Result |
| --- | --- | --- |
| Pointers appended at the tail instead of the header | `keeps the pointer header ahead of a traceback` | fails |
| Allowance always the ceiling (no split) | `composes a whole three-part result under the wrapper budget` | fails: **307,511 > 157,286** — the pre-fix total, reproduced |
| `countInlineParts` hardcoded to 3 | `keeps the full inline window when only one stream is chatty` | fails (inline drops to 49 KB) |
| `spillAllowed` forced true for a remote host | `truncates a remote cell honestly` | fails |
| Driver ceiling disabled | `stops forwarding at the driver's per-cell ceiling` | fails |
| Live view ships the full window | `streams a live view far smaller than the settled window` | fails |

The header-wording fix was found *by* a test failing: the header's instruction line
(`read_file the paths below`) rendered even when nothing was spillable, telling the model
to read a file that does not exist. A clean run against the wrong expectation is what
caught it.

## Field measurements (integration tests, real driver)

- `print("A"*2_000_000)` + `print("B"*200_000)` with a 157,286-char budget → result
  **102,595 chars** (header + the full 102,400-char window — one chatty stream keeps the
  whole ceiling), opening
  `[output truncated — read_file the paths below for the full streams]` /
  `stdout: 2MB total, last 38KB inline; full output -> …`; the named file holds
  **2,200,002 bytes** and contains the second print.
- `print("C"*1_500_000)` then `raise ValueError("boom")` → isError, content under budget,
  `full output ->` inside the first 1,024 characters, `ValueError: boom` present.
- `for i in range(20000): print('x'*200)` → 4 MB printed; every live view ≤ **16,384**
  chars (2 ticks), settled result 102,506 chars. The view cost is duration, not
  duration × window.
- 3,000,000-char print with the ceiling set to 1 MiB → marker present, reported total
  `1MB` (forwarded bytes, not printed bytes).
- Fake remote host (`kind: "ssh:test"`, local driver process) + 500 KB print → header reads
  `full output not captured (the kernel runs on another host)`, no path named, no file written.

## Found while measuring

`workspace.ts` imports `renderCellOutput` for the **one-shot** path (`runSupervisedPython`,
model-facing branch), so the kernel cell and one-shot `run_python` already shared one
renderer. Changing that renderer to lead with pointers covers both — which is how
`one-shot-python-supervision.test.ts` failed during this pass: it asserted the old footer
wording (`saved to`). It now asserts the header wording and that the path is named.

That test also proved the honesty rule needed to be derived rather than passed. The first
version of the header took a `spillAllowed` flag from the caller and always rendered the
instruction line, so a remote cell was told to `read_file` paths below a header that named
no file. The header now decides from `snapshot.spillPath`: no file, no promise.

## Follow-ups after this run

- **Bash now follows the same two rules.** `runStreamingBash` and the remote
  SSH wrapper render a pointer header before the tail and derive the settled
  window from the caller's `resultBudgetChars`. The remote command prints the
  header before `tail`, so a head-keeping wrapper cannot remove the path.
  Witnesses: `bash-output-budget.test.ts` (local header, budget-sized window,
  spill file, no header when the output fits) and `workspace-ssh-paths.test.ts`
  (header before `tail -c`, budget-sized tail).
- **Sub-ceiling streams are spilled at render time.** A stream under the
  100 KiB capture ceiling can still exceed the render allowance (three parts,
  or a small context budget). `spillTrimmedStreams` now writes that full window
  to a spill file before rendering, so the pointer names a real copy instead of
  "no copy was written". Witnesses: the unit case in `kernel-output.test.ts`
  and the real-driver case `fg-trim` in `python-kernel.test.ts`.

## One settle path

`finalizeBoundedOutput()` in `kernel-output.ts` now owns the order: allowance from
the parts that exist → spill any stream the allowance will trim → header → windows
→ capped repr. `renderCellOutput()` is gone. Foreground cells (`settlePending`) and
one-shot `run_python` (`runSupervisedPython`) both settle through it, and one-shot
finally receives the wrapper budget: `resultBudgetChars` threads from
`getMaxToolResultChars(contextWindow)` through `WorkspacePythonOptions` into the
capture sizing, so the producer's window is budget-sized too. Bash shares the
allowance derivation and the header-before-body placement, and deliberately keeps
its own header wording — its spill always holds the whole stream, so the wording
that names `read_file(path=…, offset=N)` inline is the useful one there.

Measured at a 30,000-character wrapper budget (allowance 21,808 for one stream,
10,904 for two):

| Case | Result |
| --- | --- |
| 15,001-char stdout + 1,000-char stderr | header `15KB total, last 10KB inline; full output -> …`, one spill file `py-<id>-out-trim.txt` holding **all 15,001 characters**, result 12,263 chars |
| 40,001-char stdout | the budget-sized capture truncates and spills at the source: one file, **no `-trim` suffix**, holding all 40,001 characters; result ≤ 30,000 |

Witnesses, each a revert of what it guards:

| Mutation | Result |
| --- | --- |
| Trim-spill unwired inside `finalizeBoundedOutput` | **2 failures** — the new one-shot band case and `fg-trim` in `python-kernel.test.ts`. One owner, both producers |
| `resultBudgetChars` not threaded to the one-shot path | both one-shot budget cases fail |
| One-shot capture keeps its old 100 KiB ceiling | exactly the capture-sizing case fails (a `-trim` copy appears where the capture should have spilled) |
| Header suppressed in `finalizeBoundedOutput` | **10 failures** across three files |

Two cleanups rode along. `formatSpillFooter` (and its private `formatMib`) had no
production caller left once bash moved to a header, so it is removed — a tested but
unused export is how the tail-placed shape gets reachadopted — along with its two
tests and its line in `pi-1.0-migration.md` §4.2, which lists the module's surface
and had become drift. `kernel-output.ts`'s private `formatSize` duplicated the
exported `formatCapLabel`; one formatter now exists, plus `formatInlineLabel` for
the promise direction. The migration document's prose about byte-stable footer
wording stays: it describes why spill paths are short per-call ids, which is still
true, and it is a record rather than a description of today's renderer.

`kernel-output.test.ts`'s three-part assertion moved from `last 49KB inline` to
`last 48KB inline`: the allowance is 49,698 characters = 48.5 KiB, and a label that
rounds a promise up claims bytes the reader does not get.

Suite after this run: 140 files / 1286 pass / 1 todo; tsc clean both sides.
