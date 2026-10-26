# Durable Work — The Job Supervisor, Command Jobs, and Completion Notices

Scope: how background work survives, how the agent learns it ended, and what the kernel
therefore does *not* need to become. Companion documents:
[job-supervisor.md](job-supervisor.md) (the durable process plane),
[session-python-kernel.md](session-python-kernel.md) (the kernel substrate: protocol, interrupts,
jobs, snapshot/restore), [kernel-codemode.md](kernel-codemode.md) §2.6 and §4.5 (the
notification families and the handle API), [pi-1.0-migration.md](pi-1.0-migration.md) §3 (the
server's process supervisor), [remote-python-kernel.md](remote-python-kernel.md).

**Position, stated up front.** Long-lived work belongs to a dedicated host-side job supervisor
service that spawns process groups and owns their execution ledger. The supervisor is a
separate systemd user unit in its own slice; the server is a client, not its parent. The Python
kernel stays ephemeral: its namespace is durable through snapshot/restore, its background
*cells* stay transient, and the work worth keeping alive is a command — a supervised process
group owned by the supervisor. The kernel-adoption design (socket transport, process placement,
identity-gated adoption) is kept in §7 as a named alternative with a measurement gate, because
the analysis that would justify it is specific and the prerequisites are real.

## 1. Problem

`run_python` keeps one Python process per chat. It holds the namespace and runs background cells
as asyncio tasks. The process is a child of the server, so a restart takes it down; the namespace
comes back from a snapshot, the jobs do not. `python_jobs` answers from an in-memory map while the
spill files it wrote stay on disk with nothing pointing at them, so after a restart the tool
reports "no background jobs for this chat" for work that was demonstrably running.

That is a false negative about what the agent itself did, and it is the motivating defect. Four
separate things are conflated under "state":

| Thing | Today | Worth making durable? |
|---|---|---|
| Namespace (names, imports, `_`) | snapshot on idle/dispose, restore on attach | yes, already — keep it |
| Job evidence (that a job existed, its command, its output) | in-memory registry + spill files, nothing linking them | **yes — the server's `job_view` for cells, the supervisor's `jobs.db` for commands** |
| Live work — a cell | asyncio task on the kernel's loop | no: it cannot outlive its kernel by construction |
| Live work — a command | a process group, currently only reachable from inside a cell | **yes: the only class that can outlive the kernel — owned by the supervisor** |

The gap that produces the next design decision: a cell *cannot* be made durable. Cells are tasks
on the kernel's own event loop. Commands are processes. So "make the background work survive"
means "make commands first-class and put them under a supervisor that outlives the server," not
"make the kernel immortal".

## 2. Which component owns durability

The rule: **something long-lived must own the ledger of work, and it must not be the component
that deploys most often.** Porrima answers that with a dedicated job supervisor service and its
SQLite ledger; the server is a client. This is the prime-agent shape (a daemon owns jobs, the
engine is a client), reduced to Porrima's process plane.

| | Job supervisor shape (**chosen**) | albedo shape (§7 alternative) |
|---|---|---|
| Long-lived component | `porrima-jobs.service` + `jobs.db` (execution); the server's SQLite (notices) | the kernel, reached over a bridge |
| Who spawns long-lived work | the supervisor | the kernel |
| Where "a notice is owed" lives | the server's `job_view` | the kernel |
| Restart semantics | the supervisor adopts its rows; the server replays its view and notices | the kernel reattaches and re-declares its inventory |
| What it costs | a service, a protocol, a ledger split | new transport, new process placement, an adoption protocol |

The decisive facts are about our own substrate:

- A command spawned as a child of `porrima.service` inherits its cgroup. `setsid`/`detached`
  changes the session, not the cgroup, so `systemctl --user restart porrima` kills it. The
  supervisor is a separate unit in `porrima-jobs.slice` with `KillMode=process`: a server
  restart does not touch it, and a supervisor restart does not kill its jobs. The placement and
  unit details are in [job-supervisor.md](job-supervisor.md) §3.
- The server's `sweepSupervisorJournal()` still reaps the server's own supervised children
  (foreground bash and kernels); TTS workers and SSH masters have their own teardown. Durable
  command groups are not in that journal; the supervisor has its own journal, `jobs.db`, and
  startup reconciliation.
- `SIGTERM` disposes every kernel. Under this shape that is correct behavior, not a defect:
  kernels are ephemeral, and durable work is not inside them.
- The kernel's own unique knowledge is narrow: whether a cell job is still running, and whether
  an in-kernel await or handle consumed its result. Those are facts to report into the server's
  view, not a queue to own.

The supervisor is a real, small component, not a module. It is process-shaped, not
session-shaped: it knows jobs, not chats, turns, or notices. Keeping that boundary is what stops
it from becoming a second application server.

## 3. Design

### 3.1 The ledger

There are two stores, deliberately different:

- **The supervisor's `jobs.db`** is authoritative for command/service execution: identity,
  process group, state, exit, output paths, and the event log.
- **The server's `job_view`** in `porrima.db` is the unified read model for the `jobs` tool, the
  UI, notices, and the fallback when the supervisor is down. It holds cell rows written by the
  kernel manager and command rows mirrored from the supervisor, plus notice state.

| Field | Owner | Purpose |
|---|---|---|
| `id`, `chat_id` | both | identity; `chat_id` is *not* a cascade delete — deleting a chat sends `stop_chat`, reaps the groups, and marks rows |
| `workspace` | server | the locked workspace label, for visibility and stats |
| `kind` | server view: `cell` \| `command` \| `service` \| `remote`; supervisor: `command` \| `service` | job class; recovery and wake policy depend on it |
| `command` / `snippet`, `cwd` | source, mirrored | what was started, where, verbatim enough to be greppable |
| `pid`, `pgid`, `start_id`, `boot_id` | source, mirrored | process identity for commands; null for cells; `start_id` is boot-relative, so `boot_id` travels with it |
| `started_at`, `ended_at`, `duration_ms` | both | recorded at the event, never recomputed at replay |
| `state` | source, mirrored | `starting` \| `running` \| `finished` \| `stopped` \| `lost` \| `failed` |
| `exit_code`, `signal`, `stop_reason` | source, mirrored | outcome and why it stopped (`user`, `timeout`, `shutdown`, `system-stop`, `log-cap`, `chat-deleted`, `workspace-change`, `daemonized`, `memory-cap`) |
| `output_paths` | source, mirrored | stdout/stderr files and the status file |
| `origin_turn_id` | supervisor, mirrored | which turn started it; UI and audit |
| `notify` | server | whether a completion may wake (default true) |
| `notice_group`, `notice_message_id`, `notice_state` | server | coalescing and idempotent delivery (§3.3) |
| `last_synced_at` | server | freshness of the mirror |

`starting` is the write-ahead state: the server mints the job id and writes its `job_view` row
before calling `start`, and the supervisor inserts `starting` before spawning. A crash between
spawn and row update is recovered from the wrapper's `pid`/`status.json`; a spawn that never
completed is `failed`, not `lost`.

`lost` is the honest state: a row that was `running` at a server boundary and cannot be matched
to a live group or a status file. It is not `finished`, not `stopped`, and not absent. Replaying
it is what fixes the false negative, and it is the state OpenClaw's law is for: **outcome
unknown; say so; check side effects before re-running; never re-run automatically.**

Recovery is typed per kind, because a generic row invites the wrong default:

| Kind | After a restart |
|---|---|
| `cell` | `lost` — its process died with the kernel, by construction; the server/kernel manager owns the row |
| `command` | the supervisor finds a live group → `running`; a status file → `finished`; neither → `lost` |
| `service` | expected to be running; live → `running`, status file → `finished`, neither → `lost`; never silently restarted |
| `remote` | deferred; the remote-side supervisor and ledger are the authority there |

Job state and kernel state stay separate vocabularies. "cold job" would read as resumable and
is not a thing. The kernel states (live/parked/cold/expired) are described in
[session-python-kernel.md](session-python-kernel.md) and §7; a job's state is its own. L0 maps
the kernel manager's current `running`/`done`/`error` onto the shared vocabulary (`done` →
`finished`; `error` → `finished` with the cell error recorded), so the `jobs` tool has one
surface.

