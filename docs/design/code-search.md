# Code Search — structural code navigation for Porrima

**Status:** Phase 0 implemented — model-level `code_search` tool, dark behind
`PORRIMA_CODE_SEARCH=1`. Extends the kernel-codemode design: it is the concrete
design behind the §4.3 Tier 1 `code_search` row and answers §7 Q9 (model-level
wrapper first, in-kernel projection second, outline deferred as its own
feature). Phase 1 (kernel projection) rides the same executor.
**Date:** 2026-10-14

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
3. **No-matches is an error.** Both `rg` and `ast-grep` exit 1 on zero
   matches, and `workspace.bash` maps non-zero exit to `isError`. The model's
   most *expected* outcome (searched, found nothing) is delivered as a tool
   failure.
4. **Iteration costs a round-trip.** Query → inspect → refine → query is
   four model turns when it is one thought.

The codemode thesis says the fix has two projections: a **model-level tool**
for the one-shot "where is this" (replacing the bash incantation with a
first-class call), and an **in-kernel projection** where the iterative
query→refine→loop case runs free in variables — the same projection pattern as
`read_file`, `bash`, `web_*`, and the memory reads already live in Phase A.

The engine is **ast-grep** (Rust, tree-sitter-based — "a hybrid of grep,
eslint and codemod"): patterns are code-as-pattern, file traversal rides
ripgrep's `ignore` crate, and the parser stack was deliberately re-scoped for
agent workloads (the tree-sitter C core was rewritten in Rust, dropping
incremental old-tree reuse because agent analysis works on complete file
snapshots). A fresh parse per call is not a weakness of ast-grep; it is the
workload it was tuned for.

**Scope.** This doc designs **search** (pattern → structured matches) and
**orientation** (named, deferred: §3.4). It does not design **rewrite** —
`ast-grep -r/--update-all` is structural file mutation and lands, if ever,
behind the codemode Phase B provenance seam (Tier 2 by construction).

## 2. Rationale (condensed — full lineage in kernel-codemode §2.5)

- **The field splits two ways: fresh agentic queries vs precomputed structural
  indices.** Aider's repository-map (tree-sitter parse → signatures → PageRank
  → binary-search fit into a token budget) is the precomputed side, and its
  backfire conditions are the design brief: stale index on fast-changing repos,
  AST ≠ runtime under metaprogramming, small repos. Claude Code's counterpoint
  — deliberately *no index*; on-demand Glob/Grep/Read beat its RAG experiments
  — is the fresh side. Porrima commits to the fresh side: no per-project build
  step, no stale index, no orientation payload parked in context.
- **Why not ast-grep's own MCP server.** The official MCP (four tools:
  `find_code`, `find_code_by_rule`, `test_match_code_rule`,
  `dump_syntax_tree`) exists to give the model a test loop for rule authoring
  — every iteration costs context tokens. In the kernel the identical loop is
  free in variables. The MCP's tools map one-to-one onto what a kernel program
  can already do; the kernel projection makes the MCP redundant for us. The
  field has started shipping the MCP's shape at *model* level (pi-ast-grep's
  six-tool stack, §2.4); Phase 0 is the deliberately narrower version of that
  bet — one tool, not six — and the kernel row is the argument the other five
  don't need to exist as schema once the loop lives in variables.
- **Speed, honestly measured.** On `server/src` (~200 TS files) a pattern scan
  runs at roughly parity to slightly-worse versus `rg` — process startup and
  parse cost dominate small corpora, and rg wins the wall-clock race there.
  The vendor's throughput claims are plausible at scan scale but are *not*
  what this tool buys. What it buys is **precision and structure**: the match
  is a parsed node with byte offsets and metavariable bindings, not a line of
  text. Which is why per-call scoping and budgets are first-class (§3.2, §7),
  not an afterthought.
- **The kernel makes it strictly more useful than model-level alone** — the
  rule-authoring loop and the pattern-syntax on-ramp (§3.3) are where the
  design pays out.

### Adoption survey: which agent harnesses use ast-grep, and how

The prior-art survey (kernel-codemode §2–§2.5) covered the engine lineages;
this section covers *adoption* — which agent harnesses put ast-grep in front
of a model, and in what shape. Five patterns in the field:

