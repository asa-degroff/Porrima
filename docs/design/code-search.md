# Code Search — structural code navigation for Porrima

**Status:** Design draft (10-13). Written for coding-agent review. Extends the
kernel-codemode doc — it is the concrete design behind the §4.3 Tier 1
`code_search` row and answers §7 Q9 (model-level wrapper first, in-kernel
projection second, outline deferred as its own feature).
**Date:** 2026-10-13
**Author:** quje. Every present-tense claim about ast-grep below is either
**verified** (installed `@ast-grep/cli@0.50.0` + `@ast-grep/napi@0.50.0` into a
scratch dir and ran it, 10-13) or tagged **read** (primary docs at
ast-grep.github.io) or **inferred** (design judgment). Measured numbers are
mine, from this machine, this corpus — not vendor claims.

## 1. Problem

Today the model's default for "where is this in the code" is a bash round-trip:

```
bash(command="rg -n \"pattern\" --type ts server/")
```

Four costs, per search:

1. **Regex authoring for code shapes.** `console\\.log\\(` matches strings,
   comments, and other languages' text. Expressing "a function named anything
   taking one argument" as regex is fragile; expressing it as a pattern
   (`fn $NAME($ARG)` or `function $NAME($$$ARGS)`) is what the syntax exists
   for. The failure mode is silent: the regex matches, wrongly.
2. **Unstructured output.** `file:line: text` parsed in context. No byte
   offsets, no metavariable bindings, no machine shape — anything downstream
   (counting, filtering, transforming) is text-munging in the model's head.
3. **No-matches is an error.** Both `rg` and `ast-grep` exit 1 on zero matches,
   and `workspace.bash` maps non-zero exit to `isError`. The model's most
   *expected* outcome (searched, found nothing) is delivered as a tool failure.
   (Verified for ast-grep 0.50.0: exit 0 = matches, 1 = no matches.)
4. **Iteration costs a round-trip.** Query → inspect → refine → query is
   four model turns when it is one thought.

The codemode thesis says the fix has two projections: a **model-level tool**
for the one-shot "where is this" (replacing the bash incantation with a first-
class call), and an **in-kernel projection** where the iterative
query→refine→loop case runs free in variables — the same projection pattern as
`read_file`, `bash`, `web_*`, and the memory reads already live in Phase A.

The engine is **ast-grep** (`ast-grep`, Rust, tree-sitter-based — "a hybrid of
grep, eslint and codemod", read): patterns are code-as-pattern, file
traversal rides ripgrep's `ignore` crate, and the parser stack was
deliberately re-scoped for agent workloads (the tree-sitter C core was
rewritten in Rust, dropping incremental old-tree reuse because "AI coding
agents analyze complete file snapshots" — fresh parsing is the agent
regime's normal operation, read). That last point matters: a fresh parse per
call is not a weakness of ast-grep, it is the workload it was tuned for.

**Scope.** This doc designs **search** (pattern → structured matches) and
**orientation** (named, deferred: §3.4). It does not design **rewrite** —
`ast-grep -r/--update-all` is structural file mutation and lands, if ever,
behind the codemode Phase B provenance seam (Tier 2 by construction).

## 2. Rationale (condensed — full lineage in kernel-codemode §2.5)

- **The field splits two ways: fresh agentic queries vs precomputed
  structural indices.** Aider's repository-map (tree-sitter parse →
  signatures → PageRank → binary-search fit into a token budget) is the
  precomputed side, and its own backfire conditions are the design brief:
  stale index on fast-changing repos, AST ≠ runtime under metaprogramming,
  small repos. Claude Code's counterpoint — deliberately *no index*; on-demand
  Glob/Grep/Read beat its RAG experiments — is the fresh side. Porrima
  commits to the fresh side: no per-project build step, no stale index, no
  orientation payload parked in context. ast-grep's fresh-parse regime is
  exactly this commit, with the parser tuned for it (read, via §2.5).
- **Why not ast-grep's own MCP server.** The official MCP (four tools:
  `find_code`, `find_code_by_rule`, `test_match_code_rule`,
  `dump_syntax_tree`, text output ~75% fewer tokens than JSON, read) exists to
  give the model a test loop for rule authoring — every iteration costs
  context tokens. In the kernel the identical loop is free in variables. The
  MCP's tools map one-to-one onto what a kernel program can already do; the
  kernel projection makes the MCP redundant for us, and it is the strongest
  concrete instance of the codemode thesis yet.