### 3.2 Commands, not cells, are the durable class

- **`bash` gains `background: true` and `service: true`.** A backgrounded bash call is spawned
  by the job supervisor, recorded in `jobs.db`, mirrored into `job_view`, and returns a job id
  and a named output pointer immediately. A service is the same spawn with a long-lived
  policy: readiness polling is allowed, normal continuation never wakes, and an unexpected exit
  does. The schema change, the `jobs` rename, and the `run_python` wording batch into one
  tool-surface release, because each one is a prefix-busting event.
- **Readiness is a first-class call.** `bash(..., service: true, ready_when: "pattern",
  ready_timeout_ms: …)` or a `job_wait_for(job_id, pattern, timeout)` tool asks the supervisor
  `wait_for`, which scans the job's output from the beginning and counts output already written.
  Without a model-level readiness call, the dev-server use case degrades to tail-polling.
- **In-kernel handles are views onto supervisor-owned groups.** `tools.bash(...,
  background=True)` inside a cell asks the supervisor to spawn through the existing reverse-RPC
  channel ([kernel-codemode.md](kernel-codemode.md) §4.8), and gets a handle proxy back.
  `await h`, `h.poll()`, `h.tail(n)`, `h.kill()` operate on a job the supervisor can see,
  record, and reap. The handle API is the *client* of the ledger, not a second bookkeeping
  system. The execution details — pre-minted id, wrapper status file, file-backed output,
  adoption — are in [job-supervisor.md](job-supervisor.md) §6.
