# Remote Python Kernel (P4): Session Kernels over SSH

**Status**: P4a + P4b IMPLEMENTED + LIVE-VERIFIED (2026-10-08) — ships dark behind `PORRIMA_REMOTE_KERNEL=1`: `KernelHost` seam, ssh transport spawn, driver staging + `ready.driver` skew check, host-side state ops, driver boot self-heal (pidfile guard, stale-journal reap, sibling expiry), shutdown-order fix, tool routing + notices; **P4b**: background jobs run in the host kernel and their full output is delivered into the remote workspace (`.porrima-tool-output/py-<job8>.txt`, workspace-relative footer, 8 MB delivery cap) — the P4a foreground-demote notice is gone. Live checklist: 18/18 on Iapetus (all of the above, plus a 1.5 MB job delivered and verified). Default-on awaits an explicit call (one KV re-prefill + the tool-description flip at the same deploy). P4c (venv provisioning, per-host caps) remains design. **Revised 10-09**: the pidfile predecessor kill is now identity-verified — the pidfile carries the driver's start id (`{"pid":, "startId":}`), a live pid whose start time mismatches is a **recycled pid and is spared**, and legacy bare-pid files fall back to a cmdline match against the staged driver path (review finding: the 10-08 kill was liveness-only and would have TERM/SIGKILL'd a recycled same-user process; two regression tests added).
**Live-verified**: 10-08 — Iapetus (`asa@100.109.184.88`, project root `/home/asa/code/asa.engineer`) via `server/src/scripts/smoke-remote-kernel.ts` (the automated §5.1 checklist): first cell 335 ms warm (825 ms cold incl. staging), cwd/staging-hash/host-pidfile/streaming all correct; L1 interrupt settled with the namespace intact; debounced snapshot landed on the host; **force-dispose → remote kernel reaped in < 1 s** (channel close, §3.3 teardown confirmed live); respawn restored `smoke_answer` with the restore notice; `removeState` deleted the host dir. One finding, fixed same day: `process-supervisor.ts` `delay()` was unref'd, so a bare CLI whose only ref'd handle (the child) died mid-ladder exited silently inside `killGroupAndConfirm`'s poll — the kill ladder's confirmation timers are now refed. **P4b** re-ran the same checklist with three added checks green (job ack, workspace-relative footer, delivered-byte verification): a `background: true` cell printed 1.5 MB, finished outside the turn, and its spill landed at `/home/asa/code/asa.engineer/.porrima-tool-output/py-<job8>.txt` on Iapetus — footer readable by `read_file`, `wc -c` confirmed 1 500 001 B, cleanup removed it.
**Date**: 2026-10-08
**Related**: [session-python-kernel.md](session-python-kernel.md) — the parent design. This doc implements its P4 phase; §4.10 is the seed spec, and all cross-references below to "parent §N" point into that doc unless stated otherwise. Consumes the shared process supervisor (`process-supervisor.ts`, [pi-1.0-migration.md](pi-1.0-migration.md) §3) exactly as the local kernel does.
**Verified against**: `python-kernel.ts`, `porrima_kernel.py`, `workspace.ts` (`SshWorkspaceAdapter`), `agent-tools.ts` (post system-chat flip, commit `a635788`), `index.ts` shutdown order.

## 1. Problem

Chats whose workspace resolves to an SSH project (`SshWorkspaceAdapter`, `workspace.ts:562`) run `run_python` per call: `python3 -` fed the code on stdin through a multiplexed `ssh` exec, killed at the 300 s clamp (`workspace.ts:977-985`). The kernel path is gated off by `useKernel = workspace.kind === "local"` (`agent-tools.ts`), and the tool description tells the model "Falls back to stateless on remote machines."

Consequences — the parent's §1 list verbatim, still live for remote chats, plus one regression the parent doc did not note:

