# Code-search battery v4 — 54-run three-arm results (record)

**Status:** Complete (10-16, 12:55–16:02 MDT, 3 h 07 m). Both gate verdict lines print
**FAIL**; the §4.2 decision matrix line is therefore "both fail → surface stays dark".
Human grading found the cleanest substantive record of the program: 38/38 completed
runs correct, zero real false conclusions — and one oracle bug caught by the data
(§6, the headline finding).
**Author:** Qwen 3.8 Flash
**Date:** 2026-10-16

Companion to [code-search.md](../design/code-search.md) §4.2. This record covers battery v4 —
the same three-arm protocol as battery v3 (`code-search-probe-b1.md` is the v3-era
probe record) — run after two harness changes: the T2 redefinition/diagnostic
demotion (`4c89cbf5`) and the T3 redefinition arc v4-B → v4.1 (`1947dd49`,
`760749a8`). "v4" is numbering of the battery, not a new design generation.

## 1. What changed since battery v3, and why the runs are comparable

- **T2**: redefined prompt (return-type exclusion stated) + demoted to diagnostic
  (aggregate = T1+T3+T5). Probe B2 era established the redefinition works.
- **T3**: redefined twice this session (see §7): v4-B stipulated template-START
  semantics (oracle: whole-call scan + leftmost-token filter, truth 336/438), then
  v4.1 strict-A after probe B2 sized the behavior (single engine pattern, truth
  280 in 41 files). v3-era T3 rows are superseded, not baselines.
- **T6, T1, T4, T5**: definitions byte-stable. The T6 oracle was *found wrong* this
  battery (§6) — found, not yet fixed.
- Arms, reps, budgets, censoring, aggregates: exactly the v3 harness (`18b2be02`).
  Model unchanged (`Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp`) — the model-scoped clause of
  §4.1/§4.2 applies to every number here.

## 2. Run configuration and provenance

- Three sequential detached processes (setsid), one per arm, tasks 1–6 × 3 reps:
  `--arm a` (flag off) → `v4-a.jsonl`; `--arm b`/`--arm c` (`PORRIMA_CODE_SEARCH=1`)
  → `v4-b.jsonl`/`v4-c.jsonl`. All `exit=0`, 18 rows each, no infra censorings —
  every `aborted` row is a real 600 s wall timeout or the 16-iteration cap
  (verified: the lowest-iteration aborts sit at exactly 600 s elapsed).
- **Pre-flight, learned from v3's contamination incident** (1,680 build artifacts
  materialized mid-battery in v3 and poisoned two engine-oracle tasks): launch-time
  `git status` = 0 entries at `e64d5507`, router healthy, and the committed
  T2/T3/T6 oracles re-executed on the live tree before launching (4 / 280 / stored-1398).
  Zero tree changes during the run; **zero drift warnings** in the final report.
- Wall: arm A 52 m, arm B 70 m, arm C 65 m. 54 eval chats purged after grading;
  `eval[` extraction firewall held; live service env never flipped.

## 3. Results table

Medians over completed reps; ⚠ marks machine fc-flags (all three graded as
detector artifacts, §5); adopt = runs with ≥1 `code_search` call; snip =
`code=`-calls / total calls.

| task | | A (off) | B (schema-only) | C (+ routing line) |
|---|---|---|---|---|
| T1 | done · iter · tok | 3/3 · 3 · 9,958 | 3/3 · 4 · 11,120 · adopt 2/3 · snip 0/3 | 3/3 · 3 · 11,470 · adopt 2/3 · snip 0/2 |
| T2 (diag) | | 1/3 · 8 · 17,282 | 3/3 · 11 · 18,359 · adopt 3/3 · snip 10/14 · **fc 2⚠** | 3/3 · 8 · 46,064 · adopt 3/3 · snip 5/12 |
| T3 (v4.1) | | 0/3 (capped; parser archaeology) | 0/3 (2 cap, 1×600 s — **adopt 3/3**, tool-path drowned) | **2/3 · 5.5 · 42,798** · adopt 2/3 · snip 3/16 — both completions exactly 280 |
| T4 (diag) | | 3/3 · 3 · 8,758 | 3/3 · 4 · 9,647 · adopt 1/3 | 3/3 · 2 · 9,478 · adopt 1/3 |
| T5 | | 3/3 · 4 · 10,136 · **fc 1⚠** | 3/3 · 3 · 16,646 · adopt 3/3 · snip 0/5 | 3/3 · 5 · 11,607 · adopt 2/3 · snip 2/6 |
| T6 (diag) | | **2/3 · 10.5 · 24,189** — both correct at 1,406 (§6!) | 0/3 · adopt 1/3 · snip 4/8 | 0/3 · adopt 3/3 · snip **30/36** — all three met the trap, all capped/timed out |

Censored: 16/54 (A 6, B 6, C 4). Completed: **38/38 human-correct** — every
completed run in the battery stated its task truth exactly (5 sites · 4
declarations · 280 · 6 · 147/11 · 1,406). Zero wrong answers were ever delivered;
zero real false conclusions.