**1. The prompting layer** (no new tool). The official guide's simplest
pattern: a line in AGENTS.md — *"You are operating in an environment where
`ast-grep` is installed… default to using `ast-grep --lang [lang] -p
'<pattern>'`… avoid text-only search unless explicitly requested."* Field
reports from Claude Code users converge on **MCP for capability, skill for
judgment**: tools give power, skills give intelligence — a decision tree (code
structure → ast-grep; text, comments, logs, config → ripgrep) plus one line in
CLAUDE.md. Claude Code has no built-in ast-grep tool; adoption there is
entirely prompting/skill/MCP — consistent with its no-index stance.

**2. Skills** (progressive disclosure of when/why/how). The official skill
(`ast-grep/claude-skill`) and community variants. The most instructive is the
Hermes Agent skill: it ships a Python wrapper that **validates patterns
offline before invoking `sg`** (regex-shaped patterns get a hint and never
reach the binary), and documents three internalized pitfalls — (1) ast-grep is
not regex (`foo|bar` is a bitwise-or expression; `.*foo` and `\w+` don't
parse), (2) patterns must be valid code (`def $FN($$):` fails on the trailing
colon), (3) `--update-all` and `--json` are **silently mutually exclusive** —
preview-then-apply must be two passes. Its routing rule: "does the answer
depend on the language's syntax tree, or just on the file's bytes?"

**3. MCP** (capability over the protocol). The official experimental
`ast-grep-mcp` (the rule-development loop: decompose → sub-rules → combine →
revise → dump AST → test snippet) and community servers. This is the pattern
the kernel projection replaces — see §2 above.

**4. Harness-native tools** (first-class tools inside the agent) — the pattern
this doc designs into. The pi ecosystem alone has four independent
implementations:

- **pi-ast-grep** (code-yeongyu, a faithful port of the oh-my-openagent tool
  stack): `ast_grep_search` + `ast_grep_replace` (**dry-run by default**),
  `lang` **required**, compact text output (`file` → `line:col` → text), an
  anti-pattern table that detects regex-shaped patterns and **nudges the model
  toward grep**, and a six-step binary resolver (cached download → npm →
  platform packages → PATH → Homebrew → GitHub auto-download) with an
  explicit trust-model caveat.