1. No iteration: every call re-imports, re-reads, re-computes on the remote host.
2. Nothing survives a failure or timeout.
3. Long work holds the global turn-gate lease for its full duration — there is no `background: true` escape (`[background unavailable in stateless mode; ran synchronously]` notice).
4. One-shot output: `wrapResult` truncation with no spill (the spill path in `workspace.runPython` opts is consumed only by the local adapter's supervisor capture).
5. **No streaming either**: the SSH adapter's `bash(args, signal, _opts)` and `runPython` ignore the options argument entirely (`workspace.ts:954`, `:977`), so remote tool cards show nothing in flight even though the P2.5 seam exists. The local kernel gives this back for free once the transport is wired.

Remote SSH kernels were deferred to "phase 4" with the rationale "per-call SSH already works and the lifecycle is the hard part" (parent §4.10). The central finding of this doc: **most of the lifecycle problem was solved by P1–P3 without anyone noticing** — the mechanisms that make a server-owned kernel safe are connection-shaped, not process-shaped (§3). What remains genuinely remote-specific is transport plumbing, staging, and state-directory placement (§4).

## 2. What the parent already committed to

From parent §2.3, §4.1, §4.10, §5:

- **Adopt, unchanged**: same driver (`porrima_kernel.py`) and JSON-lines protocol over stdio; interrupt ladder; wedge policy; one-shot fallback as the universal degrade; snapshot/restore as the crash story.
- **Explicitly skip** (parent §2.3 table): live reattach across drops (Albedo's detached bridge + seq/ack session layer), live remote references, kernel version-skew swapping as a subsystem.
- **Promised semantics** (parent §4.10): driver staged once to `~/.porrima/kernel/porrima_kernel.py` on the host; an ssh drop kills the kernel, state recovering from **host-local** snapshots under `~/.porrima/kernels/` on that host; per-call execution remains the fallback and the tool result says which mode ran; **remote spill goes inside the remote workspace** (the `.porrima-tool-output/` pattern remote bash already uses), because the model's `read_file` resolves against the remote workspace root — a server-local path in the footer would be unreachable.
- Routing rule since P1 (parent §4.1): "LocalWorkspaceAdapter gets the kernel; SSH stays per-call **through P3** — a local kernel cannot have a remote cwd, and §4.10 covers when that changes." This doc is that "when."

## 3. What survives the transport change (verified against code)

These are load-bearing claims for why P4 is plumbing, not a new subsystem:

1. **The protocol client cannot tell local python from an ssh client.** Everything the manager sends and reads flows through `instance.proc` — `sendRequest` writes a line to stdin (`python-kernel.ts:208-211`), `attachReaders` frames stdout lines (`:680-693`), `proc.exited` fails pendings (`:768-774`). Swap the supervised child from `python3 driver` to `ssh host 'python3 driver'` and execute/interrupt/snapshot/restore/jobs/acks/streaming (`onUpdate`, throttled 100 ms) all ride the channel.
2. **Snapshot/restore paths are request parameters** (parent §4.8; `snapshotPaths` → `snapshot`/`restore` payloads, `python-kernel.ts:412-446`). The driver treats them as opaque strings; pointing them at `~/.porrima/kernels/<chatId>/` *on the host* is string formatting. The `pythonVersion` freshness check compares manifest vs running python **on the same host**, so cross-major risk vanishes for remote kernels (each host snapshots against its own interpreter).
3. **SSH-drop teardown already has both halves** (`porrima_kernel.py:1447-1476`, `:955-1014`):
   - *Live loop*: channel close closes the driver's stdin → the reader thread enqueues `shutdown` with `eof: true` → `_serve` runs the EOF final flush to the last host-committed snapshot target (guarded on `_last_snapshot_target`, shipped P3) → `_kill_all_children()` → exit.
   - *Wedged loop* (cannot process the queue): `_start_owner_watchdog` falls back to `os.getppid()` when `PORRIMA_KERNEL_OWNER_PID` is unset or ≤ 0 (`:1006-1014`). Remotely, the driver's direct parent is the per-connection sshd child, which exits when the connection dies — the `pidfd`/`NOTE_EXIT` wait fires, the watchdog kills journaled children and `os._exit(1)`s. So deliberately **not setting** the owner-pid env across ssh is correct, and the wedged case is bounded without any manager action.
4. **`python_jobs` list/status/tail are served from the server-side registry** (parent §4.7; fed by tagged events arriving over the channel). Transport-independent, including while a remote cell runs or the remote kernel is wedged.
5. **Child containment is driver-local** (parent §4.7): the Popen patch, `setsid`, `children.jsonl` under `PORRIMA_KERNEL_DIR`, L1 child reaping, and L2 child-group kills all execute **inside the driver on the host**. They work unchanged remotely, provided `PORRIMA_KERNEL_DIR` is set on the remote command line.
6. **Workspace-change disposal is label-opaque**: `acquireKernel` compares `instance.cwd` against `workspace.label` (`ssh:user@host:/root`), so a chat moving local↔SSH or host↔host already disposes the kernel; only the disposal's *state removal* step needs to become host-aware (§4.4).
7. **Interrupts and the wedge policy are wire requests** — L1/L2 need nothing local; the wedge flag + next-call one-shot degrade is manager-side state.

## 4. Design

### 4.1 The seam: a `KernelHost` handle

Everything filesystem- or process-shaped gets one interface, defined in `python-kernel.ts` and implemented twice:

```ts
export interface KernelHost {
  /** Identifier baked into logs; "local" or "ssh:target". */
  readonly kind: string;
  /** Host-side state dir for a chat (opaque path string, used in snapshot/restore requests). */
  stateDir(chatId: string): string;
  /** Prepare before spawn: mkdir -m 700 the state dir, stage the driver. Null on any failure (→ one-shot fallback). */
  prepare(chatId: string, driverLocalPath: string): Promise<{ command: string; args: string[]; remoteDriverHash: string } | null>;
  /** Best-effort removal of a chat's host-side state (workspace change, chat deletion). */
  removeState(chatId: string): Promise<void>;
}
```

- `LocalKernelHost` — wraps exactly what `spawnKernel`/`disposeKernel` do today (`kernelStateDir`, `mkdir mode 0700`, `rm`). No behavior change; the refactor is the point where local and remote converge.
- `SshKernelHost` — lives in `workspace.ts`, created by a new optional adapter method `createKernelHost(): KernelHost | null` (`SshWorkspaceAdapter` implements it; `LocalWorkspaceAdapter` returns null/undefined). It owns what only the adapter owns: control socket path, `sshClientArgs`, `ensureMaster`/`masterCheck`, `resolvePython`, `exec`. `prepare` returns `{ command: "ssh", args: [controlSocket, target, remoteCommandLine] }`.
- `agent-tools.ts` resolves the host per call (`workspace.createKernelHost?.() ?? localHost`) and passes it into `executeInKernel` via `KernelRunOptions` (defaulting to local when absent — internal callers and tests unchanged). Dependency direction: `workspace.ts` imports the `KernelHost` type from `python-kernel.ts`; `python-kernel.ts` never imports `workspace.ts` — no cycle.
- Feature gate: `SshWorkspaceAdapter.createKernelHost()` returns null unless `PORRIMA_REMOTE_KERNEL=1` (P4a ships dark). `useKernel` itself becomes unconditional on kind; the null host *is* the off switch, and it degrades to today's per-call path with the existing notices.

### 4.2 Spawn: the ssh client is the supervised process

`spawnKernel` builds the supervised child from the host's `prepare()` plan instead of hardcoding `python3 -u <driver>`:

- Local (unchanged): `spawnSupervised({ command: python3, args: [-u, driver], cwd, env: {PORRIMA_KERNEL_DIR, PORRIMA_KERNEL_OWNER_PID, PYTHONDONTWRITEBYTECODE}, key: "kernel:<chatId>" })`.
- Remote: `spawnSupervised({ command: "ssh", args: ["-S", sock, target, remoteLine], key: "kernel:<chatId>" })` — no `cwd`, no `env` (they do not cross ssh). `remoteLine` is a single shell line, everything path-bearing quoted with the adapter's `shellQuote`:

  ```
  cd -- '<root>' && install -d -m 700 '<stateDir>' && PORRIMA_KERNEL_DIR='<stateDir>' PYTHONDONTWRITEBYTECODE=1 '<pyPath>' -u '<stagedDriver>'
  ```

  `PORRIMA_KERNEL_OWNER_PID` is deliberately **absent** — §3.3's getppid fallback is the correct remote watchdog.
- No PTY is requested (exec with `-S` never allocates one), so framing is byte-clean.
- The supervisor journal (`children.jsonl` under `~/.porrima/supervisor/`) tracks the **local ssh client** — its purpose (reaping groups a crashed server left) is served exactly: reaping the dead ssh client's group does nothing to the remote kernel, which is fine because the remote kernel tears itself down via §3.3 once the channel is gone.
- Before spawning, `prepare()` verifies the master (`masterCheck`, then `ensureMaster` with its existing dedupe). If the master cannot come up, `prepare()` returns null → `{ reason: "spawn-failed" }` → per-call one-shot with the existing notice. The direct (non-mux) connection path (`sshDirectArgs`) is **not** used for kernels in P4a: one transport, one lifecycle; multiplexing keeps auth/connection reuse consistent with every other ssh operation.
- `READY_TIMEOUT_MS` (30 s) covers first-hop latency of an established master (spawn over a live master adds < 1 s); a cold `ensureMaster` happens in `prepare()`, before the ready clock matters.

Capacity, wedge, LRU/TTL, `brokenChats`-and-disposal semantics all stay as-is: a remote kernel is one more entry in `kernels` keyed by chatId, holding one of the 4 slots, and the idle reaper disposes it (bounded flush attempt over the channel first) just like a local one. Remote chats on a schedule — synthesis and `automation:<id>` chats (§4.7) — pay spawn + host-snapshot restore per fire, same story as idle agent chats resolved in parent §8.1.

### 4.3 Driver staging and version skew

`prepare()` stages the driver idempotently, once per (connection, build):

- Target: `~/.porrima/kernel/porrima_kernel.py` on the host (the parent §4.10 path), plus a `<target>.sha256` marker written atomically after a successful upload.
- Compare: `exec("sha256sum <target> 2>/dev/null")` (or read the marker) vs the local file's hash — `python-kernel.ts` supplies the local path (already resolved by `resolveDriverPath`, `:199-206`), the adapter computes its hash once per server process.
- On mismatch: upload via `exec` stdin — `mkdir -p ~/.porrima/kernel && cat > <target>.tmp-<uuid> && mv -f …` (56.7 KB, one round trip; `exec`'s default 30 s timeout applies to the *command*, not a streaming kernel).
- Gating: staging and kernel launch honor the same permission as remote `run_python` — **`allowBash` required** (`workspace.ts:978` is the precedent). Staging writes into `$HOME/.porrima` on the host, deliberately outside the workspace-root containment that governs model file tools; this is an app-owned, app-initiated path (the model cannot reach it through tools), and it is called out in §4.8.
- Skew: the `ready` event gains a `driver` field (first 16 hex of the sha256). Manager compares it to the hash `prepare()` staged; mismatch means the host file changed under us (another porrima install sharing the account) — treat as `{ reason: "spawn-failed" }`, re-stage on the next call. This is not the parent's rejected "version-skew swapping subsystem" (§2.3) — it is one string comparison at handshake, consistent with the §4.3-exact-match rule for `protocol`.

### 4.4 Host-side state ops: what the manager can no longer do from here

Three local-filesystem operations in the manager need host behavior, and the startup sweep needs a rethink:

| Op | Today (local) | Remote behavior |
|---|---|---|
| state dir create | `mkdir stateDir 0700` in `spawnKernel` | in `prepare()` / launch line (`install -d -m 700`) |
| `removeState` (workspace change, chat deletion) | `rm -r kernelStateDir` in `disposeKernel` | `host.removeState` → `exec("rm -rf -- <stateDir>")`; a dropped connection makes this a no-op — the remote dir expires on the host anyway (§4.4 sweep) |
| startup journal sweep | `sweepKernelJournals()` at boot (`index.ts:261`), reads `~/.porrima/kernels/*/children.jsonl` | **cannot reach hosts** — see below |
| 14-day state expiry | same sweep | same answer |

**Sweep relocation (design decision):** the stale-child reap + journal truncate + expired-sibling-directory purge moves into the **driver bootstrap**: before emitting `ready`, the driver (a) if its `PORRIMA_KERNEL_DIR/children.jsonl` exists, reaps active records using the existing `_reap_child` (`porrima_kernel.py:882`) with start-time verification, then truncates the journal; (b) removes expired sibling state dirs under its kernel root (same 14-day mtime rule); (c) if a `kernel.pid` file exists and that pid is alive **and its identity is verified**, kills it (targeted, never group), before writing its own. Liveness is not identity: the pidfile now carries the driver's start time, and a live pid whose start time differs was recycled to an unrelated process — kill nothing (the journal reap's startId rule, ported to the pidfile; revised 10-09 — the shipped 10-08 kill was liveness-only, which would have TERM/SIGKILL'd a recycled same-user pid). Legacy bare-pid files fall back to a cmdline match against the staged driver path; with no positive match, a true orphan lingers to the next generation or the 14-day prune (the documented residual). The new pidfile is written as compact JSON `{"pid":, "startId":}` (`startId` null when unreadable at boot, degrading the next generation to the cmdline fallback). This makes remote self-healing free (each fresh spawn cleans its predecessor's wreckage), and it hardens local too — the manager-side startup sweep stays as the pre-spawn backstop for chats that never spawn again, so local semantics are unchanged, not relocated.

Consequence: a wedged remote kernel orphaned by a host whose sshd model doesn't match §3.3's per-session-child assumption (some `sshd -D`/socket-activation variants) dies at the **next spawn attempt** via the pidfile guard, not instantly. Documented residual risk (§6).

### 4.5 Teardown, L3 semantics, and the shutdown-order fix

- **Ordinary disposal** (TTL/LRU/deletion/server shutdown): protocol `shutdown` request over the channel, bounded 3 s, then supervisor kill of the ssh client. The remote driver does its own child reaping on the protocol path (unchanged); killing the client closes the channel, which re-triggers §3.3 for anything left.
- **L3 `python_jobs kill force`** remains "server-side supervisor kill, never a protocol request" (parent §4.7). Over ssh it means: kill the local client, **await its exit** (channel torn down), and the remote kernel dies via EOF (live loop, plus final flush) or the sshd-child pidfd (wedged loop). The promise changes shape: "kernel gone" becomes "kernel torn down within seconds, worst case bounded by `ServerAliveInterval=30 × ServerAliveCountMax=2 ≈ 60 s` on a half-open network". The kill result text and parent §4.5/§4.7 get the footnote; no new mechanism.
- **Mid-cell network drop**: the ssh client exits → manager's `proc.exited` handler fails pending pendings with "kernel exited unexpectedly" (existing code path, `:768-774`), kernel deleted from the map; next call re-establishes the master, spawns fresh, and restores from the host snapshot (which, if the drop was hard, is whatever the EOF flush or last debounce saved). The cell's partial effects are lost — same contract as a local server crash.
- **Shutdown order (latent bug, fix ships with P4a):** `index.ts` currently calls `destroyAllMasters()` at :68, *before* `disposeAllKernels()` at :87. Locally harmless; remotely it amputates the channel the graceful dispose needs (protocol shutdown + bounded flush). Reorder: kernels before masters. `killAllSupervised()` stays last (backstop kills the ssh clients of anything that failed to dispose politely).

### 4.6 Background jobs and spill placement — P4b

The correctness problem P4b solves: job output is spilled by the manager's `OutputCapture` to the **server-local** store, and `python_jobs status` prints `Full output: <server path>` — a path the model in an SSH chat cannot `read_file` (it resolves against the remote root). Parent §4.10 ruled: remote spill goes inside the remote workspace. **Shipped**: a host may define `deliverJobOutput(chatId, jobId, content)`; when it exists, `finishJob` reads the local capture spill, caps it at 8 MB (with an in-file truncation marker), and the SSH host writes it to `<remoteRoot>/.porrima-tool-output/py-<job8>.txt` via one `exec` (stdin payload), returning the **workspace-relative** footer path — the exact remote-bash pattern (`workspace.ts`, `bash()`), so `read_file(path=".porrima-tool-output/…")` resolves. Job views prefer the delivered path and never surface the local one (`remoteSpill` marker on the job); delivery failure yields NO footer, never an unreachable path. The local host omits the method — server-local spill paths stay correct there. Retention inherits remote bash's gap (no remote-side GC of `.porrima-tool-output/`; the server-local store's 64/chat + 24 h rules do not apply) — flagged as an open question (§8.3); the model owns its workspace. The background ack path (§4.2 of the parent) rides tagged events over the channel unchanged: pause gating, caps (4/kernel, 8 box-wide), reject-foreground-while-job-runs, no-turn-gate — all inherited.

Foreground cells need nothing here: neither mode spills foreground output today (wrapResult truncates; the parent's §4.6 cell-spill wording describes the job path only — verified against code).

### 4.7 Capacity and lifecycle math

- Kernels are per chatId: `system` (synthesis/wake/built-ins) plus **one permanent chat per custom automation** (`automation:<id>`, created with `type:"system"` by `ensureAutomationChat`, `automation-runner.ts:99-117`) — all now kernel-capable, local or remote, governed by the existing LRU-4 + 30-min-idle-TTL rules. Chat ids containing `:` are legal path segments on Linux and already used for kernel state dirs (shipped in the system-chat flip for `automation:<id>` agent-chat jobs); no change.
- Box-wide caps (4 jobs/kernel, 8 box-wide — parent §4.7) exist to protect the CPU-bound inference services **on this box**. A remote job consumes the *remote* box; keeping the caps global is simpler than introducing per-host accounting and errs conservative. A per-host cap is an open question (§8.2), not P4 scope.
- Mutation lock unchanged: `workspace:<label>` with the same foreground-holds / background-escapes semantics (parent §4.7).

### 4.8 Security posture (extends parent §4.12 onto the host)

- The kernel is not a sandbox; on the remote host it runs with the SSH user's full permissions, same as per-call `run_python` today.
- New on-host artifacts, all app-owned: staged driver (`~/.porrima/kernel/`), per-chat state (`~/.porrima/kernels/<chatId>/` — namespace snapshots can hold secrets read by cells), child journals. Created `0700/0600`; removed on workspace-change/chat-deletion disposal when the channel is up, and expired by the driver's boot self-heal when it is not.
- Staging writes outside the workspace-root containment are app-initiated only (the model's file tools cannot address them) and gated behind the same `allowBash` permission that already gates remote `run_python`.
- Pickle restore stays the same trust domain (the user's own account on the host).

### 4.9 Tool surface, notices, and KV stability

- `useKernel` becomes unconditional (the host handle absorbs kind differences); `LocalWorkspaceAdapter` behavior is byte-identical.
- New `KernelFallbackReason: "transport"` → notice `[kernel: remote session unavailable; ran per-call this call]` (distinct from `spawn-failed`'s "unavailable" wording so operators can tell staging/master failures from local spawn failures). The design promise "the tool result says which mode ran" (parent §4.10) is exactly this notice surface.
- `RUN_PYTHON_TOOL` description: drop "Falls back to stateless on remote machines", add "On remote (SSH) workspaces the kernel runs on the remote host and its state survives on that host; a dropped connection loses live state but the next call restores from the last snapshot" (P4b replaces the "background unavailable" tail with the normal background sentence). Descriptions are schema bytes — this change re-prefills every chat that carries the tool once. Batch it with any other pending schema change if one lands before P4a; the P4a-on-by-default flip is a second bust and should ride a scheduled deploy.
- Byte-stability rules carry unchanged: notices are inside the persisted result text (restore/fallback pattern), `kernel.pid`/hashes never leak into model-visible output, `python_jobs list` stays deterministic.

## 5. Phased plan

| Phase | Scope | Rough size |
|---|---|---|
| P4a (**landed 2026-10-08**, dark) | `KernelHost` seam (local refactor + ssh impl), driver staging + skew check, launch-command transport, `ready.driver` field, driver boot self-heal (journal reap, expiry, pidfile guard), `removeState` over exec, shutdown-order fix, `useKernel` unconditional behind `PORRIMA_REMOTE_KERNEL=1`, tool-surface + notices + docs, tests (§5.1) | ~250–350 LOC TS + ~80–120 LOC Py |
| P4b (**landed 2026-10-08**, dark) | background jobs over ssh: host-side `deliverJobOutput`, spill pushed to remote `.porrima-tool-output/` (8 MB cap + in-file marker), workspace-relative footer, P4a foreground-demote notice removed, views never surface the local spill path | ~120 LOC |
| P4c (not scheduled) | kernel venv provisioning on hosts (parent §4.9), per-host job caps, remote RSS checks | design |

Each phase independently shippable; every failure path degrades to today's per-call behavior, which is why they ship dark. The live-host checklist (§5.1) ran green on Iapetus 2026-10-08 — P4a 15/15, then 18/18 including the P4b background job (1.5 MB delivered into the remote workspace with a workspace-relative footer). Default-on remains an explicit call (KV re-prefill + the tool-description flip at the same deploy).

### 5.1 Test strategy

There is no ssh test harness today (`__tests__` has zero SSH coverage). Two layers close most of the gap without a network:

1. **Fake-ssh integration**: a PATH shim script that parses the ssh client arg shape (`-S sock target remoteLine`), extracts the `remoteLine`, and executes it locally with `bash -c` — the manager then drives a *real* `porrima_kernel.py` through the *real* transport plumbing: spawn plan, env-in-prefix, `install -d` state dir, journal reap, pidfile guard (kill on identity match; spare recycled-pid and legacy non-driver cases), EOF teardown on client kill, L1/L2 over the channel, `removeState`. This exercises §3.1–3.5 and §4.2/4.4/4.5 end-to-end.
2. **Unit**: launch-line builder (quoting/injection on hostile roots), staging hash-compare logic against a mocked `exec`, `ready.driver` mismatch → transport fallback, shutdown-order regression (kernel dispose before master destroy), and `createKernelHost()` null when the flag is off / `allowBash` is false.

Plus a **live-host checklist**, automated as `server/src/scripts/smoke-remote-kernel.ts`
(`npx tsx src/scripts/smoke-remote-kernel.ts --connection <id|host> --root <remoteRoot>`):
staging, first cell, cwd, streaming, host pidfile, interrupt-with-namespace-survival,
debounced snapshot on the host, hard drop (force-dispose → remote reaped by
EOF/watchdog), respawn + restore notice, `removeState` teardown. **Ran green on
Iapetus 2026-10-08** (15/15 for P4a; 18/18 with the P4b job-delivery checks; see Live-verified header).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| sshd without a per-session child that dies on channel close → orphaned wedged remote kernel | §4.4 identity-verified pidfile guard kills the predecessor at next spawn (recycled pids are spared); worst case one kernel lingers on the host idle |
| Half-open network hides a dead channel; manager thinks the kernel is alive | `ServerAliveInterval=30 ×2` tears the connection ≤ ~60 s; client exit → `proc.exited` → one-shot degrade meanwhile |
| Staging corrupts (partial upload) → every call spawns a broken driver | atomic tmp+`mv`; `.sha256` marker only after success; `ready.driver` compare; failure = one-shot fallback, never a respawn loop |
| Another install/host user mutates the staged driver between compare and spawn | `ready.driver` handshake catches it; degrade + re-stage |
| Remote exec round trips make control ops slower than local | all control deadlines already ≥ 2–15 s; snapshot flush is bounded by design (2 s) and loss-tolerant |
| 4-slot LRU now shared with remote kernels; heavy SSH automation fleets could starve agent chats of live kernels | capacity already degrades to one-shot with a notice; monitor via existing per-kernel log lines |
| On-host snapshots hold secrets, new hosts are less trusted than this box | §4.8 posture, 0700/0600, expiry; same trust domain as the SSH account itself — stated, not presented as isolation |
| Shutdown ordering regression breaks today's local teardown | reorder is strictly safer (kernels disposed while everything they might touch is still up); covered by the order regression test |

## 7. Alternatives considered

- **Albedo-style detached kernel + durable bridge** (reattach across drops, seq/ack): rejected with the same reasoning as parent §7 — Porrima is server-owned; the host-side snapshot + drop-and-respawn story covers the user-visible need at a fraction of the complexity. The stdio protocol leaves room to add it later.
- **Direct non-mux ssh for the kernel channel** (own `sshDirectArgs` connection, no ControlMaster): considered and rejected for P4a — keeps auth, host-key policy, and master lifecycle single-sourced; revisit only if mux coupling (master death killing kernels) proves annoying in practice.
- **Stage via `SshWorkspaceAdapter.writeFile`**: rejected — that path is workspace-root-contained by design; staging is app-owned state outside the workspace and needs its own small, auditable exec, not a containment carve-out.
- **Manager-side remote sweep (exec every host's `children.jsonl` at boot)**: rejected — hosts are unknown until used, connections may be down, and boot would fan out ssh; the driver-boot self-heal (§4.4) is local to the moment of truth.
- **Remote RSS watchdog over ssh `ps`**: skipped — remote memory is the host's problem and its own OOM killer's job; TTL + snapshots bound our side.
- **A dedicated kernel venv on the host** (parent §4.9 prime-agent pattern): orthogonal to transport; P4c.

## 8. Open questions

1. **Ship dark or on?** Current lean: dark behind `PORRIMA_REMOTE_KERNEL=1` through the live-host checklist, then default-on in the next release (one KV re-prefill at the default flip, batched with schema churn).
2. **Per-host job caps** (P4c candidate): global 8 protects *this* box, but remote jobs consume *other* boxes; a per-host cap needs host identity in the cap counter. Keep global for now.
3. **Remote `.porrima-tool-output/` GC**: inherited gap from remote bash — nothing prunes the workspace dir today. Options: driver-boot prune alongside the kernel self-heal, or leave it model-facing. Decide in P4b.
4. **Minimum remote python version**: the driver assumes Linux + modern CPython (pidfd path falls back to a 30 s poll loop elsewhere). Pin a floor (3.10?) and fail `ready` cleanly on older hosts so the fallback notice is actionable, not cryptic.

## 9. References

- Parent: `docs/design/session-python-kernel.md` — §4.5 (L1/L2/L3), §4.7 (jobs, pause gating), §4.8 (snapshot paths, EOF flush), §4.10 (this phase's seed), §4.11 (teardown/sweep), §4.12 (security), §4.13 (replay stability), §8.1 (system chats, resolved 2026-10-08)
- `server/src/services/python-kernel.ts` — `spawnKernel` `:699`, `acquireKernel` `:835`, `sendRequest` `:208`, `snapshotPaths` `:412`, `disposeKernel` `:994`, `sweepKernelJournals` `:1111`
- `server/python/porrima_kernel.py` — `_setup_fds` `:365`, owner watchdog `:955-1014`, journal `_append_journal` `:831` / `_reap_child` `:882` / `_kill_all_children` `:926`, EOF shutdown `:1447-1476`, `main` `:1501`
- `server/src/services/workspace.ts` — SSH master registry `:483-560`, `exec`/`ensureMaster` `:592-705`, remote bash spill `:954-975`, `runPython` `:977-985`, `resolvePython` `:717-730`
- `server/src/index.ts` — shutdown order `:68`/`:87`/`:97`, startup sweep `:261`
- `server/src/services/automation-runner.ts` — automation chats `:99-117`, chatType `:211`, tool build `:333`