- **Ownership rules travel with the handle**: a handle awaited before any other API use owns its
  process group and cancelling that await kills the group; touching `poll`/`tail` first marks it
  a background handle and later awaits only wait. `h = await run(...)` binds only after the await
  returns, so a cell interrupted mid-wait leaves the work addressable by id from the ledger, not
  by name.
- **Bounded await degrades instead of failing**: an inline await past the yield budget returns a
  snapshot carrying the live handle, and must not cancel the inner wait.
- **Caps are enforced where the work is spawned.** The supervisor is the only spawner of durable
  commands, so it owns the per-chat and box-wide caps there; cells keep their existing kernel
  caps. A job outliving a kernel is by definition not visible to any kernel's counter, which is
  exactly why the cap lives at the supervisor. CPU weight becomes available here too: a process
  group can be `nice`d, which a task on the kernel's loop structurally cannot be.
- **Cells stay transient, and say so.** `run_python(background: true)` remains a kernel task
  with kernel lifetime; the tool description and the row's `kind` both state it. Detaching from
  a kernel — TTL eviction, LRU, disposal — should snapshot first, so a cell's *data* still gets
  the cold-restore path.
- **Foreground work is unchanged.** Foreground `bash` stays on the server's process supervisor
  and keeps `withMutationLock('workspace:<label>')` for its duration. Background and service
  jobs escape that lock, exactly like background cells; the tool description says the command
  is a workspace peer. `job_view` records the workspace label for visibility.
- **Output is file-backed.** A durable job never writes to a pipe held by the server or the
  supervisor. The supervisor opens the output files and the wrapper writes `status.json`, so a
  command that finishes while both processes are down still records its outcome.

### 3.3 Completion notices, owned by the server

A job that finished **with its result unread** produces a notice. Reading the result, stopping
the job, or awaiting the handle retires it; an await cut short by an interrupt or a deadline read
nothing, so it leaves the notice owed.

| Consumption channel | Where it is visible | Effect |
|---|---|---|
| `jobs list/status/tail` (today `python_jobs`) | server `job_view` | retires — the server saw the read itself |
| `jobs kill` | server + supervisor | retires; an explicit stop is its own report |
| awaiting a handle inside a cell | kernel only | reported into `job_view` as consumption evidence (a one-way frame, not a withdrawal protocol) |
| a human viewing job output in the UI | server | **retires nothing** — a viewer is not the agent |

Delivery is boundary-shaped, server-driven, and coalesced:

- A busy chat is *refused* and the server retries at the next turn boundary. There is no
  kernel-side or supervisor-side announcer: the server owns the turn gate, chat busy-state,
  pause, and sleep.
- **Append-row and wake-turn are one gated act, recoverable on restart.** A notice parked as a
  tail row for a later user turn can be overtaken by a read and go stale; deciding "still
  unread?" and landing the row in the same act under the per-chat write lock is what makes
  staleness impossible. This is a correctness argument, not a cost argument. `job_view` is in
  `porrima.db` and the notice row in `app.db`, so the act is not one database transaction:
  `notice_state` (`pending|appended|delivered|suppressed`) plus the pre-minted message id make
  recovery idempotent. If the row exists on restart, mark delivered; if it does not, deliver.
