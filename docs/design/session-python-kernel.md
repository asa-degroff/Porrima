# Session Python Kernel — Persistent REPL for `run_python`

**Status**: P1 implemented (T3, 2026-10-04): driver, manager, persistent namespace, top-level await, interrupts L1/L2, wedge policy, TTL/LRU, one-shot fallback, child journal + startup sweep. P2–P4 are design.
**Date**: 2026-10-03
**Reviewed**: 10-03 — present-tense claims verified against code (`workspace.ts`, `agent-tools.ts`, `tool-system.md`, `turn-gate.ts`, `sandbox.ts`, pi-agent-core 0.85 dist); revisions from that review are marked inline.
**Reviewed**: 10-04 — second review against a local prime-agent clone (`repl.md`, `repl.py`, `crates/pa-core/src/kernel/`), the installed `@earendil-works/pi-agent-core@0.85.1`, and this box's Python (`python3` 3.14.4, no `dill`); 10-04 revisions are marked inline and summarized in §9.
**Reviewed**: 10-04 — third review against the pi 1.0.2 tarballs + upstream changelog, the Porrima codebase, and a fresh prime-agent read (teardown order, snapshot scheduling, protocol hardening); revisions marked inline and summarized in §10.
**Related**: [pi-1.0-migration.md](pi-1.0-migration.md) — pi-agent-core 1.0 removed the node/harness surface that `runStreamingBash` uses; the forced bash rewrite and this plan share one process supervisor and one tool-output store (§2.3, §4.2, §4.6, §4.11).

## 1. Problem

`run_python` is stateless: `workspace.ts` spawns a fresh `python3 -` per call
(local `L300`, SSH `L898`), pipes the code to stdin, and kills the process on
timeout. Everything the code built is gone when it returns.

Four consequences:

1. **No iteration.** Every call re-imports, re-reads files, re-loads data.
   A multi-step analysis of one dataset repeats its setup every turn.
2. **No survival of failure.** A timeout or Stop aborts the process and loses
   all state. The model must rebuild from scratch.
3. **Long jobs block the whole system.** Tools execute inside a turn, and every
   turn holds the global single-slot lease in `turn-gate.ts`. One 5-minute
   `run_python` queues every other chat behind it for the full duration
   (300 s tool cap, `RUN_PYTHON_TOOL`).
4. **Output is one-shot.** `wrapResult` truncates the result to the context
   budget (`agent-tools.ts:159`); the rest is discarded. `bash` already solves
   this by spilling to a file (`runStreamingBash`, `workspace.ts:169`), but
   Python does not.

`sandbox.ts`'s persistent sessions persist only a *directory* (`executePython`),
not a namespace, and per `docs/tool-system.md:67` are reachable only from
`read_pdf`'s URL branch — which is also dormant today: its sole caller passes
no `sessionId`, so the session map is never populated (10-04 third review).

## 2. Prior art

Albedo: https://tangled.org/okami.mom/albedo/
Prime Agent: https://github.com/PrimeIntellect-ai/prime-agent/


### 2.1 prime-agent (the origin)

- Runtime: `python -m rlm.repl`, a **newline-delimited JSON subprocess**.
  Requests arrive on fd 0; events leave on a private dup of the original fd 1
  made before redirection; fds 1/2 are redirected into pipes so raw output
  cannot corrupt framing; stderr is a diagnostics tail. Protocol v3 is
  specified in `prime-agent-runtime/src/rlm/repl.md`.
- **One persistent `__main__` namespace on one asyncio loop.** Cells compile
  with `PyCF_ALLOW_TOP_LEVEL_AWAIT`, run as tasks, and background tasks created
  by a cell keep running between cells. Cells register in `linecache` for real
  tracebacks. A trailing expression's `repr` becomes `result` and `_`.
- Events: `ready`, `stdout`/`stderr` (tagged with the writing cell's id via
  contextvars; `null` for raw fd bytes, C extensions, subprocesses),
  `result`, `display` (MIME dict via `emit()`), `host_request`, `error`,
  `done`. Cell output streams to the model as in-flight tool updates.
- Interrupts: SIGINT targeted at the running cell via asyncio; an interrupt
  that arrives before its request starts is **parked** and delivered on start;
  a cell that will not stop produces a "wait or kill" choice
  (`busy_kernel_prompt`), never an automatic state loss.
- **Snapshot/restore**: `dill` (recurse mode) required for snapshot/restore — a
  reported error when absent, never a pickle fallback (10-04 review) — one name
  at a time; `_`-prefixed names skipped; per-variable cap (16 MiB) and total cap
  (256 MiB); oversized names can be `prune_oversized`; atomic tmp+rename with a
  JSON manifest; per-name failures reported. Snapshots are **debounced 1500 ms
  after executions settle** and flushed on dispose; restore runs right after
  start, before the runtime bootstrap.
- **`bash()` jobs** are first-class: supervised process groups, opaque activity
  ids, `list`/`tail`/`kill` out-of-band even while a cell runs, and an
  **orphan-process journal** so a crashed kernel's children are reaped.
- Environment: a dedicated kernel venv provisioned with `uv` and 12 default
  packages (pandas, numpy, requests, …); Python skills are importable packages.
- Model surface: **one tool, `ipython(code)`**. Everything else — shell,
  subagents (`rlm.spawn`), MCP, factories — is Python inside the namespace.

### 2.2 Albedo (the derivative)

Keeps prime-agent's core (persistent namespace, top-level await, single model
tool, snapshot/restore, interrupts) and hardens the process layer:

- A **detached kernel** in its own process group, reached through a bridge with
  a durable seq/ack session layer (outbox, dedupe, replay) so it survives
  dropped connections and daemon restarts; the daemon reattaches with backoff.
- **Output retention**: 64 KiB preview, 1 MiB retained per channel for the 16
  newest cells / 64 newest jobs, paged via `output.read(id, offset)`.
- **Cell journal**: source + outcome saved per cell; `cells.read/info/trace`
  and `cells.run(id, replacements, check)` repair and rerun without resending
  source; interrupted tool calls recover their outcome.
- **Remote kernels over SSH**, bundle staging, per-host job slots, reattach
  semantics for unreachable hosts.
- Kernel swap on bundle/protocol/module skew at idle; live remote references;
  image attachments per cell; heavy-job admission slots.

That is ~1,700 lines of kernel Python plus bridge/link/protocol modules and
thousands of lines of host code — a large subsystem, justified because for
Albedo the kernel *is* the tool environment.

### 2.3 What Porrima takes, what it leaves

