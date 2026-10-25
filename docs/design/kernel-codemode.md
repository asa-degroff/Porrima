# In-Kernel Tool Composition — codemode for the session kernel

**Status:** Phase A implemented and live behind `PORRIMA_KERNEL_TOOLS=1`; Phases B–D design.

## 1. Problem

Every tool call in the current model loop round-trips its full output through the model's
context before the next action can use it. Cloudflare's original Code Mode post states the
cost plainly: "the output of each tool call must feed into the LLM's neural network, just
to be copied over to the inputs of the next call, wasting time, energy, and tokens" —
and code composition lets the model "only read back the final results it needs."
(source: blog.cloudflare.com/code-mode/, read)

Porrima already runs a persistent per-chat Python kernel
([session-python-kernel.md](session-python-kernel.md)): state survives across calls and
across server restarts (dill restore), background jobs run under a box-wide cap of 8 with
a 4-slot LRU, the interrupt ladder maps stop-button → job abort, and large outputs spill
to disk. System-chat and remote-SSH kernels (P4a) use the same protocol.

What the kernel cannot do is call Porrima's tools. `run_python` is the only tool that
crosses into it; everything else — `web_fetch`, `read_file`, `search_memory`, `bash` —
stays a model-level call whose output lands in context. So the persistence we built is
valuable only for Python-native work (the kernel can `subprocess`, but without
Porrima's permission layer, output spilling, observability, or the memory system).
The "pipe output into input" pattern is structurally impossible today.

**Goal:** a feature-complete in-kernel execution mode in which the model can call
Porrima's tools from inside one program, so intermediate values stay in kernel memory
and only the final result crosses the wire. The acceptance bar: it should be able to
**replace isolated bash calls**, not sit beside them.

### Non-goals

- **No security sandbox.** The kernel runs with user trust, exactly like the `bash` tool.
  Confinement (Cloudflare/opencode's axis) is orthogonal for a local agent and is not the
  point of this design.
- **No durable execution / replay / approval / rollback.** That is Cloudflare's separate
  axis (SQLite replay spine, pause/resume approvals, compensation). Different threat
  model; Porrima has `ask_user` and the permission layer instead.
- **No second runtime.** No JS interpreter. The composition language is the kernel's own
  Python — one substrate, not two.
- **No model-surface changes in Phase A.** The change is additive first; surface
  shrinkage is a later, evidence-gated decision (§5 Phase D). Phase A does spend one
  capability line in the `run_python` *description* — description text, not a new or
  removed tool, and batched per §4.9.
- **No subagent spawning in Phase 1.** The prime-agent `rlm.spawn` equivalent (recursive
  child agents callable from code) is out of scope; the seam is noted where it would
  land (§4.7) but not built.

## 2. Prior art

Five lineages, plus structural navigation (§2.5) — a fourth axis the codemode survey
missed — plus completion notification (§2.6), a fifth axis that the survey never separated
from yield/resume. Full detail with sources lives in the archived project
memory blocks ("Codemode Prior Art — Lineages", "Round 2", "BG Notification — …" — out of
active context, still searchable) and §8; this section is the design-relevant distillation.

**"Codemode" conflates two separable ideas** — (A) in-language *tool composition*
(pipe outputs to inputs without round-tripping through model context) and (B) *persistent
environment* (state surviving across calls/turns). Every implementation picks a point on
both axes, and the axis choices are the whole design space.

| System | Language / runtime | State scope | Callable from code | Kept model-level |
|---|---|---|---|---|
| Cloudflare `@cloudflare/codemode` (originator) | TS in V8 isolates | per-call (disposable) | MCP connectors only (+ `search`/`describe`) | nothing — codemode is the only model tool |
| opencode `@opencode/codemode` | pure-TS interpreter, no sandboxing | per-call (fresh runtime per call) | MCP tools + orchestration namespaces (browser, worktrees, session) | the primitives: read/edit/write/**shell**/web |
| OpenAI Codex `codex-rs` | JS in persistent V8 isolate (separate host binary) | per-conversation | essentially the **whole tool surface** (Function + Freeform kinds), minus exec-itself | nothing in codemode mode |
| Prime Agent (PrimeIntellect) | Python (IPython kernel: spawn/execute/revive) | per-session, survives supervisor restart | `rlm.*` API (subagents, harness CRUD, messaging, compact/goal/refine, images, skills) + MCP client | exactly `bash`, `edit`, `python_repl` |
| smolagents CodeAgent (CodeAct lineage) | Python (AST-whitelist local executor; E2B/Docker/Modal/Blaxel remote) | per-process / per-kernel | **all tools** (`additional_functions`) | nothing — code is the only interface |

Persistent-shell lineage (OpenHands in-sandbox bash sessions + Jupyter plugin; Cline
VS Code terminal + background spawn; Claude Code — no official persistent shell,
community tmux wrappers; the `repl-scratchpad` skill driving a tmux-backed Python REPL
with a "print contract"). This lineage is where Porrima's kernel already sits, and
strictly ahead of it: in-process and typed, not shell-piped. (Cline details via
DeepWiki's source trace — corroborated, not read at primary source.)

**The structural finding every implementation shares: projection, not relocation.**
The kernel never re-implements tool logic. It gets callables that proxy back to the
host over a protocol; the host keeps the permission checks, the single source of truth,
and the observability:

- Cloudflare: sandbox globals are RPC bindings; connectors execute host-side.
- opencode: child calls route through the host tool loop; each nested call enforces its
  own permission individually.
- Codex: a dispatch broker forwards to the regular tool router with session/turn
  context preserved; nested calls are recorded with cell provenance
  (`ToolCallSource::CodeMode { cell_id }`).
- Prime Agent: "The MCP protocol itself runs kernel-side (Python stdio/HTTP); the
  engine never spawns MCP servers" — the kernel's generic MCP client resolves auth
  through host handlers. `rlm.*` calls hit a host seam trait.
- smolagents: `additional_functions` are host callables injected into the code.

**Reliability-model note:** Prime Agent's architecture is daemon supervisor + one worker
process per active session + append-only JSONL session persistence + reattach after
supervisor restart. That is structurally the same ridge as Porrima (server + per-chat
kernel process + dill restore). We are not catching up to their architecture — we are
already on it.

**Two end-state shapes**, both defensible:

1. **Additive** (Cloudflare/opencode shape): keep the model's full tool surface; code
   composes tools from inside the runtime.
2. **Minimal surface** (prime-agent shape): shrink the model-facing surface toward
   bash/edit/python_repl; everything else lives as the kernel API.

Prime Agent's provenance matters for weighting: it is the product of the org that wrote
the RLM paper (arXiv 2512.24601 → prime-agent arXiv 2608.23552, "A Self-Improving RLM
Harness"; Continual Harness arXiv 2605.09998), ported TS→Rust with a byte-parity merge
gate against the TS v0.9.8 binary. Research→product in one line, with verification
discipline. Its surface contract ("tools exposed to the model: `bash`, `edit`,
`python_repl`") is the strongest endorsement in the survey for the minimal-surface
end-state.

### 2.5 Structural navigation — ast-grep and the repository-map lineage

A fourth axis the codemode survey never touched: **structural code
navigation** — tools that understand code structure rather than match text. None of the
five lineages exposed it as a first-class tool; they all ride on ripgrep/read + shell.

**ast-grep** (ast-grep.github.io, read) — Rust, tree-sitter-based "a hybrid of grep,
eslint and codemod." Patterns are code-as-pattern (`console.log($$)`,
`fn $NAME($$)`), composable into YAML relational rules (`all`/`any`/`inside`/`has`/
`precedes`/`follows`, `stopBy: end`); 30+ languages via tree-sitter grammars; file
traversal on ripgrep's `ignore` crate; a measured six-rule scan of TypeScript's `src`
in ~1 s wall. Three details matter here:

- The author **rewrote tree-sitter's C core in Rust** and scoped the fork deliberately:
  it dropped incremental old-tree reuse (an editor-only concern) because "AI coding
  agents analyze complete file snapshots" — a fresh parse is the agent workload's
  normal operation (blog: tree-sitter-rust-rewrite, read). Parser throughput +30%,
  end-to-end ~22% faster; a TypeScript stress corpus that once peaked above 1 GiB now
  peaks at 91 MiB. The parser stack is now tuned for exactly our regime.
- **`sg outline`**: a first-class orientation command — top-level symbols, imports,
  exports, members; views (`names`/`signatures`/`digest`/`expanded`); filters
  (`--match` regex, `--type`, `--items`); JSON with line ranges, byte offsets,
  LSP-compatible symbol types; NDJSON stream mode (reference/cli/outline, read).
- The **official AI surface** (advanced/prompting, read): a Claude Code skill for rule
  authoring; an AGENTS.md prompt pattern ("default to ast-grep for syntax-aware search,
  avoid text-only search unless requested"); `llms-full.txt` (the whole docs for model
  context); and an experimental official MCP (ast-grep-mcp, read) with four tools —
  `find_code`, `find_code_by_rule`, `test_match_code_rule`, `dump_syntax_tree` — text
  output ~75% fewer tokens than JSON, organized around an iterative rule-development
  loop (break down the query → sub-rules → combine → test against a snippet → dump the
  AST when it fails).

**The repository-map lineage** (aider origin; agentpatterns.ai distillation,
corroborated): tree-sitter parse → symbol/signature extraction → file graph → PageRank
with personalization (files being edited get boosted) → binary-search fit into a token
budget (default ~1024 tokens). Aider's SWE-bench Lite result (26.3% resolve, 70.3%
correct file identification) credits the full stack, not an ablation. The pattern's own
backfire conditions: fast-changing repos (stale index), heavy metaprogramming
(AST ≠ runtime structure), small repos. The counterpoint: **Claude Code deliberately
doesn't index** — on-demand agentic search (Glob/Grep/Read) beat its RAG experiments
(corroborated). The field splits into *fresh agentic queries* vs *precomputed structural
indices*; ast-grep's fork sits squarely on the fresh side.

**Design mapping** (inferred; lands in §4.3, §7 Q9): the kernel makes ast-grep strictly
more useful than its own MCP — the MCP exists to give the model a test loop for rule
authoring, and every iteration costs context; in the kernel the same loop is free in
variables (the codemode thesis in a concrete place). A model-level `code_search`
wrapper over the CLI is separable from protocol v2 and earns Tier 1 on every §4.2
criterion. `sg outline` opens a project-context orientation seam (outline entry →
range-read by byte offset → transform, without full file reads). Structural rewriting
lands in Tier 2 by construction (file mutation → provenance gate).

**Adoption survey:** which agent harnesses actually use
ast-grep and in what shape (prompting layer, skills, MCP, harness-native tools
in the pi ecosystem / PraisonAI / Gemini CLI / Zed's syntax-enriched grep, and
the CI ratchet-gate role) lives in [code-search.md](code-search.md),
with the design refinements it validated (pagination,
parse-error reporting, pattern pre-validation).

### 2.6 Completion notification — how the agent learns that background work ended

Yield and resume (§4.5) answer *how work detaches*. A separate axis answers *how the agent
finds out it ended*, and every harness that has background work has solved it one of three
ways. Porrima has not solved it at all: `run_python`'s description already forbids polling
("end your turn and check progress with `python_jobs` on a later turn") while offering no way
to satisfy the prohibition. That is the gap §4.5 closes.

| Family | How it works | Who pays the cost | Examples |
|---|---|---|---|
| **Steer** | the notice is injected into the running conversation at the next step boundary | needs a withdrawal mechanism (a notice can race the agent's own read) and a durable pending record | opencode (`Inbox`, `delivery: "steer"`, `execution.wake`); prime-agent (steering row with `queueIfBusy` + `resumeIfIdle`, and `bash.consumed` to withdraw a stale queued notice) |
| **Boundary** | a busy session *refuses* the notice; the sender retries until the session is idle, then lands one coalesced notice | no withdrawal machinery, because consumption during the turn retires the notice before it can land | albedo (`owed` = finished-with-result-unread, one announcer, 2 s retry, "jobs still owed when the retry lands share one notice, and so one turn"); OpenClaw (completion turn in the originating session, "waits behind existing work") |
| **Pull** | the agent holds a handle and asks | nothing to deliver, but a turn can end with work outstanding and nobody noticing | Codex (`exec`/`wait`/`write_stdin`); Claude Code (`TaskOutput` removed in favour of `Read` on the output file) |

Five independent implementations agree on four rules:

1. **A backgrounded call returns a handle plus a named output pointer**, never a promise of
   results. The pointer *is* the primitive — Claude Code retired its retrieval tool rather than
   its output file.
2. **Anti-polling is written into the tool result**, not only the system prompt, and the most
   robust harnesses enforce it structurally: albedo's shell guard refuses a raw shell line,
   `subprocess`, and `time.sleep` of a second or more from inside a cell, and each refusal names
   the `run()` call the line means — explicitly "guidance, not a sandbox".
3. **Coalescing is default, not a guard.** N completions → one notice → one turn. This matters
   more here than anywhere else in the survey: a notice turn costs a fresh prefill.
4. **Something long-lived must own the ledger of owed completions**, and it should not be the
   component that deploys most often. prime-agent puts it in the daemon; albedo puts it in the
   kernel (with a host-side registry mapping session id → submit closure, and a loader that
   *starts* an idle session so an owed wake can land); opencode puts it in the host store as a
   pre-minted message id with a typed recovery record.

Which family Porrima uses is decided by where the ledger lives, not by taste: the long-lived
execution owner is the job supervisor, while the owed-completion ledger is the server's SQLite,
so the **boundary** family applies directly and the steer family's withdrawal machinery is not
needed. That position is settled in [kernel-durability.md](kernel-durability.md) §2; §4.5 states
the notification design itself.

## 3. Design axes, and where Porrima sits

| Axis | CF | opencode | Codex | prime-agent | smolagents | **Porrima (today)** |
|---|---|---|---|---|---|---|
| State scope | per-call | per-call | per-conversation | per-session (+restart) | per-process | **per-chat (+restart, widest)** |
| Confinement | confined | confined | open | open (opt-in OS sandbox ext.) | soft (AST whitelist) | open |
| Yield / resume | n/a (durable replay) | n/a | `exec`/`wait`/`terminate` by cell_id | daemon + reattach | timeout only | background jobs, no cell resume |
| Tool catalog discovery | `search`/`describe` lazy | `search` builtin | schema-size cap on injection | static layered prompt | static | static (grows with surface) |
| Durable replay / approval | yes | no | no | no (snapshots for refine) | no | no (out of scope, §1) |
| Model surface size | one tool | full + codemode | full (+codemode) | **three tools** | zero (code only) | ~30 tools |
| Completion notification | durable replay | steer + wake | pull only | steer + wake + consumed-withdrawal | n/a | **pull only, no wake** |

Porrima lacks two axes: the composition axis (the kernel-side tools API) and the completion
axis (§2.6) — the ability for background work to bring the agent back. Both are designed here.

## 4. Design

### 4.1 The kernel tools API (a projection)

A namespaced `tools.*` module is injected into the kernel namespace. Each entry is a
host tool from the server's tool registry, invoked over a **reverse RPC channel — a
kernel-initiated request answered by a server-initiated response**. This direction is
not in v1: v1 is strictly server-initiated — every line on the kernel's stdin is a
request consumed serially by `_serve` (`porrima_kernel.py`), every stdout line is an
event correlated to a server request id, and `host_request` appears nowhere in the
driver or manager — so it is new mechanism on both sides. §4.8 is its spec, and it is
Phase A's real design object, not an aside. Message shapes, roughly:

```
kernel → server:  tool_call { call_id, tool, args }
server → kernel:  tool_result { call_id, value | error, spilled_path?, truncated? }
```

Properties:

- **Allowlist-driven** (§4.3). Tools not on the allowlist are simply absent from the
  namespace — excluded, not discouraged.
- **The permission layer is untouched; the oversight density is not.** Execution still
  happens server-side in the tool registry, with all existing authorization, limits,
  and observability. The kernel changes *who can initiate* a call, not *what a call may
  do* — and that is the core semantic shift of this design, not a formality:
  model-level tools pass a per-call judgment step, and one program replaces many judged
  calls with one judgment. §4.7 states the consequence; the tier structure (§4.3) exists
  to bound it.
- **Args are JSON-encoded and server-validated.** The dispatcher validates args against
  the tool's TypeBox schema before execution — a buggy kernel program gets a clean tool
  error, never an executor crash. Kernel-side serialization is strict JSON
  (`allow_nan=False`) with a size cap on the `tool_call` frame, mirroring v1's
  kernel→server frame rules (parent §4.3).
- **Results are raw, not context-budgeted.** The registry's `wrapResult` truncation
  (`createWrapResult`/`getMaxToolResultChars` in `agent-tools.ts` — 15% of the
  context window, floor 8k chars) exists to protect *model context*; kernel results
  never enter context, so kernel dispatch must not reuse it. Large results spill to disk
  with the existing tool-output-store pattern; the in-kernel value becomes a reference
  (path + head preview) so the program can stream/process it without holding it in
  memory. **Remote-kernel carve-out (§4.9):** a server-local spill path is unreachable
  from an SSH host kernel's `open()` — exactly the problem P4b solved for job output
  (remote-python-kernel.md §4.6).
- **The boundary is explicit.** Only the returned value (and `print`) crosses to the
  model — the print contract, already the kernel's semantics. Truncation at the boundary
  carries codex's explicit marker style: "Warning: truncated output (original token
  count: N)" — the original size is reported, never silently cut.
- **Serialized dispatch; the workspace lock is never re-entered** (§4.9). Kernel-originated
  calls execute on one per-kernel FIFO on the server. Without this rule the acceptance-bar
  case deadlocks on the design as first written: `run_python`'s execute holds
  `withMutationLock('workspace:<label>')` for the whole call,
  `withMutationLock` is a non-reentrant FIFO promise queue, and nested
  `bash`/`write_file`/`edit_file` acquire the same key. The FIFO also supplies, for
  kernel-origin calls, the serialization `SEQUENTIAL_TOOL_NAMES` gives the model loop
  — which a cell's `asyncio.gather` of tool calls otherwise bypasses.
- **Budgets.** Caps enforced **in the server-side dispatcher** — a wedged or buggy loop
  cannot be trusted to count itself — scoped per `(chat, cell | job)`, with a global
  in-flight cap and a per-call timeout, all config-driven (implementation settings, same
  placement as the snapshot caps). "Per-turn" is not the primitive: background jobs
  outlive their turn, and the unbounded in-kernel loop the CPU-contention rationale points
  at is a job. Rationale stands: the reranker (32102) and the helper inference services
  are CPU-only and share the box; an in-kernel loop of dozens of `search_memory` calls
  would contend with them.
- **Construction is turn-free** (§4.9). The registry is built per turn today, closing
  over turn callbacks (`ToolSideEffects` — artifact, visual, ask-user, browser-frame —
  and `onUpdate`, both in `agent-tools.ts`). Kernel dispatch needs a dedicated
  construction path with side effects explicitly deferred and chat-type gating
  (`SYSTEM_CHAT_EXCLUDED_TOOLS`) applied the same way; a background job runs with no live
  turn to attach to by construction.

### 4.2 The split criteria

Three criteria explain every split observed in the survey; they are the design rule:

1. **Pipeline density.** Does the tool compose with loops and intermediate state
   (fetch→parse→loop→summarize; paginated reads; snapshot→act→snapshot)? → in-kernel.
   This is where the token-piping win lives.
2. **Control-flow weight.** Does the call pause or redirect the agent's own turn
   (`ask_user`, future-turn scheduling)? → model-level only. A kernel program driving
   the agent loop inverts the control hierarchy; no surveyed system allows it.
3. **Visibility weight.** Does the call produce a UI artifact or a side effect visible
   outside this chat (artifact panels, reminder cards, other chats)? → the **commit**
   stays model-level; **preparation** may be in-kernel.

A note on framing: "coding tools vs application features" is the wrong axis for
Porrima. The memory system is not an app feature bolted onto a coding agent — it is the
product. By the criteria above, memory *reads* are workhorse data operations (research
pipelines: search→dedupe→synthesize) and belong in the kernel; memory *writes* carry
identity weight and need provenance rather than exclusion.

### 4.3 Tiers

**Tier 1 — in-kernel from Phase A** (workhorse data operations):

| tool | density rationale |
|---|---|
| `bash` | the acceptance bar (§1); codex nests `shell_command`, prime-agent keeps it model-level but full-host |
| `read_file`, `list_files` | pagination loops; output spilling already handled |
| `code_search` (ast-grep wrapper) | structural queries — pattern → matches with byte offsets; the query→loop→transform case; read-only; §2.5. Model-level wrapper separable from protocol v2; remote = the binary-availability carve-out. **Design: [code-search.md](code-search.md)** — the kernel projection rides the exposure list (§4.10) and adds the structured `value_json` wire flag plus the `code=` snippet mode |
| `web_search`, `web_fetch` | the flagship token-piping case |
| `read_pdf` | heavy payloads, in-code processing; Phase A (pure read, heaviest payload case) — image parts spill to file paths, never bytes (§4.9) |
| `search_memory`, `search_conversation`, `read_archived_context` | research pipelines; non-destructive |
| `list_memory_blocks`, `read_memory_block` | block navigation without round-trips |

**Tier 2 — in-kernel once the provenance seam lands** (§4.4):

| tool | requirement |
|---|---|
| `write_file`, `edit_file` | kernel-origin provenance in the file-mutation record |
| `save_memory` | UI display + attribution |
| `create_memory_block`, `update_memory_block` | UI display + attribution |
| `create_notebook_entry` | UI display + attribution |

Prime Agent's precedent is direct: their memory-equivalent (`rlm.harness` CRUD) lives in
the kernel, with evidence-backed updates and snapshot lineage.

**Tier 3 — model-level only:**

| tool | why |
|---|---|
| `ask_user` | turn-level pause; the absolute. No surveyed system lets code own human input |
| `schedule_reminder`, `update_automation` | cross-turn side effects; must be attributable to the model's explicit decision |
| `schedule_chat_message` | cross-chat, visible side effect (covers the steering-message-queue idea) |
| `create_artifact`, `update_artifact` | visible UI commit — but **authoring** may be in-kernel: iterate HTML in the kernel against the headless-chromium preview, commit with one model-level call |
| `install_skill`, `remove_skill`, `list_skills` | rare, high-judgment, environment-management |

**Hard bans** (codex's `exec`-cannot-invoke-itself pattern, generalized):

- `run_python` is not callable from the kernel. We *are* the kernel; nested kernels are
  a resource and a lifecycle hazard (box cap of 8, LRU slots).
- Tier 3 tools are excluded from the allowlist, not discouraged in prose.

**Undecided — browser tools** (`browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_hover`, `browser_type`, `browser_screenshot`): opencode's precedent is
in-codemode, and it is our best pipeline-density case (tabID chaining, element loops).
But ours is a **user-attached** Chrome with a consent handshake, and the PiP viewer
tracks calls for rendering. The consent + rendering integration is the real work; staged
late Phase B/Phase C (§5).

### 4.4 The provenance seam (the real design object of Phase B)

Kernel-originated tool calls must be attributable end to end:

- **Record:** every kernel-origin call carries `source: { kind: "kernel", chat_id, job_id, call_id }` — the codex `ToolCallSource::CodeMode { cell_id }` equivalent. The record's destination — the registry is turn-scoped and jobs outlive turns — is the originating `run_python` row's `details` for foreground cells (collected before the call settles), and a job-sidecar record for background jobs. `details` never re-enters model context (parent §4.6 wire-shape rule), so nested activity is human-only observability and the token savings hold.
- **Chat display:** the tool call renders under its originating `run_python` call (nested grouping), so the transcript shows *the program called this*, not just *the agent called this*. Phase A keeps the record flat (details only, no UI work); nested rendering is Phase B's UI half.
- **Request viewer:** wire-level capture (request-viewer.md) already records per-turn LLM traffic; foreground kernel-origin activity joins the same per-turn view. Background jobs have no turnId to join on — request ids are `${turnId}:${iteration}` — so job-originated activity correlates by `(chatId, job_id)` and the viewer needs a jobs axis (Phase B).
- **Extraction:** no new path, by construction. Nested results are kept *out* of model context — they are precisely not the model's observations, so routing them through extraction would donate back the tokens this design exists to save. Extraction observes exactly what the model does — the outer cell result. Tier-2 *writes* are server-side operations whose records carry the `source` field directly; nothing needs to re-enter context.

Tier 2 is gated on this seam — a memory write that cannot be attributed to a
program is an identity-level defect, not a convenience gap.

### 4.5 Yield, resume, and completion notices

Two separable halves, and the survey (§2.6) shows harnesses routinely confuse them: **detaching**
work (yield) and **re-engaging** the agent when it ends (notice). Codex's
`exec`/`wait`/`terminate` triple — yield at a time budget, resume or kill by cell id, explicit
model-visible status strings ("Script running with cell ID …" / "Script completed|failed") — is
the reference shape for the first half. It is the *only* surveyed harness with no second half at
all, and it gets away with it because the agent always holds the handle. Porrima does not: a
background cell can end its turn with work outstanding and nothing to bring it back.

**4.5.1 Adopt the unread contract.** A job that finishes **with its result unread** produces a
completion notice. Reading the result, awaiting the handle, or stopping the job retires the wake;
an await cut short by an interrupt or a deadline read nothing, so it leaves the wake owed. The
predicate is local to the job, and Porrima already has every consumption channel it needs:

| Consumption channel | Where it happens | Retires the wake |
|---|---|---|
| `jobs tail` / `status` (today `python_jobs`) | model-level tool, server `job_view` | yes |
| awaiting a handle | inside a kernel cell | yes |
| `jobs kill` (L2 or `force` L3) | model-level tool | yes — an explicit stop is its own report |
| UI viewing of job output | artifact panel / stats screens | **no** — a viewer is not the agent |

That last row is the one a naive implementation gets wrong, and albedo states it as a rule: its
job-view reads deliberately bypass the consuming read path "so watching a job never withdraws the
wake its result is owed".

**4.5.2 Handles, not strings.** In-kernel `tools.bash` currently returns a string. The handle shape
replaces it: `h = tools.bash(cmd, background=True)` starts the work and returns immediately;
`await h` collects it (instant if already finished) and yields exit status, duration, output, and a
`running` discriminator; `h.poll()` / `h.tail(n)` / `h.kill()` inspect and stop out of band. What a
handle points at is the durability decision: a **command** handle refers to a process group owned by
the job supervisor ([job-supervisor.md](job-supervisor.md) §6) and recorded in `jobs.db` and the
server's `job_view` ([kernel-durability.md](kernel-durability.md) §3.2), so it survives the kernel
that created it, while a plain `subprocess` from a cell stays in the kernel's family and dies with
it. The handle API is the *client* of that ledger, not a second bookkeeping system. Three rules
travel with it:

- **Ownership is explicit.** A handle awaited before any other API use owns the process group —
  cancelling that await kills the group. Touching `poll`/`tail`/`running` first marks it a
  background handle, and later awaits only wait. Without this rule the interrupt ladder (§4.5 of
  session-python-kernel) kills the wrong thing.
- **Bounded await degrades instead of failing.** An inline await past a yield budget (order 10 s,
  capped well below the cell timeout) returns a snapshot carrying the live handle rather than an
  error, and **must not cancel the inner wait** — cancelling an owned wait would kill the command
  the degrade exists to preserve. Degrade hints are budgeted per kernel, not per job.
- **Bind before awaiting.** `h = await run(...)` blocks before the assignment, so a cell
  interrupted mid-wait leaves the running work addressable only by id. Worth one line in the
  capability text; it is the difference between an orphan and a handle.

**4.5.3 Delivery is boundary-shaped, and coalesced.** Completion notices land at the turn
boundary (`getFollowUpMessages` / the next turn), never as mid-turn steering:

- Mid-turn injection diverges the wire at the injection point. Tail-shaped delivery is
  append-shaped, which is the cheap shape for the prompt cache — the same lever as every other
  intentional rewrite.
- Boundary delivery is also what makes the race impossible: a notice that only lands when the
  chat is idle can never overtake the read that satisfies it, because a read during the turn
  retires it first. Steer-shaped delivery buys immediacy and pays for it in withdrawal machinery.
- A busy chat is *refused*, and the server retries until it is idle. One notice per completion
  batch: N jobs finishing during one turn produce one row and one turn. This is not a nicety
  here — a notice turn costs a fresh prefill, so coalescing is the economics answer as well as
  the noise answer.
- A notice for a chat mid-turn waits behind that work rather than displacing it, and takes a
  **background-priority** turn-gate lease when it does run.

**4.5.4 Notice shape.** Each notice carries two renderings and a pre-minted row id, so the
transcript row and the model-facing text cannot drift apart:

- a **display** line for the human transcript (`job finished (exit_code=0, ran 1.2s): <command>`),
- a **model text** row, marker-wrapped, bounded, naming each job, its outcome, its handle, and the
  read call that consumes it, plus provenance and an anti-noise instruction in the row itself
  (no user sent this; use the result if the work needs it, otherwise acknowledge briefly and stay
  idle) rather than in the system prompt, where it would cost prefix bytes on every turn.
- the payload stays behind the handle: the notice announces and points, `jobs tail` / the
  spill file carry content. This keeps the injected row small, which is what makes a notice cheap
  on the wire.
- Byte stability and replay rules apply unchanged: normalized content, deterministic ordering, no
  wall-clock durations computed at replay (record `duration_ms` at completion), and the row must
  survive compaction archiving and re-reconstruction.

**4.5.5 Wake eligibility is a property of the job.** A job started as a service (a dev server, a
watcher) is expected to keep running; its normal continuation is not what anyone waits for, so it
does not wake while it runs. But a service that **exits unexpectedly** — a crash, or a clean exit
nobody asked for — is exactly what the agent needs to know, so that wakes. An explicit stop does
not. The kind is recorded at start, visible in `jobs list`, and queryable without asking the
kernel — the counterpart in cache-warm/residency logic asks the same question the way albedo's
`awaited_jobs` does. Combined with a readiness primitive (`wait_for(pattern, timeout)` — wait
until a line of output matches, counting output already written, never stopping the job) this
settles the policy: **notify on completion, never on continuation.** Long-lived work is polled or
ready-checked while it runs; unexpected exits announce themselves.

**4.5.6 Where "owed" lives: the server's `job_view`.** The pending notice and the decision to
deliver it belong to the server, because the server's store is the long-lived component
([kernel-durability.md](kernel-durability.md) §2) and the server already answers `jobs` from its
own `job_view`. The job supervisor reports execution facts — started, finished, lost — into that
view; it never writes a notice. **Server-visible consumption needs no signal at all** — the
process that would queue the notice saw the read, so it declines to queue it. Only in-kernel
consumption (an awaited handle) has to travel, and it travels as a one-way consumption frame into
`job_view`, not as a withdrawal protocol. A withdrawal event would only be necessary if a notice
could be queued mid-turn and then have to be retracted; boundary delivery (§4.5.3) removes that
case by refusing delivery while the chat is busy and re-checking "still unread?" in the same gated
act that lands the row.

**4.5.7 The pull arm stays.** A codex-style `job_wait(job_id, timeout_ms, terminate?)` is still
worth having for the cases where waiting is genuinely cheaper than ending the turn — and, exactly
as Codex documents for its own wait loop, the doc must name which Porrima turn machinery the wait
bypasses: it holds the turn-gate lease, it is not a steering boundary, it does not trigger mid-turn
compaction, and it is not a hook point for tool policy. An undeclared bypass is how a control
primitive becomes a loophole.

**4.5.8 Enforcement versus instruction.** The strongest anti-polling mechanism in the survey is
not a prompt. albedo's shell plugin simply **refuses** a raw shell line, `subprocess`, and
`time.sleep` of a second or more from inside a cell, and each refusal *names the `run()` call the
line means* — "the refusal teaches by example". Its own docstring is the important part: **"This
is guidance, not a sandbox: libraries and plugins still spawn."** Porrima has explicitly chosen the
opposite posture (session-python-kernel §4.7: "`bash` remains the tool for shell pipelines; inside
cells, plain `subprocess` is allowed"), and that choice is defensible — Porrima is a multi-tool,
open-permission harness, not a `run()`-only kernel. The transferable piece is the *shape* of the
refusal (name the replacement) rather than its breadth. The cheap, low-controversy application is
refusing the **blocking** primitive only — a cell-wide `sleep` that stalls the kernel's own loop
while a job waits on it — with the replacement named. Refusing `subprocess` outright is a surface
decision with §7 open question 10 attached, not a notification decision.

**4.5.9 Staging.** L0 ships the job view/ledger; L1 ships coalesced boundary notices with the
server-owned unread check (no new model-visible surface: a row type, a delivery rule, and a line
in the `run_python` description — batched with any other pending description change, because
tool-surface churn is a cache event). L2a ships the job supervisor, supervisor-spawned command
groups, and the `jobs` tool over `job_view`; L2b ships services, readiness, and in-kernel handles
with the bounded await; L2c wires supervisor events, notices, global stop, and the UI. L3 is
kernel durability, gated on measurement, and is not a prerequisite for any of the above. The
ladder is named once, in [kernel-durability.md](kernel-durability.md) §5; this document's Phase
A/B/C map onto L0–L1 / L2 / beyond.

### 4.6 Post-compaction kernel notice

Prime Agent emits an explicit notice after compaction that **the kernel state survived**
(their `ipython_state` / `CompactionKernelProbe`). Without such a notice the model may
re-query state that is still alive in the kernel. Phase A adds one:
append a short kernel-state-persistence notice to the compaction summary.

**Implementation shape:** one concat at `archiveAndIndex` — the single choke point
both compaction paths (pre-send and turn-end) return their summary through — so the two
summary dialects cannot drift, and the mid-turn path gets it via the summary row
`truncateChatHistory` inserts. The handoff-row writer (`persistMidTurnHandoff`) stays
content-pure: D6's contract (route owns content, writer owns shape) is untouched.

### 4.7 Guardrails

- **Untrusted data.** Web and browser content is data, not instructions (opencode's
  explicit rule). The precise exposure: fetched content
  cannot bypass permissions — the server enforces them regardless of call origin — but it
  can **steer a program that no longer requires the model's per-call judgment**. The named
  vector is bulk cross-chat reads: `search_conversation` / `read_archived_context` reach
  cross-chat archives at model level too, but each call there passed a judgment step;
  inside a loop, injected text can direct hundreds of archive reads with none. Same for a
  pipeline that feeds fetched content straight into `bash` args. Permissions are unchanged;
  oversight density drops — which is what the caps of §4.1, the tier structure of §4.3,
  and the data/instruction rule in the tool descriptions and kernel API doc (§4.9) are
  there to bound.
- **No nested kernels, no tier-3, no self-reference.** Hard allowlist enforcement (§4.3).
- **Snapshot growth.** Large in-kernel objects raise dill serialization cost at
  snapshot/restore. The API doc steers programs to spill large intermediates to disk
  early (the spill reference in §4.1 exists for this).
- **Subagent seam (not built).** If Porrima ever makes `schedule_chat_message`/sub-chats
  callable from code, the pattern is prime-agent's `RlmSubagentHost`: a host seam
  trait, a max recursion depth, and deferral of parent work behind unsettled
  descendants. The protocol message shape in §4.1 is deliberately generic enough that
  this extends without rework.

### 4.8 Protocol v2 — the reverse RPC channel

This is the load-bearing new machinery of Phase A — Phase A is honestly scoped as
"protocol v2 + dispatch semantics + policy on top," not "one new message type"; the
rest of §4.1 is policy on top of it. Prime-agent's v1 protocol
ships this direction as `host_request` (parent §2.1); Porrima's v1 deliberately did not
implement it, so both sides gain new code and the protocol number becomes **v2**.

Kernel side (`porrima_kernel.py`):

- A **pending-call table** keyed by `call_id`: `tools.<name>(args)` serializes the call,
  writes one `tool_call` frame onto the event stream, and awaits an asyncio future
  resolved by the matching response. The await is a suspension point, so L1/L2 interrupt
  semantics carry over unchanged.
- A **demux in the stdin reader** (`_read_requests`): server→kernel lines are
  requests *or* responses. Responses (`tool_result` for a `call_id` in the pending table)
  must **not** join the request queue — `_serve` is serial, so a cell
  awaiting its own response would deadlock behind it. They resolve futures via
  `call_soon_threadsafe`, the pattern the interrupt path
  (`_request_interrupt`/`_schedule_escalation`) already uses.
- **Cancellation:** L1/L2 settle a cell that is awaiting a call — the pending future
  fails locally, and the server must abort the in-flight execution (§4.8, server side) or
  a stopped cell leaves a `bash` or `write_file` running with nobody waiting: a side
  effect the model believes was stopped.
- **Strict JSON both directions:** args serialize `allow_nan=False` with a size cap on
  the encoded frame (`_TOOL_ARGS_CAP`, 8 Mi chars); exceeding it — or any unserializable
  payload — raises `KernelToolError` into the calling cell, with the actionable
  steer to write the payload to a file and pass its path, never a corrupt line
  (same rule as v1's frame caps).

Server side (`python-kernel.ts`):

- The stdout reader (`attachReaders`) gains a **request case**: `tool_call` → dispatcher
  (§4.9) → response line written to kernel stdin. Response frames interleave with the
  calling cell's stdout events; `call_id` correlation makes ordering irrelevant.
- A per-kernel **`call_id → AbortController` registry**: the dispatcher creates the
  signal per nested call. Cancellation has two halves: a settling cell sends an
  explicit `{event:"tool_cancel", call_id}` frame (the kernel's `await` raises on
  L1/L2/kill before its reply arrives, and telling the server beats waiting for a
  reap), and the manager's own views of cell settle (`done`), job settle
  (`job_done`), kernel exit (`proc.exited`), and dispose/protocol-failure reap any
  orphans as the backstop. A late reply to a dead call is dropped by the driver's
  pending table, so both halves can race harmlessly.
- **Handshake:** `PROTOCOL_VERSION` 1 → 2. The existing exact-match rule (parent §4.3)
  is the whole skew story: a v1 driver never emits `tool_call` and receives no
  namespace — no compat path, and remote staging's hash compare re-stages on upgrade.
  A v2 server driving a v1 kernel needs no special handling: the direction is simply
  absent, exactly as today.

### 4.9 Server-side dispatch (the Phase A mechanics under the policy)

- **Construction.** `getAgentTools(chatId, effects, contextWindow, project, chatType,
  timeMarker)` (`agent-tools.ts`) is turn-scoped: closures over `ToolSideEffects`
  and the loop's `onUpdate`. Kernel dispatch needs a sibling builder —
  `getKernelToolSurface(...)` — drawing the same registry entries with the same
  chat-type gating, side effects deferred, and streaming wired into the calling cell's
  output path (the parent §4.6 constraint holds: partials are live-only, never
  persisted). The §4.3 allowlist is then a name filter applied to that surface — not a
  parallel list that can drift from the registry.
- **Lock semantics.** The deadlock chain §4.1's bullet names: foreground `run_python`
  holds `workspace:<label>` while nested `bash`/`write_file`/
  `edit_file` try to acquire the same key through the
  non-reentrant `withMutationLock` queue. Background has the dual: the job already escaped the
  lock by accepted policy (parent §4.7), and a job's nested `bash` queueing behind the
  label lock a same-chat foreground cell holds can strand a cell that is waiting on job
  output. Rule: **kernel-origin dispatch runs on the per-kernel FIFO and never enters
  the global `workspace:<label>` queue.** The justification is already in the design:
  the foreground cell *is* the lock holder (the nested call is the same actor), and the
  job is the accepted workspace peer. The FIFO provides the same-workspace serialization
  the label lock exists to give — which is also why the FIFO is required even for a
  program that only ever calls serially.
- **Result shaping.** No `wrapResult` context truncation (§4.1). Text returns as the raw
  value; the §4.1 caps truncate with the marker, oversize payloads spill through
  `tool-output-store` and the in-kernel value is the reference. Image parts (`read_pdf`
  with `extractImages`) spill to file paths, never base64 through a strict-JSON frame —
  bytes on the wire reopen the repr-cap problem at a different door; the cell opens the
  path or `emit()`s the image the ordinary way.
- **Remote kernels.** The spill path is server-local and a host kernel cannot `open()`
  it — P4b's exact problem, solved once for job output by pushing into the remote
  workspace (remote-python-kernel.md §4.6). Phase-A remote behavior: values inline up to
  the frame cap with an explicit truncation marker; spill references are a local-kernel
  affordance, stated in the kernel API doc. Per-call delivery into the remote workspace
  is a Phase C item, following the `deliverJobOutput` pattern.
- **Budget counters** live here: `(chat, cell | job)` call counts, global in-flight cap,
  per-call timeout — the timeout races the dispatcher call, so a dispatcher that ignores
  its `AbortSignal` cannot wedge the per-kernel FIFO. Exceeding any is a clean tool error with an actionable message
  (split across turns / background-ify / reduce scope) — a silent failure would teach
  the model to retry the same program.
- **API documentation lives kernel-side** (answering the placement half of §7 Q6):
  `tools.__doc__` plus a `tools.list()` reflection over the constructed surface. The
  model-facing copy is one capability line in the `RUN_PYTHON` description ("the kernel
  exposes `tools.*` callables — see `help(tools)` in a cell"), batched with any other
  pending schema change the way remote-python-kernel.md §4.9 batches its description flip.
  Putting the full API in the system prompt would spend permanent prefix bytes on the
  thing Phase D exists to earn back.

**Dispatch telemetry.** Every dispatch terminal records one sample to
`kernel_tool_stats` (porrima.db, 1000-row cap; `kernel-tool-stats.ts` +
GET/POST-clear `/api/kernel-tool-stats`): tool, outcome
(`ok`/`error`/`refused`/`aborted`), duration, value/args chars, and the
spill/truncation/structured (`value_json`) flags, keyed by chat + cell.
Refusals are first-class samples — budget exhaustion and not-exposed calls
are exactly the pressure signals Phase D and §7 Q2's budget tuning need.
This is the evidence layer the plan otherwise assumes: §5's Phase D gate
("after kernel-usage telemetry shows which model tools the kernel has made
redundant"), Q2's "placeholders to tune with usage", and kernel-side
adoption for tools like `code_search`, whose dispatches are invisible in
transcript metrics (they ride under `run_python`). Recording is
fire-and-forget after the wire response — telemetry never fails or slows a
dispatch — and is disabled under `NODE_ENV=test` so protocol tests never
pollute the store (`PORRIMA_KERNEL_STATS=1/0` overrides).

**Density readout protocol — `code_search` (pre-registered before the traffic
exists, so the questions cannot drift toward whatever the data shows).** The
transcript program (code-search.md §4.1–§4.2) established a behavioral law:
*single-shot queries go to the tool, aggregation goes to scripts* — and the
kernel projection is the half of the thesis the transcript program structurally
cannot see. `cell_id` makes loop density directly observable without transcript
surgery; the dogfood window (flag ON for real local work — an operator
choice, distinct from the §4.1 flip) reads against these frozen questions:

1. **Chain depth.** Dispatches sharing `(chat_id, cell_id)`: the density
   thesis *fires* at median ≥ 2 `code_search` dispatches per cell — the
   signature cell shape is snippet(`code=`) → file-scan → refined-scan,
   `structured=1` throughout (the code-search.md §3.3 loop taken in variables). Median 1
   with nonzero volume means the kernel is being used as a one-shot call
   site — the loop is not being taken.
2. **Substitution (paired, transcript-side).** Stats cannot see raw Python
   — `open()` + regex never dispatches — so a qualitative pass over the
   week's `run_python` programs asks whether text-munging enumerate/count
   loops are shrinking against the recorded baseline of hand-rolled
   parser-API scratch scripts. The claim is substitution of raw scripting
   by `tools.code_search`, not dispatch volume alone.
3. **Wire-shape health.** `error`/`refused` rates against the model-level
   tool's own record; `truncated`/`spilled` counts on large match pages
   (aggregation-in-variables working); `duration_ms` against the
   ~50 ms/scan cost measured in code-search.md §2 — a ten-iteration refine
   pass staying sub-second is part of the promise.
4. **Verdict shapes, pre-declared.** (a) Depth ≥ 2 + substitution: the
   density case holds — Phase D's shrink gate gets its first real input
   and `code_outline` (code-search.md §3.4) ships on the same demand
   logic. (b) Model-tool alive, kernel zero: discoverability is the
   binding constraint — fix the capability line / `tools.__doc__` text and
   re-read before adding any surface. (c) Both dark: the default never
   got reached in real work; nothing new gets designed until the canary.

**Instruments.** Q1's *shape* half needs the args route + pattern identity, which
the stats store does not carry by default — a `code_search` ok sample writes a
compact tag into the free `detail` field: ``snippet|scan pat:<hex8>`` (the same
`code`-present route check the executors branch on; an 8-hex sha256 digest of the
pattern — chain joins on the digest, raw args stay unstored). The tag is built by
`codeSearchShapeTag` in `kernel-tool-stats.ts`, wired at both ok record sites in
`python-kernel.ts`; error/refusal `detail` is untouched, and rows written without
a tag simply read as untagged. The window computes with
`npx tsx src/scripts/readout-kernel-density.ts [--days N] [--json]` — read-only
against both stores, prints the four questions plus the verdict-shape echoes (it
reports, it does not judge; Q2's substitution pass stays the transcript listing
the checklist half surfaces).

### 4.10 Implementation shape

How the design is shaped across registry, manager, and driver — including the
places where the shape refines §4.9:

- **Dispatcher is an injected seam, not a manager-owned builder.** `KernelToolDispatcher`
  (`{tools, call(tool, args, signal)}`) is defined in `python-kernel.ts` and
  **implemented in `agent-tools.ts`** (`createKernelToolDispatcher`), passed per
  execute via `KernelRunOptions.toolDispatcher`. The manager never imports the
  registry — that would invert the dependency (agent-tools already imports
  python-kernel). `getKernelToolSurface` as §4.9 named it is therefore this
  injection, built from the same resolved workspace the turn's tools close over;
  side effects are absent by construction (the dispatcher calls adapter methods
  directly, no `ToolSideEffects`). The per-kernel FIFO, budgets, abort registry,
  and spill/inline shaping all live manager-side as designed.
- **Exposure list rides the execute request.** The manager sends
  `tools: dispatcher.tools` as a field on each execute request; the driver rebuilds
  the `tools` namespace from it per cell (no stale surface; no driver-side allowlist
  to drift). No field (flag off) → no namespace. `tools` is added to
  `_SNAPSHOT_ALWAYS_SKIP` like `emit`.
- **Gate**: `PORRIMA_KERNEL_TOOLS=1` (server env) → `kernelToolsEnabled()`; when
  off, the namespace is never sent and arriving `tool_call` frames find no live
  dispatcher and are refused. The `run_python` description's capability line
  (§5 Phase A's one schema-bust item) is gated identically — the constant is built
  at import with `kernelToolsEnabled()` appended, so flag-off servers carry the
  original description bytes and flag-on busts the frozen prefix exactly once.
- **Budgets** (env knobs): `PORRIMA_KERNEL_TOOL_CALLS_MAX=64` per (chat, cell|job);
  `PORRIMA_KERNEL_TOOL_TIMEOUT_MS` — when set explicitly it wins for every tool,
  otherwise per-tool defaults apply (`bash: 300 s` matching the model-level ceiling,
  generic `120 s`). Response values ride the wire inline up to 2M chars with the §4.1
  truncation marker (`truncated` + `total_chars` on the frame); `read_file`'s
  configured cap (256 KiB default) and `bash`'s adapter-side spill (`opts.chatId` →
  the shared tool-output store, footer riding in the value string) sit inside that
  bound.
- **Spill references.** Values over 1 MiB on a local kernel write the full text to
  the shared tool-output store (`kernel-<call8>.txt`, 64/chat + 24 h retention
  inherited) and the cell receives a dict `{'path', 'head', 'total_chars', 'spilled'}`
  — `head` a 4096-char preview — to stream from; remote kernels keep the inline 2M cap
  + marker (§4.9 carve-out),
  with the P4b job-delivery path covering hosts that own delivery. A spill failure
  degrades to truncation-with-marker rather than losing the value.
- **`read_pdf` figures.** Base64 image parts never ride the wire — they land in the
  tool-result-images store and the value lists on-disk paths
  (`shapeReadPdfKernelResult`).
- **Every Tier 1 entry is a projection onto the model-level executor**, not a second
  implementation: `list_files` goes through the workspace adapter,
  `web_search`/`web_fetch` through `executeWebTool`,
  `search_memory`/`search_conversation`/`read_archived_context`/`list_memory_blocks`/
  `read_memory_block` through `executeMemoryTool` with the chat's scope, `read_pdf`
  through `executeReadPdf`, `bash` through the adapter's `bash` with the chat's spill
  opt-in. The allowlist is the dispatcher's `tools` list — §4.3's hard-allowlist as
  mechanism, so a tier-2 name is absent from the namespace (`AttributeError` before
  any RPC).
- **Background jobs**: the ack re-keys the dispatcher from the execute id onto the
  driver-minted jobId — a job composing tool calls outside its turn is a
  first-class path (that's what the budgets are for). The dead request-id entry is
  dropped unconditionally, not only when the re-key happens; otherwise a job whose
  ack never re-keys leaks its dispatcher for the kernel's lifetime.
- **Deferred within §4.9's design**: partial streaming of nested-call output into the
  cell's live view (`onUpdate` is not wired to kernel dispatch — nested results
  arrive complete; the §4.6 partials live-only rule applies whenever it lands).

## 5. Staging

| Phase | Scope | Model surface |
|---|---|---|
| **A — additive tier 1** | protocol v2 reverse RPC (§4.8) + dispatch mechanics (§4.9) + allowlist + serialization + budgets (§4.1); post-compaction notice (§4.6); the job view/ledger + coalesced boundary completion notices (§4.5.1–§4.5.4); the one capability line in the `run_python` description, batched with pending schema changes | unchanged (§4.9's line is description text, not a surface change; notices are rows, not tools) |
| **B — provenance + tier 2** | provenance seam (§4.4); mutations + memory writes; nested rendering + the viewer's jobs axis; in-kernel handles with bounded await, `wait_for`, and the `job_wait` pull arm (§4.5.2/§4.5.5/§4.5.7); browser consent design | unchanged |
| **C — feature integrations** | browser tools in-kernel (consent + PiP); artifact authoring flow (in-kernel iteration, model-level commit); remote spill delivery (the `deliverJobOutput` pattern per nested call, §4.9) | unchanged |
| **D — surface shrinkage (evidence-gated)** | retire model tools proven redundant by kernel usage; per-chat opt-in | shrinks |

Phase D's strategic argument is a **KV-cache dividend**: every retired model tool
removes schema bytes from every prompt, shrinking the frozen prefix — the same
discipline that drives the wire-level KV work. It is gated on evidence: Phase D
happens only after kernel-usage telemetry shows which model tools the kernel has made
redundant, and it ships per-chat opt-in with an A/B, not as a global flip.

**Remote kernels (P4a):** the SSH-session kernel speaks the same protocol, so the RPC
half of tier 1 is structurally available there with no extra work; remote `bash`/file
semantics are unchanged. The serialization half needs the §4.9 carve-out: server-local
spill references are unreadable from a host kernel, so remote Phase A is inline-capped
results with explicit truncation markers, and per-call spill delivery follows the
`deliverJobOutput` pattern in Phase C.

## 6. Risks

| Risk | Mitigation |
|---|---|
| CPU contention: in-kernel search loops vs CPU-only reranker/inference services | `(chat, cell|job)` call caps + global in-flight cap, per-call timeouts, server-side enforcement (§4.1/§4.9); budgets config-driven |
| Deadlock: nested `bash`/`write_file` re-acquires the `workspace:<label>` lock the parent `run_python` holds | per-kernel dispatch FIFO; the label queue is never entered (§4.9) |
| Interrupted cell or killed kernel strands a server-side tool execution | cell/job settle + `proc.exited` + L3 abort all orphaned calls via the call_id registry (§4.8) |
| Cell `asyncio.gather` storms the registry; corrupt args | dispatcher FIFO + server-side TypeBox validation + arg-frame size cap (§4.1/§4.9) |
| Protocol skew (v1 driver, v2 server) | exact-match handshake rule (parent §4.3): v1 drivers simply lack the namespace; remote staging hash compare re-stages on upgrade (§4.8) |
| Provenance UI complexity (nested rendering, the viewer's jobs axis) | Phase B is its own phase; tier 2 gated on it. Extraction is out of scope by construction (§4.4) — nested results never enter context. |
| Snapshot/restore cost growth from large in-kernel objects | spill-to-disk guidance + existing 16/64 MiB caps |
| Untrusted data steering kernel-origin calls | permissions enforced server-side regardless of origin (§4.1); the shift is oversight density, not authorization, and §4.7 names the vector; caps (§4.1/§4.9) + the data/instruction rule in the tool descriptions and kernel API doc bound it |
| Retrieval self-observation: a kernel program searching the chat it is running in while state mutates | accepted for reads; writes remain tier 2 with provenance |
| Phase D behavior regression | per-chat opt-in + A/B; gated on telemetry |
| Review risk: tiers are policy, not mechanics | §7 open questions are the review surface |

## 7. Open questions (review surface)

1. **Tier 1 set** — confirm the exact list. In particular: should `list_files` expose
   glob patterns in-kernel (it does at model level), and is `read_pdf` Phase A or B?
   → Answered: `read_pdf` is Phase A (marked §4.3) with the image-as-path rule
   of §4.9. The `list_files` glob question is a tool-surface question, not a kernel one —
   the projection should mirror what the model has; divergence there is drift, not design.
2. **Budget numbers** — per-`(chat, cell | job)` call cap, global in-flight cap,
   per-call timeout defaults. The CPU-contention argument and the server-side
   enforcement point are settled (§4.1/§4.9); the numbers are not.
   → Answered: defaults are set in §4.10 (env knobs — `64` calls per
   `(chat, cell | job)`, and per-tool timeouts where an explicit
   `PORRIMA_KERNEL_TOOL_TIMEOUT_MS` wins over bash `300 s` / generic `120 s`);
   treat them as placeholders to tune with usage, not as the decision.
3. **Memory writes** — ship tier-2 memory writes *only* with the provenance seam, or is
   there an earlier safe increment (e.g. `save_memory` with an explicit `source` field in the
   memory row itself)?
   → Answered: the earlier increment is right. The `source` field on the row is the
   schema half of §4.4 and is cheap; the *record* is the seam, nested *rendering* is a
   Phase-B nicety. A memory write that cannot be attributed is the defect; a memory write
   whose attribution isn't pretty is not.
4. **Browser consent model** — per-call consent, or program-scoped consent (one
   handshake covers a browser session started from code)? What does the PiP viewer show
   for kernel-origin calls?
5. **Phase D mechanics** — which tools are shrinkage candidates first, and how does the
   per-chat opt-in surface (setting? automation? explicit user action?).
6. **API naming + discoverability** — `tools.*` flat namespace vs per-domain namespaces
   (codex's IndirectNamespacePrefixes / opencode's `search` builtin)? Static API
   description block in the kernel docs vs lazy discovery as the catalog grows?
   → Answered: flat `tools.*` at Phase-A scale; the discovery mechanism is
   kernel-side reflection (`tools.__doc__`, `tools.list()` — §4.9), not a prompt block,
   and not a `search` builtin until the catalog outgrows a ~10-name docstring. Per-domain
   namespaces can be layered on a flat namespace later without breakage; the reverse is
   churn.
7. **Human input from a program** — a kernel program that needs a user decision must
   surface it as a model-level `ask_user`. Should the program explicitly yield with a
   "waiting-for-user" state (ties to §4.5), or is that the model's problem after the
   program returns?
   → Answered: the program returns a structured "needs user decision" value
   and the model calls `ask_user` next. No surveyed system blocks code on a human, a
   program that awaits a human is a cell that holds the turn lease hostage (§4.5), and
   this costs no new mechanism. The §4.5 yield/resume question is about *computation*
   outliving a turn — keep those separate.
8. **Bash parity** — should kernel-origin `bash` calls keep identical output handling as
   model-level bash (rolling in-memory window, spill to /tmp at 50 KB), or do kernel
   programs get the raw stream (they can buffer themselves)?
   → Answered: raw-with-cap + spill reference (as §4.1/§4.9 shape it). The
   rolling window and 50 KB spill exist to protect *model context*; kernel callers
   bypass that by construction, so copying the model path's constraints would cargo-cult
   the wrong layer's reason.
 9. **Structural navigation** — does a model-level `code_search` wrapper
    (ast-grep CLI) ship as an additive tool independent of Phase A (it
    doesn't touch protocol v2), and when does the in-kernel projection follow (the
    exposure list, §4.10)? One tool or two (`code_search` vs `code_outline`)? Is `sg`
    a dependency in the onboarding profiles (remote hosts = the Phase C shape)? Pattern-
    syntax education via a kernel-loadable reference file — the §4.9 "API documentation
    lives kernel-side" principle applied to `llms-full.txt` (on demand, zero prompt
    bytes)? And is `sg outline` a per-project context-orientation feature (a different
    seam — noted here, designed separately)?
    → Answered: ship the model-level wrapper first — cheap, separable, and it
    shrinks the model's rg→read loops immediately; the in-kernel projection follows as
    a Tier 1 row on the existing exposure list; `code_outline`/project-orientation
    deferred as its own feature. Specified in [code-search.md](code-search.md) — the
    two-projection staging (model-level phase 0 gated on its own flag, kernel
    projection phase 1), outline deferred kernel-first (§3.4 there),
    `@ast-grep/napi` as the dependency with the CLI fallback (note the `sg`
    name collision — §5 there), and the default-shift framing for
    the tool-set fit question (§4 there).
10. **`subprocess` refusal inside cells** — §4.5.8's enforcement question. Porrima's kernel
    deliberately allows plain `subprocess` (session-python-kernel §4.7) because it is a
    multi-tool, open-permission harness, not an `run()`-only kernel; albedo reaches the same
    openness from the other side ("guidance, not a sandbox: libraries and plugins still spawn").
    Does the guard refuse only blocking primitives (`time.sleep` ≥ 1 s in a cell, unbounded
    `subprocess.wait`), or the whole class, in exchange for a handle API that replaces them?
    → Open: refuse the blocking class first — it is the one refusal that repairs a *kernel*
    failure mode (a cell monopolizing its own event loop while a job waits on it) rather than a
    model-behaviour preference. The wider refusal is a surface decision that only makes sense
    together with handles, and only if handle usage telemetry shows the replacement is actually
    used.
11. **Where "wake owed" lives** — kernel-side (albedo: local, self-arbitrating, lost if the
    kernel is hard-killed) or server-side (durable rows).
    → Answered: server-side, permanently. The long-lived execution owner is the job supervisor,
    but the notice lives in the server's `job_view`; server-visible consumption needs no signal
    at all (§4.5.6, [kernel-durability.md](kernel-durability.md) §2–§3.3). The supervisor reports
    execution facts, and the kernel reports only what only it can know — liveness, and
    consumption by an in-kernel await — into that view.
12. **Notice visibility to the model's own turn machinery** — does a completion notice run as an
    ordinary turn (its own gate lease, its own compaction pass), or as a tail append that needs no
    turn at all? The cheap option is a tail row that only *teaches* the next user-initiated turn;
    the effective option is a wake turn that lets the agent act on the result immediately.
    → Answered in shape, open in number: **the row append and the wake are one gated act,
    idempotently recoverable**, because a tail row parked for a later turn can be overtaken by a
    read and go stale — that is a correctness argument, not a cost one. The ledger and the notice
    row live in different databases, so the act is not one transaction; `notice_state` and the
    pre-minted message id make recovery idempotent. Cost is a separate dial: a per-chat wake budget
    with backoff down to teach-only rows (§4.5.3, durability §3.4). The open part is the budget
    number.
13. **Job vocabulary split** — a background *cell* (an asyncio task on the kernel's loop, dies
    with the kernel) and a background *command* (a supervised process group, can outlive it) are
    not the same kind of job, and `jobs` currently presents them as one. Does the handle
    API make commands the durable class and cells explicitly transient, or does the kernel grow a
    process-level job type so cells can hand work off?
    → Answered: commands are the durable class, cells are explicitly transient, the kind is recorded
    on the row, and recovery is typed per kind ([kernel-durability.md](kernel-durability.md)
    §3.1–§3.2). The handle API is the client of the supervisor's ledger, not a kernel-side job type.

## 8. Sources

Prior art (all read at primary source except where noted):

- Cloudflare: blog.cloudflare.com/code-mode/ (origin, isolates, token-piping argument);
  developers.cloudflare.com/agents/tools/codemode/how-it-works/ (durable runtime, replay,
  approvals, snippets, lazy discovery)
- opencode: packages/codemode/README.md; packages/opencode/src/tool/code-mode.ts @b6478dce
  (fresh runtime per call; shell excluded from catalog); opencode.ai/v2/docs/tools/
- Codex: codex-rs/core/src/tools/code_mode/{mod.rs, execute_handler.rs, wait_handler.rs}
  @main (exec/wait/terminate, Function/Freeform kinds, schema cap, no self-recursion,
  per-turn dispatch worker, hook bypass, truncation markers, cell provenance)
- Prime Agent: README.md, AGENTS.md (surface contract), crates/pa-core/README.md
  (IPython kernel, kernel-side MCP, RlmSubagentHost, reliability model); arXiv
  2608.23552, 2605.09998, 2512.24601
- smolagents: huggingface.co/docs/smolagents — secure_code_execution,
  reference/python_executors (AST local executor, `additional_functions`, state between
  executions, remote Jupyter-kernel executors)
- CodeAct: arXiv 2402.01030 (ICML 2024); machinelearning.apple.com/research/codeact
- E2B: e2b.dev docs + e2b-dev/code-interpreter (stateful Jupyter-kernel sandboxes)
- Persistent-shell lineage: docs.openhands.dev (sandbox runtime, Jupyter plugin);
  deepwiki.com/cline/cline/8.2 (terminal modes — corroborated via source trace);
  github.com/anthropics/claude-code/issues/9881 (no official interactive shell);
  github.com/knot0-com/repl-scratchpad (tmux-backed Python REPL skill, print contract)
- ast-grep: ast-grep.github.io (introduction; advanced/prompting — official
  AI-usage guide; reference/cli/outline; blog: optimize-ast-grep, tree-sitter-rust-
  rewrite — all read); github.com/ast-grep/ast-grep-mcp (official experimental MCP, read)
- Repository-map lineage: aider.chat 2023-10-22 repomap post + aider.chat
  /docs/repomap.html; agentpatterns.ai/context-engineering/repository-map-pattern
  (distillation, corroborated); vadim.blog "Claude Code Doesn't Index Your Codebase"
  (corroborated); LlamaIndex CodeNodeParser (tree-sitter RAG chunking — corroborated,
  not read)

Completion notification (§2.6, §4.5):

- albedo (`tangled.org/okami.mom/albedo`, read at source): `priv/python/albedo_plugins/run.py`
  (`owed` = finished-with-result-unread, one announcer, retry-until-idle, one notice per batch,
  `service` flag, bounded await that snapshots instead of failing), `priv/python/albedo_cells.py`
  (cell auto-backgrounding under the same notice contract), `priv/python/albedo_shell.py` (the
  refusals — `sh -c`, `subprocess`, and `time.sleep` of a second or more — each rejected with the
  replacement call named in the error text),
  `priv/python/albedo_output.py` (retention caps and the output/cell inventories a model can list),
  `priv/python/albedo_link.py` + `albedo_bridge.py` (detached kernel, durable seq/ack outbox,
  reattach), `src/albedo/daemon/albedo_wakes.erl` (session → submit closure registry, loader for
  unloaded sessions), `src/albedo/daemon/turn.gleam` (turn-source delivery policies),
  `src/albedo/daemon/session.gleam` (a wake is an ordinary submit),
  `robot-docs/kernel.md` + `robot-docs/kernel-state.md` (notice framing, job views, observation
  without polling)
- opencode (`anomalyco/opencode`, read at source): `packages/core/src/job.ts` (job registry,
  pre-minted notification id, typed recovery records), `packages/core/src/session/inbox.ts`
  (`delivery: "steer"`, pending-only inbox), `packages/core/src/session/execution.ts`
  (`execution.wake`), `packages/core/src/session/execution/restart.ts`
  (startup replay; restart notices deliberately do not revive idle sessions),
  `packages/core/src/tool/plugin/shell.ts` (auto-backgrounding),
  `packages/core/src/session/runner/llm.ts` (inbox drain at the step boundary)
- prime-agent: `crates/pa-core/src/session_engine/bash_notices.rs` (queued `bash.completed` host
  request after the creating cell's barrier; `bash.consumed` inside a later read withdraws a
  queued notice; the `queueIfBusy` / `resumeIfIdle` wake semantics, named after their TS-engine
  parity), `crates/pa-daemon/src/bash_notices.rs` (the daemon worker's queue-lane sinks),
  `crates/pa-core/src/prompts/layers/bash-over-subprocess.md` (a whole prompt layer whose point is
  §4.5.8's question), `prime-agent-runtime/src/rlm/bash.py` (handle ownership, bounded await,
  `_reap_group`), `crates/pa-daemon/tests/autobg_headless_e2e.rs` (auto-background end-to-end)
- OpenClaw: docs.openclaw.ai/gateway/background-process (completion turn in the originating
  session, waits behind existing work, one unknown-outcome completion turn after a gateway
  restart, no notice on explicit stop), docs.openclaw.ai/tools/process (the process tool as the
  pull arm)
- Claude Code: `TaskOutput`/`KillShell` retired in favour of `Read` on a named output file;
  `Monitor` for event streams; hooks as the completion-attention channel
  (docs.claude.com/en/docs/claude-code/hooks) — corroborated, not read at source
- Codex: `codex-rs/core/src/unified_exec/mod.rs` (process caps), `core/src/tools/code_mode/wait_spec.rs`
  (pull semantics; no wake anywhere in the family)

Porrima: [session-python-kernel.md](session-python-kernel.md),
[kernel-durability.md](kernel-durability.md),
[job-supervisor.md](job-supervisor.md),
[remote-python-kernel.md](remote-python-kernel.md),
[request-viewer.md](request-viewer.md),
[turn-engine.md](turn-engine.md).