- N jobs finishing during one turn produce **one** notice row and at most one wake turn.
  Coalescing is default, not a guard: a notice turn is a fresh prefill, and on this substrate a
  cold prefill is expensive.
- A wake turn takes a **background-priority** turn-gate lease and waits behind existing work.
  The lease carries the wake's own `timeoutMs` as its ceiling, so the gate judges it against that
  budget instead of against silence. The budget is a policy budget of the same class a custom
  automation gets (default 30 minutes, `PORRIMA_JOB_NOTICE_TIMEOUT_MS`); it is deliberately not
  derived from context size or prefill speed, which vary with the model and hardware. If the wake
  does not complete, the notice is not retried and the budget was already spent on the attempt —
  that is what stops a chronically failing chat from re-paying the prefill every tick, and the
  row standing at the tail is what keeps the payload available to the next real turn.
- The payload stays behind the handle: the row announces and points, `jobs tail` and the job's
  output file carry content. This keeps the injected row small enough to be cheap.

Wake eligibility is a property of the job:

| Kind | Wakes on |
|---|---|
| `command` | finish, or a supervisor-enforced stop (timeout, log cap, memory cap), unless `notify: false` |
| `service` | **unexpected exit** (non-zero or zero), or a supervisor-enforced stop — not normal continuation, not an explicit stop |
| `cell` | finish, unless consumed |
| `lost` | once, subject to the wake budget; unknown-outcome wording |
| `remote` | deferred |

The service row is the one a naive policy gets wrong: a dev server that dies at 2am is exactly
what the agent needs to know, while a `stop` the agent asked for is not news. "Notify on
completion, never on continuation" supports this — a crash is a completion.

Row shape, and its obligations to the rest of the system:

- a **display** line for the transcript (`job finished (exit_code=0, ran 1.2s): <command>`) and
  a **model text** row for the agent, both derived from one structured notice payload and one
  pre-created message id so they cannot drift; marker-wrapped, bounded, naming each job's
  outcome, its handle, and the read call that consumes it, plus the anti-noise instruction *in
  the row* (no user sent this; use it if the work needs it, otherwise acknowledge briefly and
  stay idle) rather than in the system prompt, where it would cost prefix bytes on every turn.
- **Extraction and compaction must see a distinct row type.** A notice row is not user speech;
  extracted as such it becomes a false memory about something the user never said, and a summary
  that quotes live process state is a row whose claims rot. No wall-clock durations at replay:
  `duration_ms` is recorded at completion.
- **`system-pause` gates notice turns, not just job starts.** A job finishing during a pause must
  not wake the agent.
- **The supervisor reports; the server decides.** `job_finished`/`job_lost` events update
  `job_view`; the server's notice scheduler coalesces and delivers. The supervisor never writes
  a notice row or calls a turn.

### 3.4 Budgets, visibility, and controls

- **Per-chat wake budget with backoff.** A job the model keeps restarting and keeps failing is a
  notice-turn loop; each one is a fresh prefill. Bound wakes per chat per window, then degrade to
  the teach-only tail row.
- **`jobs` answers from `job_view`**, refreshing live rows from the supervisor on demand (with a
  timeout and a fallback) and from the kernel manager as cells change; L2c adds supervisor events
  for promptness. A supervisor round-trip on every `list` is only safe with a timeout, and
  `job_view` is already the durable view. `tail` reads the output file; `kill` routes to the
  supervisor or the kernel by `source`.
- **The UI is the safety control here, not an enhancement.** Durable background work is a
  persistence primitive: a prompt-injected job now survives the server. So: a chat-header badge
  when a chat has live work (state, count, age), a global **stop all background work** control,
  and per-job state on the stats screen with its process group, unit/supervisor, and output
  paths. Deleting a chat must show what it will stop, and cascade to `job_view` and the groups.
- **System chat.** Jobs started by automations are recorded and noticed in the system chat, not
  delivered as a user-facing wake.
- **Global stop is distinct from pause.** `system-pause` refuses new starts and notice turns;
  `stop_all` (or `systemctl stop porrima-jobs.slice`) kills running work. Both are needed.

