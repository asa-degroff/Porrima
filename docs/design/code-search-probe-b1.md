# Code-search battery v3 — probe run B1 (results)

**Status:** Probe complete (10-15, arm B only, T1/T2/T5 × 3, 9/9 runs, ~26 min).
**Author:** Qwen 3.8 Flash
**Date:** 2026-10-15

Companion to [code-search.md](code-search.md) §4.2. This is the *results* record
of the 9-run probe that §4.2's protocol mandates before spending the 45-run
three-arm battery: arm B (tool on, schema-only discovery, no routing line) on
the tasks with the sharpest v2 signal. It answers §4.2's two questions — did
the v3 surface (S1 model-level `code=` + S2 description v3, shipped in
5c74b605) collapse the T2 verification swamp, and is snippet mode actually
used? — and adds the one finding the battery decision should carry forward:
the residual T2 failure is a task-definition gap, not a surface gap.

## 1. Run configuration

```
# from server/, HEAD 5c74b605 (tree clean at start and finish)
PORRIMA_EVAL_CODE_SEARCH=1 PORRIMA_CODE_SEARCH=1 \
  npx tsx src/scripts/eval-code-search.ts --tasks 1,2,5 --reps 3 \
  --out /tmp/opencode/eval-code-search/probe-b1.jsonl
```

- **Arm:** B only (9 runs, sequential, own process; foreground turn-gate lease
  per run; shared the GPU with live traffic — llama-server queued both).
- **Model:** `Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp` — the same model as both v2 gate
  runs, so probe-vs-v2 comparisons are same-floor.
- **Surface proof:** the script's own arm/surface check passed (`arm=on` and
  `code_search` present in the tool registry).
- **Scope fence held:** `eval-code-search.ts` is byte-identical to v2
  (`git diff e31a12fb..HEAD -- server/src/scripts/eval-code-search.ts` = 0);
  no routing line in the harness prompt; censoring/aggregate machinery
  untouched; live service env kept `PORRIMA_CODE_SEARCH` off; **no runner
  fixes were needed**; wall time 13:50 → 14:16:47 (~26 min, inside the 20–40
  estimate).