- **oh-my-pi** (`packages/coding-agent/src/tools/ast-grep.ts`): a single
  `ast_grep` tool with schema `{pat, path?, lang?, skip?}` — `skip` is the
  only pagination parameter, the limit is a hardcoded `DEFAULT_AST_LIMIT = 50`
  (converges with this design's `maxMatches` default), and a bounded retention
  buffer keeps the best matches across multiple search targets in a pinned
  order (path → line → column → byte). Runs in-process, but **not through
  `@ast-grep/napi`**: the `pi-natives` Rust addon links `ast-grep-core`
  directly (50+ grammars, runtime provisioning via `ensureGrammar` /
  `rerunWithGrammars`). `lang?` is an **optional override over auto-detect**
  ("cpp for ambiguous .h files"). Per-file parse errors are collected and
  reported separately (capped, with totals); when parse errors exist, its
  zero-match text is a **qualified absence** ("the query may be mis-scoped;
  narrow `path` before concluding absence") and the empty result is marked
  `useless()` for compaction; the model text carries `meta: NAME=value` lines
  for matches with bindings. Approval class `read`; lazy tool loading
  (`loadMode: discoverable`); the tool description lives in a rendered prompt
  file with five worked examples; structured details ride alongside the
  model-facing text.
- **@juvio15/pi-ast-grep** (pi.dev): six tools over a CLI subprocess —
  `ast_grep_run` (**pattern *or* kind**, plus a `code=` snippet mode that
  runs the §3.3 snippet-testing case at *model* level), `ast_grep_scan` (YAML
  rules), `ast_grep_rewrite` (preview default, `apply` opt-in), a live
  **`ast_grep_outline`** ("map a file before you read it"),
  `ast_grep_debug_query` (pattern debugging as a tool), and
  `ast_grep_languages` (a language catalog *is* a tool). Injects a bounded
  "promotion" guidance block into the system prompt only while its tools are
  active — a dynamic version of §4's one-line default-shift.
- **pi-ast-grep** (fadouse, pi.dev): a single read-only `ast_grep` tool,
  `command: run | scan`, `pattern` or `kind`; invokes the binary with
  **argument arrays, not shell strings** — the same no-quoting-surface
  argument §3.1 makes for napi, reached independently by a CLI wrapper author.

Outside the pi ecosystem:

- **PraisonAI**: `ast_grep_search` (JSON by default), `ast_grep_rewrite`
  (dry-run default), `ast_grep_scan` (YAML rules); **path confinement** (paths
  must resolve inside the workspace, rejected before `sg` runs); a
  **10,000-char output cap** with head+tail preview, a *"Full output saved
  to:"* pointer and an env override — structurally the same spill-reference
  pattern as Porrima's tool-output store; graceful fallback when ast-grep
  isn't installed.
- **Gemini CLI** (community extension): four tools — `ast_read`
  (**structural read of one node** — inspect a class or function without
  reading the file; outline-adjacent), `ast_write`, `ast_grep_search`,
  `ast_grep_rewrite`; an async mode that detaches long searches to a file;
  tips insist on explicit `lang`.
- **Zed**: the contrasting architecture — no structural-search tool at all.
  Zed **enriches the existing agent `grep` tool with syntax information**:
  match context expanded to the parent syntax node's range, match headers
  carrying **symbol breadcrumbs** (`### impl Foo for Bar › fn baz › L1278`).
  Reported eval impact: better diffs, fewer tool failures, fewer turns.
  Stated future work: an "elision" output mode.

**5. CI / rule-system role** (non-agentic). ast-grep as a repository rule
engine — `sgconfig.yml`, YAML rules with validation, `ast-grep test`
snapshots, ratchet gates. Durable project artifact, not agent tooling; out of
scope, noted because the same rule syntax serves both roles.

**Convergences this design commits to:** rewrite-dry-run-default and the
anti-regex guard are universal across implementations (§3.2); output bounding
with a saved-file pointer is the established spill pattern; structured
metadata alongside model-facing text is the field shape; a 50-match page is
what oh-my-pi hardcodes, and this design defaults `maxMatches` to 50. The
`lang` handling splits: required (pi-ast-grep, Gemini CLI) vs
auto-detect-with-override (oh-my-pi, matching the CLI default) — this design
takes the latter (§3.1).

**One honest novelty note:** no surveyed harness uses `@ast-grep/napi`. The
pi wrappers shell out to the CLI (and pay for it — resolver chains,
TLS-only auto-download, `sg` name collisions); oh-my-pi compiles
`ast-grep-core` into its own native addon. The pinned-prebuild choice in §5
is what those problems make impossible — and its consequences (§3.1's
delivery barrier, the five-language set) are things this design had to
discover because nobody else's notes cover them.

**Divergences named, not resolved:** Zed's in-situ enrichment (structure
injected into the text tool) vs this design's dedicated structural tool;
`ast_read`-style single-node structural reads sit between search and outline
(§3.4/§8). **Not adopting ast-grep (anywhere found):** aider (tree-sitter
directly, the precomputed-map lineage), and no built-in surface in
Cursor/Copilot/Codex/opencode — the ripgrep lineages of codemode §2–3.

## 3. Design

### 3.1 One executor, two projections

Single module `server/src/services/code-search.ts` — one implementation;
model-level tool and kernel dispatcher both ride it (the Phase A projection
pattern):

```ts
export interface CodeSearchMatch {
  file: string;              // workspace-relative
  start: { line: number; column: number };  // 1-based
  end:   { line: number; column: number };
  text: string;              // the matched node's source text
  metaVariables?: Record<string, string>;   // single + multi, flattened
}
export interface CodeSearchParams {
  pattern: string;
  path?: string;             // workspace-relative root; default = workspace root
  globs?: string[];          // gitignore-glob semantics; "!" prefix excludes; later wins
  lang?: string;             // language alias; default = auto-detect from extensions
  maxMatches?: number;
  skip?: number;             // pagination
}
export interface CodeSearchResult {
  matches: CodeSearchMatch[];      // the page returned
  totalMatches: number;
  filesWithMatches: number;
  skipped: { file: string; reason: string }[];  // capped list
  skippedTotal: number;
  unscanned: Record<string, number>;  // extension → count outside the language set
  scannedFiles: number;
  text: string;              // model-level text projection
  truncated: boolean;
}
export async function runCodeSearch(params, workspace, signal): Promise<CodeSearchResult>
```

**Execution: in-process via `@ast-grep/napi`** — no subprocess, no
shell-quoting surface, version-pinned to the server's package.json. The API
shape (0.50.0): `pattern(lang, pattern)` compiles a matcher `NapiConfig`;
`findInFiles(lang, {paths, matcher, languageGlobs?}, callback)` discovers and
parses files in Rust and delivers matched `SgNode`s; `parseFiles` parses a
file list. Language arguments are plain strings — `sg.Lang` is a compile-side
enum, empty at runtime.

Four binding properties shape the executor, each load-bearing:

1. **The napi bundle supports five languages** — typescript, tsx, javascript
   (jsx alias), html, css — and silently never visits files whose extension
   infers anything else. Coverage is therefore the executor's job (§3.1
   census below), and the broader CLI language set applies only to the CLI
   fallback path (§5).