### 3.5 What a kernel-bound call does when the kernel dies

Kernel-origin tool dispatchers are built per execute and keyed to a live cell or job
(`agent-tools.ts`, `python-kernel.ts`). When the kernel goes away, an in-flight kernel→host call
has no dispatcher to answer it. **Fail it.** The cell sees an error naming the cause.
Re-dispatching an adopted call means inventing attribution and idempotency for a call whose
origin already vanished — that cost is one of the main reasons adoption is not the default.

## 4. What this shape gives up

Named honestly, because these are the things the alternative buys:

| Given up | Mitigation |
|---|---|
| A live namespace with *running* state preserved across a server restart (a dev-loop kernel that never lost its half-built objects) | snapshot-on-detach: every eviction, disposal, and shutdown path flushes first; the restore notice already reports per-name failures |
| A cell that keeps computing across a restart | impossible in any shape that keeps Python cells as tasks; only commands are durable |
| Kernel-side job bookkeeping surviving a kernel `SIGKILL` | the supervisor's `jobs.db` and the server's `job_view` already record the job, its output, and its state; only in-kernel consumption evidence is lost, and it is a hint, not a queue |
| A kernel that keeps a listening service it started itself | commands are supervisor-spawned instead; `tools.bash(background/service)` is the seam |
| Remote hosts | deferred: local commands first; a remote supervisor/ledger is the same shape one box over |
| A single process to run | a second user service to install, upgrade, monitor, and version; the supervisor is a single point of failure for *new* job control, while running jobs survive its restart |
| One database for everything | `jobs.db` (execution) and `porrima.db`'s `job_view` (read model/notices); the split is what keeps ownership and migrations clean |
| Per-job CPU/memory accounting | the supervisor's `nice` + per-job RSS watchdog + the slice's `MemoryHigh`/`MemoryMax`; per-job scopes are a later refinement |

## 5. Staging — one ladder, shared with kernel-codemode.md

The codemode phases and this ladder are the same sequence, named once:

| Step | Scope | Ships |
|---|---|---|
| **L0 — ledger** | `job_view` schema and cell rows; replay into `job_view` after a restart with explicit `lost` states; output pointers; chat-deletion handling | fixes the false negative for cells today, with no other dependency |
| **L1 — notices** | the unread contract, server-owned owed state, coalesced per batch, boundary delivery retried at turn boundaries, append+wake as one gated act, distinct row type wired through extraction/compaction, pause gating, wake budget | the user-visible win; needs no new process lifetime |
| **L2a — supervisor** | `porrima-jobs.service` + slice; `start`/`stop`/`get`/`list`; wrapper/status files; file-backed output; singleton lock; adoption; `bash background`; `jobs` tool (list/status/tail/kill) over `job_view` | the durable class of work |
| **L2b — services and handles** | `service: true`; readiness (`wait_for`/`ready_when`); caps at the supervisor; `nice`/RSS; in-kernel handles over reverse RPC; bounded await | the dev-server use case and the handle API |
| **L2c — integration** | supervisor events into `job_view`; lost/service-failure notices; global stop; chat deletion/workspace change; stats/UI; CLI | the operational surface |
| **L3 — kernel durability (gated)** | only if §7's measurement says so | transport, placement, adoption |

L0 and L1 are independently valuable and are the recovery path for everything after them. L2a is
the first point where commands are actually durable. L2b depends on L2a; L2c depends on L1 and
L2a. L3 stays gated.

