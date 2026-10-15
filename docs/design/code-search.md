# Code Search — structural code navigation for Porrima

**Status:** Phases 0–1 implemented — model-level `code_search` tool (dark
behind `PORRIMA_CODE_SEARCH=1`) and the kernel projection (same flag, riding
the live kernel-tools flag). Extends the kernel-codemode design: it is the
concrete design behind the §4.3 Tier 1 `code_search` row and answers §7 Q9
(model-level wrapper first, in-kernel projection second, outline deferred as
its own feature). First gate run (10-14): **FAIL — flag stays dark**;
battery v3 (three-arm surface isolation) designed in §4.2 — S1
(model-level `code=`) and S2 (description v3) **shipped 10-15**; the
probe run is next.
**Date:** 2026-10-15

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
- **Retrieval evidence points the same way.** Cognition's SWE-grep work
  (RL-trained retrieval over parallel grep/glob/read calls) found that highly
  parallel cheap searches beat serial deep ones, and that *context pollution
  costs more than missing recall* — the agent is usually a few searches from
  recovering what it missed. Independent support for two choices here: the
  index-not-payload rendering (§3.2) and the read-only, lock-free,
  parallel-safe tool (§3.2 budgets).
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
this doc designs into. The pi ecosystem alone has at least six independent
implementations (four surveyed in depth here; also `@nicknisi/pi-ast-grep` and
`@davehardy20/pi-ast-grep-tools` — the latter **napi-based**, see the novelty
note below — plus `pi-code-nav`, which composes LSP semantics + ast-grep +
text-scan fallbacks, a bridge to the adjacent-lineages section below):

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
  **`ast_grep_outline`** ("map a file before you read it" — a rich surface:
  `view`, `match`, `type`, `pub_members`, `outline_rules`, `threads`,
  `follow`, `no_ignore`),
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
  Stated future work: an "elision" output mode. (Verified 10-14: the shipped
  `grep_tool` carries `max_ancestor_lines`/`context_lines` knobs — PR #64954 —
  and a 2048-byte snippet cap centered on the match — PR #62166. The
  enrichment line is actively developed, not a one-off experiment.)

**5. CI / rule-system role** (non-agentic). ast-grep as a repository rule
engine — `sgconfig.yml`, YAML rules with validation, `ast-grep test`
snapshots, ratchet gates. Durable project artifact, not agent tooling; out of
scope, noted because the same rule syntax serves both roles.

**Convergences this design commits to:** rewrite-dry-run-default and the
anti-regex guard are universal across implementations (§3.2 — this design's
form is advisory-on-absence rather than a hard reject, closest to the
"nudges" of pi-ast-grep and oh-my-pi; the revised rationale is in §3.2);
output bounding with a saved-file pointer is the established spill pattern;
structured metadata alongside model-facing text is the field shape; a
50-match page is what oh-my-pi hardcodes, and this design defaults
`maxMatches` to 50. The `lang` handling splits: required (pi-ast-grep, Gemini
CLI) vs auto-detect-with-override (oh-my-pi, matching the CLI default) — this
design takes the latter (§3.1).

**One honest novelty note:** the napi route is rare, not
unprecedented. The pi wrappers mostly shell out to the CLI (and pay for it —
resolver chains, TLS-only auto-download, `sg` name collisions); oh-my-pi
compiles `ast-grep-core` into its own native addon; and one pi package
(`@davehardy20/pi-ast-grep-tools`, May 2026) does depend on `@ast-grep/napi`
— and independently landed on the same narrow-language tradeoff (TS/JS/TSX
only). The pinned-prebuild choice in §5 is what the CLI wrappers' problems
make impossible — and its consequences (§3.1's delivery barrier, the
extension-set bookkeeping) are things this design still had to discover
largely alone: the napi user above ships no coverage census.

**Divergences named, not resolved:** Zed's in-situ enrichment (structure
injected into the text tool) vs this design's dedicated structural tool;
`ast_read`-style single-node structural reads sit between search and outline
(§3.4/§8). **Not adopting ast-grep (anywhere found):** aider (tree-sitter
directly, the precomputed-map lineage), and no built-in surface in
Cursor/Copilot/Codex/opencode — the ripgrep lineages of codemode §2–3. The
non-ast-grep structural-navigation lineages are named in the next section.

### Adjacent lineages — structural navigation without ast-grep (round 5, 10-14)

The adoption survey covers ast-grep's own shapes. Three adjacent lineages
answer the same underlying need — navigate code by structure, not text — with
different engines; naming them keeps this design's boundaries honest.