- **Baseline luck:** the v2 arm-B jsonls survived at
  `/tmp/opencode/eval-code-search/gate-on.jsonl` + `gate2-on.jsonl`; every v2
  figure in this doc recomputes from them directly (the recorded table's
  "median iterations 14.5 / 54.6k" for T2 is the median over all six rows
  *including the five censored* — the convention this doc keeps for T2, since
  the probe's T2 completed none).

## 2. Per-run results

| task | rep | stop | iter | tokens | byTool | code_search | snippet | tool_err |
|---|---|---|---|---|---|---|---|---|
| T1 | r1 | stop | 3 | 11,377 | bash×2, cs×1 | ✓ | 0/1 | 1 |
| T1 | r2 | stop | 3 | 10,984 | cs×1, bash×2 | ✓ | 0/1 | 0 |
| T1 | r3 | stop | 3 | 10,469 | cs×1, bash×1 | ✓ | 0/1 | 0 |
| T2 | r1 | **CENS** (600 s timeout) | 9 | 66,691 | cs×21, bash×2, lf×1 | ✓ | 6/21 | 0 |
| T2 | r2 | **CENS** (iter cap) | 17 | 26,225 | cs×7, bash×10, wf×1, ef×2, lf×1 | ✓ | 4/7 | 3 |
| T2 | r3 | **CENS** (iter cap) | 17 | 27,889 | cs×13, bash×7, wf×1, ef×2, lf×1 | ✓ | 9/13 | 1 |
| T5 | r1 | stop | 3 | 10,829 | cs×3, bash×1 | ✓ | 1/3 | 0 |
| T5 | r2 | stop | 3 | 16,973 | cs×3, bash×1, lf×1 | ✓ | 1/3 | 0 |
| T5 | r3 | stop | 4 | 11,455 | cs×3, lf×1 | ✓ | 1/3 | 0 |

Adoption **9/9**; 53 `code_search` calls total, **22 snippet calls**; 5 tool
errors; **0 false conclusions, 0 absence claims** across 9 runs.

**Human grading** (report appendix, per §4.1 — correctness is human by design):
T1 r1/r2/r3 all answered **5 call sites, all in `agent-tools.ts`, definition
correctly excluded** — correct vs oracle. T5 r1/r2/r3 all answered
**147 / 11** — correct vs oracle, each with an independent rg cross-check that
agreed. T2: no gradeable answers (all censored; per protocol their "answers"
are mid-turn narration and carry no fc flag).

## 3. Task-level verdicts vs the v2 arm-B baseline

| task | v2 arm B | probe B1 | movement |
|---|---|---|---|
| **T1** call sites | 6/6 done, iter 3.5, 11.1k tok, adoption 3/6, fc 0 | 3/3 done, iter 3, 10.98k tok, adoption 3/3, fc 0 | **no cost delta** (token parity), adoption doubled, one correct-count cross-check still paying rg's exit-1-on-no-match (the §1 cost-3 note, on the *bash* side) |
| **T2** one-param count | 1/6 done (the completer answered **758 vs oracle 4 — wrong**), all-rows iter 14.5 / 54.6k, run_python 3/6, adoption 4/6 | 0/3 done, all-rows iter 17 / 27.9k, run_python **0/3**, adoption 3/3, snippets 19/41 | **verification fixed; completion not.** Tokens halved, wall-clock to cap down ~40–55 %, scripting via `run_python` gone — but every run still drowned, in a *new* way (§4) |
| **T5** two-count | 6/6 done, iter 3.5, 16.4k tok, adoption 6/6, fc 0 | 3/3 done, iter 3, 11.5k tok, adoption 3/3, fc 0, snippets 3/9 | **improved, no regression**: −30 % tokens, snippet-verified pattern, count mode live |

## 4. The T2 finding: the swamp moved from the surface to the task

All three T2 runs did the *new* behavior perfectly and then died the same
death, for the same reason. Sequence, identical in r1/r2/r3:

1. **Snippet-first verification** (the S1 design target, 3/3). r1's opening
   narration: *"I'll first test my AST patterns against snippets to make sure
   they capture exactly what I need (including `async`, and excluding
   generators/overloads/arrows)."* r3: *"I'll verify the ast-grep patterns
   against test snippets before scanning."* The trap-list vocabulary in the
   narration is the S2 cheatsheet being read and used.
2. **The base scan returns the oracle's answer immediately** —
   `function $NAME($ARG) { $$$ }` → **4 matches in 3 files**, first message of
   every run. Pattern uncertainty: solved, cheaply, as designed.
3. **Then the model discovers the typed-return class.** r2's narration:
   *"The basic pattern catches both plain and `async` functions, but misses
   typed signatures and generic functions."* It scans
   `function $NAME($ARG): $RET { $$$ }` → **750 matches in 114 files**
   (`globs: ["!*.test.ts"]`, engine-exact — refereed at run time after the
   probe: same pattern/globs re-run returns 750/114; including test files,
   763/123; the snippet referee confirms the pattern matches *only*
   one-param-with-return-type declarations, never multi-param). The generic
   zero even renders the qualified absence correctly (*"no matches in
   server/src/services — 2 file(s) in scope are not scanned (.py×2)…"*).
4. **Two engine-verified numbers that cannot both be the answer** — 4 and 750 —
   and the run drowns in the contradiction: r1 paginated the 750 at 100/page
   × 8 until the 600 s timeout (66.7k tok, iter 9); r2/r3 retreated to
   scratch parsers written via **bash+node** (`/tmp/count-funcs.js`,
   `/tmp/count-one-param-fns.js` — surviving the anti-script clause by moving
   tool and changing intent: not counting what a pattern can match, but
   reconciling why two verified patterns disagree — epistemically *sound*, and
   exactly what the clause cannot see), hit `Cannot find module 'typescript'`
   (TS 7 native build) and the `/usr/bin/sg` = setgroups collision (§5, again),
   and capped at 16 iterations (271 s / 361 s).

**Why the contradiction has no in-task resolution:** the oracle's
complete-node pattern requires `{` immediately after `)` — it silently counts
*one-param declarations **without** return-type annotations*: 4. The task
prompt closes the shape list over arrows/methods/generators/overloads but
says nothing about typed returns, and by natural reading
`function name(oneParam) { ... }` describes `function foo(x: T): R { ... }`
too. The inclusive class is ≈754 members (4 + 750 non-test). §4.1's note that
"the complete-node trap applies to the oracle author exactly as it does to
the model" was true and understated: it is the same trap, pointed the other
way — the oracle's literalism is a *shape* choice the prompt never states.
The v2 off-arm swamped here too (17 iter / 36.6k pure bash+python); this is
not a code_search artifact.

**New behavioral signature worth noting:** each T2 run's first assistant
message batched 21–24 tool calls (parallel verification fan-out) — unseen in
v2's sequential-call traces. Iterations compressed (r1: 9) while calls per
run exploded (24). Battery metrics should read `iterations` beside `toolCalls`
for T2 with this in mind.

## 5. Snippet mode: used, correctly, at the designed rate

The §4.2 question ("is snippet mode actually used at all?") is answered yes,
with judgment:

- **22 of 53 `code_search` calls across the probe were `code=` snippets**: T2
  19/41 (all three runs), T5 3/3 runs exactly one, **T1 0** — correct
  non-usage: a call-site pattern is not shape-ambiguous, and the model did not
  ritualize testing.
- The calls do real work, not theater. T2 r1 ran an arity ladder
  (`function $NAME<$TP>($ARG)`, `<$TP, $TP2>`, `<$TP, $TP2, $TP3>` each tested
  against 1/2/3-type-param fixtures) to bound generic coverage. T2 r3 tested
  default args, destructuring, rest params, overloads, and export forms
  before scanning. T5 verified the binding shape of
  `throw new $X($$$ARGS)` (e.g. r2: `code="function f() { throw new Error(\"a\"); throw new CodeSearchError(\"b\", 42); }"`
  → *"2 matches in the snippet"*) then scanned.
- **The `maxMatches=1` count-mode hint — recorded unused in the v2 results —
  is now live**: T5 r1 and r3 counted with it ("147 matches in 46 files
  (showing 1 of 147)", one output line each); r2 pulled the full page.
- The honest-zero contract (§4.2 S1: *"a zero here is a pattern problem, not
  an absence"*) rendered correctly on every snippet path result; no run
  misread a snippet zero as absence. One apparent snippet/file result
  mismatch in first-pass transcript analysis was a toolCall↔toolResult
  **index-pairing artifact** — ID-paired extraction shows every call carrying
  its mode's own rendering.
- T5's shape is the §4.2 thesis in microcosm: **snippet-test → count-mode
  scan → rg cross-check → answer** in 3 iterations, ~11.5k tokens.

## 6. Oracle drift: none

All three probe oracles match the **corrected (gate2)** v2 oracle byte-for-byte:
T1 `5 call sites {"server/src/services/agent-tools.ts":5}`;
T2 `4 declarations: [createWrapResult, invalidateRouterCache, setHistoryDuration, setHiddenGpus]`;
T5 `total throws: 147; CodeSearchError throws: 11`. The 10-14→10-15 commits
(kv-snapshot, thinking-timer, S1/S2 itself) moved none — S1/S2 added no
`throw new` sites under `services/`, and the T2 class was untouched. (The
*report's* drift machinery did surface one historical oddity: T2's v2 oracle
string differs **between the two v2 runs** — "6 definitions" at `gate` vs
"4 declarations" at `gate2`. That is the `e31a12fb` script fix landing between
them — pre/post the `!*.test.ts` glob — not repo drift. The user-facing v2
table mixes both runs; this doc's baseline recomputes from both files as-is.)

## 7. What the 45-run battery should carry

The §4.2 protocol's decision rule: *"If the behavior does not move, selection —
not verification — is the binding constraint."* The probe says the opposite
about selection (9/9 adoption, 53 calls) and confirms S1/S2 on their own
axis (snippet verification live, run_python gone, count mode live, T1 parity,
T5 improved). The binding constraint on T2 is now the **task definition**,
which the v3 scope fence freezes. Consequences:

- **T2 will likely censor in all arms as written** — v2 off-arm (17 iter) and
  v3 arm-B (3/3 capped/timeout) both drown on the same 4-vs-750 ambiguity.
  Read its rows as diagnostics of the task gap, not as surface-vs-surface
  signal; the battery aggregate's completion guard should be interpreted with
  this in mind.
- **A future task fix** (post-fence, out of scope here, named so it can be a
  deliberate decision later): state the exclusion in the prompt ("declarations
  whose `)` is immediately followed by `{` — return-type-annotated ones do not
  count"), or re-word the oracle class to the inclusive one. Either edit makes
  T2 answerable by an honest model; the fence's point is that *this* battery
  cannot measure that fix.
- **The flip decision itself is not made here** — per §4.2 it follows from the
  three-arm battery's strict (B vs A) and nudge (C vs A) verdict lines. The
  probe supports proceeding.

## 8. Artifacts

- `probe-b1.jsonl` — 9 full rows (final answers survive the purge) and
  `probe-b1.log` — in `/tmp/opencode/eval-code-search/` (same dir as the v2
  baseline `gate-on.jsonl`/`gate2-on.jsonl`).
- Extraction/analysis used at grading time (kept for reuse against the 45-run
  battery): `analyze-probe.py` (per-run table + byTool + oracle-drift diff;
  note: pair toolResults by **call ID**, not index), `v2-t2-traces.py`,
  `t2-750-check.ts` (the engine referee), `t2-oracle-precompute.ts`.
- **Second referee (vela, 10-15, independent re-run against the live engine
  via the executor):** 750/114 (typed pattern, `server/src/services`,
  `!*.test.ts`) and 763/123 (unscoped) confirmed; the oracle's literal class
  is 4 under the same scope; the probe's per-run table, oracles, toolErrors
  (5) and zero false conclusions all match `probe-b1.jsonl` exactly.
- Eval chats purged post-grading (`--purge`, 9 deleted); `app.db` back to zero
  `eval[code-search]%` chats; repo tree clean at 5c74b605.