**The measurement gate for L3.** At every server shutdown, record kernel-specific work: `kind=cell`
jobs running, their age, namespace restore fidelity (skipped/pruned names, restore time), and
whether a live kernel would have preserved something the snapshot did not. Exclude
`command`/`service` jobs: L2 makes those durable by design, so their presence at restart says
nothing about whether L3 earns its transport. After a few weeks, if live-at-restart *kernel/cell*
work is rare and short, the snapshot plus a `lost` row is enough; if it is common and long, L3
earns its complexity.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A `lost` row read as "the job failed" | `lost` is a distinct state with its own wording everywhere it surfaces: outcome unknown, check side effects, never re-run automatically |
| A durable job nobody asked for keeps running | caps at the supervisor, the global stop control, the chat badge, chat-deletion `stop_chat`, and supervisor reconciliation (adopt live, reap only unclaimed) |
| The supervisor is down or crash-looping | the server starts normally; background starts fail with a clear notice; running jobs continue; the supervisor's `Restart=always`, singleton lock, and status files bound the damage |
| The supervisor restarts and kills its own jobs | `KillMode=process` + the dedicated slice; adoption from `jobs.db` and `status.json` |
| Notice turns looping on a failing job | per-chat wake budget with backoff to teach-only rows |
| Notice rows extracted as user statements or quoted into summaries | distinct row type, explicit handling in extraction and compaction, recorded durations |
| In-kernel handle and `job_view` disagreeing about state | the supervisor wins for command execution; the server wins for notices; reconcile on connect, never mid-run |
| Protocol skew between server and supervisor | `welcome` advertises the protocol; read paths degrade, `start` refuses with a clear notice; support at least the previous protocol |
| Corrupt `jobs.db` or lost output | integrity check at startup, quarantine rather than guess; `job_view` is the audit fallback; output retention is independent |
| Two supervisors | the singleton lock; two servers are prevented by the server's data-dir instance lock |
| Stale namespace read as fresh (removed packages, dead handles, lost `cwd` after a rebuild) | the manifest carries `savedNames`/`skipped`/`pruned`/`bytes`/`pythonVersion`/`timestamp` and no `cwd`; either record `cwd` or have the restore notice say which case happened |
| Driver version skew across kernel generations | kernels stay ephemeral, so the next spawn stages the current driver; if L3 is pursued, §7's hash gate and park-and-rebuild apply |
| A prompt-injected durable job survives the server | the badge, per-job stats, global stop, chat-deletion confirmation, and `stop_all` are the controls; the supervisor does not add a sandbox |

## 7. Alternative kept open — kernel adoption

If the measurement gate says live-at-restart *kernel* work is common and long, the durable-kernel
design is this, and its prerequisites are load-bearing:

1. **A kernel-side job journal and output capture first.** Today `job_done` and stdout frames go
   to the manager's capture and the server spills. With no owner attached, a parked kernel has
   nowhere to put them. An adoptable kernel needs its own durable job records and bounded output
   files, with the wire demoted to a view. Without this, the adoption inventory is a promise
   nothing can back.
2. **Transport.** A Unix socket in the state dir with the existing line framing, a rotated attach
   token, a single owner with an epoch, and EOF meaning "owner absent" rather than death — with
   a bounded outbound queue so a disconnected owner can never block a job. Socket path length is
   a real constraint (`sun_path` ~108 bytes) for per-chat directories under a long home path.
3. **Placement.** Transient user units under a dedicated slice, with `--collect` so retired units
   do not accumulate, `Restart=no`, explicit `KillMode`, per-unit
   `MemoryHigh`/`MemoryMax`/`TasksMax`, escaped unit names, `XDG_RUNTIME_DIR` handled explicitly,
   stale-socket unlink, and a bounded `is-active` + connect handshake (a queued unit is not an
   accepting socket, so a one-shot fallback path stays). `setsid` is rejected on measurement: it
   detaches the session, not the cgroup, so a child of the service cannot survive
   `systemctl --user stop`. A `KernelPlacement` seam plus a fake-systemd harness is required or
   none of this is testable in CI.
4. **Adoption by identity.** Same state dir, pid alive with matching `start_id` *and* matching
   `boot_id`, driver hash and protocol version compatible, token valid — else snapshot, dispose,
   respawn, restore. A live pid whose start time does not match is a stranger, and signalling it
   is the failure mode the identity checks exist to prevent. Memory: a soft kernel-side threshold
   that interrupts a cell and flushes a snapshot, `MemoryHigh` to throttle, `MemoryMax` as the
   hard backstop — and no promise that the namespace survives a hard OOM, only that it survives
   if the snapshot lands.
5. **Lifecycle semantics to fix first.** Kernels leaving the supervisor journal (or the sweep
   skipping `kernel:*` keys), `SIGTERM` meaning park rather than dispose, a disposal matrix
   (TTL/LRU → snapshot-and-exit; workspace change / chat deletion / protocol failure / explicit
   stop → stop and reap), the owner watchdog disabled in durable mode (its `os.getppid()`
   fallback would point at `--user` systemd), a liveness check added to the state-dir TTL prune
   (the manager deletes past the TTL without one; the driver's own prune already skips live
   kernels), and a maximum driver age so "swap only at an idle boundary" cannot pin an old
   driver behind a dev server forever.
