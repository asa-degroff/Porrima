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
missed. Full detail with sources lives in the archived project
memory blocks ("Codemode Prior Art — Lineages", "Round 2" — out of active context, still
searchable) and §8; this section is the design-relevant distillation.

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

## 3. Design axes, and where Porrima sits

| Axis | CF | opencode | Codex | prime-agent | smolagents | **Porrima (today)** |
|---|---|---|---|---|---|---|
| State scope | per-call | per-call | per-conversation | per-session (+restart) | per-process | **per-chat (+restart, widest)** |
| Confinement | confined | confined | open | open (opt-in OS sandbox ext.) | soft (AST whitelist) | open |
| Yield / resume | n/a (durable replay) | n/a | `exec`/`wait`/`terminate` by cell_id | daemon + reattach | timeout only | background jobs, no cell resume |
| Tool catalog discovery | `search`/`describe` lazy | `search` builtin | schema-size cap on injection | static layered prompt | static | static (grows with surface) |
| Durable replay / approval | yes | no | no | no (snapshots for refine) | no | no (out of scope, §1) |
| Model surface size | one tool | full + codemode | full (+codemode) | **three tools** | zero (code only) | ~30 tools |

The only axis Porrima lacks is the composition axis itself — the kernel-side tools API.
That is what this document designs.

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

### 4.5 Yield / resume semantics

Codex's `exec`/`wait`/`terminate` pair (yield at a time budget, resume or kill by
cell_id, explicit model-visible status strings: "Script running with cell ID …" /
"Script completed|failed") is the reference shape. Mapping onto Porrima:

- **Phase A:** no new surface. `run_python` already yields (background jobs),
  `python_jobs` inspects/kills them, and the status vocabulary exists.
- **Phase B+:** consider a codex-style first-class handle — a `wait(job_id, timeout_ms,
  terminate)` equivalent, cell-identity in the status strings, and the hook-bypass
  property codex implements for its wait loop ("wait is runtime control for an existing
  code cell, not a standalone user action… hooks should not block or rewrite the wait
  loop itself"). The design must decide which Porrima turn machinery (turn gate,
  steering) the wait loop bypasses, and say so in the doc.

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
| **A — additive tier 1** | protocol v2 reverse RPC (§4.8) + dispatch mechanics (§4.9) + allowlist + serialization + budgets (§4.1); post-compaction notice (§4.6); the one capability line in the `run_python` description, batched with pending schema changes | unchanged (§4.9's line is description text, not a surface change) |
| **B — provenance + tier 2** | provenance seam (§4.4); mutations + memory writes; nested rendering + the viewer's jobs axis; wait/terminate evaluation (§4.5); browser consent design | unchanged |
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

Porrima: [session-python-kernel.md](session-python-kernel.md),
[remote-python-kernel.md](remote-python-kernel.md),
[request-viewer.md](request-viewer.md),
[turn-engine.md](turn-engine.md).

