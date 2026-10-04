# Session Python Kernel — Persistent REPL for `run_python`

**Status**: Design. Not implemented.
**Date**: 2026-10-03

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
`read_pdf`'s URL branch.

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
- **Snapshot/restore**: `dill` (recurse mode) if available, one name at a time;
  `_`-prefixed names skipped; per-variable cap (16 MiB) and total cap
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
| Snapshot/restore, debounce, caps, manifest | Orphan journal (process-group kill + startup sweep is enough) |
| Streaming cell output as tool updates | Dedicated kernel venv (defer; system `python3` first) |
| MIME `display` → tool-result images | Remote kernels (phase 4, optional) |

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
- Disposal: chat deletion, workspace change, TTL, LRU, graceful shutdown.
  Chat deletion cascades through `chat-deletion.ts` and covers all three
  artifacts: the live kernel handle, the output dir, and the state dir.

### 4.2 Process model

- The server spawns `python3 -u <driver>` as a child in its **own process
  group** (`detached: true` locally), so a group kill reaches the kernel and
  every child it spawned.
- stdio: requests on the kernel's stdin, events on its stdout, stderr kept as a
  bounded diagnostics ring buffer (last ~64 KiB) surfaced in errors.
- **No bridge, no socket, no daemon**: the kernel dies with the server. Snapshot
  + restore covers restarts (G5). This is the single biggest simplification
  versus Albedo.
- Driver file: `server/python/porrima_kernel.py`, resolved relative to the
  service module (`../../python/porrima_kernel.py`) so dev (`src/services`) and
  build (`dist/services`) both find it. No TS build step needed for Python.
  The install/systemd package must ship `server/python/` — a missing driver
  silently degrades every call to one-shot, so the version/update check
  verifies the file's presence.

### 4.3 Protocol (v1)

Newline-delimited JSON, UTF-8. One object per line, no other framing.

Requests (server → kernel):

| Request | Fields |
|---|---|
| `execute` | `{id, code, timeout_ms?, background?}` |
| `interrupt` | `{id?}` — no reply; parked until the named cell starts |
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
  fields.

Rules borrowed from prime-agent's `repl.md`: a private dup of fd 1 is made
before redirection; a per-write lock keeps frames whole; fd 0 is rebound to
`/dev/null` after the reader takes it so `input()` sees EOF; a malformed line
yields a protocol error event and the runtime keeps serving; stdin EOF is
`shutdown`.

### 4.4 Execution semantics

- Persistent `__main__` namespace, one asyncio event loop.
- Cells compile with `PyCF_ALLOW_TOP_LEVEL_AWAIT`; the last expression is
  compiled as `eval` and its value bound to `_` and reported as `result`.
- Cell source registered in `linecache` under `<porrima-cell-N>` so tracebacks
  show the offending line; tracebacks formatted plain with runtime frames
  stripped.
- A failed cell keeps the namespace (no rollback). `timeout_ms` defaults to the
  tool's timeout (30 s), max 3600 s for background jobs; a foreground timeout
  interrupts the cell, then reports `status:"error"` with the namespace intact.
- One execution at a time per kernel; duplicate `id`s are rejected (the server
  never reuses ids).

### 4.5 Interrupts

