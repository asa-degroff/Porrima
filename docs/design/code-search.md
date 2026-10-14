# Code Search — structural code navigation for Porrima

**Status:** **Phase 0 IMPLEMENTED (10-13/14)** — executor, tool definition,
budgets, gating, 20-test suite (all green), live smoke on the real repo
(1,551 async-function matches); still dark behind `PORRIMA_CODE_SEARCH=1`.
Design draft (10-13). Written for coding-agent review; round-4
adoption survey folded in 10-13, corrected by a **review pass 10-13** (the
pi-ecosystem claims re-verified against READMEs + oh-my-pi source — three
survey claims corrected, two pi packages added; `@ast-grep/napi` slice-0 probes
run, §3.1's open question resolved; ordering/rendering/zero-match rules and the
OQ7 flip added). **Verified (quje, 10-13):** the review pass's napi probes
re-run in a scratch dir — `Lang` empty at runtime, string language compiles,
no `path` on nodes (`getRoot().filename()` routes the file), `findInFiles`
resolves to a file count, root scans honor `.gitignore` (6 of 7 probes
independently confirmed; the explicit-path-override control probe rests on
the ignore-crate semantics); the oh-my-pi `pi-natives` correction confirmed at
primary source (`crates/pi-natives/Cargo.toml`: `ast-grep-core.workspace = true`
— a direct crate dependency, not the published napi package); both pi.dev
package listings confirmed, `@juvio15/pi-ast-grep@0.4.2` matching the claimed
version.
Extends the
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
  concrete instance of the codemode thesis yet. Round-4 note: the field has
  started shipping the MCP's shape at model level — `@juvio15/pi-ast-grep`
  (§2, pattern 4) is roughly the MCP's four tools plus outline and a language catalog.
  Phase 0 is the deliberately narrower version of that bet — one tool, not six
  — and the kernel row is the argument the other five don't need to exist as
  schema once the loop lives in variables.
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

### Adoption survey: which agent harnesses use ast-grep, and how (round 4, 10-13)

The prior-art survey (rounds 1–3, codemode §2–§2.5) covered the *engine*
lineages; this round covers *adoption* — which agent harnesses actually put
ast-grep in front of a model, and in what shape. Five patterns in the field:

**1. The prompting layer** (no new tool). The official guide's simplest
pattern: a line in AGENTS.md — *"You are operating in an environment where
`ast-grep` is installed… default to using `ast-grep --lang [lang] -p
'<pattern>'`… avoid text-only search unless explicitly requested"* (read).
Field report from a Claude Code user (read, 2025-11): the split that works is
**MCP for capability, skill for judgment** — "tools give power, skills give
intelligence" — with a decision tree (code structure → ast-grep; text,
comments, logs, config → ripgrep) and one line in CLAUDE.md. Claude Code has
no built-in ast-grep tool; adoption there is entirely prompting/skill/MCP —
consistent with its no-index stance.