- **Speed, honestly measured (verified, 10-13, this machine).** On
  `server/src` (~200 TS files), a pattern scan: `ast-grep` **0.050 s wall /
  0.362 s user** vs `rg` **0.010 s wall / 0.004 s user** for the same query.
  On small corpora the process-startup + parse cost dominates and rg wins the
  wall-clock race. The vendor's throughput claims (10× regex, parser
  +30%/e2e ~22%, read) are plausible at scan scale but are *not* what this
  tool buys. What it buys is **precision and structure**: the match is a
  parsed node with byte offsets and metavariable bindings, not a line of
  text. Speed is roughly parity-to-slightly-worse per call, which is why
  per-call scoping and budgets are first-class (§3.2, §7), not an afterthought.
- **The kernel makes it strictly more useful than model-level alone** — the
  rule-authoring loop, the pattern-syntax on-ramp (§3.3, §7).

## 3. Design

### 3.1 One executor, two projections

New module `server/src/services/code-search.ts` — the single executor,
following the Phase A projection pattern (one implementation; model-level
tool and kernel dispatcher both ride it):

```ts
export interface CodeSearchMatch {
  file: string;              // workspace-relative
  start: { line: number; column: number };
  end:   { line: number; column: number };
  text: string;              // the matched node's source text
  metaVariables?: Record<string, string>;  // single + multi, flattened
}
export interface CodeSearchParams {
  pattern: string;
  path?: string;             // workspace-relative root; default = project root
  globs?: string[];          // gitignore-glob semantics; "!" prefix excludes
  lang?: string;             // ast-grep language; default = auto-detect from files
  context?: number;          // lines around each match (text projection only)
  maxMatches?: number;
}
export async function runCodeSearch(params, workspace, signal): Promise<CodeSearchResult>
```

**Local workspaces: in-process via `@ast-grep/napi`** — no subprocess, no
shell-quoting surface, version-pinned to the server's package.json. The 0.50.0
surface (verified from the package's `types/api.d.ts`): `pattern(lang,
pattern)` compiles a pattern into a matcher config; `findInFiles(lang,
config, callback)` "discovers and parses multiple files in Rust" and delivers
matched `SgNode`s; `parseFiles`/`parseAsync` for the snippet-testing case
(kernel rule loop). Note: this is the *new* napi API — the older
`matchSourceCode`/`matchRuleSourceCode` names do not exist in 0.50.0 (verified:
exports are `Lang, kind, parse, pattern, parseAsync, findInFiles,
registerDynamicLanguage, parseFiles, tsx, jsx, html, ts, css, js, SgNode,
SgRoot`). Signatures beyond the top-level ones get pinned during
implementation, not assumed here.

**The match JSON, exactly as ast-grep emits it (verified, 0.50.0):**

```json
{"text":"console.log(`value: ${msg}`)",
 "range":{"byteOffset":{"start":68,"end":96},
          "start":{"line":3,"column":2},"end":{"line":3,"column":30}},
 "file":"sample.ts","lines":"  console.log(`value: ${msg}`);",
 "charCount":{"leading":2,"trailing":1},"language":"TypeScript",
 "metaVariables":{"single":{},"multi":{"ARGS":[
    {"text":"`value: ${msg}`","range":{"byteOffset":{"start":80,"end":95},
     "start":{"line":3,"column":14},"end":{"line":3,"column":29}}}]},
  "transformed":{}}}