2. **Match nodes carry no file path.** It lives at `node.getRoot().filename()`,
   populated only on the discovery path. `CodeSearchMatch.file` routes
   through it.
3. **`findInFiles`/`parseFiles` resolve before their callbacks land.**
   The resolved number is how many files *will* deliver; the per-file
   callbacks are still in the libuv queue. Reading whatever has arrived at
   resolution is silently partial — matches disappear nondeterministically,
   worst on early calls of a process. The executor waits (bounded grace,
   under the same timeout race) until delivered callbacks equal the
   resolved count, and flags the result as incomplete rather than trusting a
   short read if the grace expires.
4. **`pattern()` never throws** — tree-sitter parses tolerantly, so garbage
   patterns compile and match nothing. Static validity is undecidable at this
   boundary (any token parses as an identifier in some grammar). Pre-
   validation therefore covers only the classes that can be caught
   mechanically; everything else gets a truthful zero-match (§3.2).

**File discovery/ignore semantics.** `findInFiles` honors `.gitignore` the way
the CLI does (same `ignore` crate). The precedence rule the executor inherits
from ripgrep: passing an ignored path **explicitly** in `paths` matches it
anyway — scans descend ignore-clean, requested paths are honored as asked.
There is no include/exclude glob at the napi boundary (`languageGlobs` maps
extensions to a language, it is not a filter), so the `globs` parameter is
executor-side filtering over discovered paths.

**Coverage: the scope census.** A zero-match result is only honest if the
caller knows what the engine could not see. The executor walks the scope
itself (ignore-aware, pruning VCS/dependency/build directories) and
aggregates by extension: files outside the five-language set become `unscanned`
counts and `skipped` entries, never invisible gaps. The census is metadata,
never the scan; its cost is one directory walk with no parsing, and discrepancies
fail safe (under-report skips, never over-claim coverage). With an explicit
`lang`, the census also detects the scope-error case — a `ts` query over a tree
holding no `ts` files is reported as such, not as absence.

**Parse/scan errors, reported separately.** Unparseable files are a normal
occurrence (generated code, unusual dialects), and silently dropping them
makes "0 matches" ambiguous. Errors are collected per file, capped in the
list, totaled, and surfaced *alongside* the matches — never folded into them
— exactly like census skips. Both classes feed the qualified-absence
rendering (§3.2).

**Remote workspaces: the carve-out.** The server cannot parse files it cannot
read locally without N adapter reads. Two options, staged:

- **(b, first)** adapter-read + in-process parse: read candidate files through
  the workspace adapter (scoped by `path`/`globs` first — discovery via
  `list_files`, then parse what matched), parse in the server. Works on every
  remote host with **zero new dependencies**; cost is read-then-parse latency
  on big trees, which scoping bounds.
- **(a, later)** `ast-grep` binary on the remote host, invoked through the
  remote bash path (host-owned, the Phase C shape). Only worth it once a
  remote repo's tree makes (b) measurably slow.

Phase 0 refuses non-local workspaces with a message naming the phase.

### 3.2 The model-level tool

**Name:** `code_search`. **Surface (shipped):**