- The server writes `{type:"interrupt", id}`; the driver's reader thread raises
  `KeyboardInterrupt` in the running cell via SIGINT to the main thread, with
  asyncio task identification (prime-agent's mechanism). An interrupt for a
  queued cell is parked and delivered when it starts.
- Stop button → interrupt (state preserved) rather than process kill. A cell
  that does not stop within a grace window (default 5 s) reports
  "still stopping" and the model may retry or kill; killing is explicit
  (`python_jobs` kill or TTL eviction), never automatic, so state loss is
  always the caller's choice.

### 4.6 Results, streaming, retention

- The tool result keeps today's shape — stdout, then `[stderr]`, then the
  trailing value — with **no new content fields**. `normalizeToolResultContent()`
  strips results to strict `{type, text}` items and extra fields ride the wire
  but vanish on replay (KV digest divergence — "Tool Result Wire Shape" in
  `docs/tool-system.md`); `cellId`/`duration`/`truncated` metadata therefore
  goes in `details` or an in-text footer, never as content items.
- **Streaming** (P2): stdout chunks arrive as pi-ai `onUpdate`s, which the tool
  wrapper already threads through (`agent-tools.ts:409`); today `run_python`
  ignores `onUpdate`.
- **Retention**: full output spills to
  `~/.porrima/kernel-output/<chatId>/<cellId>.txt` (1 MiB cap), mirroring
  `bash`'s spill pattern (`workspace.ts:198`); the truncated result footer
  points at `read_file(path, offset=…)`. No new read tool needed.
- Retained files: newest 64 per chat, 24 h TTL, deleted with the chat.

### 4.7 Background jobs

- `run_python(..., background: true)` returns immediately with a `jobId`; the
  cell runs as an asyncio task in the kernel. It **does not hold the turn-gate
  lease** — this is the point.
- New tool `python_jobs(action: "list"|"status"|"tail"|"kill", jobId?, lines?)`
  — list this chat's jobs (id, status, started, duration), tail output (capped
  16 KiB), kill (cancel task; SIGINT to process group for `subprocess` children
  the cell started).
- Completion is visible on the next turn's `python_jobs list`; an optional
  wake (P2/P3) can post a message into the chat through the existing cross-chat
  or queued-message path. No automatic turn start in P1.
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
- Caps: 4 concurrent background jobs per kernel, 1 MiB output each, 64
  retained; kernel restart kills jobs and says so.