```

The executor normalizes this to `CodeSearchMatch` (dropping `lines`/
`charCount` at the boundary — context lines are a text-projection concern, not
a structural one).

**File discovery/ignore semantics:** one claim deliberately left unverified
here — whether `findInFiles` honors `.gitignore`-style ignores the way the CLI
does (the CLI rides ripgrep's `ignore` crate; the napi discovery path is
plausible but not measured). It is a slice-0 acceptance check, not an
assumption. If it does not, the executor filters through the same ignore
logic the adapter uses for `list_files`.

**Remote workspaces: the carve-out.** The server cannot parse files it cannot
read locally without N adapter reads. Two options, staged:
- **(b, first)** adapter-read + in-process parse: read the candidate files
  through the workspace adapter (scoped by `path`/`globs` first — discovery
  via `list_files`, then parse what matched), parse in the server. Works on
  every remote host with **zero new dependencies**; cost is read-then-parse
  latency on big trees, which scoping bounds.
- **(a, later)** `ast-grep` binary on the remote host, invoked through the
  remote bash path (host-owned, the Phase C shape — same dependency pattern as
  the spill store's host-side files). Only worth it once a remote repo's tree
  makes (b) measurably slow.

### 3.2 The model-level tool — Phase 0

**Name:** `code_search`. **Surface:**

```
code_search(pattern, path?, globs?, lang?, context?, maxMatches?)
```

**Output — compact text, not JSON.** The model-level result is an *index*,
not a document: one line per match, trimmed to the matched text, plus a
summary. JSON would spend context bytes on delimiters the model must not
parse:

```
47 matches in 12 files (showing 50)
server/src/services/agent-tools.ts:1048: toolDispatcher: kernelToolsEnabled() ? ...
server/src/services/agent-tools.ts:1106: return withMutationLock(`workspace:${...
```

**No matches is a clean value, not an error** — `0 matches in N files`. This
fixes cost #3 at the surface: the expected outcome stops being a failure.
Invalid patterns are tool errors carrying ast-grep's message verbatim
(including its suggestion when one is printed).

**Budgets, server-side** (the §4.9 principle — the caller cannot be trusted to
count itself): `maxMatches` default 50; output char cap default ~20 KB
(config knob); per-call timeout default 120 s (a repo-wide unscoped scan on a
large tree can be slow; scoping is the remedy, the timeout is the backstop).
The tool is **read-only and lock-free**: it never acquires
`workspace:<label>` and is not in `SEQUENTIAL_TOOL_NAMES` — parallel-safe,
exactly like `read_file`.

**Gating:** dark launch behind `PORRIMA_CODE_SEARCH=1`; the tool definition
ships only when the flag is on (the kernel-tools capability-line pattern —
zero schema bytes until flip). One honest cost this buys: a new tool
definition (~150 schema tokens in the prefix when on). It earns them by
*replacing a default*, not by adding a capability class the model would have
to learn to choose (§4).

**Description** carries a compact pattern cheatsheet plus three worked
examples — the on-ramp for pattern syntax lives where the tool is, because
the failure mode (cost #1) is authoring, not calling. Cheatsheet content
(inferred, to be validated against 0.50.0 in slice 0):
- `fn $NAME($$$ARGS)` / `function $NAME($ARG)` — structure with metavariables
- `$VAR = await $CALL()` — single metavariables bind; `$$$NAME` binds *lists*
- plain text with no metavariables is a **literal** match
- the classic trap (verified via `--debug-query`): `$$` is *not* a
  multi-element metavariable — it parses as a bare identifier named `$$`.
  Three dollars plus a name is the list syntax.

### 3.3 The kernel projection — Phase 1

One line on the dispatcher's exposure list (`createKernelToolDispatcher`),
same projection pattern as the other Phase A rows. Differences from the
model-level tool, both deliberate:

- **Structured output.** In the kernel, result bytes are free (they stay in
  variables), so the kernel projection returns the *normalized JSON shape*
  (`CodeSearchMatch[]`), not compact text. The model-level text is for
  context; the kernel JSON is for computation.
- **The rule-authoring loop** — the case the MCP exists for, made free:

  ```python
  snippet = await tools.read_file(path="server/src/services/turn-gate.ts")
  for pat in ["async function $NAME($$$ARGS)", "function $NAME($$$ARGS)"]:
      out = await tools.code_search(pattern=pat, path="server/src/services")
      # inspect out[i]["metaVariables"], refine, re-run — zero context per loop
  ```

  Write rule → test → inspect → revise, all in variables, nothing crossing the
  wire until the final result. The MCP's ~75%-tokens text output buys for
  context what the kernel gets for free — this is the codemode thesis in the
  concrete place §2.5 named.
- **Snippet testing without the filesystem** (the `parseFiles`/`pattern`
  napi path): a kernel program can test a pattern against a string it built,
  not just files — the `test_match_code_rule` MCP tool, in-kernel.

`code_search` joins the §4.3 Tier 1 row as designed (read-only; the density
case is query→loop→transform; the remote carve-out is §3.1's (b)-then-(a)).

### 3.4 Orientation — named, deferred, designed separately

`ast-grep outline` (verified: text `line: signature` per top-level symbol;
`--json` gives `{path, language, items: [{symbolType, name,
range: {byteOffset, ...}, signature, astKind, isImport, isExported}]}`) is a
*different job* from search — "where do I look next" vs "where is this". It
opens the project-context orientation seam noted in codemode §2.5
(outline entry → range-read by byte offset → transform, without full file
reads). It is **kernel-first** (zero schema bytes; on-demand mid-session
orientation is a kernel activity, and `list_files` covers the directory-tree
case at model level) and gets its own design section when it ships. This doc
names it so the review can reject the boundary if it is wrong.

### 3.5 Guardrails

- **Untrusted data.** Match text is file content — the data/instruction rule
  applies exactly as it does to `web_fetch` and `read_file` (the namespace
  `__doc__` carries it; the model-level tool rides the same framing).
- **Bounded output, server-side** (§3.2 budgets).
- **Fresh parse = no stale state.** There is no index to go stale; each call
  parses what it scans. The cost is CPU per call, which the budgets and
  scoping manage — and which is why a *precomputed* repo map (aider's
  lineage) remains out of scope: it would re-introduce the stale-state surface
  this design exists to avoid.

## 4. Fit with the existing tool set — and what it replaces

The question this doc is asked to answer is not "add a tool" but "make the
existing surface easier to use". The answer is a **default shift**, not a
capability removal:

| surface | today | after `code_search` |
|---|---|---|
| **searching code** | `bash(command="rg -n ...")` — regex authoring, text output, exit-1-on-no-match | **`code_search`** — pattern authoring, structured index, clean 0-match value |
| **searching text/non-code** (logs, configs, cross-file, binaries, remote) | `bash` + `rg` (rg 15.1.0 on this box) | unchanged — `rg` stays reachable and stays *the* tool for text search |
| **reading** | `read_file` | unchanged — search→read is still the loop; `code_search` replaces the *search half* with structure |
| **orientation** | `list_files` (+ ad hoc `ls` via bash) | unchanged now; `code_outline` deferred (§3.4) |
| **kernel `tools.*`** | `bash`/`read_file` cover search via `tools.bash("rg")` + Python text-munging | `tools.code_search` — structured, loop-free (§3.3) |
| **prompt/AGENTS.md guidance** | (implicit: "use rg") | one added line — *default to `code_search` for code; `rg` for text* (ast-grep's own AGENTS.md pattern, read) |

Why replacement-beats-addition: the model's decision surface grows with every
tool, and "search the code" currently has exactly one default (bash+rg).
`code_search` earns its schema bytes by *being that default* — one decision
("search code? call `code_search`") instead of two ("which regex? which
flags? how do I parse the output?"). It adds a capability class (structure)
while keeping the surface flat. Nothing is removed from `bash`: the escape
hatch for everything `code_search` doesn't cover — regex, non-code, binaries,
and (per §3.1) hosts where the napi platform matrix doesn't reach.

**Sequencing with the kernel:** the model-level tool is separable from
protocol v2 by construction (it is just another registry tool + executor) and
ships dark, so it can land independently of the Phase A flag — the codemode
Q9 lean, now concrete. The kernel row is one line on the existing exposure
list and follows as soon as the executor exists.

## 5. Dependency placement

- **`@ast-grep/napi@0.50.0` as a server dependency** (native prebuilds;
  install was 6 s on this box). Verified platform support matrix (package
  README, 0.50.0): Windows x64/arm64, macOS x64/arm64, **Linux x64 gnu** —
  Enceladus (Ubuntu x64) is covered. **musl and arm64 Linux are not in the
  matrix** — the fallback for those hosts is the `@ast-grep/cli` binary via
  the onboarding profiles, which is exactly why the CLI remains a supported
  execution path even where napi is not.
- **Name collision (verified on this box):** `/usr/bin/sg` on Enceladus is
  **util-linux's set-group**, not ast-grep. ast-grep is not installed here.
  Every reference in this design — code, docs, onboarding — uses
  `ast-grep` as the canonical name and **never** the `sg` short name on the
  host PATH. (ast-grep ships both `ast-grep` and `sg` binaries; the `sg`
  alias is fine inside a controlled install dir, not on a shared system PATH.)
- **Version-pinned** in package.json; the executor is written against the
  0.50.0 napi API (§3.1), so an upgrade is a reviewed bump, not a drift.

## 6. Staging

| phase | scope | gates |
|---|---|---|
| **0** | model-level `code_search`: executor (napi, local), tool definition, budgets, gating, tests (incl. the `findInFiles` ignore-semantics acceptance check, invalid-pattern error shape, 0-match clean value, budget stops) | dark; `PORRIMA_CODE_SEARCH=1` to flip |
| **1** | kernel dispatcher row + JSON projection + snippet-testing path (`pattern`/`parseFiles`) | rides the live kernel flag; one exposure-list line |
| **2** | remote carve-out (b): adapter-read + in-process parse; (a) host binary only if measured slow | the remote-kernel test bench (P4 smoke pattern) |
| **3** | `code_outline` — its own design section, kernel-first | deferred; boundary named in §3.4 |
| **4** | the one-line default shift in AGENTS.md / tool guidance | lands with phase 0's flip |

## 7. Risks

1. **Pattern-syntax learning cost (real, measured).** The `$$` vs
   `$$$ARGS` trap is not hypothetical — it is what a correct-looking pattern
   silently does (verified via `--debug-query`, 10-13). Mitigations: the
   cheatsheet in the tool description (§3.2), ast-grep's own
   `--debug-query` as the in-tool debugger, and the kernel rule loop (§3.3)
   where syntax errors are cheap to find. Residual: the model will still
   author bad patterns; the clean error surface keeps that recoverable.
2. **Fresh-parse cost on large repos (measured: startup-dominated below
   ~200 files; rg wins wall-clock there).** Mitigations: `path`/`globs`
   scoping as the primary lever, server-side budgets and the 120 s backstop,
   and honest docs that this tool buys precision, not speed.
3. **napi platform matrix gaps (musl/arm64 Linux, verified absent in 0.50.0).**
   Mitigation: the CLI fallback path (§5); remote hosts sidestep both via
   phase 2 (b) until (a) is earned.
4. **Output-volume blowout** (one query, 10k matches). Mitigation:
   `maxMatches` + char cap enforced server-side, summary line always present.
5. **API drift** (the napi surface changed underfoot — 0.50.0 has no
   `matchSourceCode`). Mitigation: version-pinned, executor isolated in one
   module, top-level signatures verified today and the rest pinned in
   slice 0.
6. **Staleness: none by design** — fresh parse per call. The risk is the
   inverse (someone later adding a cache); the design brief says the cache is
   how this feature goes wrong.

## 8. Open questions (review surface)

1. **Defaults:** `maxMatches` 50? context lines 1? output cap 20 KB?
2. **`lang` semantics:** auto-detect from file extensions (CLI default) vs
   require explicit when `path` is a single file. Lean: auto-detect, explicit
   override.
3. **`-k/--kind` selector mode** (match by node kind without a pattern — the
   CLI supports it): expose in v1 or defer. Lean: defer — pattern-only is the
   90% case, and kind selection is a power feature that costs description
   bytes.
4. **Remote carve-out order** (§3.1): (b) read-then-parse first vs (a) host
   binary first. Lean: (b) — zero new dependencies wins until measured otherwise.
5. **Budget knobs:** ride the existing implementation-settings surface or get
   their own env knobs (the kernel-tools pattern)? Lean: settings, with env
   overrides, matching the kernel-tools knobs' shape.
6. **Where the pattern reference lives long-term:** tool description
   (always in prefix) vs kernel-loadable reference on demand (the
   `llms-full.txt` principle, codemode §4.9). Lean: cheatsheet in the
   description now; the full reference kernel-side on demand once the
   cheatsheet is proven insufficient by usage.
7. **Does the model-level tool need the `metaVariables` in its text
   output?** (e.g. `...:1048 [toolDispatcher]: ...`). Lean: no — bindings are
   a kernel/computation concern; the text index stays one match per line.

## 9. Sources

- **Verified, 10-13, this machine** (installed + ran `@ast-grep/cli@0.50.0`
  and `@ast-grep/napi@0.50.0` in a scratch dir): `run`/`outline` usage and
  options; JSON match shape; outline JSON shape; exit codes (0 = matches,
  1 = no matches); the `$$`-is-an-identifier trap via `--debug-query=pattern`;
  speed measurement on `server/src` (0.050 s wall / 0.362 s user vs rg 0.010 s
  wall / 0.004 s user); napi exports and `pattern`/`findInFiles` signatures
  (`types/api.d.ts`); platform support matrix (package README); `/usr/bin/sg`
  = util-linux set-group on Enceladus; ast-grep not installed; rg 15.1.0
  present.
- **Read** (primary docs, ast-grep.github.io): `run`/`outline` reference;
  the tree-sitter Rust-rewrite blog post (agent-workload scoping); the
  prompting/AGENTS.md pattern and `llms-full.txt`; the official MCP
  (`ast-grep-mcp`, four tools, ~75% token delta claim).
- **kernel-codemode.md** (10-13): §2.5 (research round 3 — the full lineage:
  aider/agentpatterns/LlamaIndex, the fresh-vs-precomputed split, the kernel
  insight), §4.3 (Tier 1 `code_search` row), §7 Q9 (the open questions this
  doc answers and its recorded lean), §4.9 (server-side budgets, lock rules,
  the remote carve-out principle), §4.10 (Phase A projection pattern).
- **Inferred** (design judgment, marked as such in §3–§4): the two-projection
  staging, the default-shift framing, the output-format choices, the
  cheatsheet content, the phase-2 (b)-before-(a) order.