```
code_search(pattern, path?, globs?, lang?, maxMatches?, skip?)
```

`context` is deliberately not in the schema: the index-not-payload rendering
below stands on its own, and an unimplemented parameter is a trap. If
orientation-by-context is ever wanted it belongs to `code_outline` (§3.4),
not to search output.

**Output — compact text, not JSON.** The model-level result is an *index*, not
a document: one line per match, plus a summary. JSON would spend context
bytes on delimiters the model must not parse:

```
47 matches in 12 files
server/src/services/agent-tools.ts:1048 [NAME=toolDispatcher]: const toolDispatcher = ...
server/src/services/memory-tools.ts:315 [MSG=`value: ${msg}`]: console.log(`value: ${msg}`)
server/src/services/memory-extraction.ts:88: async function extractMemories(...) … +14 lines
```

**Ordering.** Matches sort by `(file, start.line, start.column, byteOffset)`
before truncation. Fresh parse per call means no index, so pagination (`skip`)
is only coherent under a deterministic order; without it, "next page" under a
churning tree is undefined.

**Rendering.** Multi-line node text renders as the first line plus an
`… +N lines` marker — the model-level text is an index, not a payload; full
node text stays in the kernel projection. Metavariable bindings render inline
on the match line (`[NAME=binding]`, capped); multi-element bindings compress
to one capped line. A binding-free line cannot show *what* the pattern
matched — bindings are often the answer, and the full structure is always
available kernel-side.

**No matches is a clean value, not an error.** `no matches in <scope>`. This
fixes cost #3 at the surface: the expected outcome stops being a failure. Two
refinements make absence *honest*, not just clean:

- When the census found files the engine cannot visit (or scan errors), the
  zero-match text names them — "N file(s) in scope are not scanned (.py×12,
  .go×3) — code_search covers ts/tsx/js/jsx/html/css; for other languages use
  rg via bash" plus "coverage is partial — narrow `path` before concluding
  absence." Absence-over-partial-coverage is exactly where the model
  over-concludes.
- With an explicit `lang` and zero files of that language in scope, the result
  says so — a scope error reported as such, not as a result.

**Budgets, server-side** (the codemode §4.9 principle — the caller cannot be
trusted to count itself): `maxMatches` default 50, hard cap 1000; output char
cap 20 KB (`PORRIMA_CODE_SEARCH_MAX_CHARS`); per-call timeout 120 s
(`PORRIMA_CODE_SEARCH_TIMEOUT_MS`) — the timeout stops *waiting* (the Rust
scan cannot be cancelled mid-flight; scoping is the remedy, the timeout the
backstop). The tool is **read-only and lock-free**: it never acquires
`workspace:<label>` and is not in `SEQUENTIAL_TOOL_NAMES` — parallel-safe,
exactly like `read_file`.

**Pattern pre-validation, two layers.** The engine referee (a tolerant parse
that matches nothing) handles everything the mechanical layers don't, so the
surface only catches what is cheap and certain:

1. **Regex-shape heuristic** — rejects the classic regex shapes (`\w`, `\d`,
   `.*`, `[a-z]`, and *spaceless* `|`) with the hint *"ast-grep patterns are
   code, not regex — for text search use `rg` via bash."* The pipe rule is
   deliberately space-aware: `foo|bar` is almost always a regex-union mistake,
   while `a | b` is valid code (bitwise-or, TS union types) and must pass.
   Known tradeoff: a spaceless legitimate bit-or pattern gets nudged to rg —
   the same call the field's implementations make.
2. **No-code-content class** — empty strings and bare punctuation mirror the
   CLI's exit-8 "Cannot parse query" and are a hard tool error.

What used to be a third layer — a "written for a different language" validator
— is *not* part of this design: static language-foreignness is undecidable
(the same token is a keyword in one grammar and a legal identifier in
another), and guessing wrongly converts a recoverable clean absence into a
confident wrong error. Mis-language patterns land as zero matches; the
coverage notes above distinguish "did not match" from "did not look."

**Gating:** dark launch behind `PORRIMA_CODE_SEARCH=1`; the tool definition
ships only when the flag is on (the kernel-tools capability-line pattern —
zero schema bytes until flip). The honest cost of the flip: a new tool
definition (~150 schema tokens in the prefix). It earns them by *replacing a
default*, not by adding a capability class the model would have to learn to
choose (§4).