- `bash` remains the tool for shell pipelines; inside cells, plain
  `subprocess` is allowed (Porrima is not Albedo's `run()`-only kernel).

### 4.8 Snapshot / restore

- `dill` if installed, else `pickle`; per-name serialization so one bad value
  does not fail the snapshot; `_`-prefixed names skipped; caps **16 MiB per
  variable (matching prime-agent) / 64 MiB total**. Per-variable is the
  usefulness threshold — an iterative data-analysis namespace routinely holds
  values above 8 MiB serialized, and those long sessions are exactly the ones
  snapshot survival is for; total is the real cost driver (serialization CPU
  inside the kernel between cells, contention with the CPU-only inference
  services on the same box, write churn across up to 4 live kernels), which
  is why it stays below prime-agent's 256 MiB. Both caps are `snapshot`
  request parameters (`max_variable_bytes`, `max_bytes`) and land in
  implementation settings. Atomic tmp+rename; JSON manifest
  (`savedNames`, `skipped`, `bytes`, `pythonVersion`, `timestamp`).
- Debounced **1.5 s after each execution settles**, plus a flush on disposal
  and graceful shutdown; `prune_oversized` available as a maintenance action.
  Skip/prune notices are actionable: they name the variable, its serialized
  size, and the escape hatch — spill to a file (`to_parquet`/`np.save`) and
  keep the path, which survives snapshots as a plain string.
- State at `~/.porrima/kernels/<chatId>/namespace.pkl` + `manifest.json`,
  directory mode 0700; deleted with the chat and expired after 14 idle days.
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
- Deferred because per-call SSH already works and the lifecycle is the hard
  part; nothing in P1–P3 depends on it.

### 4.11 Lifecycle, cleanup, orphans

- Every kernel is spawned into its own process group; disposal sends SIGTERM to
  the group, waits up to 3 s, then SIGKILL. All children inherit the group, so
  ordinary subprocess trees die with the kernel.
- A startup sweep kills leftover `porrima_kernel.py` processes recorded in
  `~/.porrima/kernels/*/pid` from a previous server run (pid + start-time
  identity to avoid pid reuse), then removes stale pid files.
- The idle reaper runs on its own interval (same pattern as the scheduler's
  periodic ticks), never inside a request.
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
- New `PYTHON_JOBS_TOOL` (list/status/tail/kill).
- System chats run one-shot; their result carries a one-line "stateless
  mode in this chat type" prefix (the same notice pattern as restore) so a
  headless automation model does not rely on persistence it will not get.
  The one-shot path keeps the adapter's internal `argv`/`maxBuffer` options
  (`workspace.ts` `WorkspacePythonOptions`); internal callers are not routed
  through the kernel in P1.
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
| P1 | Driver (`porrima_kernel.py`), manager/supervisor, persistent namespace, top-level await, interrupts (test matrix: C extension holding the GIL, `subprocess.wait`, tight `except`-swallowing loop, parked interrupt, double interrupt), lazy per-chat kernels, TTL/LRU, one-shot fallback, startup sweep, shutdown disposal, tool description, tests | ~600–800 LOC TS+Py |
| P2 | Background jobs, `python_jobs`, output spill/paging, streaming `onUpdate`, job caps | ~300–400 LOC |
| P3 | Snapshot/restore + notices + expiry, MIME `display` (matplotlib → tool-result images via existing image pipeline) | ~250–400 LOC |
| P4 (optional) | Remote SSH kernels, kernel venv provisioning, job-completion wake | ~400–600 LOC |

Each phase is independently shippable. P1 alone fixes iteration, failure
survival, and interrupt-without-state-loss; P2 fixes the turn-gate blocking
problem.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Orphaned kernel/child processes | Process-group kill, startup sweep with pid+start-time identity, shutdown disposal |
| Memory growth from live namespaces | Max kernels + idle TTL + LRU, snapshot caps, no eviction while busy |
| Namespace leakage across chats | Per-chat keys and per-chat state directories |
| Replay/token drift from result shape | Stable JSON fields, no timestamps in text, `python_jobs` sorted deterministically |
| First-call latency (spawn + restore) | Lazy creation with `onUpdate` progress; ready timeout 30 s; failures fall back to one-shot for that call |
| Capacity exhaustion (all live kernels busy) | Degrade to one-shot with a notice (§4.1); LRU only ever evicts idle kernels |
| In-turn polling of background jobs | Tool description steers to end the turn; second `tail` of the same incomplete job in one turn returns a notice (§4.7) |
| Pickle state as an attack surface | Same trust domain, 0700/0600, documented; never auto-run restored code beyond pickle/definition replay (P1 has no definition replay at all) |
| CPU/RAM contention with inference | Job caps, output caps, TTL; jobs are user-visible and killable |
| Kernel crash mid-cell | Tool result reports the crash and the last snapshot; next call restarts fresh with a notice |

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
   lean: lazy `dill`, fall back to `pickle`.
3. **Job-completion wake**: none (poll), chat message via cross-chat, or push
   notification? Current lean: none in P1/P2, cross-chat message in P3.
4. **Output reading**: spill-to-file + `read_file` (bash pattern) or a
   dedicated `python_output` tool? Current lean: spill-to-file.
5. **Tool naming**: keep `run_python` (yes — it is in prompts, skills, and
   docs).
6. **Defaults**: idle TTL 30 min, max 4 kernels, snapshot caps 16 MiB
   per-variable / 64 MiB total (§4.8) — settle in implementation settings.
7. **Cell journal/repair** (Albedo's `cells.run`): worth a P5 if interrupted
   calls prove common in practice; not now.

## References

- prime-agent: <https://github.com/PrimeIntellect-ai/prime-agent> —
  `prime-agent-runtime/src/rlm/repl.md` (protocol), `repl.py`,
  `crates/pa-core/src/kernel/` (manager, snapshot, orphan journal, bootstrap)
- Albedo: <https://tangled.org/okami.mom/albedo> —
  `robot-docs/kernel.md`, `robot-docs/kernel-state.md`,
  `priv/python/albedo_kernel.py`
- Porrima today: `server/src/services/workspace.ts` (`runPython`),
  `server/src/services/agent-tools.ts` (`RUN_PYTHON_TOOL`, `wrapResult`),
  `server/src/services/sandbox.ts` (legacy session dirs),
  `server/src/services/turn-gate.ts`