**2. Skills** (progressive disclosure of when/why/how). The official skill
(repo `ast-grep/claude-skill`, also surfaced as `ast-grep/agent-skill` — read),
Hermes Agent's optional `ast-grep` skill (v1.0.0, vendored from
code-yeongyu/ast-grep-skill, read), and community variants. The Hermes skill
is the most instructive: it ships a Python wrapper that **validates patterns
offline before invoking `sg`** (regex-shaped patterns get a hint and never
reach the binary), and documents three internalized pitfalls — (1) ast-grep
is not regex (`foo|bar` is a bitwise-or; `.*foo` and `\w+` don't parse),
(2) patterns must be valid code (`def $FN($$):` fails on the trailing
colon), (3) `--update-all` and `--json` are **silently mutually exclusive** —
preview-then-apply must be two passes. Its routing rule: "does the answer
depend on the language's syntax tree, or just on the file's bytes?"

**3. MCP** (capability over the protocol). The official experimental
`ast-grep-mcp` (four tools, the rule-development loop: decompose → sub-rules
→ combine → revise → dump AST → test snippet; read) and a community server
(`thrawn01/mcp-ast-grep`, read). This is the pattern the kernel projection
replaces — see §2 above.

**4. Harness-native tools** (first-class tools inside the agent) — the
pattern this doc designs into. Four stacks, seven implementations:
- **pi ecosystem — four independent implementations** (review pass 10-13;
  READMEs and source):
  - `pi-ast-grep` (code-yeongyu, a faithful port of the oh-my-openagent tool
    stack, re-licensed MIT for the pi-coding-agent ecosystem): `ast_grep_search`
    + `ast_grep_replace` (**dry-run by default**), `lang` **required**, 25
    languages, compact text output (`file` → `line:col` → text), an
    anti-pattern table that detects regex-shaped patterns and **nods the
    model toward grep**, and a six-step binary resolver (cached download →
    `@ast-grep/cli` npm → platform npm packages → PATH → Homebrew → GitHub
    release auto-download) with an explicit trust-model caveat (no checksum
    beyond TLS; `PI_OFFLINE=1` for manual install).
  - `oh-my-pi` (`packages/coding-agent/src/tools/ast-grep.ts`; review pass,
    re-read from source 10-13): a single `ast_grep` tool with schema
    `{pat, path?, lang?, skip?}` — `skip` is the only pagination parameter and
    the limit is a hardcoded `DEFAULT_AST_LIMIT = 50` (converges with this
    doc's `maxMatches` default); a bounded retention buffer keeps the best
    matches across multiple search targets **in a pinned order** (path → line
    → column → byte — the comparator is what makes paging deterministic; §3.2
    adopts the same rule). Runs **in-process, but not through
    `@ast-grep/napi`** — its `pi-natives` Rust addon links `ast-grep-core`
    directly (50+ grammars, runtime provisioning via `ensureGrammar`/
    `rerunWithGrammars`/`missingGrammars`). `lang?` is an **optional override
    over auto-detect** ("cpp for ambiguous .h files") — the open question 2 lean, shipped
    in the field. Collects and reports **per-file parse errors separately**
    (capped, with totals); when parse errors exist its zero-match text is a
    **qualified absence** ("the query may be mis-scoped; narrow `path` before
    concluding absence") and the empty result is marked `useless()` so
    compaction can drop it; the model text carries `meta: NAME=value` lines
    for matches with bindings (open question 7 evidence). Approval class `read`;
    `loadMode: discoverable` (lazy tool loading); tool description carried in
    a separate rendered prompt file with five worked examples; structured
    details alongside the model-facing text (`matchCount`, `fileCount`,
    `filesSearched`, `limitReached`, `parseErrors`).
  - `@juvio15/pi-ast-grep` (pi.dev v0.4.2, Apache-2.0, extension+skill;
    read): six tools over a CLI subprocess — `ast_grep_run` (**pattern *or*
    kind**, plus a `code=` snippet mode that runs the §3.3 snippet-testing
    case at *model* level), `ast_grep_scan` (YAML rules), `ast_grep_rewrite`
    (preview default, `apply` opt-in), **`ast_grep_outline` shipped live**
    ("map a file before you read it" — §3.4's counter-evidence),
    `ast_grep_debug_query` (Risk 1's mitigation as a tool),
    `ast_grep_languages` (a language catalog *is* a tool). Injects a bounded
    "promotion" guidance block into the system prompt only while its tools
    are active — a dynamic version of §4's one-line default-shift; `AST_GREP_BIN`
    override, version floor with footer warnings, `/ast-grep-check` smoke
    command, and `/ast-grep-rules` (a saved-rule library in-session: pattern
    5's CI-rule role leaking into the agent).
  - `pi-ast-grep` (fadouse, pi.dev v0.1.0; read): a single read-only
    `ast_grep` tool, `command: "run" | "scan"`, `pattern` or `kind`; invokes
    the binary with **argument arrays, not shell strings** — the same
    no-quoting-surface argument §3.1 makes for napi, reached independently by
    a CLI wrapper author; strips accidental leading `@` from path inputs to
    match pi's file-reference convention.
- **PraisonAI** (Python multi-agent framework; read): `ast_grep_search`
  (**JSON output by default**), `ast_grep_rewrite` (dry-run default),
  `ast_grep_scan` (YAML rules); **path confinement** (paths must resolve
  inside the workspace — rejected before `sg` runs); **10,000-char output
  cap** with head+tail preview + *"Full output saved to: <path>"* pointer and
  an env-var override — structurally the same spill-reference pattern as
  Porrima's tool-output store; graceful fallback when ast-grep isn't
  installed (returns install instructions, never crashes); 60 s/120 s
  timeouts.
- **Gemini CLI** (community extension, stevenAthompson/ast-grep-extension;
  read): four tools — `ast_read` (**structural read of one node** — inspect a
  class or function without reading the file; outline-adjacent),
  `ast_write`, `ast_grep_search`, `ast_grep_rewrite`; "one of a handful of
  extensions that Gemini CLI actually asked me to build… it uses it frequently
  as the builtin 'Replace' command seems to be pretty primitive"; an async
  mode that detaches long searches, writes output to a project `tmp/` file,
  and notifies via **tmux injection** (a harness-environment hack); tips
  insist on explicit `lang`.
- **Zed** (editor agent; read): the contrasting architecture — Zed does not
  add a structural-search tool. Instead (PR #29601, merged 2025-04-29) it
  **enriches the existing agent `grep` tool with syntax information**: match
  context is expanded to the parent syntax node's range, and match headers
  carry **symbol breadcrumbs** (`### impl GitRepository for RealGitRepository
  › fn compare_checkpoints › L1278-1284`) so the model gathers structure
  before reading files. Reported eval impact: better diffs, fewer tool
  failures, reduced total turns. Stated future work: an "elision" output mode
  combining per-file matches while keeping symbol declaration lines.

**5. CI / rule-system role** (non-agentic). The `harness-engineering` repo's
`ast-grep-setup` skill (read): ast-grep as a **repository rule engine** —
`sgconfig.yml`, YAML rule files with a validation script, `ast-grep test`
snapshots, and **ratchet gates** (block new violations while grandfathering
existing ones), architecture boundaries, a ready-made TypeScript rule
library (no-floating-promises, no-unsafe-any, …). This is ast-grep as a
durable project artifact, not an agent tool — out of scope for this doc,
noted because the same rule syntax serves both roles.

**Convergences the survey validates in this design:** rewrite-dry-run-default
and the anti-regex guard are universal across implementations (they should be
first-class, not afterthoughts — §3.2); output bounding with a saved-file
pointer is PraisonAI's exact spill pattern; in-process execution (no
subprocess) is demonstrated in the pi ecosystem — **but not via
`@ast-grep/napi`**: oh-my-pi links `ast-grep-core` into its own Rust addon, so
the pinned-prebuild choice in §3.1/§5 is the one move no surveyed harness has
made (a strength — no resolver chain, no auto-download trust hole, no host
`sg` collision — and an honest novelty note, §5); a 50-match page is what
oh-my-pi hardcodes internally, converging with `maxMatches = 50`; structured
metadata alongside model-facing text is the oh-my-pi shape. `lang` handling
splits: required (pi-ast-grep, Gemini CLI) vs auto-detect-with-override
(oh-my-pi, matching the CLI default — the open question 2 lean's field
support; under napi it lands as the §3.1 string-language mapping).
**Divergences named, not resolved:** Zed's in-situ enrichment (structure
injected into the text tool) vs this doc's default-shift (a dedicated
structural tool); pagination — oh-my-pi ships `skip` (its limit is internal,
not a parameter) and this doc leans to match in phase 0, with the §3.2
ordering contract as the precondition (open question 8); `ast_read`-style
single-node structural reads sit between search and outline (open question 9). **Not adopting ast-grep
(anywhere found):** aider (tree-sitter directly in `repomap.py` — the
precomputed-map lineage), and no built-in surface in Cursor/Copilot/Codex/
opencode (the ripgrep lineages of codemode §2–3).

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
surface (verified from the package's `types/api.d.ts` **and runtime probes,
10-13, this machine**): `pattern(lang, pattern)` compiles a pattern into a
matcher `NapiConfig`; `findInFiles(lang, config, callback)` "discovers and
parses multiple files in Rust" and delivers matched `SgNode`s per file,
`config` shape verified as `{paths: string[], matcher: NapiConfig,
languageGlobs?: string[]}`; `parseFiles`/`parseAsync` for the snippet-testing
case (kernel rule loop). Note: this is the *new* napi API — the older
`matchSourceCode`/`matchRuleSourceCode` names do not exist in 0.50.0 (verified:
runtime exports are `Lang, kind, parse, pattern, parseAsync, findInFiles,
registerDynamicLanguage, parseFiles, tsx, jsx, html, ts, css, js`; `SgNode`/
`SgRoot` are types, not runtime values). Four probe findings shape the
executor — each one was an assumption until today: (1) `sg.Lang` is a
compile-side enum, **empty at runtime**; language args are strings (`'ts'`
works; `Lang.Ts` is `undefined` and fails as a Rust `StringExpected` throw) —
the executor keeps an explicit name table; (2) match nodes do **not** carry
the file path — it lives one hop away at `node.getRoot().filename()`,
populated only on the `findInFiles` discovery path (per its own declaration
comment); `CodeSearchMatch.file` routes through `getRoot()`; (3) `FindConfig`
has **no include/exclude globs** — `languageGlobs` maps extensions to a
language, it is not a filter — so the `globs` param below is necessarily
executor-side filtering over discovered paths, never a napi feature; (4) the
`findInFiles` promise resolves to a file count (probes could not distinguish
*scanned* from *files-with-matches*), and nothing at this boundary reports
files searched — the §3.2 summary line counts callback invocations (files
with matches, per probe) and must not claim a `filesSearched` the binding
cannot supply.

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

**File discovery/ignore semantics: resolved by probes, 10-13.** `findInFiles`
**does** honor `.gitignore` the way the CLI does (probe: a git repo with an
`ignored/` dir holding a matching file; a root scan skipped it — napi rides the
same `ignore` crate). The control probe surfaced the precedence rule `globs`
must inherit: passing that ignored path **explicitly** in `config.paths` *does*
match it — ripgrep's ignore-crate semantics, explicit arguments override
ignores. So: scans descend ignore-clean; requested paths are honored as asked.
The executor documents the rule and applies its `globs` filtering after
discovery (napi's filter surface is ignores + languageGlobs, nothing else).

**Parse errors, reported separately.** Unparseable files are a normal
occurrence (generated code, unusual dialects), and silently dropping them
makes "0 matches" ambiguous. The oh-my-pi implementation (round 4, read) sets
the pattern: collect per-file parse errors, cap the list, report the total,
and surface them *alongside* the matches — never folded into them. The
executor does the same: `matches` + `parseErrors[]` + `parseErrorsTotal`, with
the text projection appending a one-line summary ("2 files skipped: parse
errors — see …" when non-empty).

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
47 matches in 12 files
server/src/services/agent-tools.ts:1048: toolDispatcher: kernelToolsEnabled() ? ...
server/src/services/agent-tools.ts:1106: return withMutationLock(`workspace:${...
server/src/services/memory-tools.ts:315 [MSG=`value: ${msg}`]: console.log(`value: ${msg}`)
server/src/services/memory-extraction.ts:88: async function extractMemories(...) … +14 lines
```
(The last two lines preview the review-pass rendering rules below — inline
single bind, multi-line collapse.)

**No matches is a clean value, not an error** — `no matches` (+ the scope that
was searched). This fixes cost #3 at the surface: the expected outcome stops
being a failure. One refinement the review pass steals from oh-my-pi: when the
scan produced **parse errors**, zero matches is a *qualified* absence — the
summary appends "skipped files may mean the query is mis-scoped; narrow `path`
before concluding absence." Absence-with-unparsed-corpus is exactly where the
model over-concludes. (oh-my-pi additionally marks empty results `useless()` so
compaction drops them; the Porrima analogue: a zero-match tool row is
retention-fodder, never signal.) Invalid patterns are tool errors generated
by the executor's own validator (§3.2 pre-validation) — the engine itself
never throws on bad syntax (tree-sitter's error tolerance carries garbage
through, and it matches nothing).

**Ordering and rendering (review-pass additions).** Matches sort by
`(file, start.line, start.column, byteOffset)` before truncation — a pinned
comparator (oh-my-pi's `compareAstFindMatch` is the reference shape). Fresh
parse per call means no index, so pagination (`skip`, open question 8) is only coherent
with a deterministic order; without it, "next page" under a churning tree is
undefined. Multi-line node text renders as the first line plus an `… +N lines`
marker — the model-level text is an index, not a payload; full node text stays
in the kernel projection. Metavariable bindings: single binds render inline on
the match line (`file:1048 [NAME=binding]: …`), multi binds (`$$$`) compress to
one capped line — open question 7 flipped to yes-compactly on this evidence; the kernel
JSON remains the structural source.

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
(**validated against 0.50.0 in slice 0, 10-13/14** — the two inferred lines
below were corrected):
- `function $NAME($$$ARGS) { $$$ }` — the complete-node workhorse form.
  **Patterns must be complete nodes**: a body-less function pattern
  (`function $NAME($$$ARGS)`) matches NOTHING — the inferred `fn $NAME($$$ARGS)`
  / `function $NAME($ARG)` lines were wrong on this point. The partial
  prefix `function $NAME` (trailing ERROR node) is the workhorse instead —
  it matches ANY function definition (typed, generic, async).
- `await $CALL($$$ARGS)` — single metavariables bind; `$$$NAME` binds *lists*
  (the inferred `$VAR = await $CALL()` statement form fails to match).
- plain text with no metavariables is a **literal** match
- the classic trap (verified via `--debug-query`): `$` is *not* a
  multi-element metavariable — it parses as a bare identifier named `$`.
  Three dollars plus a name is the list syntax.

**Pattern pre-validation.** Every serious implementation in the field (round
4) guards against regex-shaped patterns *before* the call — pi-ast-grep
detects them and nudges toward grep, the Hermes wrapper validates offline and
never invokes `sg` on a regex-shaped pattern, the skills carry anti-pattern
tables. The executor does the mechanical half in three layers, all
calibrated against the CLI referee (probed 10-13/14):
1. **regex-shape heuristic** — rejects the classic regex shapes (`\w`, `\d`,
   `.*`, `|`, `[a-z]`) with the hint *"ast-grep patterns are code, not regex
   — for text search use `rg` via bash"* — saving a round-trip and pointing
   the model at the right tool instead of a confusing empty result.
2. **trivial class** — no code content at all (empty, bare punctuation;
   mirrors the CLI's exit-8 "Cannot parse query"). Hard tool error.
3. **foreign-token rule** — the "written for a different language" class.
   `pattern()` NEVER throws on bad syntax (tree-sitter parses tolerantly, so
   ERROR-node presence is not a validity signal — `function (unclosed` is
   100% ERROR yet must stay a clean 0-match, and `function $NAME` carries an
   ERROR wrapper yet is the flagship matching pattern). The signal: a
   concrete token that is a generic name in the target language but a
   KEYWORD of another supported language, decided by a single-token parse
   (keywords are anonymous nodes — `sg.kind()` only sees named kinds, so the
   parse is the referee). Explicit `lang`: hard tool error naming the
   offending token; auto-detect: per-file parse-error entry (file skipped,
   the rest of the corpus still scanned — which is what makes the qualified
   0-match phrase fire).

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
  concrete place §2.5 named. Honest cost (review pass): every iteration is a
  fresh parse of the scoped tree (§1's regime) — the loop is free in *context*,
  not in CPU. At measured cost (~0.05 s over all of `server/src` on this box)
  a ten-iteration refine pass stays well under a second; scoping is what keeps
  it there.
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
names it so the review can reject the boundary if it is wrong. Review-pass
note: the field disagrees with the *deferral*, not the seam —
`@juvio15/pi-ast-grep` ships `ast_grep_outline` live at model level ("map a
file before you read it") and Gemini CLI's `ast_read` sits in the same
territory (§2, pattern 4). The kernel-first lean therefore rests on the
economics (§3.2
budgets make orientation free mid-kernel; `list_files` covers the tree case),
not on uncertainty about whether orientation is a distinct job. It is.

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
- **Field position (review pass).** No surveyed harness uses `@ast-grep/napi`:
  the pi-ecosystem wrappers shell to the CLI (and pay for it — pi-ast-grep's
  six-step resolver chain, TLS-only auto-download, and the `sg` name collision
  are exactly what a pinned dependency makes impossible), while oh-my-pi
  compiles `ast-grep-core` into its own Rust addon, sidestepping the prebuild
  matrix entirely and carrying 50+ grammars with runtime provisioning. That
  addon route is demonstrated insurance if Risk 3 ever bites, and its grammar
  reach is the honest ceiling-comparison against our bundled set
  (`registerDynamicLanguage` is the napi-side analogue — named, not used in
  v1). The pinned prebuild stays the right v1: version-pinned in
  package.json, no download path, no host-PATH surface.
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
| **0** | model-level `code_search`: executor (napi, local), tool definition, budgets, gating, tests — **IMPLEMENTED + VERIFIED 10-13/14** (20/20 suite; every pin closed: napi ignore semantics, `findInFiles` resolves to a file count, the napi's five-language table, `globs` post-discovery filtering + explicit-path precedence, the `(file, line, col, byte)` ordering comparator, multi-line rendering, the error surface (trivial class + foreign-token rule), the qualified 0-match value, budget stops; live smoke on the real repo) | dark; `PORRIMA_CODE_SEARCH=1` to flip |
| **1** | kernel dispatcher row + JSON projection + snippet-testing path (`pattern`/`parseFiles`) | rides the live kernel flag; one exposure-list line |
| **2** | remote carve-out (b): adapter-read + in-process parse; (a) host binary only if measured slow | the remote-kernel test bench (P4 smoke pattern) |
| **3** | `code_outline` — its own design section, kernel-first | deferred; boundary named in §3.4 |
| **4** | the one-line default shift in AGENTS.md / tool guidance | lands with phase 0's flip |

## 7. Risks

1. **Pattern-syntax learning cost (real, measured).** The `$$` vs
   `$$$ARGS` trap is not hypothetical — it is what a correct-looking pattern
   silently does (verified via `--debug-query`, 10-13). Mitigations: the
   cheatsheet in the tool description (§3.2), ast-grep's own
   `--debug-query` as the in-tool debugger (shipped as a *model-level tool* by
   `@juvio15/pi-ast-grep` — if authoring friction shows up in usage, that is
   the proven fallback shape), and the kernel rule loop (§3.3)
   where syntax errors are cheap to find. Residual: the model will still
   author bad patterns; the clean error surface keeps that recoverable.
2. **Fresh-parse cost on large repos (measured: startup-dominated below
   ~200 files; rg wins wall-clock there).** Mitigations: `path`/`globs`
   scoping as the primary lever, server-side budgets and the 120 s backstop,
   and honest docs that this tool buys precision, not speed.
3. **napi platform matrix gaps (musl/arm64 Linux, verified absent in 0.50.0).**
   Mitigation: the CLI fallback path (§5); remote hosts sidestep both via
   phase 2 (b) until (a) is earned. Insurance with field precedent: oh-my-pi
   compiles `ast-grep-core` into its own native addon and never touches the
   prebuild matrix (§5) — building our own binding is the proven way out if
   this ever bites.
4. **Output-volume blowout** (one query, 10k matches). Mitigation:
   `maxMatches` + char cap enforced server-side, summary line always present.
5. **API drift** (the napi surface changed underfoot — 0.50.0 has no
   `matchSourceCode`). Mitigation: version-pinned, executor isolated in one
   module, top-level signatures and config shapes verified 10-13 — the runtime
   probes caught two d.ts-vs-runtime traps on day one (empty `Lang` at runtime;
   no path on the match node; §3.1), which is why "pinned, not assumed" is not
   ceremony. The rest pinned in slice 0.
6. **Staleness: none by design** — fresh parse per call. The risk is the
   inverse (someone later adding a cache); the design brief says the cache is
   how this feature goes wrong.

## 8. Open questions (review surface)

1. **Defaults:** `maxMatches` 50? context lines 1? output cap 20 KB?
2. **`lang` semantics:** auto-detect from file extensions (CLI default) vs
   require explicit when `path` is a single file. Lean: auto-detect, explicit
   override — **oh-my-pi ships exactly this** (optional `lang?` override for
   ambiguous extensions; the round-4 bullet omitted it). Under napi the choice
   also carries the §3.1 string-language name table.
3. **`-k/--kind` selector mode** (match by node kind without a pattern — the
   CLI supports it): expose in v1 or defer. Lean: defer — pattern-only is the
   90% case, and kind selection is a power feature that costs description
   bytes. Review-pass note: both newer pi packages ship it (`pattern` *or*
   `kind`, mutually exclusive) — evidence accumulating, argument holds; a
   kind-only rule is a one-line addition in the napi rule object when usage
   asks.
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
   output?** Review pass **flips the lean: yes, compactly** — oh-my-pi emits
   `meta:` lines in its model text and pi-ast-grep's whole docs lean is
   bindings-as-answer ("what are the arguments here?"); a binding-free line
   can't show the pattern matched what the model meant. The §3.2 rendering
   rule is the compromise: single binds inline on the match line, multi binds
   compressed and capped, full structure kernel-only. The text index stays one
   match per line.
8. **Pagination.** oh-my-pi (round 4) ships `skip` — page through a 47-match
   result without re-running the query from zero; its limit is internal
   (hardcoded 50), not a parameter, so this doc's caller-adjustable
   `maxMatches` budget is the superset.
   Lean: add `skip` to the schema in phase 0; it is three words of executor
   work and the text projection already carries the total count to make it
   useful. **Precondition (review pass): the §3.2 ordering contract** —
   pages are only stable under fresh parses with a deterministic comparator.
9. **In-situ enrichment / single-node structural reads.** Zed (round 4) does
   not add a structural tool — it enriches the existing `grep` output with
   syntax (parent-node context ranges, symbol breadcrumbs). The adjacent
   moves for Porrima are *read_file* context selection by syntax node range
   instead of fixed lines, and Gemini CLI's `ast_read`-style single-node
   structural reads — same territory, tool-side. Named here as a future
   direction (a `read_file` refinement or the outline primitive of §3.4, not
   a new tool); not designed in this doc.

## 9. Sources

- **Verified, 10-13, this machine** (installed + ran `@ast-grep/cli@0.50.0`
  and `@ast-grep/napi@0.50.0` in a scratch dir): `run`/`outline` usage and
  options; JSON match shape; outline JSON shape; exit codes (0 = matches,
  1 = no matches); the `$$`-is-an-identifier trap via `--debug-query=pattern`;
  speed measurement on `server/src` (0.050 s wall / 0.362 s user vs rg 0.010 s
  wall / 0.004 s user); napi exports and `pattern`/`findInFiles` signatures
  (`types/api.d.ts`); **runtime napi probes 10-13** (`@ast-grep/napi@0.50.0`,
  scratch dir): `FindConfig` = `{paths, matcher, languageGlobs?}` and
  `pattern()`→matcher wiring; `findInFiles` honors `.gitignore` on a root scan
  *and* matches an explicitly-passed ignored path (control probe — ignore-crate
  precedence); file path via `node.getRoot().filename()` (nothing on the node
  itself); `sg.Lang` empty at runtime — `Lang.Ts` is `undefined`, a Rust
  `StringExpected` throw, `'ts'` works; `findInFiles` resolves to a file count
  (scanned-vs-with-matches indistinguishable in my probe); platform support
  matrix (package README); `/usr/bin/sg` = util-linux set-group on Enceladus;
  ast-grep not installed; rg 15.1.0 present.
- **Read** (primary docs, ast-grep.github.io): `run`/`outline` reference;
  the tree-sitter Rust-rewrite blog post (agent-workload scoping); the
  prompting/AGENTS.md pattern and `llms-full.txt`; the official MCP
  (`ast-grep-mcp`, four tools, ~75% token delta claim).
- **Read** (round 4, 10-13, adoption survey): the ast-grep prompting guide
  (the four adoption patterns; the AGENTS.md example attributed to a Kieran
  Klaassen post); `pi-ast-grep` README (tool set, `lang` required, 25
  languages, six-step binary resolution, trust-model caveat, anti-pattern
  table) — every pi-ast-grep claim stands; `oh-my-pi`
  `packages/coding-agent/src/tools/ast-grep.ts` source (re-read, review pass:
  `pat`/`path`/`lang?`/`skip` schema, `skip` paging against a hardcoded
  internal limit, bounded-retention ordering comparator, per-file parse
  errors, qualified zero-match + `useless()` marking, `meta:` lines in model
  text, in-process via its own Rust `pi-natives` addon linking `ast-grep-core`
  — *not* `@ast-grep/napi` — `approval: read`, `loadMode: discoverable`,
  prompt-file description with examples);
  PraisonAI ast-grep tools docs (JSON default, path confinement, 10k-char
  cap with saved-file pointer, 60/120 s timeouts, not-installed fallback);
  Hermes Agent ast-grep skill docs (offline pattern validation, the
  `--json`/`--update-all` silent mutual exclusivity, the syntax-tree-vs-bytes
  routing rule); Gemini CLI `ast-grep-extension` README (`ast_read`/
  `ast_write`/search/rewrite, tmux-injection async mode, "asked me to build"
  quote); Zed PR #29601 (syntax-enriched agent grep: parent-node context,
  symbol breadcrumbs, reported eval gains, elision plan);
  `harness-engineering` ast-grep-setup skill (sgconfig, YAML rule tests,
  ratchet gates); nohzafk "teaching Claude Code to use ast-grep"
  (MCP = capability, skill = judgment; the decision tree);
  `ast-grep/claude-skill` and `ast-grep/agent-skill` repos;
  `thrawn01/mcp-ast-grep`; aider `repomap.py` + tree-sitter-language-pack
  (the non-ast-grep contrast). Review-pass additions: `@juvio15/pi-ast-grep`
  pi.dev README (six tools over the CLI, `code=` snippet mode, conditional
  "promotion" prompt block, `AST_GREP_BIN` + version floor, `/ast-grep-check`,
  `/ast-grep-rules` rule library, extension+skill packaging); `pi-ast-grep`
  (fadouse) pi.dev listing (`command: run|scan`, `kind`, argument-array
  exec); oh-my-pi README (the `pi-ast` crate links `ast-grep-core`; 50+
  grammars; native `ast_grep`/`ast_edit` tool family).
  **Survey corrections recorded (review pass):** the round-4 oh-my-pi entry
  omitted `lang?` from its schema, described an internal hardcoded limit as a
  schema limit, and credited in-process execution to "napi bindings" that are
  not `@ast-grep/napi`; the pi ecosystem counts four implementations, not two.
- **kernel-codemode.md** (10-13): §2.5 (research round 3 — the full lineage:
  aider/agentpatterns/LlamaIndex, the fresh-vs-precomputed split, the kernel
  insight), §4.3 (Tier 1 `code_search` row), §7 Q9 (the open questions this
  doc answers and its recorded lean), §4.9 (server-side budgets, lock rules,
  the remote carve-out principle), §4.10 (Phase A projection pattern).
- **Inferred** (design judgment, marked as such in §3–§4): the two-projection
  staging, the default-shift framing, the output-format choices, the
  cheatsheet content, the phase-2 (b)-before-(a) order.