**The LSP lineage (semantic navigation).** The field's most-adopted
structural-navigation tool for agents is not ast-grep-based at all: **Serena**
(~24k stars) drives *language servers* over MCP — `find_symbol`,
`find_referencing_symbols`, `get_symbols_overview`, `replace_symbol_body`,
`rename_symbol` — across 30+ languages. The same direction shows up inside
harnesses: Zed PR #45685 (expose LSP goto-definition/find-references to the
agent), oh-my-pi ships an `lsp` tool alongside its ast-grep ones, and
`pi-code-nav` combines LSP semantics (TS-only) with ast-grep and text-scan
fallbacks. The distinction is a hard capability boundary: ast-grep matches
*syntax* — "every call site of `foo`" is a pattern approximation that cannot
disambiguate two different `foo`s, cannot follow a rename, cannot see types.
LSP answers those, at costs this design's principles currently refuse: a
language server per language, project dependencies installed for full
resolution, startup latency per workspace, and an index/build posture in
tension with the fresh-query stance (§2). **Not adopted — but the excluding
principles are not set in stone.** If usage shows demand for reference-grade
semantics ("what calls this, *exactly*"), the path is an LSP adapter —
tsserver is already on every Porrima host, and the TS-only carve is exactly
what pi-code-nav ships — not more ast-grep. Note also that Serena's
most-praised tool, `get_symbols_overview`, is the same seam as
`code_outline` (§3.4): one more signal that orientation is where this family
of tools earns its keep, and one more reason §6 re-orders outline ahead of
remote.

**Trigram indices (precomputed text).** Zoekt and GitHub's Blackbird power
server-scale code search with precomputed trigram indices. Text, not
structure — the wrong axis for this tool — but they are the precomputed
pole's heavyweights, and the fresh-query stance rejects them for the same
reason it rejects aider's repo map: an index is a build step and a staleness
surface (§3.5).

**Grammar-free structural matchers.** **Comby** matches structural holes
(`:[x]`) uniformly across languages with no per-language grammar — the exact
complement of ast-grep's napi coverage ceiling (§5). Less precise (no real
syntax tree, so no metavariable bindings over node structure) and a smaller
ecosystem; it answers a question Porrima does not have today, because the
census + rg fallback covers the polyglot tail adequately and the
grammar-packages plan (§6 G) shrinks the ceiling itself.