## 4. T2 drowning modes (the redefinition's verdict)

| | r1 | r2 | r3 |
|---|---|---|---|
| A | completed-correct (own AST + grep cross-check, 8 it) | script-swamp | script-swamp |
| B | completed-correct ⚠(fc artifact) | completed-correct ⚠(fc artifact) | completed-correct |
| C | completed-correct (55.1k tok) | completed-correct (18.3k) | completed-correct (46.1k) |

6/6 on-arm reps completed, all correct — vs the v2-era 1/6-and-wrong and v3-era
censoring. The stated exclusion killed the contradiction mode; what remains is the
verification compulsion (C's read_file×3-5 sweeps) and the off arm's parser draw.
c-r2's note shows the stipulation fully internalized: it identified the *tool
description's own example strings* (`function $NAME($ARG) { $$$ }` in
agent-tools.ts / code-search.ts comments) and excluded them as non-declarations.

## 5. The three fc-flags — all verified artifacts

Each flag fired on exclusion-note or qualifier wording beside a correct, committed
count; none is a false conclusion.

| row | correct answer | what tripped the detector |
|---|---|---|
| a T5 r1 | 147/11 (sum 131+11+2+1+1+1 shown in-answer) | "verify **none** of these are inside comments"; count-noun never adjacent ("147 line matches") |
| b T2 r1 | 4, table-form | "…none qualify" in the generics-review note; "same 4" non-adjacent |
| b T2 r2 | 4, table-form | "none of the four are async…" + exclusion list; "declarations" is not in the suppression-noun list |

This is the fourth sighting of the detector's word-sensitivity class (after the v2
colon-form fix `fea5b12f` and v3's b-T2-r3). Stored rows are data, not judgments —
flags recomputed at report time mean a one-line noun-list extension retro-silences
all three without touching transcripts. Left unfixed per the fence; open item (§10).

## 6. Headline: the T6 oracle was wrong, and the battery caught it

Three independent model ASTs — v3-era (b T6 r2: 1,406) and this battery's two
arm-A completions (a T6 r2/r3: **1,406** in 154 files, file-level tables in-answer)
— disagreed with the frozen engine oracle (1,398) by exactly +8. Forensics
(`t6-forensics.cjs`, `t6-recount.cjs`, raw napi, field-based):

- Structural enumeration (`if_statement` without `alternative` field; consequence
  a `return_statement`, or a `statement_block` whose single named child is one)
  returns **1,406 — matching the models file-for-file** (+4 compaction.ts, +1 each
  extraction-settings/memory-tools/request-log/skills).
- All eight misses share one shape: `if (cond) { /* comment */ return x; }` — a
  **leading comment inside the block**. In this binding (ast-grep napi 0.50, TS
  grammar) comments are significant children for pattern matching: the oracle's
  `if ($C) { return $R; }` structurally refuses them. The else-text-filter was
  exonerated (0 involvement — no WITH-ELSE witnesses in the diff).
- Re-grading consequence: **arm A's two T6 completions were correct against truth**;
  the 1,398 stored in their rows is the wrong reference. The v3-era b-T6-r2 (1,406)
  was also correct.

Engine facts this establishes, to pin per §3.1 discipline: (a) comments inside
statement blocks are match-significant; (b) statement patterns do *not* exclude a
trailing `else` (already known from the T6 design referee); (c) both belong on the
Risk-6 re-verify-on-bump list. T6 stays diagnostic so no gate number was affected —
but nothing T6 measures can be trusted until its oracle is fixed (§10 ①).

## 7. The T3 arc: B → probe B2 → v4.1 → probe B3 → battery