6. **States.** live (attached) / parked (**only when work is running** — an idle detach should
   snapshot and exit, which is the cheap cold path) / cold (snapshot on disk, no process) /
   expired. LRU eviction means detach-and-park, never dispose.

**Substrate already present.** Most of L3 is already built, aimed the other way:

| Mechanism | Where | What it becomes under adoption |
|---|---|---|
| Per-chat state dir, 0700, 14-day TTL | `kernelStateDir`, `KERNEL_STATE_TTL_MS`, driver `_prune_expired_state` | the cold tier, unchanged |
| Namespace snapshot/restore (`namespace.pkl` + `manifest.json`, debounced, capped) | driver snapshot/restore frames; manager `readSnapshotManifest` | the park-and-rebuild path for skew, unchanged |
| Kernel identity: pid + `startId`, legacy cmdline match | driver `_read_pidfile`, `_process_start_id`, `_cmdline_is_driver` | the adopt predicate |
| Per-cell child journal `{pid, pgid, startId, cell, active, recordedAt}`, fsynced | `children.jsonl` | the adoption inventory for live children, and the reap list when adoption fails |
| `Popen` patched to `start_new_session` | driver `_install_popen_patch` | children already outrank the kernel's lifetime; re-adoption needs no new mechanism |
| Driver content hash in `ready`, protocol version check | `_driver_hash()`, `protocolFailure` | the skew gate for adoption vs park-and-rebuild |
| Startup sweep that reaps journaled groups but keeps young state dirs | `sweepKernelJournals()` | adopt-then-reap, with record-level pruning instead of truncation |

**Model-visible consequences.** A durable kernel is a long-lived compute environment, and that
has to be legible or it becomes a source of invisible wrongness. A **resume notice** lands after
adoption or park-and-rebuild, naming the restored namespace (count, notable names, per-name
failures), live jobs, unknown-outcome jobs, the kernel cwd, and the driver generation. With an
eager startup reconcile it is a tail row; a lazy adoption on the first call carries the same
content as a tool-result prefix, never as a mid-turn injection. Staleness is named, not assumed:
`cwd` does not survive a rebuild today (the manifest has no `cwd`), imports may reference removed
packages, and handles to deleted files survive in names. `jobs` gains kernel states
(live/parked/cold/expired) separate from job states, and the driver generation is surfaced so a
capability claim made against an old generation is visible as such.

**Security and product consequences.** A listening kernel is a reachable server: socket 0600 in a
0700 state dir, a rotated attach token, an owner epoch, and no authority implied by a predictable
path. The identity predicate is a safety control, not hygiene. Chat deletion must stop the unit,
reap journaled groups, and remove the state dir; capacity fallback still degrades to one-shot;
the stats surface lists kernel units with state, RSS, and live job counts; and two kernels on one
workspace are a visible condition, not an invisible one.

L3 is independent of the job supervisor. The supervisor makes commands durable; L3 would make
live *kernel/cell* work durable. Do not let the supervisor's success become an argument for L3.

## 8. Open questions

1. **Ledger retention.** Resolved: output files age out after 14 days; terminal `jobs.db` and
   `job_view` rows after 30 days, with the view allowed a longer window. The audit row survives
   the output; `jobs tail` reports expired output.
2. **Does `bash` background auto-trigger on timeout**, or only on an explicit flag? Codex
   auto-backgrounds; `yield_after_ms` is the ergonomic middle ground, and auto-trigger makes a
   surprise handle appear mid-turn.
3. **Service wake policy specifics.** Unexpected exit wakes; does a service that exits 0 after
   running for days also wake? (Yes, if it was not explicitly stopped — it is gone.) What is the
   default `notify` for a service started during an automation run?
4. **Per-chat wake budget numbers**, and what teach-only mode actually says.
5. **Global stop**: one control, or per-chat only plus a stats-screen action? The slice stop is
   the operator's path; the UI needs a graceful path.
6. **`wait_for` scope**: per-job output only, or a shared watch over files/logs a service writes
   outside its own stdout?
