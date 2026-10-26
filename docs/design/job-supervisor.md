# Job Supervisor — The Durable Process Plane

Scope: the long-lived user service that owns durable background commands and services, its
ledger and protocol, and how the server uses it. Companion documents:
[kernel-durability.md](kernel-durability.md) (the job ledger, command jobs, and completion
notices), [kernel-codemode.md](kernel-codemode.md) §4.5 (handles),
[session-python-kernel.md](session-python-kernel.md) (the ephemeral kernel),
[pi-1.0-migration.md](pi-1.0-migration.md) §3 (the server's process supervisor).

**Position.** Durable background work is a host-side command executed by a dedicated job
supervisor service. The supervisor is a separate systemd user unit in its own slice, with its
own SQLite ledger and output store; the server is a client. The Python kernel stays ephemeral:
its namespace is durable through snapshot/restore, its background cells are transient. The
supervisor is process-shaped, not session-shaped — it knows jobs, not chats, turns, or notices.

## 1. Why a separate service

The server's `process-supervisor.ts` cannot be the durable owner. A child spawned by
`spawnSupervised` inherits `porrima.service`'s cgroup; `detached`/`setsid` changes the session,
not the cgroup. The unit runs with `KillMode=control-group` (the systemd default, and the
shipped unit), so `systemctl --user restart porrima` kills every process in the cgroup,
including a "detached" command. Fixing `killAllSupervised()` is necessary but not sufficient:
the command is still in the server's cgroup.

Three placements were considered:

| Placement | How it works | Verdict |
|---|---|---|
| Per-job transient units | `systemd-run --user --unit=porrima-job-<id> ...`; one unit per command | Works, but one systemd object per command; the server parses unit state; caps, global stop, and accounting are spread across units; unit churn for frequent commands |
| **Dedicated job supervisor** | One `porrima-jobs.service` in `porrima-jobs.slice` owns spawn, reaping, output, and the execution ledger | **Chosen** — one adoption protocol, one cap owner, one global stop, one place for exit status; matches prime-agent's daemon shape |
| `KillMode=process` on `porrima.service` | Keep the child-of-server supervisor, stop signalling the cgroup | Rejected — leaves every other child (kernels, TTS, SSH masters) alive on stop; `systemctl stop` semantics become murky; cleanup relies on journals |

The supervisor is not a general process supervisor. Foreground `bash`, Python kernels, TTS
workers, and SSH masters stay with the server's process supervisor. The daemon owns only
durable background commands and services.

## 2. Component boundary

| The supervisor owns | The server owns |
|---|---|
| Spawning and killing process groups | Chats, turns, transcripts |
| Output files and per-job status | Notice state, coalescing, wake turns |
| `jobs.db` — authoritative execution rows | `job_view` — unified read model (cells + commands) |
| Per-chat and box-wide caps, `nice`, RSS watchdog | Kernel cells and their lifecycle |
| Global stop and adopted-process reconciliation | Chat deletion, workspace-change decisions |
| A socket, a CLI, and supervisor health | The UI, stats, pause gating, push |

One supervisor per user/data dir. It accepts multiple local clients — the server, the CLI, and
diagnostics — but it is a singleton; a lock prevents a second daemon. The server is the only
client that starts jobs from turns. The daemon never reads chat transcripts, calls the LLM, or
writes notice rows.

## 3. Unit, slice, and lifecycle

The supervisor is `porrima-jobs.service`, in `porrima-jobs.slice`:

```ini
[Unit]
Description=Porrima Job Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PORRIMA_DIR}/server
Environment=NODE_ENV=production
ExecStart=${NODE_BIN} dist/jobs-daemon.js
Restart=always
RestartSec=2
TimeoutStopSec=5
KillMode=process
Slice=porrima-jobs.slice

[Install]
WantedBy=default.target
```

`porrima-jobs.slice` carries the box-wide backstop:

```ini
[Unit]
Description=Porrima background jobs

[Slice]
MemoryHigh=…
MemoryMax=…
TasksMax=…
```

`KillMode=process` is load-bearing. It means systemd signals only the daemon's main process,
not the cgroup, so a supervisor restart does not kill its jobs. The slice gives the deliberate
full-stop control without making every restart destructive. The installer ships the slice unit
alongside the service; `Slice=` alone would create an implicit slice with no caps.

The server unit gains `Wants=porrima-jobs.service` and `After=porrima-jobs.service`. It must
not use `Requires=` or `PartOf=`: the server starts and serves normally when the supervisor is
unavailable, with background jobs degraded.

| Action | Result |
|---|---|
| `systemctl restart porrima` | Jobs unaffected |
| `systemctl restart porrima-jobs` | Daemon restarts; jobs survive; the new daemon adopts |
| `systemctl stop porrima-jobs.service` | Daemon stops; jobs survive |
| `systemctl stop porrima-jobs.slice` | Full stop of the job plane (daemon + jobs) |
| UI "stop all" → `stop_all` | Kills jobs, leaves the daemon running |
| Server crash / SIGKILL | Jobs unaffected |
| Reboot | No jobs; `running` rows become `lost` unless a status file records completion |

The `stop porrima-jobs.service` behavior is deliberate: stopping the control plane is not
stopping the work. A full stop is the slice, a `stop_all` RPC, or the CLI's `stop-all`.
Operators need one documented way to do each.

The user manager must linger (`loginctl enable-linger`) if the server and supervisor run
without an active login session; Porrima already requires this for `porrima.service`.

Socket path: `$XDG_RUNTIME_DIR/porrima/jobs.sock`, falling back to `~/.porrima/jobs.sock`.
When `PORRIMA_DATA_DIR` is explicitly set, the socket lives at `$PORRIMA_DATA_DIR/jobs.sock`
instead, so a dev data directory cannot reach the production supervisor. The runtime path
keeps the Unix socket well under `sun_path`'s ~108-byte limit and is cleaned up by the session
manager; the fallback keeps the daemon usable in environments without `XDG_RUNTIME_DIR`.

## 4. Storage

The supervisor owns its execution ledger; the server owns the unified read model and notices.
They are deliberately separate databases.

**Supervisor `~/.porrima/jobs.db`** (SQLite, WAL) is authoritative for command/service
execution:

```sql
jobs(
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- command | service
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,             -- starting | running | finished | stopped | lost | failed
  pid INTEGER, pgid INTEGER, start_id TEXT, boot_id TEXT,
  exit_code INTEGER, signal TEXT, stop_reason TEXT,
  started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  stdout_path TEXT, stderr_path TEXT, status_path TEXT,
  origin_turn_id TEXT,
  outputs_pruned_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, event TEXT, at TEXT, payload TEXT);
meta(key TEXT PRIMARY KEY, value TEXT);
```

**Server `porrima.db` → `job_view`** is the unified read model for the `jobs` tool, the UI,
notices, and the fallback when the supervisor is down:

```sql
job_view(
  job_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  workspace TEXT,
  kind TEXT NOT NULL,              -- cell | command | service | remote
  source TEXT NOT NULL,            -- kernel | supervisor
  command TEXT,
  cwd TEXT,
  pid INTEGER, pgid INTEGER, start_id TEXT, boot_id TEXT,
  state TEXT NOT NULL,             -- starting | running | finished | stopped | lost | failed
  exit_code INTEGER, signal TEXT, stop_reason TEXT,
  started_at TEXT, ended_at TEXT, duration_ms INTEGER,
  output_paths TEXT,
  origin_turn_id TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  notice_group TEXT, notice_message_id TEXT,
  notice_state TEXT,               -- none | pending | appended | delivered | suppressed
  last_synced_at TEXT
);
```

Ownership rules:

- The supervisor wins for command/service execution state; the server wins for notice state.
- `lost` and `failed` are uncertainty/server-side start states, not execution outcomes. An
  authoritative supervisor list or `get` may correct them to `running`/`finished`; `finished`
  and `stopped` never regress to a non-terminal state from an event. Correcting a row to a live
  state also withdraws a notice that is still `pending` for it — the notice claims the outcome
  is unknown, and the view no longer believes that. A notice already `appended` stays as the
  record it truthfully was when it was written.
- Cell rows are written by the server's kernel manager (`source="kernel"`); the supervisor
  never sees them.
- On conflict, `job_view` is a mirror, not a second authority. The server reconciles from the
  supervisor on connect and on startup; it never edits `jobs.db`.
- If the supervisor is down, `job_view` still answers list/status from the last sync and says
  "supervisor unavailable" for rows that were running.
- `chat_id` is not a database cascade. Deleting a chat sends `stop_chat`, reaps the groups, and
  marks the rows `stopped` (or `lost` if the group cannot be confirmed) with a `chat_deleted`
  flag; the rows are pruned on the same schedule as the output store.
- The supervisor's database is small and its transitions are fsynced
  (`synchronous=FULL` for start/finish; `NORMAL` is acceptable for events). An integrity check
  at startup refuses to guess: a corrupt ledger is quarantined and the server is told, not
  silently marked all-lost.

Output lives beside the ledger, one directory per job:

```
~/.porrima/jobs/<chatId>/<jobId>/
  stdout.log
  stderr.log
  status.json
  pid
  start_id
  boot_id
  command.txt
```

The model-facing tail stays bounded (the existing output window); the durable file may be
larger. Output files are removed after 14 days; terminal `jobs.db` rows are kept for 30 days,
and the server's `job_view` rows use the same record clock (optionally longer). Sweeps run on
supervisor start and daily; they touch terminal rows only and protect live, adopted, and
journal-held groups. A deleted chat drops its output tree once no live group or journal hold
remains, while its ledger rows age out normally. A row whose output has aged out still reports
state; `jobs tail` says the output expired rather than pretending the job is unknown.
`PORRIMA_JOBS_OUTPUT_RETENTION_DAYS` and `PORRIMA_JOBS_RECORD_RETENTION_DAYS` override the
supervisor windows; `PORRIMA_JOB_VIEW_RETENTION_DAYS` may extend the server view independently.

Alongside `jobs.db`, the supervisor keeps an append-only
`~/.porrima/jobs/journal.jsonl` (`{version, job_id, pid, pgid, start_id, boot_id, active,
recordedAt}`), fsynced on spawn and on confirmed group death. It exists for the same reason the
server's supervisor journal does: a crash can leave a live group whose row was never updated or
whose database write was lost. The active record is appended immediately after the spawn, before
the ledger row is marked running, so the record exists before the write it is meant to cover. The
job directory's own `pid`/`start_id`/`boot_id` files (written by the wrapper) are a second path
back for the same window. The journal is pruned per record on confirmed group death, never
truncated as a whole, because an adopted record must survive the next restart.

## 5. Protocol

Newline-delimited JSON over the Unix socket, one object per line, request ids echoed. Frames
are small — output never crosses the socket.

Handshake:

- `hello {protocol, client}` → `welcome {protocol, pid, start_id, boot_id, started_at, version, capabilities}`.
- A protocol mismatch is reported to the server as a degraded supervisor, not a crash. The
  server should support at least the previous protocol for `list`, `get`, and `stop`.

Requests:

| Request | Fields | Reply |
|---|---|---|
| `start` | `{job_id, chat_id, kind, command, cwd, env, timeout_ms, origin_turn_id}` | `started {job_id, pid, pgid, start_id, boot_id, stdout_path, stderr_path, started_at}` |
| `stop` | `{job_id, force?}` | `stopped {job_id, state, stop_reason}` |
| `get` | `{job_id}` | `job {job}` |
| `list` | `{chat_id?, states?, limit?}` | `jobs {jobs}` |
| `wait_for` | `{job_id, pattern, timeout_ms}` | `waited {matched, line, finished}` |
| `stats` | `{}` | `stats {supervisor}` |
| `stop_chat` | `{chat_id}` | `stopped_all {count}` |
| `stop_all` | `{}` | `stopped_all {count}` |
| `subscribe` | `{since_seq}` | stream of `event {seq, event, job}` |

`start` is idempotent by the server-minted `job_id`: a retry returns the existing row instead
of spawning twice. If the start response is lost, the server resolves the id with `get`: a found
job is mirrored, absence is a start failure, and a failed lookup leaves the row `lost`/unknown
rather than fabricating a failure. `stop` is idempotent. `wait_for` scans the job's output from
the beginning (bounded to the retained window), counts output already written, and returns
`finished` if the job ends before a match; `pattern` is a literal substring by default, with a
regex option addable later without changing the request shape. This is the readiness primitive
for services.

Events (`job_started`, `job_finished`, `job_stopped`, `job_lost`) carry a durable `seq`. On
connect — at startup and on every later reconnect — the server reconciles from a `list`
restricted to the live states, then subscribes from the current sequence. A long event backlog
is not the correctness mechanism: `list` is truth, events are promptness. The event log is
pruned aggressively.

The server's client connects lazily, retries with backoff, and degrades cleanly. A background
start while the supervisor is unavailable fails with a clear error; the server does not fall
back to a non-durable child, because that would make durability unpredictable.

## 6. Execution

- **Write-ahead.** The server mints `job_id`, writes its `job_view` row as `starting`, and calls
  `start`. The supervisor inserts `starting`, spawns the wrapper, records `pid`/`pgid`/
  `start_id`/`boot_id`, then flips to `running`. If the supervisor is unavailable or the spawn
  fails, the server marks the row `failed`; a row left `starting` means the supervisor may have
  spawned and the reconcile path must decide.
- **Wrapper and status file.** The wrapper writes `pid`, `start_id`, and `boot_id` before
  running the command, waits for it, and writes `status.json` atomically (`exit_code`,
  `signal`, `started_at`, `ended_at`, `duration_ms`) before exiting. If the supervisor and the
  server are both down when the command finishes, the status file still records the outcome.
  `lost` is reserved for a group that vanished without a status file. A `lost` row is not
  final: when its status file appears later, the row settles to the outcome the file records,
  and the earlier uncertainty survives in `stop_reason` rather than being erased.
- **File-backed stdio.** The supervisor opens `stdout.log` and `stderr.log` and passes the file
  descriptors to the child (`stdio: ["ignore", stdoutFd, stderrFd]`), with `detached: true`.
  Output must never be a pipe back to the supervisor or the server: a detached command writing
  to a dead pipe can die on SIGPIPE, which would defeat the durability claim.
- **Identity and completion.** `pid`, `pgid`, `start_id`, `boot_id`. Own children resolve on
  exit plus a short stdio grace; adopted children are polled for group liveness and the status
  file. Completion is the wrapper's status plus group-empty. If the wrapper exits but the group
  still has members, the supervisor kills the leftovers and records `stop_reason=daemonized`.
  Services must run in the foreground; a service that backgrounds itself is a user error.
- **Services do not auto-restart.** A service that exits is `finished` or `lost`; the agent
  decides whether to restart it. The UI and the completion notice report the exit.
- **Caps at the spawn site.** Per-chat and box-wide caps are enforced by the supervisor, which
  is the only spawner. Cells keep their existing kernel caps. Services get a separate cap
  because they are long-lived. Rejections name the running jobs and the stop/read escapes.
- **Lifetime.** A background command's `timeout` is a hard maximum, set above the foreground
  ceiling; a service has no completion timeout and runs until stopped, the slice stops, or a
  configured maximum age is reached. The tool result states which policy applied.
- **CPU and memory.** Jobs are `nice`d (default +10) so background work yields to the CPU-only
  inference services. A per-job RSS watchdog terminates the offender before the slice's
  `MemoryMax` becomes the OOM backstop. Per-job cgroup accounting is a later refinement; the
  slice is the box-wide bound.
- **Output caps.** The combined stdout+stderr budget is 64 MiB per job, overridable with
  `PORRIMA_JOBS_MAX_OUTPUT_BYTES`. The supervisor checks live jobs once a second; reaching the
  cap stops the group and records `stop_reason=log-cap`. The files keep their tails within the
  budget rather than growing past it. A job that exits between checks is checked and trimmed
  on completion; a job that crosses the cap while the supervisor is down is checked and trimmed
  when recovery settles its status. The cap is therefore soft during supervisor downtime until
  recovery. The model-facing tail is a separate, smaller window. A service that logs without
  bound should be run with its own logging destination, not the job's stdout.
- **Environment and cwd.** The server passes the resolved `cwd` and the same environment the
  foreground `bash` tool uses (including `BASH_ENV_HARDENING`), so a background command behaves
  like the foreground one. The supervisor validates the cwd before spawning.
- **Workspace mutation lock.** Foreground `bash` keeps `withMutationLock('workspace:<label>')`.
  Background and service jobs escape it, exactly like background cells; the tool description
  says the kernel/command is a workspace peer. The ledger records the workspace label for
  visibility.

## 7. Reconciliation and failure modes

On supervisor start:

1. Acquire the singleton lock (`jobs.lock` with pid/start_id/boot_id); a live matching lock
   means another daemon is running.
2. Open `jobs.db`, run migrations, integrity-check.
3. For every `starting`/`running` row: if `boot_id` differs, the row is from a previous boot
   and becomes `lost` unless its status file says it finished. Otherwise find the group by
   `pid`/`pgid`/`start_id`; adopt if alive and matching; read `status.json` if present; mark
   `finished` or `lost`.
4. Reap journal groups with no ledger row, and only where the record's `start_id` matches the
   live process. A record whose start time cannot be confirmed is not evidence that the group is
   the supervisor's to kill.
5. Start the retention sweep: old output directories, terminal ledger rows, and orphaned
   directories. The same sweep repeats daily.
6. Start the output-cap watch: live stdout/stderr sizes are checked once a second.
7. Bind the socket, emit `welcome`, serve.

Adoption matrix:

| Ledger | Group | Action |
|---|---|---|
| `starting` | live | adopt → `running` |
| `starting` | none | `failed` (spawn did not complete) |
| `running` | live, identity matches | adopt |
| `running` | none, status file says finished | `finished` |
| `running` | none, no status file | `lost` |
| `running` | live, identity mismatch | do not signal; `lost`, leave the stranger alone |
| `finished`/`stopped` | live | stale; kill and reap |
| no row | live | orphan; reap |

Lifecycle behavior:

- `SIGTERM`: stop accepting `start`, flush, exit without killing jobs. `KillMode=process`
  leaves them; the next daemon adopts.
- `SIGKILL`/crash: children survive; the DB, journal, and status files recover; systemd
  restarts the daemon.
- An unconfirmed stop or daemonized-group kill marks the row `lost` and keeps its journal record
  active. Recovery retries the reap with the recorded identity; the group is never reported as
  `stopped`/`finished` while it may still be alive. Such a row stays held and re-observed: when
  its status file appears and the group is gone, the row settles to the recorded outcome; when
  the group is gone with no status file, `lost` stands and the hold is released; when the wrapper
  ended but the group outlived it, the group is ended and the row settles as `daemonized`. A
  supervisor restart settles `lost` rows that have status files before reaping decides anything.
- Upgrade: restart the daemon; it adopts; the server reconnects and reconciles. Restart the
  daemon before the server so the new server sees an adopting supervisor, not a gap.
- Two daemons: the singleton lock. Two *servers* over one data directory are prevented by the
  server's own instance lock: `~/.porrima/server.lock` holds pid, process start identity, and
  boot id, claimed at startup and released on shutdown. A live holder makes a second server
  refuse to start and names it; a lock left by a crash, a recycled pid, or another boot is
  reclaimed. `PORRIMA_DATA_DIR_LOCK=0` opts out. The supervisor can serve only one server by
  convention.
- Stale socket: unlink after the lock and identity check.
- Corrupt DB: refuse to guess; quarantine and report degraded.
- Protocol skew: `welcome` advertises the protocol; the server degrades read-only paths and
  refuses `start` with a clear notice.

On server start:

0. Claim the data directory (`~/.porrima/server.lock`). Another live server holding it makes
   this one refuse to start rather than share the chats, the scheduler, the kernels, and the
   supervisor client.
1. Connect to the supervisor and `list` its live jobs. If the supervisor is unavailable, do
   **not** mark `job_view` rows `lost`; leave the last known state and report "supervisor
   unavailable."
2. Reconcile `job_view` against that list. Live rows are bounded by the supervisor's caps, so a
   list restricted to `starting`/`running` is complete, while a window over every state is not —
   a service older than a few hundred short commands would fall off the page. A live view row the
   list did not mention is asked about by id: a row the supervisor reports (usually a terminal
   state reached while the server was away) is mirrored, a row the supervisor does not have becomes
   `lost`, and a lookup that failed leaves the row alone. A bounded, rotating set of recent
   `lost`/`failed` rows is also asked about by id, so a start-timeout row that actually ran can be
   corrected to its real outcome. Each probe is recorded, a row is not re-asked until its recheck
   interval elapses, and uncertainty older than the probe horizon is left for an explicit
   `jobs status`; absence or a failed lookup leaves the uncertainty in place.
3. Stop jobs whose chat no longer exists (on startup and on each reconnect).
4. Deliver `lost`/`finished` notices for unread work (§3.3 of kernel-durability.md).

## 8. Server integration

- `jobs-client.ts` is the only server-side client. It connects lazily, retries, and exposes
  `start/stop/stopChat/stopAll/get/list/waitFor/stats`.
- `bash background: true` and `service: true` call the supervisor. Foreground `bash` stays on
  the server's `process-supervisor`.
- `python_jobs` becomes `jobs` (or keeps its name as an alias for one release). It merges
  `job_view` rows from the supervisor and the kernel manager: `list`, `status`, `tail`,
  `kill`, `wait_for`. `tail` reads the output file (server-local path for local jobs; the
  workspace adapter for remote jobs, when that exists). `kill` routes by `source`; `force`
  means "skip grace" for a supervisor job and "L3" for a kernel job, and the result text says
  which.
- `run_python(background: true)` remains a transient cell. The description says so and points
  long-lived work at `bash background`/`service`.
- Notices: supervisor event → `job_view` → the server's notice scheduler → boundary
  delivery. The supervisor never decides whether a notice is owed.
- Chat deletion / workspace change: `stop_chat` / `stop` before the transcript or project is
  removed. The UI says what will be stopped.
- Global stop: the UI and CLI call `stop_all`; `systemctl stop porrima-jobs.slice` is the
  operator's nuclear option.
- System chat: jobs started by automations are recorded and noticed in the system chat, not
  delivered as a user-facing wake.

## 9. Security and observability

- Same user, same permissions as `bash`; no sandbox is introduced. Socket 0600 inside a 0700
  directory; DB and output 0600/0700.
- The supervisor socket is a reachable control plane for the same user. The trust boundary is
  unchanged: a process that can read the data dir already has the user's authority.
- Durable background work is a persistence primitive: a prompt-injected job now survives the
  server. The chat badge, per-job stats, global stop, and chat-deletion confirmation are safety
  controls, not decoration.
- Background jobs inherit the server's environment, including secrets, exactly as foreground
  `bash` does. Document it; do not pretend the supervisor narrows the environment.
- Logs go to `journalctl --user -u porrima-jobs`; output belongs in the job files. The
  supervisor logs spawn, adopt, finish, stop, lost, reconcile, and protocol errors.
- `/api/jobs/stats` (server route) exposes supervisor uptime/protocol, job counts, caps, DB
  and output sizes, last reconcile, and last error. The system stats bar can show a compact
  "jobs: N running, M services" line.

## 10. Staging and tests

| Step | Scope |
|---|---|
| **L2a** | Supervisor skeleton; unit + slice + `KillMode=process`; `start`/`stop`/`get`/`list`; wrapper and status files; file-backed output; singleton lock; adoption; local commands only; `jobs` tool (list/status/tail/kill) |
| **L2b** | Services; `wait_for`; caps; `nice`; RSS watchdog; `ready_when`; in-kernel handles over reverse RPC |
| **L2c** | Events and notice integration; global stop; chat deletion/workspace change; stats/UI; CLI; remote deferral |

L0 (the ledger/read model) and L1 (notices) ship before the supervisor and remain the recovery
path. L3 (kernel adoption) stays gated on the measurement described in
[kernel-durability.md](kernel-durability.md) §5.

Tests that matter:

- Start a command, `SIGKILL` the supervisor, restart it, verify adoption and output.
- Start a command, `SIGTERM` the server, restart it, verify the job is still visible.
- Kill the supervisor and server while a command runs; verify the wrapper's status file makes
  it `finished`, not `lost`.
- Reboot simulation: no group, no status file → `lost`, with the unknown-outcome wording.
- Idempotent `start` retries; duplicate `job_id`; capacity rejection; stop/force; log cap.
- Protocol skew: old server against new supervisor; new server against old supervisor.
- The systemd behavior (`KillMode=process`, slice stop) is a deployment checklist, not a unit
  test; the process-level adoption tests run without systemd.

## 11. Open questions

1. **Service cap.** The existing 4-per-chat / 8-box-wide cap is for kernel cells. Commands need
   a comparable host-wide cap, and services probably need a smaller separate one (e.g., two per
   chat / four box-wide).
2. **Per-job cgroup accounting.** The slice is the L2 bound; per-job scopes would give
   per-job memory and CPU accounting at the cost of systemd churn.
3. **Remote jobs.** `bash background` on an SSH workspace needs a remote supervisor, a remote
   ledger, and a remote sweep. Defer it; return "unsupported" until that exists.
4. **Tool name.** `jobs` is the clean name; `python_jobs` is the current name. The rename is a
   schema/description event, so batch it with L2.
5. **Protocol compatibility.** How many server/supervisor version pairs must interoperate?
   At minimum, the previous protocol for `list`/`get`/`stop`.
6. **Service log destination.** The job's stdout is a bounded file; a service that needs
   unbounded logs should point at its own log file. `wait_for` watches the job output only
   unless a shared file watch is added.

## 12. Sources

- prime-agent: `crates/pa-daemon` (a long-lived daemon owns sessions and jobs; the engine is a
  client), `crates/pa-core/src/session_engine/bash_notices.rs` (queued completion notices,
  `bash.consumed`, `queueIfBusy`/`resumeIfIdle`), `prime-agent-runtime/src/rlm/bash.py`
  (handle ownership, bounded await, group reaping).
- albedo (`tangled.org/okami.mom/albedo`): `priv/python/albedo_link.py` +
  `albedo_bridge.py` (detached kernel, durable seq/ack outbox, reattach with backoff);
  `priv/python/albedo_plugins/run.py` (`owed`, one announcer, retry-until-idle, `service`).
- systemd: `systemd.exec(5)` (`KillMode=`, `RuntimeMaxSec=`), `systemd.slice(5)` (slice
  accounting), `systemd-run(1)` (transient units, considered and rejected as the L2 default).
- Porrima: [kernel-durability.md](kernel-durability.md),
  [kernel-codemode.md](kernel-codemode.md) §4.5,
  [session-python-kernel.md](session-python-kernel.md),
  [pi-1.0-migration.md](pi-1.0-migration.md) §3.