**Semantic rule engines.** **Semgrep** (taint/dataflow analysis, its own MCP
surface) is the heavyweight cousin — CI/security-rule oriented, far beyond
orientation needs. ast-grep's YAML rule system covers the lightweight end of
the same spectrum and is deliberately out of scope here (§1); the
pattern-only surface is the 90% case (§8's `-k/--kind` note).

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
shape (0.50.0): `pattern(lang, pattern)` compiles a matcher `NapiConfig`
(reusable across `findAll` calls — the auto-detect path caches one compiled
pattern per language); `findInFiles(lang, {paths, matcher, languageGlobs?},
callback)` discovers and parses files in Rust and delivers matched `SgNode`s;
`parseFiles` parses a file list. Language arguments are plain strings
(`sg.Lang` is populated at runtime in 0.50.0, but names only the bundled
five; the executor never reads it).

Four binding properties shape the executor, each load-bearing:

1. **The napi bundle supports five languages** — typescript, tsx, javascript
   (jsx alias), html, css — and silently never visits files whose extension
   infers anything else. **The extension set is broader than the language
   names**: js/mjs/cjs/jsx → JavaScript,
   ts/mts/cts → TypeScript, tsx → Tsx, html/htm/xhtml → Html, css/scss →
   Css. The executor's alias table mirrors the engine's inference set —
   a stale table mis-reports *scanned* files as unscanned (and can emit a
   false "no X files in scope" scope error), the coverage-honesty inversion
   the census exists to prevent; a drift-pin test asks the live engine which
   extensions it visits and compares against the table. Coverage is otherwise
   the executor's job (§3.1 census below), and the broader CLI language set
   applies only to the CLI fallback path (§5).
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
   short read if the grace expires. This is an upstream-known limitation:
   ast-grep's own *Performance Tip for napi usage* page documents the race
   and ships the same counted-callback workaround — re-check it on every
   version bump (§7 Risk 6).
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
executor-side filtering over discovered paths. Executor-side means
gitignore semantics for real: a bare directory pattern (`!dist`) excludes
everything beneath it (ancestor-segment matching, not just whole-path
minimatch — the Phase 0 filter shipped without this and `!dist` silently
kept `dist/foo.ts`), `!` negates, later globs win. (`languageGlobs` does
have one coverage use the filter framing hides: `findInFiles` accepts globs
whose matching files are parsed *as* the call's language — e.g. `*.vue` /
`*.svelte` as HTML — a partial reach-extension noted in §8.)

**Path resolution.** Mirrors `workspace.ts`'s `resolveLocalPath` exactly,
including `~` → HOME (not workspace-root-relative — the Phase 0 executor
diverged here): the same path string must mean the same thing to `read_file`
and `code_search`, including in project chats where root ≠ HOME. Absolute
paths and `..` escapes follow the house convention (bash can reach them
too); the census cap and the call deadline bound the cost of an
over-wide scope.

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
code_search(pattern, code?, path?, globs?, lang?, maxMatches?, skip?)
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
(`PORRIMA_CODE_SEARCH_TIMEOUT_MS`) — **one deadline for the whole call**,
covering the census walk as well as the scan; the timeout stops *waiting*
(neither the walk nor the Rust scan can be cancelled mid-flight; scoping is
the remedy, the timeout the backstop). The tool is **read-only and
lock-free**: it never acquires `workspace:<label>` and is not in
`SEQUENTIAL_TOOL_NAMES` — parallel-safe, exactly like `read_file`.

**Pattern pre-validation: one hard class, one advisory.** The engine referee
(a tolerant parse that matches nothing) handles everything the mechanical
layers don't, so the surface only catches what is cheap and certain:

1. **Regex-shape heuristic — advisory, not a rejection**.
   The classic regex shapes (`\w`, `\d`, `.*`, `[a-z]`, and *spaceless* `|`)
   are detected, but the search **runs anyway**; the hint (*"the pattern
   looks regex-shaped — ast-grep patterns are code, not regex; for text
   search use `rg` via bash"*) is appended **only when the result is a
   zero-match**. Rationale: the detector has real false-positive classes in
   a TS codebase — a tight union type (`string|number` inside a signature
   pattern) and index arithmetic (`$ARR[$I-1]`) both trip it — and a hard
   rejection converts a possibly-valid pattern into a guaranteed no-result.
   Advisory-on-absence keeps the engine the referee (a regex-shaped pattern
   that matches real code returns matches and no note) and fires the nudge
   exactly where the over-conclusion risk lives: at absence. The pipe rule
   stays space-aware (`a | b` never trips it). Cost: a genuine regex
   pattern spends one ~50 ms scan before being redirected — acceptable, and
   still cheaper than the model's rg round-trip. The field's hard-reject /
   nudge implementations make the opposite call; this design follows its own
   principle that only the engine can decide validity.
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
- **Patterns must be complete nodes**: a bodiless parameterized pattern
  (`function $NAME($$$ARGS)`) matches only bodiless *declarations* (TS
  overload signatures), never definitions — for an exact parameter count use
  the body slot (`function $NAME($ARG) { $$$ }`). The **partial prefix**
  `function $NAME` is the workhorse — it matches every function definition
  (typed, generic, async), and the matched text is the full node including
  the body.
- `await $CALL($$$ARGS)` — single metavariables bind; `$$$NAME` binds lists.
  Statement-level forms (e.g. `$VAR = await $CALL()`) are grammar-dependent;
  prefer the call expression itself.
- The template-literal shape is its own worked example: ``console.log(`$$$X`)``
  (add `, $$$REST` for calls with more arguments). Without a template case in
  the cheatsheet, models default to text tools for backtick queries even
  though the pattern expresses the shape — the example is the discovery
  on-ramp for a whole task family.
- **Count mode**: `maxMatches=1` (carried in the parameter description) — the
  summary line always reports `totalMatches`, so a pure count costs one
  output line instead of 50 matches' worth of node text. Counting is the
  densest common query shape; paying full payload for it is the token loss
  the hint removes.
- Plain text with no metavariables is a **literal** exact-node match.
- The classic trap: `$` is *not* a multi-element metavariable — it parses as
  a bare identifier named `$`. Three dollars plus a name is the list syntax.
- Language coverage statement (the five languages; rg for the rest).

### 3.3 The kernel projection — Phase 1 (shipped 10-14)

One conditional row on the dispatcher's exposure list
(`createKernelToolDispatcher`), same projection pattern as the other Phase A
rows; the gate (`PORRIMA_CODE_SEARCH=1`) is evaluated per dispatcher
construction — per cell — so a flip needs no restart beyond the one the
kernel-tools line already rides. Differences from the model-level tool, all
deliberate:

- **Structured output.** In the kernel, result bytes are free (they stay in
  variables), so the kernel projection returns the normalized JSON shape
  (`CodeSearchResult` without `text`). The model-level text is for context;
  the kernel JSON is for computation — including `skipped`/`unscanned`, so
  a program can decide whether absence is meaningful before drawing a
  conclusion, and the §3.2 regex-shape `hint` (it has no `text` to read
  from). **Wire shape:** the manager JSON-stringifies structured values
  and flags the response `value_json`; the driver decodes the flag back into
  a real dict for the cell (a decode failure keeps the raw string — the flag
  never fails a call). Truncated JSON stays a marked string (a cut string is
  not parseable); spill references carry `json: True` so the cell knows to
  `json.load(open(path))`.
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
  cost (~0.05 s over all of `server/src` on the dev box: ~55 ms `findInFiles`,
  ~45 ms `parseFiles` over 295 files, while `rg` stays
  ~10× faster wall-clock, the precision-not-speed framing of §2 holding) a
  ten-iteration refine pass stays well under a second, and scoping keeps it
  there. The auto-detect path caches one compiled pattern per language, so
  loop iterations pay parse cost, never recompile cost.
- **Snippet testing without the filesystem** (the `parse`/`pattern` napi
  path): `code=` switches the same tool to snippet mode — test a pattern
  against a string the program built, not just files. The
  `test_match_code_rule` MCP tool, in-kernel. Shipped shape:
  `runCodeSearchOnSnippet({pattern, code, lang?, maxMatches?, skip?})` →
  `{matches (file = "(snippet)"), totalMatches, lang, truncated, hint?}`;
  `lang` defaults to ts (the house language) and the resolved language rides
  in the result — snippet mode has no census, so the mis-language class is
  the one silent failure the result must at least name. The advisory
  regex-shape hint (§3.2) rides both paths, at absence only. Synchronous by
  construction (parse + findAll on a bounded string); no filesystem means it
  works on **remote kernels too** — the file scan stays local-only until the
  remote carve-out phase.

`code_search` joins the codemode §4.3 Tier 1 row as designed (read-only; the
density case is query→loop→transform; the remote carve-out is §3.1's
(b)-then-(a)). The manager's per-tool timeout gives it 150 s — 30 s of
headroom over the executor's own 120 s deadline so the executor's more useful
timeout message ("narrow `path`…") wins the race instead of the generic
abort text.

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

### 4.1 Success criteria — how the flip earns its keep

The default-shift bet (§4) is falsifiable and should be falsified or
confirmed with measurements, not vibes — the field now models this: Zed
reports eval deltas for its grep enrichment (better diffs, fewer tool
failures, fewer turns), and Cognition trained retrieval models against a
weighted F1 that prioritizes precision because context pollution costs more
than missing recall (§2).

**Battery.** A small fixed task set over the Porrima repo itself, each with a
known ground truth: (1) find all call sites of a chosen function; (2) count
single-parameter function declarations under a **closed shape list** (plain
and async `function name(oneParam) {…}` only — arrows, methods, generators,
and overload signatures excluded, non-test files only; the open-ended
"which function definitions" phrasing sent *both* arms into
build-your-own-parser spirals, so the question is as closed as the oracle);
(3) count `console.log` calls whose first argument **starts with** a
template literal — the prompt's semantics are pinned to the oracle's
textual starts-with reading (backtick first after the paren, modulo
whitespace, concatenations included), because the is-vs-starts-with
ambiguity otherwise makes correct answers ungradeable; (4) a deliberate
false-absence probe — a query whose answer lives in a `.py` file, checking
the model honors the coverage note instead of concluding absence — graded
on **correctness/fc only**, since the on-arm correctly does *not* use the
tool there and a per-task efficiency gate would only measure the schema
cost; (5) a two-count task that decomposes naturally into query→refine (the
full §3.3 kernel shape earns a dedicated case once kernel adoption shows up
in the wild). The runner is
`server/src/scripts/eval-code-search.ts`: it drives real headless turns on
project chats bound to the repo and takes a foreground turn-gate lease per
run. Eval chats carry the `eval[` title prefix, which doubles as the
delayed-extraction firewall — the scheduler's candidate query skips such
chats, so transcripts never enter the memory system even with a stray server
alive (an eval-time misconception extracted into a durable memory would
steer the very behavior the battery measures); `--purge` removes the chats
once graded, and the jsonl rows keep the full answers. Ground truth is recomputed at run time so the battery survives repo
drift; oracles are independent of the engine (rg — multiline-aware where
calls can wrap, since line-based matching undercounts wrapped calls) except
for the shape rg cannot express (task 2), where the engine derives the truth
and the complete-node trap applies to the oracle author exactly as it does to
the model. Oracle strings are deterministically ordered (rg's parallel walk
order is not), and the report warns when a task's oracle still differs
across arms. The harness prompt is fixed and names **no tools**: both arms
differ only in the tool surface, and discovery must come from the schema
alone — the exact condition the flip creates. Turn budgets are sized for
runs to *finish* on the local model; a run that still does not complete
(timeout, iteration cap) is **censored** — marked, excluded from gate
medians, and never false-conclusion-flagged, because its "answer" is
mid-turn narration, not a conclusion. Correctness grading is human by
design — the report prints every final answer beside its oracle — with one
auto-flag: an absence claim where truth exists (numeric zeros included; only
non-zero commitments suppress it).

**Metrics** — Porrima already records the raw material (request-log,
model-stats): turns to answer, tokens spent on search calls, tool-error rate,
and **false-conclusion rate** (a wrong answer delivered confidently — the
failure the census exists to prevent). Run the battery with the flag off
(bash+rg baseline) and on; `--reps 3` minimum for gate decisions (single-run
medians are noise). Per-task gate lines are diagnostics; the **flip verdict
is the battery-level aggregate**: summed per-task median turns and tokens
across the efficiency tasks (the schema cost amortizes across the battery,
not per task), plus two guards — completion rate must not drop (an arm
cannot win by censoring its slow runs out of the median) and false
conclusions must not increase. The ~150 schema tokens (§3.2) are earned only
if the on-run **does not lose** the aggregate on turns/tokens (ties pass —
at battery scale, parity with the baseline is the bar; wins are the bonus)
*and* adds no false conclusions.

**Gate:** Phase 4's guidance line lands on a battery pass, not on the flip
alone — and that line is a **nudge, not the mechanism**: the feature must
not depend on AGENTS.md being load-bearing, which is why the battery
measures schema-only discovery in the first place.

**Results (first gate run, 10-14; Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp, reps 3,
both arms complete, 30 runs):** verdict **FAIL — the flag stays dark.**
Aggregate over the efficiency tasks: turns 15 → 21, tokens 43.2k → 49.1k
(summed per-task medians); completion rate 11/15 on both arms; zero false
conclusions across 60 runs in two gate runs; the T4 probe passes both. The
human-graded appendix tells the rest of the story: the on-arm is never less
correct and its answers are consistently richer (AST-cross-verified counts,
line-level breakdowns; its one completed T3 run is the only answer in the
battery to identify the string-literal false positive inside the oracle's
textual count — a tool-description example line, demonstrating the
AST-vs-text boundary live). The efficiency loss decomposes into: (1) schema
cost where the tool is correctly unused (T4, +7%); (2) additive
verification — the model wields code_search *on top of* rg rather than
instead of it, and pays for line-numbered payloads on counting questions
(the `maxMatches=1` hint went unused; the model wants the lines); (3)
non-adoption where the task's semantics are textual rather than structural
(T3: adoption 0/6 across both gates — starts-with-backtick is a ripgrep
question, the model correctly prefers text tools, then over-verifies into
parser-building swamps on *both* arms). T2 proved non-discriminative: 0/3
off completed, 1/3 on completed and wrong — the closed shape list did not
contain the model's enumeration reflex. Adoption where the shape is
AST-native is solid: T5 3/3, T1 2/3, plus a correct coverage-note-routed
cross-check on T4. **The verdict is model-scoped** — a 27B quant with a
strong write-your-own-parser prior; the battery reruns as the model floor
changes. **The kernel projection (§3.3) is untested by this battery** —
kernel-side adoption rides under `run_python` in transcript metrics; the
kernel dispatch telemetry (`kernel_tool_stats`, kernel-codemode §4.9)
records it directly, so future runs can measure the projection's density
thesis without transcript surgery.

### 4.2 Battery v3 — surface isolation (design, 10-15)

The first gate run's verdict is model-scoped, but that scope was measured
only in the hardest configuration the feature could ship in: schema-only
discovery, no nudge, no cheap pattern-test path at the model level. A
10-15 re-analysis of the 60-run jsonl (`byTool` per run) shows the
efficiency loss decomposes into components the surface can address — and
the field's actual bet is guided positioning, not what the battery
measured.

**Evidence (60-run re-analysis).** Adoption is task-shaped, not
model-fixed: T5 (pure syntax two-count) is on-arm 6/6 with *fewer*
iterations (median 5 → 3.5) and zero false conclusions — the off arm had
one. T3 (textual semantics) is on-arm 0/6 with a +55% token cost (20.5k →
31.8k) at zero adoption — pure consideration cost: the tool was *considered*
on a task it cannot answer. The T2 swamp exists on *both* arms (off arm:
17 iterations, 36.6k tokens, pure bash+python; on arm: code_search **and**
run_python and bash in the same runs) — counting phrasing invites
scripting regardless of the tool, and the on arm pays the additive-
verification price.

**The self-probe.** The T2 closed shape is expressible in a *single*
pattern: `function $NAME($ARG) { $$ }` matched exactly the countable class
on a fixture containing every excluded shape — arrows and methods excluded
by root node type, generators by the `*` token, bodiless overload
signatures by the complete-node rule. One shot, no negation needed. The
weights can generate the right pattern; what they cannot do at the model
level is *verify* it cheaply before committing to a scan. Untestable
certainty resolves to a script — sound epistemic behavior under a surface
that prices certainty too high. The gap is verification, not fluency or
expressiveness.

**Field position.** The vendor's prompting ladder (AGENTS.md default-shift
line → skill → llms-full in context → MCP rule-development process) carries
its own caveat: the line "requires a model with up-to-date knowledge of
ast-grep to be effective. If the model is not familiar with the tool, it
may not utilize it as instructed" — the failure mode is *selection*, not
familiarity. oh-my-pi teaches the full metavariable grammar in the
model-facing prompt and ships `ast_grep` **disabled by default**; Serena v2's
headline interface is a Python REPL (composition in code) — the same
lineage as Porrima's `run_python`, and Prime Agent's deliberately minimal
surface. "Write your own parser" is the system's strongest affordance used
as designed, not a defect of the model.

**Surface changes (prerequisites — the battery cannot run v3 without both).**

- **S1 — `code=` at the model level.** *(implemented 10-15.)* The
  executor's snippet path (`runCodeSearchOnSnippet`, §3.3) already exists;
  the model-level handler routes `code` there and the schema gains the
  parameter. Snippet results have no scope census, so the model-level
  projection must say *snippet*, not *workspace* — no invented totals
  (`renderSnippetText`: shared match-line idiom with `renderText`, and the
  honest zero — *"a zero here is a pattern problem, not an absence"*).
  The snippet path takes no workspace, parity with the kernel dispatcher.
  The honest-zero text earned its keep on day one: the first version of the
  S1 tests typed `$$` for `$$$` in a pattern — the §7 Risk 1 silent-outcome
  trap — and the projection's pattern-problem line is what surfaced it.
  The single highest-leverage change: it converts the one behavior the
  weights cannot self-resolve (unverified pattern coverage) into a ~200 ms
  tool call.
- **S2 — description v3.** *(implemented 10-15 — the candidate text below
  is the shipped text.)* A diff against the prior §3.2 text (measured
  before/after — the gate's aggregate eats the delta):
  - *add* — the snippet nudge: "If you are unsure a pattern will match,
    test it first against a snippet: pass `code=` with a small example —
    cheaper than scanning." (the verification gap)
  - *add* — the anti-script clause: "Do not write a script to count what a
    pattern can match — the pattern is the script." (the T2 swamp)
  - *replace* — the complement framing ("use rg via bash for plain-text
    search") becomes a boundary plus substitutive positioning: "If the
    answer depends on text content (string literals, character order), not
    syntax, use rg via bash — this tool matches syntax only, and is the
    default for syntax-structural questions." (the additive double-dip;
    the T3 consideration cost)
  - *deliberately omitted* — full grammar completion (`$_`, the
    metavariable-reuse rule, per-language traps — the oh-my-pi standard):
    the self-probe showed one-shot syntactic fluency is present; the gap
    is verification, not grammar. Every token must carry a measured
    justification — grammar tokens don't.

**Arms.**

- **A — off** (baseline, unchanged).
- **B — on, schema-only** (with S1+S2). Must be re-run: S2 changes the
  surface, so the v2 on-arm is not comparable.
- **C — on + routing line**: the harness-prompt variant carrying the
  Phase 4 nudge (candidate: "For questions about code structure —
  declarations, call sites, argument shapes — use `code_search`; for
  questions about text content, use rg via bash; do not write scripts to
  count what a pattern can match."). The line rides the harness prompt,
  not AGENTS.md — the battery's firewall and schema-only purity are
  unchanged in A/B; C approximates what the AGENTS.md deployment would add
  in production. The line's own ~25 tokens sit inside C's numbers.

**Tasks.** T1–T5 byte-identical to v2 (comparability with the recorded
numbers). **T6 — diagnostic probe** (excluded from the flip aggregate,
like T4): *"Count `if` statements (without else) whose consequent is
exactly one `return` statement — both the brace-less form `if (x) return y;`
and the single-statement block `if (x) { return y; }` count."* The trap: a
block-form-only pattern (or brace-less-only) silently misses the other
form — the naive single pattern gives a wrong count; a snippet test
containing both forms catches it in one call, and the correct full answer
is a two-pattern decomposition (the §3.3 kernel shape exercised at the
model level). Oracle: engine-derived (tree-sitter); the complete-node
trap applies to the oracle author as always. **Fixture audit before
freeze — both forms must exist in server/src with non-zero instances
(no vacuous witness); if the brace-less form is absent, swap the task.**

**Protocol — probe first.** Before committing the 45-run battery:
T1+T2+T5 × 3 reps on arm B only (9 runs, ~20–30 min on the local model).
The questions: does the T2 swamp collapse (median iterations 14.5 → single
digits, `run_python` dropping out)? Does snippet mode get used at all? If
the behavior does not move, selection — not verification — is the binding
constraint and the nudge arm becomes the whole question; the full battery
still runs, re-scoped.

**Gates — two verdict lines, one decision.**

- **Strict gate (B vs A):** the doc's original purism — the flip must not
  lean on the nudge. Same aggregate as §4.1: summed per-task median turns
  and tokens across the efficiency tasks, completion guard, false-
  conclusion guard, ties pass.
- **Nudge gate (C vs A):** the field's bet — tool plus routing line.
- Decision matrix:
  - **C passes, B fails** → routing is load-bearing but the description
    alone doesn't carry it — ship the tool *with* the routing instruction,
    and the placement preference is the tool's own surface first: extend
    the description (the token cost is measured, like everything else in
    the battery) before any external doc; AGENTS.md / tool guidance is a
    last resort, not the default. The purism clause becomes a revisit item
    — an open question for the measured data, not a law.
  - **B passes** (regardless of C) → flip; routing already rides the
    description, and no external line is needed at all.
  - **both fail** → the model-scoped verdict stands as written; the line
    holds until the model floor moves (the Qwen4 canary is the clock), and
    the surface stays dark.
- A passing arm C validates the routing instruction as a *prompt* surface;
  it does not by itself validate the AGENTS.md deployment — a cheap smoke
  (a small run subset with the line in the real project context) follows
  the flip if C is the passing arm.

**Couplings and caveats.**

- **T4 × Phase G:** adding python grammar (§5, phase G) flips T4's ground
  truth from "none, route to rg" to "N found" — the battery's oracle is
  coupled to the language-coverage decision; the census's `unscanned`
  demand metric and the battery cannot both be treated as frozen facts.
- **Adversarial counting prompts:** v2's closed shape lists make the
  counting tasks harder than the wild; a v3 pass there may overstate
  adoption. T4's probe remains the honest signal — and it already passes
  both arms.
- **Kernel projection:** still not battery-measurable (transcript
  surgery); `kernel_tool_stats` records the rule-loop density from real
  post-flip usage. Battery v3 does not change this.

**Not in v3 (scope fence):** no new model, no outline tasks (phase 2 is a
separate feature with its own design section), no Phase G, no MCP/skill
paths (superseded by the kernel-composition thesis, §2.5), no changes to
the censoring or aggregate machinery.

## 5. Dependency placement

- **`@ast-grep/napi@0.50.0` as a server dependency** (native prebuilds).
  Platform support, per the pinned version's *published artifacts* (the npm
  README's support table lags them): Windows
  x64/arm64/x32, macOS x64/arm64, **Linux x64 gnu, Linux x64 musl, Linux
  arm64 gnu, Linux arm64 musl**. Enceladus (Ubuntu x64) is covered, and
  0.50.0 has no local-platform gap at all. The
  `@ast-grep/cli` binary via the onboarding profiles remains a supported
  execution path — now primarily for remote hosts (phase 3(a)) and as
  insurance against prebuild regressions on future bumps, not for local
  platform gaps.
- **The five-language ceiling — and its cheap escape route.** The napi bundle
  visits typescript, tsx, javascript, html, css — and only those (extension
  set per §3.1 fact 1, which is wider than the five names). v1 deliberately
  ships at the ceiling: the scope census (§3.1) makes it visible in every
  result rather than silently wrong, and `rg` via bash covers the rest. But
  raising it is now a dependency addition, not a research project:
  ast-grep publishes official **`@ast-grep/lang-*` packages** (the
  ast-grep/langs monorepo) — prebuilt tree-sitter grammars made exactly for
  the napi's `registerDynamicLanguage` — so python coverage is `npm install
  @ast-grep/lang-python` + one register call + alias-table entries (the
  drift-pin test then guards the table). Caveats: per-platform native dynamic
  libraries, a postinstall script (pnpm ≥ 10 needs `--allow-build`
  allowlisting; npm runs it by default), and prebuild availability per
  grammar. **On the plan** (§6, phase G), demand-gated — the census's
  `unscanned` counts *are* the demand metric. The CLI (28+ languages) remains
  the fallback of last resort.
- **Field position.** The napi route is rare but not unprecedented (§2
  novelty note): the pi wrappers mostly shell to the CLI (six-step resolver
  chains, TLS-only auto-download, `sg` name collisions are exactly what a
  pinned dependency makes impossible), one pi package
  (@davehardy20/pi-ast-grep-tools) uses the napi with the same
  narrow-language tradeoff, and oh-my-pi sidesteps the prebuild matrix
  entirely by compiling `ast-grep-core` into its own Rust addon —
  demonstrated insurance if the platform matrix ever bites, and evidence that
  broader grammar coverage is solvable in-process without changing the
  dependency story.
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
| **1** | kernel dispatcher row + JSON projection + snippet-testing path (`code=` over `parse`/`pattern`) | **implemented** — exposure gated on `PORRIMA_CODE_SEARCH=1` per dispatcher construction; structured values ride the `value_json` wire flag (driver decodes to a real dict); e2e-pinned through the registry seam |
| **2** | `code_outline` — its own design section, kernel-first | **ahead of remote:** the field's orientation signal is strong and strengthening — @juvio15's rich outline tool, Serena's `get_symbols_overview` as its most-praised feature, `sg outline` first-class with JSON/NDJSON (§2 adjacent lineages); boundary named in §3.4 |
| **3** | remote carve-out (b): adapter-read + in-process parse; (a) host binary only if measured slow | the remote-kernel test bench (P4 smoke pattern); after outline, which serves every local session |
| **G** | **grammar coverage** via the official `@ast-grep/lang-*` prebuilt grammar packages (§5): register dynamic languages, extend the alias table, re-run the drift pin | demand-driven, any time after phase 0 — lands when the census's `unscanned` counts show a language worth covering (python the expected first); each language is one package + table entries + one register call |
| **4** | the one-line default shift in AGENTS.md / tool guidance — a nudge, not the mechanism (discovery must work from the schema/description alone; the feature never leans on AGENTS.md being load-bearing) | **gated on the §4.1 eval battery**, not on the flip alone — first gate run 10-14: **FAIL, flag stays dark** (§4.1 Results; model-scoped verdict, kernel projection untested); **battery v3 designed §4.2** (S1 model-level `code=` + S2 description v3 as prerequisites; arms A/B/C with the strict gate B-vs-A and nudge gate C-vs-A decision matrix) |

## 7. Risks

1. **Pattern-syntax learning cost.** The `$$` vs `$$$ARGS` trap and the
   complete-node requirement are real authoring failures with silent outcomes
   — and the silence is not always a clean zero: a bodiless parameterized
   pattern (`function $N($A)`) plausibly matches *something* (TS overload
   signatures), sending the model into a verify-the-contradiction spiral
   (observed live in the §4.1 shakeout). Mitigations: the cheatsheet
   in the tool description (§3.2 — including the bodiless-declaration trap),
   the advisory regex-shape note on
   zero-match results (§3.2 — fires only at absence, so valid-but-
   regex-shaped code patterns are never blocked), ast-grep's `--debug-query`
   as the debugger (shipped as a model-level tool by @juvio15/pi-ast-grep —
   the proven fallback shape if friction shows up in usage), and the kernel
   rule loop (§3.3) where syntax errors are cheap to find. Residual: the
   model will still author bad patterns; the clean absence surface keeps
   that recoverable, and the §4.1 battery's false-conclusion rate is how the
   residual gets *measured* rather than assumed away.
2. **Fresh-parse cost on large repos** (startup-dominated below ~200 files;
   rg wins wall-clock there). Mitigations: `path`/`globs` scoping as the
   primary lever, server-side budgets and the 120 s backstop, and honest docs
   that this tool buys precision, not speed.
3. **napi platform matrix gaps — narrower than the README suggests.**
   0.50.0 publishes
   Linux arm64 gnu/musl and x64 musl prebuilds alongside the rest (§5); the
   README's support table understates the published artifacts. Residual: prebuild *regressions* on future bumps, and hosts
   outside the nine published targets. Mitigation: the CLI fallback path
   (§5), the test suite's skip-not-fail prebuild probe, and remote hosts
   sidestepping both via phase 3(b) until (a) is earned. oh-my-pi's
   own-addon route is demonstrated insurance.
4. **Coverage illusion** — a five-language engine returning a clean zero over
   a polyglot repo *is the false absence this design exists to prevent*.
   Mitigation: the scope census (§3.1) names every unscanned file and
   extension in the result, the description tells the model the ceiling up
   front, and the qualified-absence phrasing (§3.2) makes "no matches" read
   as "no matches *among what was scanned*." The alias table itself is a
   drift surface in BOTH directions — the engine's extension set is wider
   than the five language names, and Phase 0 shipped a table too narrow
   (scanned `.mjs`/`.mts`/`.scss` files reported unscanned, false "no X
   files in scope" errors) — so it is pinned by a test that queries the live
   engine (§3.1 fact 1). Residual: the census walk approximates (not
   replicates) ignore-crate semantics; discrepancies fail safe by
   under-reporting skips.
5. **Output-volume blowout** (one query, 10k matches). Mitigation:
   `maxMatches` + char cap enforced server-side, summary line always present.
6. **API drift.** The napi surface has changed underfoot before
   (`matchSourceCode` is gone in 0.50.0), and d.ts-vs-runtime traps are
   routine (`Lang` names only the bundled five at runtime; no path on the
   node; callbacks lagging resolution — the last one upstream-documented,
   §3.1 fact 3). Mitigation: version-pinned, executor isolated in one module,
   engine facts pinned in the module header and re-verified on every bump —
   the drift-pin test makes the extension-set fact self-checking.
7. **Staleness: none by design** — fresh parse per call. The risk is the
   inverse (someone later adding a cache); the design brief says the cache is
   how this feature goes wrong.

## 8. Future directions

- **`code_outline`** (§3.4) — kernel-first orientation, then a decision about
  a model-level surface. Now staged as phase 2 (§6), ahead of remote: the
  orientation signal from the field (Serena's `get_symbols_overview`,
  @juvio15's outline tool, `sg outline`) is the strongest in this family.
- **Grammar coverage** — now a planned phase (§6 G) via the official
  `@ast-grep/lang-*` prebuilt grammar packages + `registerDynamicLanguage`
  (§5); `languageGlobs` (`findInFiles` parsing `*.vue`/`*.svelte` as HTML,
  etc.) is a partial reach-extension for embedded syntaxes, worth trying
  before full grammar packages for those cases. The census makes the current
  ceiling explicit wherever it sits, and its `unscanned` counts are the
  demand signal that schedules this phase.
- **LSP semantics** (§2 adjacent lineages) — if usage shows demand for
  reference-grade navigation ("what calls this symbol, *exactly*", rename-
  aware), the path is a language-server adapter (tsserver first — already on
  every Porrima host; pi-code-nav's TS-only carve is the demonstrated shape),
  not more ast-grep. The principles excluding it are revisitable, not
  load-bearing.
- **`-k/--kind` selector** (match by node kind without a pattern): a
  one-line addition over the napi rule object when usage asks; deferred on
  description-bytes cost — pattern-only is the 90% case. (The napi matcher
  already accepts full YAML-shaped rule objects — kind, relational rules,
  constraints — so this is a schema question, never an engine one.)
- **In-situ enrichment** (the Zed direction): `read_file` context selection
  by syntax-node range, symbol breadcrumbs — a `read_file` refinement or the
  outline primitive, not a new tool. Zed's shipped `grep_tool` knobs
  (`max_ancestor_lines`/`context_lines`, 2048-byte snippet cap) are the
  concrete reference shape.
- **Remote phase 3(a)** — host-owned `ast-grep` binary over the remote bash
  path, if measured slow.
- **The full pattern reference** kernel-loadable on demand once the
  description cheatsheet is proven insufficient by usage.