7. **Does the kernel report in-kernel consumption eagerly (a frame at await time) or only in its
   inventory at attach?** Eager is cheap and keeps `job_view` complete; lazy loses nothing except
   precision about a job the server already thinks is unread.
8. **Chat deletion**: reap the groups and mark rows `lost`, or reap and delete the rows? The
   audit argument says keep the rows; storage says prune them on the same schedule as the output
   store.
9. **Service cap and per-job accounting.** The existing 4/8 caps are for kernel cells; commands
   need a comparable host-wide cap, and services likely need a smaller one. Per-job scopes would
   give memory accounting at the cost of systemd churn.
10. **Remote commands.** Defer; a remote supervisor/ledger is a separate deployment. Do not list
    `kind=remote` as supported until it exists.

## 9. Sources

Prior art:

- prime-agent: `crates/pa-daemon` (sessions and jobs belong to the daemon; the engine is a
  client), `crates/pa-core/src/session_engine/bash_notices.rs` (queued `bash.completed` after
  the creating cell's barrier, `bash.consumed` withdrawing a queued notice,
  `queueIfBusy`/`resumeIfIdle`), `crates/pa-daemon/src/bash_notices.rs` (queue-lane sinks),
  `crates/pa-core/src/prompts/layers/bash-over-subprocess.md`,
  `prime-agent-runtime/src/rlm/bash.py` (handle ownership, bounded await, `_reap_group`)
- opencode: `packages/core/src/job.ts` (job registry, pre-minted notification id, typed recovery
  records), `packages/core/src/session/inbox.ts` (`delivery: "steer"`, pending-only inbox),
  `packages/core/src/session/execution.ts`, `packages/core/src/session/execution/restart.ts`
  (startup replay; restart notices deliberately do not revive idle sessions),
  `packages/core/src/tool/plugin/shell.ts`, `packages/core/src/session/runner/llm.ts` (inbox drain
  at the step boundary)
- albedo (`tangled.org/okami.mom/albedo`): `priv/python/albedo_plugins/run.py` (`owed`, one
  announcer, retry-until-idle, one notice per batch, `service`, bounded await that snapshots
  instead of failing), `priv/python/albedo_cells.py` (cell auto-background under the same
  contract), `priv/python/albedo_shell.py` (refusals that name the `run()` call the line means —
  "guidance, not a sandbox: libraries and plugins still spawn"), `priv/python/albedo_output.py`
  (retention caps and listable inventories), `priv/python/albedo_link.py` + `albedo_bridge.py`
  (detached kernel, durable seq/ack outbox, reattach with backoff),
  `src/albedo/daemon/albedo_wakes.erl` (session → submit closure registry, loader that starts an
  idle session so an owed wake can land), `src/albedo/daemon/turn.gleam`,
  `src/albedo/daemon/session.gleam`, `robot-docs/kernel.md`, `robot-docs/kernel-state.md`
- Jupyter / IPython kernel management: connection files, heartbeat ports, and the
  gateway-kernel liveness model (the closest existing answer to attach/auth/liveness, and the
  shape §7 would be imitating)
- OpenClaw: docs.openclaw.ai/gateway/background-process (completion turn in the originating
  session, waits behind existing work, one unknown-outcome completion turn after a gateway
  restart, no notice on explicit stop)
- Claude Code: `TaskOutput`/`KillShell` retired in favour of `Read` on a named output file;
  `Monitor` for event streams — the output pointer as the primitive (corroborated, not read at
  source)
- Codex: `codex-rs/core/src/unified_exec/mod.rs` (process caps),
  `core/src/tools/code_mode/wait_spec.rs` (pull semantics with no wake anywhere in the family)

Porrima: [job-supervisor.md](job-supervisor.md) (the durable process plane and its protocol),
[session-python-kernel.md](session-python-kernel.md) (§4.1 lifetime, §4.7 background jobs, §4.8
snapshot/restore, §4.11 lifecycle and the startup sweep, §8.3 the wake question),
[kernel-codemode.md](kernel-codemode.md) (§2.6 families, §4.5 handles and notices),
[pi-1.0-migration.md](pi-1.0-migration.md) §3 (the server's process supervisor and
`killAllSupervised`), [remote-python-kernel.md](remote-python-kernel.md).