- **v4-B** (stipulated template-START class; oracle = whole-call scan +
  leftmost-token filter; truth 336/438; scope pin `!server/src/scripts` closes the
  peek channel that produced v3's only "completion"). Probe B2 (arm B × 3, 10-16):
  0/3 completed — truth side worked (r1's own parser hit the exact 336 mid-run,
  censored by its verification loop), selection did not ("AST semantics" primes the
  parser; 2/3 never touched the tool), and pattern enumeration failed live
  (`(`$T`, $$$REST)` → 3 vs census 19; left-nested chains) — exactly the referee's
  warning, paid for by the probe rather than the battery.
- **v4.1 strict-A** (the pre-committed demotion): class = one engine pattern
  `console.log(`$$$X`)`, truth 280 in 41 files. Probe B3 (arm B × 3): **2/3
  completed, 3/3 reached 280**; r2's trace is the designed behavior end to end —
  snippet-test of the wildcard class → full scan → skip-pagination for per-file
  attribution → **count-mode (`maxMatches=1`) control scan of the excluded scripts
  scope**, named in the answer as correctly excluded.
- **Battery**: A 0/3 (parser archaeology persists), B 0/3 (all adopted the tool —
  including one 600 s timeout *on the tool path* — sampling variance against B3's
  2/3), **C 2/3 completed, both exactly 280** — the routing line converted T3
  completions where schema-only did not (§4.2's nudge-gate hypothesis, supported at
  task level). But comparability did NOT return: the off-arm's 0/3 keeps the
  "no comparison" clause locked in both gate lines. v4.1 made the truth reachable
  by every path; it did not make the *off-arm* reach it in budget.

## 8. Oracle drift

**Zero drift warnings.** All stored oracles arm-consistent and equal to their
probe-era values: T1 `5 call sites {agent-tools.ts:5}` · T2 `4 declarations`
(the frozen four) · T3 `280 template-only … 41 files` · T4 `6 json.dumps` ·
T5 `147; CodeSearchError 11` · T6 stored `1398` consistently — correct as stored
values, wrong as truth (§6; the oracle bug predates this battery, not drift).

## 9. Gate verdicts — stated as printed

- **Strict (B vs A): FAIL.** turns a=7 b=7 **ok (tie)** · tokens a=20,094
  b=27,766 **WORSE** · completion 12/18 → 12/18 **ok** · false conclusions
  a=1 b=2 **WORSE** (both flags artifacts, §5) · **1 incomparable (T3)**.
- **Nudge (C vs A): FAIL.** turns a=7 c=8 **WORSE** · tokens a=20,094 c=23,077
  **WORSE** · completion 12/18 → 14/18 **ok (best of the program)** · fc
  a=1 c=0 **ok** · **1 incomparable (T3)**.
- **§4.2 decision matrix as printed:** both fail → the model-scoped verdict
  stands; the line holds until the model floor moves (the Qwen4 canary is the
  clock); the surface stays dark.

**Decomposition (reporting, not overriding).** v3's FAILs were pure-mechanical
(every measured axis won or tied for the on-arms). v4's are different: the on-arms
genuinely *lose* aggregate turns/tokens this battery. Two causes, both honest:
(1) **baseline draw variance** — arm A's T5 median was 25,922 tok in the v3
battery and 10,136 here on the identical definition (3-rep medians swing ~2.5×
across batteries; the aggregate is dominated by T5+T1, and T3 contributes nothing
when incomparable). Arm A drew cheap. (2) **verification cost is now the on-arm
tax** — correctness was bought at the top of the budget: C's T2 completions run
46k tok for the same 4 that A's lucky rep got at 17k; C's T3 completions pay
~43k for pages + control scans. Substantively (truth axis) the program's best run
ever — 38/38, zero real fc, two honest T3 completions, a self-caught oracle bug
via model/engine disagreement. Procedurally, under the §4.1 gate at reps=3 on this
model: FAIL, dark, as printed.

## 10. Open items (① and ③ fixed 10-16 by vela; ② and ④ remain decisions)

1. **T6 oracle fix — FIXED 10-16**: the four-pattern+text-filter oracle was
   replaced with the field-based structural enumeration (napi, `alternative`
   field check, comment-filtered block census); truth re-frozen at 1,406 and
   re-derived live against the executor the same day (814 brace-less, 402
   block, 181 bare, 9 bare-block); the comment-significance fact is pinned
   in the executor's module header and on the Risk-6 bump-verify list
   (code-search.md §7.6). Harness-only; battery unaffected (T6 is
   diagnostic).
2. **T3 comparability**: off-arm 0/3 persists under every T3 definition tried
   (textual, B, A) — the parse-it-right reflex costs >16 iterations/600 s. Options:
   demote T3 to diagnostic like T2 (aggregate becomes T1+T5 — a mechanism change,
   doc-owner call), or raise T3's budget (same class of change), or accept the
   locked clause as the accurate signal that this task, as posed, cannot complete
   in arm A on this model.
3. **fc detector — FIXED 10-16**: committed-count suppression is now
   modifier-tolerant (up to two words between count and noun: "147 line
   matches", "4 function declarations") and the noun list gained
   declarations/statements. Verified: the three battery-v4 artifacts
   recompute clean (both gate lines print fc ok/ok), the v2-era stored
   flag (gate-off T5 r2 — a fossil of the pre-colon-fix detector; the
   answer committed 147/11 and was human-graded correct) recomputes clean
   too, and absence answers without a committed count still flag.
4. **600 s wall vs parallel turns**: the low-iteration timeouts (3, 6, 6 iters at
   exactly 600 s) show parallel-burst turns can hit the wall at iteration 3.
   Budget tuning would be iteration-blind today.

## 11. Artifacts

`/tmp/opencode/eval-code-search/`: `v4-{a,b,c}.jsonl` (full rows incl. answers +
oracles; chats purged post-grading) · `v4-report.txt` (three-file report: tables,
both gates, appendix) · `v4-analysis.txt` (per-run byTool/snippets/modes) ·
`t3v4-referee.ts`, `t6-forensics.cjs`, `t6-recount.cjs`, `t6-miss-lines.cjs`
(engine referees; re-derives every number in §6) · `probe-b2.*`/`probe-b3.*` (the
T3 arc's probes) · `chain4.log` (per-arm exits). Harness: `18b2be02` (arms/T6/
gates), `1947dd49` (T3 v4-B), `760749a8` (T3 v4.1), `e64d5507` (B3 record);
battery ran at `e64d5507`, tree clean at close.