| Adopt | Skip (for now) |
|---|---|
| Persistent namespace, one asyncio loop, top-level await | Detached bridge + seq/ack outbox (snapshot covers restarts) |
| JSON-lines stdio protocol, fd 1/2 redirection, cell-tagged output | Live remote references |
| Interrupt with parked interrupts, namespace preserved | Kernel version-skew swapping |
| Background jobs + retained output + kill | Single-tool CodeMode (Porrima stays multi-tool) |
| Snapshot/restore, debounce, caps, manifest | Orphan journal as a full subsystem — but a lightweight child journal is required once children are `setsid`'d (§4.7, 10-04 review) |
| Streaming cell output as tool updates (spike-first, §4.6) | Dedicated kernel venv (defer; system `python3` first) |
| MIME `display` → tool-result images | Remote kernels (phase 4, optional) |

Separately from prior art, pi-agent-core 1.0 removed the `./node` and
`./harness/*` surface — the bash process-supervision primitives. That forces a
bash rewrite and creates a shared Node-side process supervisor plus a shared
tool-output spill store, both specified in
[pi-1.0-migration.md](pi-1.0-migration.md) (§3, §4). This plan consumes them
instead of building its own. The P2.5 streaming seam is unaffected: the
`execute(…, onUpdate)` signature and `tool_execution_update` event are
unchanged in 1.0.

## 3. Goals / Non-goals

**Goals**

- G1. A persistent Python namespace per agent chat, created lazily, with
  top-level `await` and namespace survival across cells, failures, and turns.
- G2. Interrupts that preserve the namespace; a failed or stopped cell never
  destroys state.
- G3. Background execution decoupled from the global turn gate, with retained
  output the model can page and a way to list/tail/kill jobs.
- G4. Output beyond the context budget remains readable (spill + paging).
- G5. Best-effort namespace survival across server restarts via snapshot.
- G6. No regression: one-shot behavior stays available; remote SSH keeps
  working (per-call in P1, persistent in P4).

**Non-goals**

- A security sandbox. The kernel runs with the user's full permissions, exactly
  like `bash` and today's `run_python`; `sandbox.ts` already says so.
- A kernel process that survives server restarts while live. The server owns
  the process; snapshots are the recovery path.
- Collapsing Porrima's tool surface into CodeMode.
- Multi-user isolation.

## 4. Design

### 4.1 Scope and lifetime

- **One kernel per agent chat**, key = `chatId`, created lazily on the first
  `run_python` call. The kernel's cwd is the chat's workspace root at creation.
  **Routing rule: chats on `LocalWorkspaceAdapter` get the kernel path; chats
  on the SSH adapter stay per-call through P3** (G6) — a local kernel cannot
  have a remote cwd, and §4.10 covers when that changes.
- A project/location change disposes the kernel; the next call lazily creates a
  new one and the tool result carries a one-line notice.
- **System chats** keep the one-shot path (see open questions): they run
  headless and frequently, and persistent kernels there are mostly waste.
- **Idle TTL** 30 min (env/settings override), **max live kernels** 4, LRU
  eviction of idle kernels (never evict a kernel with a running cell or live
  background job).
- **Capacity exhaustion degrades to one-shot**: if all live kernels are busy
  (running cell or live job) when a new chat needs one, that call runs
  one-shot with a one-line notice instead of failing — the same fallback as
  spawn failure (§6).
- **A wedged same-chat kernel also degrades to one-shot** (10-04 review): if a
  chat's own kernel is unresponsive (a cell that swallowed L1 and L2, a failed
  restore, or a manager-side protocol failure), the next `run_python` in that
  chat runs one-shot with a one-line notice instead of queueing behind the
  wedge. The kernel is flagged; `python_jobs kill force` or disposal clears it
  (§4.5).
- Disposal: chat deletion, workspace change, TTL, LRU, graceful shutdown.
  Chat deletion cascades through `chat-deletion.ts` and covers all three
  artifacts: the live kernel handle, the output dir, and the state dir.

### 4.2 Process model

- The server spawns `python3 -u <driver>` as a child in its **own process
  group** (`detached: true` locally) through the shared Node-side process
  supervisor (`process-supervisor.ts`, [pi-1.0-migration.md](pi-1.0-migration.md)
  §3) — the same primitive the rewritten `bash` uses. A group kill reaches the
  kernel and any child still in that group; the child-containment model that
  decides this is settled in §4.7 (10-04 review).