**Description** carries the pattern cheatsheet and worked examples — the
on-ramp for pattern syntax lives where the tool is, because the failure mode
(cost #1) is authoring, not calling. Shipped content:

- `function $NAME($$$ARGS) { $$$ }` — the complete-node form.
- **Patterns must be complete nodes**: `function $NAME($$$ARGS)` (no body)
  matches nothing. The **partial prefix** `function $NAME` is the workhorse —
  it matches every function definition (typed, generic, async), and the
  matched text is the full node including the body.
- `await $CALL($$$ARGS)` — single metavariables bind; `$$$NAME` binds lists.
  Statement-level forms (e.g. `$VAR = await $CALL()`) are grammar-dependent;
  prefer the call expression itself.
- Plain text with no metavariables is a **literal** exact-node match.
- The classic trap: `$` is *not* a multi-element metavariable — it parses as
  a bare identifier named `$`. Three dollars plus a name is the list syntax.
- Language coverage statement (the five languages; rg for the rest).

### 3.3 The kernel projection — Phase 1

One line on the dispatcher's exposure list (`createKernelToolDispatcher`),
same projection pattern as the other Phase A rows. Differences from the
model-level tool, both deliberate:

- **Structured output.** In the kernel, result bytes are free (they stay in
  variables), so the kernel projection returns the normalized JSON shape
  (`CodeSearchResult` without `text`). The model-level text is for context;
  the kernel JSON is for computation — including `skipped`/`unscanned`, so
  a program can decide whether absence is meaningful before drawing a
  conclusion.
- **The rule-authoring loop** — the case the MCP exists for, made free:

  ```python
  snippet = await tools.read_file(path="server/src/services/turn-gate.ts")
  for pat in ["async function $NAME($$$ARGS)", "function $NAME"]:
      out = await tools.code_search(pattern=pat, path="server/src/services")
      # inspect out["matches"][i]["metaVariables"], refine, re-run — zero context per loop
  ```

  Write rule → test → inspect → revise, all in variables, nothing crossing
  the wire until the final result. This is the codemode thesis in the
  concrete place §2.5 named. Honest cost: every iteration is a fresh parse of
  the scoped tree — the loop is free in *context*, not in CPU; at measured
  cost (~0.05 s over all of `server/src` on the dev box) a ten-iteration
  refine pass stays well under a second, and scoping keeps it there.
- **Snippet testing without the filesystem** (the `parseFiles`/`pattern`
  napi path): a kernel program can test a pattern against a string it built,
  not just files — the `test_match_code_rule` MCP tool, in-kernel.

`code_search` joins the codemode §4.3 Tier 1 row as designed (read-only; the
density case is query→loop→transform; the remote carve-out is §3.1's
(b)-then-(a)).

### 3.4 Orientation — named, deferred, designed separately

`ast-grep outline` (text: `line: signature` per top-level symbol; `--json`:
`{path, language, items: [{symbolType, name, range, signature, astKind,
isImport, isExported}]}`) is a *different job* from search — "where do I look
next" vs "where is this". It opens the project-context orientation seam
noted in codemode §2.5 (outline entry → range-read by byte offset →
transform, without full file reads).

The field treats it as worth a tool: @juvio15/pi-ast-grep ships
`ast_grep_outline` at model level ("map a file before you read it") and
Gemini CLI's `ast_read` sits in the same territory. The seam is real; the
model-level commitment is what this design defers, on economics — zero
schema bytes, the budgets make orientation free mid-kernel, and `list_files`
covers the directory-tree case at model level. It is **kernel-first** and
gets its own design section when it ships.

### 3.5 Guardrails

- **Untrusted data.** Match text is file content — the data/instruction rule
  applies exactly as it does to `web_fetch` and `read_file` (the kernel
  namespace `__doc__` carries it; the model-level tool rides the same
  framing).
- **Bounded output, server-side** (§3.2 budgets).
- **Fresh parse = no stale state.** There is no index to go stale; each call
  parses what it scans. The cost is CPU per call, which the budgets and
  scoping manage — and which is why a *precomputed* repo map (aider's
  lineage) remains out of scope: it would re-introduce the stale-state
  surface this design exists to avoid.
- **Coverage honesty.** A search result must always distinguish "searched,
  no matches" from "could not search this." The census and skipped entries
  are load-bearing, not decoration — silently skipping what the engine
  cannot see is the failure mode that makes a clean zero-match a lie.

## 4. Fit with the existing tool set — and what it replaces

The question this design answers is not "add a tool" but "make the existing
surface easier to use". The answer is a **default shift**, not a capability
removal:

| surface | today | after `code_search` |
|---|---|---|
| **searching code (ts/tsx/js/jsx/html/css)** | `bash(command="rg -n ...")` — regex authoring, text output, exit-1-on-no-match | **`code_search`** — pattern authoring, structured index, clean 0-match value |
| **searching other languages** (python, go, rust, …) | `bash` + `rg` | unchanged — `code_search` names them as unscanned and points at `rg` |
| **searching text/non-code** (logs, configs, binaries, remote) | `bash` + `rg` | unchanged — `rg` stays *the* tool for text search |
| **reading** | `read_file` | unchanged — search→read is still the loop; `code_search` replaces the *search half* with structure |
| **orientation** | `list_files` (+ ad hoc `ls` via bash) | unchanged now; `code_outline` deferred (§3.4) |
| **kernel `tools.*`** | `bash`/`read_file` cover search via `tools.bash("rg")` + Python text-munging | `tools.code_search` — structured, loop-free (§3.3) |
| **prompt/AGENTS.md guidance** | (implicit: "use rg") | one added line — *default to `code_search` for code; `rg` for text* |

Why replacement-beats-addition: the model's decision surface grows with every
tool, and "search the code" currently has exactly one default (bash+rg).
`code_search` earns its schema bytes by *being that default* — one decision
("search code? call `code_search`") instead of four ("which regex? which
flags? how do I parse the output? did it actually look?"). It adds a
capability class (structure) while keeping the surface flat. Nothing is
removed from `bash`: the escape hatch for everything `code_search` doesn't
cover — regex, non-code, binaries, other languages, and hosts where the napi
platform matrix doesn't reach.

**Sequencing with the kernel:** the model-level tool is separable from
protocol v2 by construction (it is just another registry tool + executor) and
ships dark, so it can land independently of the Phase A flag. The kernel row
is one line on the existing exposure list and follows as soon as the executor
exists.

## 5. Dependency placement

- **`@ast-grep/napi@0.50.0` as a server dependency** (native prebuilds).
  Platform support matrix: Windows x64/arm64, macOS x64/arm64, **Linux x64
  gnu** — Enceladus (Ubuntu x64) is covered. **musl and arm64 Linux are not
  in the matrix** — the fallback for those hosts is the `@ast-grep/cli`
  binary via the onboarding profiles, which is why the CLI remains a
  supported execution path even where napi is not.
- **The five-language ceiling.** The napi bundle visits typescript, tsx,
  javascript, html, css — and only those. Two escape routes exist and are
  deliberately not taken in v1: `registerDynamicLanguage` (load extra
  tree-sitter grammars as native objects) and the CLI (28+ languages). Both
  are Phase-1+ decisions; until then the scope census (§3.1) makes the
  ceiling visible in every result rather than silently wrong, and `rg` via
  bash covers the rest.
- **Field position.** No surveyed harness uses `@ast-grep/napi`: the pi
  wrappers shell to the CLI (six-step resolver chains, TLS-only
  auto-download, `sg` name collisions are exactly what a pinned dependency
  makes impossible), while oh-my-pi sidesteps the prebuild matrix entirely by
  compiling `ast-grep-core` into its own Rust addon — demonstrated insurance
  if the platform matrix ever bites, and evidence that broader grammar
  coverage is solvable in-process without changing the dependency story.
- **`minimatch`** powers the `globs` post-filter (the napi's filter surface
  is ignores + languageGlobs, nothing else); **`ignore`** powers the
  gitignore-aware scope census. Both small and pure-JS.
- **Name collision:** `/usr/bin/sg` on common Linux is **util-linux's
  set-group**, not ast-grep. Every reference — code, docs, onboarding — uses
  `ast-grep` as the canonical name and never the `sg` short name on a host
  PATH.
- **Version-pinned** in package.json; the executor is written against the
  0.50.0 napi API (§3.1), so an upgrade is a reviewed bump, not a drift.

## 6. Staging

| phase | scope | gates |
|---|---|---|
| **0** | model-level `code_search`: executor (napi, local), scope census + coverage reporting, tool definition, budgets, gating, tests | implemented; dark behind `PORRIMA_CODE_SEARCH=1` |
| **1** | kernel dispatcher row + JSON projection + snippet-testing path (`pattern`/`parseFiles`) | rides the live kernel flag; one exposure-list line |
| **2** | remote carve-out (b): adapter-read + in-process parse; (a) host binary only if measured slow | the remote-kernel test bench (P4 smoke pattern) |
| **3** | `code_outline` — its own design section, kernel-first | deferred; boundary named in §3.4 |
| **4** | the one-line default shift in AGENTS.md / tool guidance | lands with phase 0's flip |

## 7. Risks

1. **Pattern-syntax learning cost.** The `$$` vs `$$$ARGS` trap and the
   complete-node requirement are real authoring failures with silent outcomes
   (a wrong pattern parses and matches nothing). Mitigations: the cheatsheet
   in the tool description (§3.2), ast-grep's `--debug-query` as the debugger
   (shipped as a model-level tool by @juvio15/pi-ast-grep — the proven
   fallback shape if friction shows up in usage), and the kernel rule loop
   (§3.3) where syntax errors are cheap to find. Residual: the model will
   still author bad patterns; the clean error surface keeps that recoverable.
2. **Fresh-parse cost on large repos** (startup-dominated below ~200 files;
   rg wins wall-clock there). Mitigations: `path`/`globs` scoping as the
   primary lever, server-side budgets and the 120 s backstop, and honest docs
   that this tool buys precision, not speed.
3. **napi platform matrix gaps** (musl/arm64 Linux). Mitigation: the CLI
   fallback path (§5); remote hosts sidestep both via phase 2 (b) until (a)
   is earned. oh-my-pi's own-addon route is demonstrated insurance.
4. **Coverage illusion** — a five-language engine returning a clean zero over
   a polyglot repo *is the false absence this design exists to prevent*.
   Mitigation: the scope census (§3.1) names every unscanned file and
   extension in the result, the description tells the model the ceiling up
   front, and the qualified-absence phrasing (§3.2) makes "no matches" read
   as "no matches *among what was scanned*." Residual: the census walk
   approximates (not replicates) ignore-crate semantics; discrepancies fail
   safe by under-reporting skips.
5. **Output-volume blowout** (one query, 10k matches). Mitigation:
   `maxMatches` + char cap enforced server-side, summary line always present.
6. **API drift.** The napi surface has changed underfoot before
   (`matchSourceCode` is gone in 0.50.0), and d.ts-vs-runtime traps are
   routine (empty `Lang` at runtime; no path on the node; callbacks lagging
   resolution). Mitigation: version-pinned, executor isolated in one module,
   engine facts pinned in the module header and re-verified on every bump.
7. **Staleness: none by design** — fresh parse per call. The risk is the
   inverse (someone later adding a cache); the design brief says the cache is
   how this feature goes wrong.

## 8. Future directions

- **`code_outline`** (§3.4) — kernel-first orientation, then a decision about
  a model-level surface.
- **Grammar coverage** — `registerDynamicLanguage` (dynamic tree-sitter
  grammars through the napi) or the CLI fallback path for languages beyond
  the bundled five; the census makes the current ceiling explicit wherever
  it sits.
- **`-k/--kind` selector** (match by node kind without a pattern): a
  one-line addition over the napi rule object when usage asks; deferred on
  description-bytes cost — pattern-only is the 90% case.
- **In-situ enrichment** (the Zed direction): `read_file` context selection
  by syntax-node range, symbol breadcrumbs — a `read_file` refinement or the
  outline primitive, not a new tool.
- **Remote phase (a)** — host-owned `ast-grep` binary over the remote bash
  path, if measured slow.
- **The full pattern reference** kernel-loadable on demand once the
  description cheatsheet is proven insufficient by usage.