- **Owner watchdog** (10-04 review): the driver runs a watchdog thread outside
  the asyncio loop (prime-agent's `PRIME_AGENT_KERNEL_OWNER_PID` pattern) that
  exits the process when the server pid disappears. Without it, "the kernel
  dies with the server" holds only for graceful shutdown — a server SIGKILL
  leaves the kernel (and its children) running until the next startup sweep.
  Mechanism (10-04 third review): a **blocking exit wait, not a poll loop** —
  Linux `pidfd_open` + `poll`, kqueue `NOTE_EXIT` elsewhere, a 30 s
  `kill(pid,0)` loop only where neither exists (prime-agent `repl.py:1516-1561`;
  Windows needs a process-handle wait because `os.kill(pid,0)` *terminates*
  there — out of scope, Porrima is Linux-first). On owner death the thread
  kills the journaled child groups and hard-exits (`os._exit(1)`): a sync cell
  monopolizes the loop, so a queued graceful shutdown would never run.
- stdio: requests on the kernel's stdin, events on its stdout, stderr kept as a
  bounded diagnostics ring buffer (last ~64 KiB) surfaced in errors.
- **No bridge, no socket, no daemon**: the kernel is server-owned and does not
  outlive a hard server crash by design. Snapshot + restore covers restarts
  (G5). This is the single biggest simplification versus Albedo.
- Driver file: `server/python/porrima_kernel.py`, resolved relative to the
  service module (`../../python/porrima_kernel.py`) so dev (`src/services`) and
  build (`dist/services`) both find it. No TS build step needed for Python.
  The install/systemd package must ship `server/python/`, and `npm run build`
  currently copies only `pdf-extract.py` into `dist` — the build must copy or
  ship the driver the same way (10-04 review). A missing driver silently
  degrades every call to one-shot, so the version/update check verifies the
  file's presence.

### 4.3 Protocol (v1)

Newline-delimited JSON, UTF-8. One object per line, no other framing. Every
request carries a `"type"` field (omitted from the Fields column for brevity;
10-04 review — prime-agent's `repl.md` includes it and §4.5 already writes
`{type:"interrupt", id}`).

Requests (server → kernel):

| Request | Fields |
|---|---|
| `execute` | `{id, code, timeout_ms?, background?}` |
| `interrupt` | `{id?}` — no `done` reply; a parked interrupt emits `parked_interrupt` |
| `snapshot` | `{id, path, manifest_path, max_bytes?, max_variable_bytes?, prune_oversized?}` |
| `restore` | `{id, path}` |
| `list_names` | `{id}` |
| `shutdown` | `{id?}` |

Events (kernel → server):

- `{event:"ready", protocol, python}` — handshake, sent once.
- `{event:"stdout"|"stderr", id|null, text}` — cell-tagged Python-level writes;
  `null` for raw fd bytes and unattributable output (shown as background
  output). 64 KiB per frame.
- `{event:"result", id, text}` — trailing-expression `repr`, also bound to `_`.
- `{event:"display", id|null, data}` — MIME dict for `emit()` (P3).
- `{event:"error", id|null, ename, evalue, traceback}`.
- `{event:"done", id, status:"ok"|"error", duration_ms}` — exactly one per
  id'd request, after all its other events. Snapshot/restore/list add result
  fields; a `background:true` execute acks immediately with `status:"ok"` and
  `job_id`.
- `{event:"job_done", job_id, status:"ok"|"error", duration_ms}` — exactly one
  per background job, after all its other events; the server registry flips
  the job's status on it (§4.7).
- `{event:"parked_interrupt", for_id}` — an interrupt arrived before its cell
  started; it will be delivered when that cell starts. Lets the server report
  "interrupt pending" instead of guessing. (A Porrima v1 addition — prime-agent
  parks internally via `_pending_interrupts` but emits no wire event for it;
  10-04 third review.)

Rules borrowed from prime-agent's `repl.md`: a private dup of fd 1 is made
before redirection; a per-write lock keeps frames whole; fd 0 is rebound to
`/dev/null` after the reader takes it so `input()` sees EOF; a malformed line
yields a protocol error event and the runtime keeps serving; stdin EOF is
`shutdown`. More rules from the 10-04 reviews:

- **Drain fence**: raw fd bytes are pumped asynchronously, so `done` waits on a
  pump-drain token (prime-agent's `_Pump.drain()`) before it is sent. Without
  it, a cell's `os.write(1, …)` / C-extension / subprocess output can arrive
  after `done` — lost from the foreground result or misattributed as
  background output.
- **Host-side frame bounds and repair**: cap a protocol line (prime-agent uses
  32 MiB). On overflow or invalid UTF-8, fail the active execution, kill the
  kernel, and restart it with restore — never respawn-loop a kernel that
  corrupts twice — while the reader **keeps draining and discarding** the
  oversized stream so a corrupt child blocked on a full pipe cannot deadlock
  the kill path (prime-agent's "poisoning", `startup.rs:313-341`; 10-04 third
  review). Result and `error` frames are capped kernel-side (prime-agent:
  1 Mi chars per `repr`/traceback entry with a trailing marker, plus an
  aggregate traceback cap that keeps the newest entries) so a giant `repr`
  cannot ride the wire before `wrapResult` truncates it.
- **Strict JSON** (10-04 third review): every kernel→server frame is
  serialized with `allow_nan=False` — NaN/Infinity serialize as non-JSON
  tokens and tear line framing. An unserializable or oversized payload fails
  the calling cell instead of riding the wire (prime-agent caps
  `display`/`host_request` payloads at 16 Mi chars for the same reason).
- **Handshake mismatch** (10-04 third review): `ready.protocol` must equal the
  expected version exactly. A mismatch is an error and the call degrades to
  one-shot (§4.1) — never a coexist/retry dance, since older-protocol kernels
  and snapshots may be on disk after a server upgrade.

### 4.4 Execution semantics

- Persistent `__main__` namespace, one asyncio event loop. The namespace is a
  synthetic module's `__dict__` installed as `sys.modules["__main__"]`
  (prime-agent's trick), not the driver's own `__main__`. This makes `dill`
  pickle cell-defined functions/classes **by value**; with the driver's real
  `__main__`, they would serialize by qualified-name reference into the driver
  module and restore would fail or bind them to the wrong globals (10-04
  review, §4.8).
- Cells compile with `PyCF_ALLOW_TOP_LEVEL_AWAIT`; the last expression is
  compiled as `eval` and its value bound to `_` and reported as `result`.
- Cell source registered in `linecache` under `<porrima-cell-N>` so tracebacks
  show the offending line; tracebacks formatted plain with runtime frames
  stripped.
- A failed cell keeps the namespace (no rollback). `timeout_ms` defaults to the
  tool's timeout (30 s), max 3600 s for background jobs; a foreground timeout
  interrupts the cell, then reports `status:"error"` with the namespace intact.
- One foreground execution at a time per kernel; background jobs run
  concurrently and are tracked separately (§4.7). Duplicate `id`s are rejected
  (the server never reuses ids).

### 4.5 Interrupts

- Three levels, in order. State loss happens only at level 3:
  - **L1 interrupt** — the server writes `{type:"interrupt", id}`; the driver
    targets the loop's main thread (`signal.pthread_kill` on the main thread
    plus a `call_soon_threadsafe` wake, not a bare process-directed `os.kill`),
    which CPython delivers as `KeyboardInterrupt` in the running cell (cells
    run on the event loop's main thread; task identification targets the right
    frame — prime-agent's mechanism). The driver re-installs its SIGINT handler
    before every request, since a cell can rebind it (10-04 review). Reliable
    for pure-Python code, including `subprocess.wait()` loops; delayed until a
    C call returns while a C extension holds the GIL; **swallowed by a cell
    that overwrites the SIGINT handler or catches
    `KeyboardInterrupt`/`BaseException`** — such cells escalate to L2.
  - **L2 cell kill** — after the grace window (default 5 s), the driver cancels
    the cell's asyncio task (`task.cancel()`) and kills the cell's tracked
    subprocess child groups (§4.7). **The namespace is intact** — names bound
    before the cancel remain. Scope matters (10-04 review): cancellation is
    delivered at the next suspension point, so L2 kills await-suspended cells
    and (via the child-group kill) unblocks `subprocess.wait()` loops, but it
    **cannot stop a synchronously running cell that swallowed L1 and never
    yields** — `task.cancel()` only sets a flag the blocked loop never gets to
    deliver. Cancellation raises `CancelledError` (a `BaseException`), so
    `except Exception` and `except KeyboardInterrupt` cannot swallow it; only
    an explicit `except BaseException` at an await point can.
  - **L3 kernel kill** — process-group kill plus journaled child groups
    (§4.11). State loss; the last snapshot is the recovery point. Never
    automatic.
- **Wedge policy** (10-04 review). If L2 does not settle the cell within a
  second grace window (default 5 s — the sync-swallowing case above, or a
  background task hogging the loop), the tool call returns an error saying the
  kernel is wedged and the namespace is preserved, and the chat's kernel is
  flagged so the next `run_python` degrades to one-shot (§4.1) rather than
  queueing behind the wedge. Recovery is explicit: `python_jobs kill` with
  `force: true` (L3, state loss) or disposal. This mirrors prime-agent's
  targeted-interrupt loop and "kernel busy" error, with Porrima's one-shot
  fallback as the availability escape hatch.
- Stop button → L1, then L2 on repeat — never L3 automatically. The tool's
  `AbortSignal` maps to the same path: abort → L1; a second abort while the
  call is still unwinding → L2 (10-04 review). A second Stop kills the cell
  but preserves the namespace, and the tool description states this. Killing
  is explicit (L2 for the cell; L3 only via `python_jobs kill` with
  `force: true`, TTL eviction, or shutdown), so state loss is always the
  caller's choice.
- An interrupt for a queued cell is parked and delivered when it starts
  (`parked_interrupt`, §4.3). Interrupt bookkeeping must also cover the
  post-run `repr`/drain **finishing window** (a request stays
  interrupt-targetable until its `done` is emitted, so a handler-raised KI
  cannot split a frame) and the done-task **handoff window** (an interrupt
  that lands after the task completed but before it is unregistered) —
  prime-agent's `FinishRequestTest` pins exactly these (10-04 review).

### 4.6 Results, streaming, retention

- The tool result keeps today's shape — stdout, then `[stderr]`, then the
  trailing value — with **no new content fields**. `normalizeToolResultContent()`
  strips results to strict `{type, text}` items and extra fields ride the wire
  but vanish on replay (KV digest divergence — "Tool Result Wire Shape" in
  `docs/tool-system.md`); `cellId`/`duration`/`truncated` metadata therefore
  goes in `details` or an in-text footer, never as content items.
- **Streaming** (P2.5, spike-first): the plumbing exists only halfway —
  verified 10-03 and re-verified on pi-agent-core 1.0.2 (the `execute(…,
  onUpdate)` signature and `tool_execution_update` event are unchanged;
  [pi-1.0-migration.md](pi-1.0-migration.md) §2.5). The tool wrappers thread
  `onUpdate` (`agent-tools.ts:409`),
  and pi-agent-core's `executePreparedToolCall` calls
  `tool.execute(id, args, signal, onUpdate)` and emits a `tool_execution_update`
  AgentEvent per update — but no current tool's execute declares `onUpdate`
  (bash's `onUpdate` at `workspace.ts:191` is pi-agent-core's `env.exec`
  shell-output callback building the bounded view — a different callback),
  and `chat.ts` has no `tool_execution_update` case: in-flight updates are
  dropped server-side. So streaming is three seams: (a) `run_python`'s execute
  accepts `onUpdate` and calls it on kernel stdout events, (b) `chat.ts` gains
  the event case plus an SSE event — in **all four** event switch sites
  (~2552, ~3105, ~3246, ~3659), not one (10-04 review), (c) the client renders
  on the tool card.
  Constraint: updates are **live-only, never persisted** — the final tool
  result already carries the full output, and persisting partials would break
  the wire/replay byte-stability above. Partials also never enter the
  model's context (the model sees only the final result), so streaming is UX
  for a human watching a cell run, not a model capability. First P2.5 item: a
  30-minute end-to-end spike; streaming is separable from the functional P2
  (jobs, spill, caps).
- **Retention**: full output spills to the shared tool-output store
  (`~/.porrima/tool-output/<chatId>/py-<cellId>.txt`;
  [pi-1.0-migration.md](pi-1.0-migration.md) §4) — the same store the bash
  rewrite uses, because pi 1.0 removed the harness spill and the two paths
  converge by necessity; the truncated result footer points at
  `read_file(path, offset=…)`. No new read tool needed. The 1 MiB cap is the
  retained background-job output window (§4.7); the spill is the full output
  up to the store's per-file byte cap (migration doc §4.3), after which it
  ends with a truncation marker.
- Retained files: newest 64 per chat, 24 h TTL, deleted with the chat — shared
  retention rules for bash and python output, owned by `tool-output-store.ts`.
  `cellId` is a short uuid per cell, not a per-kernel counter, so a kernel
  restart cannot silently overwrite a retained file from an earlier generation
  inside the 24 h window (and a `read_file` footer can never point at the
  wrong cell).

### 4.7 Background jobs

- `run_python(..., background: true)` returns immediately with a `jobId`; the
  cell runs as an asyncio task in the kernel. It **does not hold the turn-gate
  lease** — this is the point. On the wire, the execute acks with
  `done {id, status:"ok", job_id}`, the job's stdout/stderr/result/error
  events carry `job_id` as their `id`, and `job_done {job_id, status,
  duration_ms}` (§4.3) arrives exactly once at completion.
- **Child containment.** Children are `setsid`'d into their own process groups
  (so L2 can kill a cell's children selectively) and **journalled** — a kernel
  group kill does not reach them once `setsid` runs.
  - The driver patches `subprocess.Popen` at bootstrap: calls that do not set
    `preexec_fn`/`start_new_session` get `setsid`, and the child's pid + pgid +
    start-time are appended to a per-kernel journal
    (`~/.porrima/kernels/<chatId>/children.jsonl`) tagged with the owning cell
    (contextvar). This registry is what lets L2 and `python_jobs` kill reach a
    cell's subprocess children. A record is only marked inactive after group
    death is confirmed (`killpg(pid, 0)`, SIGKILLing survivors first —
    prime-agent's `_reap_group`), so a stale active record can never hide a
    live descendant (10-04 review, prime-agent bash study).
  - L3/disposal kill the kernel group **plus** every group in the journal; the
    startup sweep does the same for dead kernels' journals. Without the
    journal, `setsid` children survive the kernel's group kill — exactly why
    prime-agent has one (§2.1).
  - The Popen patch remains the riskiest novel mechanism (prime-agent
    supervises explicit `bash()` spawns instead of patching `Popen`). Fallback
    if it proves invasive: keep children in the kernel's process group (no
    `setsid`, no journal); L2 then cancels the cell but cannot selectively kill
    its children, and long-lived subprocesses belong in background cells.
  - Journal-after-spawn leaves a tiny leak window on a hard crash. prime-agent
    closes it with a spawn gate, but that gate is shell-transport-specific —
    its `bash()` wraps the command in a script that `read`s from a socketpair
    after the shell execs but before the user command runs — and the kernel's
    Popen patch spawns arbitrary binaries with no portable injection point (a
    `preexec_fn` SIGSTOP handshake is unsafe with threads). Accepted for P1:
    the window is milliseconds and the startup sweep covers everything
    journaled; the gate applies only to spawns the driver owns. See §8.8.
- **Workspace mutation lock** (10-04 review): today every `run_python` call
  holds `withMutationLock('workspace:<label>')` for its duration
  (`agent-tools.ts:871`). Foreground kernel cells keep taking it; background
  jobs necessarily escape it (the turn has ended). Two chats in the same
  project can then mutate the workspace concurrently with a foreground `bash`.
  Accept this — the kernel is a workspace peer, like a long-running shell — and
  say so in the tool description; holding the lock for a job's whole life would
  reintroduce the turn-gate problem at the workspace level.
- New tool `python_jobs(action: "list"|"status"|"tail"|"kill", jobId?, lines?, force?)`
  — list this chat's jobs (id, status, started, duration), tail output (capped
  16 KiB), kill (L2: cancel the task, then SIGTERM, 3 s, SIGKILL on the cell's
  child groups). `force: true` escalates to L3 (kernel kill, state loss) and is
  the only model-reachable L3 path (10-04 review; §4.5 previously and §4.7
  disagreed about what `kill` means).
- **`python_jobs` is served from server-side state**: `list`/`status`/`tail`
  answer from the server's own event buffer and the spill files, never a
  kernel round-trip, so they work even while a cell runs or when the kernel is
  wedged. The registry is fed by the tagged output events and flips status on
  `job_done` (§4.3). `kill`'s escalation splits by who must cooperate: L2
  (task cancel + child-group kill) needs the kernel and fails when wedged;
  `force: true` (L3) is a **server-side supervisor kill, never a protocol
  request** — a wedged kernel cannot process one, and L3 exists precisely for
  that state (§4.5).
- Completion is visible on the next turn's `python_jobs list`; an optional
  wake (P3, open question #3) can post a message into the chat through the
  existing `schedule_chat_message` path. No automatic turn start in P1/P2.
- **No in-turn polling.** Every `python_jobs` call is an LLM iteration that
  holds the turn lease; a tail-polling loop is the background problem in
  miniature. The tool description says "end your turn; check on the next
  turn," and a `tail` of the same still-incomplete job a second time in one
  turn returns that notice instead of output.
- **System pause gates job starts.** While the global pause is active
  (`system-pause.ts`), `background: true` returns a "system paused" notice —
  the same gate the automation and periodic schedulers already apply. Running
  jobs are not killed by a pause; they run to completion, mirroring how the
  scheduler skips due automations without interrupting running ones.
  Foreground cells are unaffected (user-initiated, bounded by the turn).
- Caps: 4 concurrent background jobs per kernel, **8 box-wide** (16 full-core
  jobs would fight the CPU-only inference services for every core), 1 MiB
  output each, 64 retained; kernel restart kills jobs and says so. Jobs are
  tasks inside one kernel process, so `nice()` cannot separate them from
  foreground work — the cap plus the tool description's thread-limit guidance
  (`OMP_NUM_THREADS`) are the controls.
- `bash` remains the tool for shell pipelines; inside cells, plain
  `subprocess` is allowed (Porrima is not Albedo's `run()`-only kernel).

### 4.8 Snapshot / restore

- **Engine (10-04 review)**: `dill` (lazy import, `recurse` mode) if installed,
  else `pickle`. Reality check: this box's `python3` is 3.14.4 with no `dill`,
  so P3 on a stock system is pickle-only — and plain `pickle` cannot restore
  cell-defined functions/classes at all (they exist only in the synthetic
  `__main__` of a dead process, §4.4). `dill` is a documented prerequisite for
  P3 (or the P4 venv moves earlier), and its 3.14 support must be verified.
  Prime-agent never falls back to pickle: snapshot/restore report an error when
  `dill` is missing; Porrima's pickle fallback is plain-data only and must say
  so in the notice.
- **Restore rebinding (10-04 review)**: per-name `dill.loads` is not enough.
  Restored functions carry the snapshot's frozen globals; prime-agent revives
  containers in place and rebinds `__main__` callables onto the **live**
  namespace (`_revive_with_live_globals`), with cycle memoization and backfill
  for globals the live namespace lacks. Skip this and a restored function
  mutates a stale copy of module state instead of the live namespace. This is
  the most intricate part of prior art's restore and the easiest to
  underestimate.
- Per-name serialization so one bad value does not fail the snapshot;
  `_`-prefixed names skipped; caps **16 MiB per variable (matching
  prime-agent) / 64 MiB total**. Per-variable is the usefulness threshold — an
  iterative data-analysis namespace routinely holds values above 8 MiB
  serialized, and those long sessions are exactly the ones snapshot survival
  is for; total is the real cost driver (serialization CPU inside the kernel
  between cells, contention with the CPU-only inference services on the same
  box, write churn across up to 4 live kernels), which is why it stays below
  prime-agent's 256 MiB. Both caps are `snapshot` request parameters
  (`max_variable_bytes`, `max_bytes`) and land in implementation settings.
  Atomic tmp+rename; JSON manifest (`version`, `savedNames`, `skipped`,
  `pruned`, `bytes`, `pythonVersion`, `timestamp` — prime-agent's full field
  set).
- Debounced **1.5 s after each execution settles**, plus a flush on disposal
  and graceful shutdown; `prune_oversized` available as a maintenance action.
  **The flush runs only when the kernel is idle**: a snapshot queued behind a
  running cell would never finish before a SIGKILL, so a busy kernel at
  shutdown gets hard-crash semantics — the last-settled snapshot is the
  recovery point (same as §6 "Kernel crash mid-cell"). "Idle" means **no
  foreground cell**: a live background job does not block the debounce or the
  idle flush — asyncio tasks are not serializable and are never captured
  anyway (§4.7: restart kills jobs), so suppressing snapshots behind a
  multi-hour job would only lose foreground state.
- **Commit shielding (10-04 review)**: install a parking SIGINT handler only
  for the `os.replace` commit phase (payload then manifest), and consume a
  parked interrupt rather than re-raising — the destructive snapshot
  succeeded, and re-raising would make the server treat it as failed and
  discard the only copy of pruned names. A KI during payload write leaves the
  old pair fully intact. Reads enforce the same per-variable/total caps as
  writes before allocating, so a corrupt manifest cannot force a huge
  allocation.
- **Failed-restore guard (10-04 review)**: a failed or partial restore marks
  the kernel so the debounced flush never overwrites a fuller on-disk
  payload; only a successful re-restore clears it.
- **EOF final flush (10-04 third review**, from prime-agent
  `repl.py:1223-1247`**)**: on stdin EOF — the server died without a graceful
  dispose, so the pipes closed while the loop may still be live — the runtime
  best-effort flushes the namespace to the **last-known snapshot target**
  before exit, guarded so it never fires before the first host-committed
  snapshot (`_last_snapshot_target is None`). This pairs with the owner
  watchdog (§4.2): the watchdog covers the wedged-loop case (hard exit, no
  flush possible); the EOF flush covers the live-loop case, extending the G5
  recovery point from "last debounce" to "up to the EOF". P3.
- **Capture-freshness memo (10-04 third review**, from prime-agent
  `manager/snapshot.rs`**)**: skip the whole-namespace re-dump while provably
  unchanged — a user-execution counter plus a payload/manifest stat witness,
  invalidated by restore and by capture sequence. This is prior art's actual
  answer to this section's own cost worries (serialization CPU contending
  with the CPU-only inference services, write churn across 4 live kernels).
  P3.
- **Request validation (10-04 third review)**: `path === manifest_path`
  rejected via `realpath` (aliasing cannot clobber the payload with the
  manifest); `prune_oversized` re-measures at write time because in-place
  mutation defeats name-based size tracking (prime-agent `repl.py:836-843,
  1143-1152`).
- Skip/prune notices are actionable: they name the variable, its serialized
  size, and the escape hatch — spill to a file (`to_parquet`/`np.save`) and
  keep the path, which survives snapshots as a plain string.
- State at `~/.porrima/kernels/<chatId>/namespace.pkl` + `manifest.json`,
  directory mode 0700; deleted with the chat and expired after 14 idle days.
- **Version mismatch at restore**: if the running `python3` major version
  differs from the manifest's `pythonVersion`, skip restore entirely with a
  one-line notice (cross-major dill objects are the drift risk); same-major
  restores attempt per-name with failures in the notice.
- Startup/creation flow: spawn → `restore` → `ready`; the first tool result
  carries a one-line notice when names were restored or dropped. On a hard
  crash (SIGKILL, power loss) the last debounced snapshot is what comes back —
  document that in the tool description.
- Pickle is the same trust domain as the user's own code; this is stated in the
  code comment and docs, not presented as isolation.

### 4.9 Environment

- P1 uses the same `python3` resolution as today (PATH locally; login shell on
  remote), `PYTHONDONTWRITEBYTECODE=1`, and the workspace root as cwd.
- A provisioned kernel venv (prime-agent's `uv` approach, default packages) is
  a later option, not P1: changing which interpreter runs `run_python` would
  silently change behavior for existing chats.
- `requirements`-style package installs remain the model's job through `bash`
  (same as today).

### 4.10 Remote SSH (phase 4, optional)

- Same driver and protocol over the existing SSH ControlMaster; the driver is
  staged once to `~/.porrima/kernel/porrima_kernel.py` on the host via the
  existing write path, then spawned with stdio piped through ssh.
- An ssh drop kills the kernel (state lost unless snapshotted to the host's
  `~/.porrima/kernels/`); per-call execution remains the fallback, and the
  tool result says which mode ran.
- **Remote spill goes inside the remote workspace** (the `.porrima-tool-output/`
  pattern bash already uses there), not the remote host's `~/.porrima/kernel-output/`
  — the model's `read_file` resolves against the remote workspace root, so a
  server-side-style path would be unreachable from the spill footer.
- Deferred because per-call SSH already works and the lifecycle is the hard
  part; nothing in P1–P3 depends on it.

### 4.11 Lifecycle, cleanup, orphans

- Every kernel is spawned into its own process group; disposal first sends the
  protocol `shutdown` request (§4.3), bounded ~3 s, so the driver kills its own
  journaled child groups and flushes state cleanly — prime-agent's teardown
  order, protocol shutdown before signals (`manager/teardown.rs`) — then
  SIGTERM to the group **plus every child group in the kernel's journal**
  (§4.7), waits up to 3 s, then SIGKILL. `setsid`'d children do not inherit
  the kernel group, so the journal is what makes teardown complete (10-04
  review). The supervisor's child registry
  ([pi-1.0-migration.md](pi-1.0-migration.md) §3) is what makes shutdown's
  `killAllSupervised()` cover kernels and bash alike.
- **Teardown isolation** (10-04 third review): each kernel's disposal carries
  its own protocol-shutdown and signal deadlines; one wedged kernel never
  blocks the others or `killAllSupervised()` — prime-agent's per-kernel
  failure isolation (`live_kernels.rs`).
- Startup sweep: the kernel process itself is covered by the supervisor's
  persisted journal, swept before anything can spawn
  ([pi-1.0-migration.md](pi-1.0-migration.md) §3.6); `sweepKernelJournals()`
  then reads each `~/.porrima/kernels/<chatId>/children.jsonl`, kills active
  child groups (start-id verified, group-first), and removes the stale state
  directories. Journal records are deactivated only on confirmed group death
  (killpg liveness, survivors SIGKILLed first — prime-agent's `_reap_group`),
  so the in-kernel reaper and this sweep agree on what is still live. The
  driver's owner watchdog (§4.2) is the in-band defense against a server
  SIGKILL; the sweep is the next-start backstop.
- The idle reaper runs on its own interval (same pattern as the scheduler's
  periodic ticks), never inside a request.
- **RSS watchdog**: the same reaper checks kernel RSS; an **idle** kernel over
  a threshold (default 2 GiB, settings-tunable) is snapshot-flushed and
  disposed — state survives via the next call's restore notice. This is the
  live-RAM bound snapshot caps cannot provide: caps bound serialization cost,
  not namespace size.
- Graceful shutdown in `index.ts` disposes all kernels alongside the existing
  SSH/TTS/browser teardown.

### 4.12 Security posture

- Not a sandbox; full user permissions, same as `bash` and `run_python` today.
- A persistent kernel holds secrets and credentials in memory for its lifetime,
  and snapshot files may contain them: `~/.porrima/kernels/` is 0700, files
  0600, expiry deletes them. Document this in `docs/tool-system.md`.

### 4.13 Model-facing changes and replay stability

- `RUN_PYTHON_TOOL` description gains: persistent namespace per **agent**
  chat, top-level await, state survives errors/timeouts, optional background
  mode, output spill path, and that a server restart restores best-effort.
  It also pushes `background: true` for anything expected to run long
  (>~60 s): a foreground cell still holds the turn lease for its full
  duration, and the model opting into background is what fixes consequence 3.
  It states that a second Stop escalates to cell kill with the namespace
  preserved (§4.5 L2), and that long-lived subprocesses belong in background
  cells.
- New `PYTHON_JOBS_TOOL` (list/status/tail/kill/force), added to
  `SEQUENTIAL_TOOL_NAMES` (it mutates jobs) and excluded from system chats
  together with the stateless-mode decision (10-04 review).
- `run_python`'s schema keeps the 300 s `timeout` max for foreground calls;
  `background: true` allows up to 3600 s. TypeBox has no conditional max, so
  execute validates the combination and the description states it (10-04
  review).
- System chats run one-shot; their result carries a one-line "stateless
  mode in this chat type" prefix (the same notice pattern as restore) so a
  headless automation model does not rely on persistence it will not get.
  The one-shot path keeps the adapter's internal options
  (`WorkspacePythonOptions` carries `maxBuffer`/`trusted`; `argv` is a
  per-call argument, not an option — 10-04 third review); internal callers
  are not routed through the kernel in P1.
- Results must stay byte-stable for the wire/replay invariant: no wall-clock
  timestamps inside result text (Porrima's time marker is appended by the
  wrapper, not the tool), deterministic ordering for `python_jobs list`, and
  no metadata as content fields (§4.6).
- A restored-namespace notice is emitted as a distinct tool-result prefix, in
  the style of prime-agent's `<ipython_kernel_reset>` notice.

### 4.14 Observability

- Per-kernel log lines with `chatId` (spawn, restore, execute, interrupt,
  snapshot, dispose, crash) at the server's existing logger levels.
- Diagnostics tail (stderr) kept per kernel and included on protocol failures.
- Counters (kernels live, cells run, snapshots, restarts) can land in
  `model-stats`-style storage later if useful; not P1.

## 5. Phased plan

| Phase | Scope | Rough size |
|---|---|---|
| P1 | Driver (`porrima_kernel.py`), manager/supervisor, persistent namespace, top-level await, interrupts L1/L2 (test matrix: C extension holding the GIL, `subprocess.wait`, tight `except`-swallowing loop, custom SIGINT handler, `except BaseException` swallow, parked interrupt, double interrupt, finishing/handoff windows), per-cell process-group patch + child journal, owner watchdog, wedge policy, lazy per-chat kernels, TTL/LRU, one-shot fallback, startup sweep, shutdown disposal (protocol `shutdown` first), tool description, tests | ~1,200–1,800 LOC TS+Py (10-04 review: 600–800 excluded the interrupt state machine and tests) |
| P2 | Background jobs, `python_jobs`, output spill/paging, job caps (per-kernel + box-wide) | ~300–400 LOC |
| P2.5 | Streaming spike (spike-first, §4.6): `onUpdate` in execute → `tool_execution_update` case + SSE event in `chat.ts` → client tool-card render. Live-only, never persisted. Ship if clean, else drop | ~100–200 LOC |
| P3 | Snapshot/restore + notices + expiry, revive-with-live-globals, read-side cap enforcement, commit shielding, failed-restore guard, EOF final flush, capture-freshness memo, request validation, MIME `display` (matplotlib → tool-result images via existing image pipeline) | ~400–600 LOC (10-04 review; third-review additions are small) |
| P4 (optional) | Remote SSH kernels, kernel venv provisioning | ~400–600 LOC |

Each phase is independently shippable. P1 alone fixes iteration, failure
survival, and interrupt-without-state-loss; P2 fixes the turn-gate blocking
problem; P2.5 is optional polish — partials never reach the model, so it buys
only the human-facing stream.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Orphaned kernel/child processes | Process-group kill + child journal (§4.7), startup sweep with pid+start-time identity, owner watchdog, shutdown disposal |
| Memory growth from live namespaces | Max kernels + idle TTL + LRU, snapshot caps, no eviction while busy |
| Namespace leakage across chats | Per-chat keys and per-chat state directories |
| Replay/token drift from result shape | Stable JSON fields, no timestamps in text, `python_jobs` sorted deterministically |
| First-call latency (spawn + restore) | Lazy creation; ready timeout 30 s; failures fall back to one-shot for that call (spawn progress becomes visible in P2.5, when the streaming plumbing lands) |
| Capacity exhaustion (all live kernels busy) | Degrade to one-shot with a notice (§4.1); LRU only ever evicts idle kernels |
| In-turn polling of background jobs | Tool description steers to end the turn; second `tail` of the same incomplete job in one turn returns a notice (§4.7) |
| Pickle state as an attack surface | Same trust domain, 0700/0600, documented; restore never re-runs cell source (unpickling itself carries the same trust as user code), in every phase |
| CPU/RAM contention with inference | Job caps, output caps, TTL; jobs are user-visible and killable |
| Kernel crash mid-cell | Tool result reports the crash and the last snapshot; next call restarts fresh with a notice |
| Stubborn foreground cell (swallowed interrupt, runaway child) | L2 cell kill (task cancel + child-group kill, namespace intact); sync non-yielding cells hit the wedge policy (bounded error, one-shot fallback); L3 never automatic; escape hatch is background mode (§4.5, §4.7) |
| Live namespace RAM (4 kernels × GB-scale frames) | RSS watchdog on the idle reaper: idle-over-threshold → flush + dispose, state survives via restore (§4.11) |
| `setsid` children outlive a killed kernel | Child journal (§4.7) reaped on disposal and by the startup sweep; journal-after-spawn window accepted with rationale in §8.8 |
| Server SIGKILL leaves the kernel running | Driver owner watchdog exits when the server pid disappears (§4.2); next-start sweep as backstop; a still-live loop performs the EOF final flush before exiting (§4.8) |
| Sync cell swallows L1 and L2 (wedge) | Wedge policy: bounded second grace, tool error with namespace preserved, kernel flagged, next calls one-shot; explicit `python_jobs kill force` for L3 (§4.5) |
| Wedged kernel blocks shutdown of the others | Per-kernel bounded teardown, protocol `shutdown` before signals (§4.11) |
| `dill` absent / 3.14 support gap | Documented prerequisite for P3; pickle fallback is plain-data only and reported; venv option moves earlier if needed (§4.8) |

## 7. Alternatives considered

- **Jupyter/ipykernel**: mature namespace/interrupt/streaming, but pulls in
  ZeroMQ and a large protocol surface, and its lifecycle model is a poor fit
  for a server-owned child. Rejected.
- **Albedo-style detached kernel with a durable session layer**: solves daemon
  restarts and dropped connections, which Porrima does not have (the server is
  the daemon); snapshot/restore is the 20 % that covers the same user-visible
  need. Rejected for now; the protocol leaves room to add it later.
- **Keep one-shot execution**: adequate for scripts, but fails G1–G4; the
  turn-gate blocking alone justifies the change.
- **Persistent bash shell**: a different feature with similar lifecycle costs;
  not requested.

## 8. Open questions

1. **System chats**: exclude persistent kernels (one-shot fallback) or allow
   them with a tighter TTL? Current lean: exclude in P1.
2. **Snapshot engine**: depend on `dill` (function/class pickling) or
   `pickle`-only (plain data), matching prime-agent's lazy import? Current
   lean: lazy `dill`, fall back to `pickle` — but note the 10-04 finding: this
   box has no `dill` and Python 3.14, and pickle-only cannot restore
   cell-defined functions. If P3 must work on a stock system, `dill` becomes a
   prerequisite or the venv moves up.
3. **Job-completion wake**: none (poll), chat message via cross-chat, or push
   notification? Current lean: none in P1/P2, `schedule_chat_message` with
   `wake: true` in P3 — the existing path, respects inactivity gates, no new
   mechanism. Prior art for the double-wake problem (10-04 review, prime-agent
   bash study): the kernel sends a `bash.completed` host request only after
   the creating cell's completion barrier, and a later read of the result
   ships a fire-and-forget `bash.consumed` frame *inside the read, before the
   cell's `done`*, so the host withdraws a queued notice before it can
   dispatch. If the P3 wake lands, copy that shape — a `python_jobs`
   tail/status read should cancel a queued wake for the same job.
4. **Output reading**: spill-to-file + `read_file` (bash pattern) or a
   dedicated `python_output` tool? Current lean: spill-to-file.
5. **Tool naming**: keep `run_python` (yes — it is in prompts, skills, and
   docs).
6. **Defaults**: idle TTL 30 min, max 4 kernels, snapshot caps 16 MiB
   per-variable / 64 MiB total (§4.8) — settle in implementation settings.
7. **Cell journal/repair** (Albedo's `cells.run`): worth a P5 if interrupted
   calls prove common in practice; not now.
8. **Child-journal spawn gate** (10-04 review, resolved after the prime-agent
   bash study): prime-agent's journal-before-execute gate is
   shell-transport-specific — its `bash()` wraps the command in a script that
   blocks on a socketpair `read` after the shell execs, before the user
   command runs (10-04 third review: the letter, not the effect —
   journal-before-run is the point). The kernel's Popen patch spawns
   arbitrary binaries, so there is no portable injection point; a
   `preexec_fn` SIGSTOP handshake would close the window but is unsafe with
   threads. **Resolved: accept the millisecond window in P1**
   (journal-after-spawn + startup sweep), and gate only spawns the driver
   owns. Revisit only if the window shows up in practice.

## 9. Second review revisions (10-04)

Review inputs: a local prime-agent clone (`repl.md`, `repl.py`,
`crates/pa-core/src/kernel/`), the installed
`@earendil-works/pi-agent-core@0.85.1` (`executePreparedToolCall` passes
`onUpdate` and emits `tool_execution_update`), and this box's Python (`python3`
3.14.4, no `dill`). All 10-03 code claims re-verified; no drift found beyond
the package rename (`pi-agent-core` → `@earendil-works/pi-agent-core`). The
load-bearing corrections, all applied inline:

1. Child containment settled: `setsid`'d children need a child journal, and
   the kernel group alone does not reap them (§4.7, §4.11).
2. Owner watchdog added: "dies with the server" is only true for graceful
   shutdown without it (§4.2).
3. Restore is more than `dill.loads`: synthetic `__main__`, by-value pickling,
   revive-with-live-globals, read-side caps, commit shielding, failed-restore
   guard (§4.4, §4.8).
4. Interrupt precision: L2 cannot stop a sync non-yielding cell; finishing and
   handoff windows added; wedge policy and the `python_jobs kill` L2/L3 split
   defined (§4.5, §4.7).
5. Drain fence and host-side frame bounds/repair added to the protocol rules
   (§4.3).
6. Porrima integration: workspace mutation lock semantics, `python_jobs`
   registration/gating, build copy step, AbortSignal mapping, four `chat.ts`
   event sites, timeout schema (§4.6, §4.7, §4.13).
7. Size estimates raised for P1/P3; one new open question plus a revision to
   #2 (§5, §8).
8. Follow-up (10-04): pi-agent-core 1.0 removed the `./node` and `./harness/*`
   surface. The forced bash rewrite and the shared process supervisor /
   tool-output store are specified in
   [pi-1.0-migration.md](pi-1.0-migration.md); this plan consumes them (§2.3,
   §4.2, §4.6, §4.11). The P2.5 streaming seam was re-verified against 1.0.2
   and is unchanged.
9. Prime-agent bash study (10-04): journal records deactivate only on
   confirmed group death (§4.7, §4.11); the spawn-gate question resolved as an
   accepted window because the gate is shell-transport-specific (§8.8); the
   `bash.consumed` withdrawal recorded as prior art for job-completion wake
   (§8.3). Supervisor-side parity items (confirmed kill, non-interactive env)
   live in [pi-1.0-migration.md](pi-1.0-migration.md) §3.3/§3.5.

## 10. Third review revisions (10-04)

Review inputs: the `@earendil-works/pi-agent-core`/`pi-ai` **1.0.2 tarballs**
and the upstream changelog (every migration claim in
[pi-1.0-migration.md](pi-1.0-migration.md) re-confirmed: harness-removal
text, `finishTurn`, `TranscriptContext`, the unchanged `onUpdate` seam), the
Porrima codebase (every load-bearing line claim re-verified — none
materially wrong), and a fresh prime-agent read focused on teardown order,
snapshot scheduling, and protocol hardening. Revisions, all applied inline:

1. Cross-references to pi-1.0-migration.md corrected: the process supervisor
   is §3 and the tool-output store §4 there; four sites here pointed at
   §4/§5 (§2.3, §4.2, §4.6, §4.11).
2. Owner-watchdog mechanism pinned: blocking pidfd/kqueue exit wait, not a
   poll loop; hard `os._exit` on owner death because a sync cell monopolizes
   the loop (§4.2).
3. Protocol hardening added: strict JSON (`allow_nan=False`), oversized-line
   poisoning (keep draining while repairing), handshake-mismatch policy,
   aggregate traceback cap; `parked_interrupt` noted as a Porrima v1 addition,
   not prior art (§4.3).
4. Teardown order fixed: protocol `shutdown` request first (bounded), then
   signals — §4.11 previously skipped the request §4.3 already defines;
   per-kernel teardown isolation added so one wedged kernel cannot block
   the others or `killAllSupervised()` (§4.11).
5. Snapshot additions: kernel-side **EOF final flush** (the live-loop
   complement to the watchdog — a server SIGKILL closes the pipes while the
   loop is alive, and a flush there extends the recovery point to "up to the
   EOF"), **capture-freshness memo** (prior art's answer to this doc's own
   write-churn/CPU-contention worry), request validation, and the manifest
   field set completed (`version`, `pruned`). The "idle" definition settled:
   no foreground cell; background jobs never captured (§4.8).
6. `python_jobs` authority settled: `list`/`status`/`tail` are served from
   server-side state (event buffer + spill files), and L3 `kill force` is a
   server-side supervisor kill, never a protocol request — a wedged kernel
   cannot process one (§4.7).
7. Precision: spawn-gate letter corrected ("after the shell execs, before
   the user command runs", not "before exec" — §4.7, §8.8); the 1 MiB cap
   moved to the job-retention window it belongs to (§4.6);
   `WorkspacePythonOptions` field set corrected (§4.13); sandbox persistent
   sessions noted dormant (§1).

## References

- prime-agent: <https://github.com/PrimeIntellect-ai/prime-agent> —
  `prime-agent-runtime/src/rlm/repl.md` (protocol), `repl.py`,
  `prime-agent-runtime/src/rlm/bash.py` (bash supervision: spawn gate,
  completion fence, orphan journal, confirmed group death),
  `crates/pa-core/src/kernel/` (manager, snapshot, orphan journal, bootstrap)
- Albedo: <https://tangled.org/okami.mom/albedo> —
  `robot-docs/kernel.md`, `robot-docs/kernel-state.md`,
  `priv/python/albedo_kernel.py`
- Porrima today: `server/src/services/workspace.ts` (`runPython`),
  `server/src/services/agent-tools.ts` (`RUN_PYTHON_TOOL`, `wrapResult`),
  `server/src/services/sandbox.ts` (legacy session dirs),
  `server/src/services/turn-gate.ts`
