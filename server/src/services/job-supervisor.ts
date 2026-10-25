import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendJobJournal,
  latestJournalRecords,
  pruneJobJournal,
} from "./job-journal.js";
import {
  JOB_PROTOCOL_VERSION,
  type JobEvent,
  type JobKind,
  type JobRecord,
  type JobState,
  type JobStopReason,
  type SupervisorStats,
} from "./job-protocol.js";
import type { JobStore, NewJob } from "./job-store.js";
import { isGroupAlive, killProcessGroup, readProcessStartId } from "./process-supervisor.js";

/**
 * The durable process plane (docs/design/job-supervisor.md §6/§7).
 *
 * Owns spawn, output files, status files, the group journal, and adoption.
 * It does not know about chats, turns, or notices beyond the ids it records.
 * Closing the supervisor never kills a job; that is what the slice/stop-all
 * controls are for.
 */

export interface StartJobInput {
  job_id: string;
  chat_id: string;
  kind: JobKind;
  command: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  timeout_ms?: number;
  origin_turn_id?: string;
}

export interface WaitForResult {
  matched: boolean;
  line: string | null;
  finished: boolean;
}

export interface JobSupervisorOptions {
  store: JobStore;
  jobsDir: string;
  journalPath: string;
  bootId: string;
  caps?: Partial<SupervisorCaps>;
}

/** Process identity captured at spawn time, before any ledger write exists. */
interface SpawnIdentity {
  pid: number;
  pgid: number;
  start_id: string | null;
}

interface SupervisorCaps {
  per_chat: number;
  box: number;
  services_per_chat: number;
  services_box: number;
}

interface JobStatusFile {
  exit_code?: number | null;
  signal?: string | null;
  started_at?: string;
  ended_at?: string;
  duration_ms?: number | null;
}

const ADOPT_POLL_MS = 1000;
const MAX_WAIT_SCAN_BYTES = 8 * 1024 * 1024;
const TERMINAL_STATES: JobState[] = ["finished", "stopped", "lost", "failed"];

const JOB_WRAPPER = `#!/bin/bash
# Porrima job wrapper. Writes process identity and a completion status file
# that survives the supervisor being down (docs/design/job-supervisor.md §6).
set -u
job_dir=$1
command=$2
printf '%s\\n' "$$" > "$job_dir/pid"
start_id=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null || true)
if [ -n "$start_id" ]; then printf 'proc:%s\\n' "$start_id" > "$job_dir/start_id"; fi
cat /proc/sys/kernel/random/boot_id > "$job_dir/boot_id" 2>/dev/null || true
started_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
start_ms=$(date +%s%3N)
/bin/bash -c "$command"
rc=$?
ended_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
end_ms=$(date +%s%3N)
duration_ms=$((end_ms - start_ms))
tmp="$job_dir/status.json.tmp"
if [ "$rc" -gt 128 ]; then
  sig=$((rc - 128))
  case "$sig" in
    1) signame=HUP ;;
    2) signame=INT ;;
    3) signame=QUIT ;;
    6) signame=ABRT ;;
    9) signame=KILL ;;
    15) signame=TERM ;;
    *) signame="SIG$sig" ;;
  esac
  printf '{"exit_code":null,"signal":"SIG%s","started_at":"%s","ended_at":"%s","duration_ms":%d}\\n' \\
    "$signame" "$started_at" "$ended_at" "$duration_ms" > "$tmp"
else
  printf '{"exit_code":%d,"signal":null,"started_at":"%s","ended_at":"%s","duration_ms":%d}\\n' \\
    "$rc" "$started_at" "$ended_at" "$duration_ms" > "$tmp"
fi
chmod 600 "$tmp"
mv -f "$tmp" "$job_dir/status.json"
exit "$rc"
`;

export class JobSupervisor extends EventEmitter {
  private readonly store: JobStore;
  private readonly jobsDir: string;
  private readonly journalPath: string;
  private readonly bootId: string;
  private readonly caps: SupervisorCaps;
  private readonly startedAt = Date.now();
  private readonly children = new Map<string, ChildProcess>();
  private readonly adopted = new Map<string, JobRecord>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();
  private readonly stopping = new Set<string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(options: JobSupervisorOptions) {
    super();
    this.store = options.store;
    this.jobsDir = options.jobsDir;
    this.journalPath = options.journalPath;
    this.bootId = options.bootId;
    this.caps = {
      per_chat: options.caps?.per_chat ?? envInt("PORRIMA_JOBS_MAX_PER_CHAT", 4),
      box: options.caps?.box ?? envInt("PORRIMA_JOBS_MAX_BOX", 8),
      services_per_chat:
        options.caps?.services_per_chat ?? envInt("PORRIMA_JOBS_MAX_SERVICES_PER_CHAT", 2),
      services_box: options.caps?.services_box ?? envInt("PORRIMA_JOBS_MAX_SERVICES_BOX", 4),
    };
  }

  stats(socketPath: string, dbPath: string): SupervisorStats {
    return {
      protocol: JOB_PROTOCOL_VERSION,
      pid: process.pid,
      start_id: readProcessStartId(process.pid) ?? null,
      boot_id: this.bootId,
      started_at: new Date(this.startedAt).toISOString(),
      uptime_ms: Date.now() - this.startedAt,
      socket_path: socketPath,
      jobs_dir: this.jobsDir,
      db_path: dbPath,
      jobs: this.store.countByState(),
      db_bytes: this.store.dbSizeBytes(),
      caps: { ...this.caps },
    };
  }

  get(id: string): JobRecord | null {
    return this.store.get(id);
  }

  list(filter: { chat_id?: string; states?: JobState[]; limit?: number } = {}): JobRecord[] {
    return this.store.list(filter);
  }

  eventsSince(seq: number): JobEvent[] {
    return this.store.eventsSince(seq);
  }

  async recover(): Promise<void> {
    const rows = this.store.list({ states: ["starting", "running"], limit: 1000 });
    for (const row of rows) {
      const dir = this.jobDir(row.chat_id, row.id);
      const pid = row.pid ?? readIntFile(join(dir, "pid"));
      const pgid = row.pgid ?? pid;
      const expectedStart = row.start_id ?? readTextFile(join(dir, "start_id"));

      if (row.boot_id && row.boot_id !== this.bootId) {
        this.recoverFromStatus(row);
        continue;
      }

      const alive = pgid != null && isGroupAlive(pgid);
      if (alive && pid != null) {
        const actualStart = readProcessStartId(pid) ?? null;
        if (expectedStart && actualStart && expectedStart !== actualStart) {
          this.markLost(row);
          continue;
        }
        let adopted = row;
        if (!row.pid || row.state === "starting") {
          adopted = this.store.markRunning(row.id, {
            pid,
            pgid,
            start_id: actualStart ?? expectedStart,
            boot_id: this.bootId,
            started_at: row.started_at ?? new Date().toISOString(),
          });
        }
        this.adopted.set(row.id, adopted);
        this.appendJournalActive({
          id: adopted.id,
          pid,
          pgid,
          start_id: adopted.start_id,
        });
        continue;
      }

      this.recoverFromStatus(row);
    }

    await this.reapUnclaimedJournalGroups();
    this.ensurePoll();
    this.pruneJournal();
  }

  async start(input: StartJobInput): Promise<JobRecord> {
    if (this.closed) throw new Error("job supervisor is shutting down");
    validateStart(input);
    const existing = this.store.get(input.job_id);
    if (existing) return existing;

    const active = this.store.list({ states: ["starting", "running"], limit: 1000 });
    this.enforceCaps(input, active);

    const chatDir = join(this.jobsDir, safeDir(input.chat_id));
    mkdirSync(chatDir, { recursive: true, mode: 0o700 });
    chmodSync(chatDir, 0o700);
    const jobDir = join(chatDir, safeDir(input.job_id));
    mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    chmodSync(jobDir, 0o700);
    const stdoutPath = join(jobDir, "stdout.log");
    const stderrPath = join(jobDir, "stderr.log");
    const statusPath = join(jobDir, "status.json");
    const wrapperPath = join(jobDir, "run.sh");
    writeFileSync(wrapperPath, JOB_WRAPPER, { mode: 0o700 });
    chmodSync(wrapperPath, 0o700);
    writeFileSync(join(jobDir, "command.txt"), input.command, { mode: 0o600 });

    const newJob: NewJob = {
      id: input.job_id,
      chat_id: input.chat_id,
      kind: input.kind,
      command: input.command,
      cwd: input.cwd,
      stdout_path: stdoutPath,
      stderr_path: stderrPath,
      status_path: statusPath,
      origin_turn_id: input.origin_turn_id ?? null,
    };
    const job = this.store.insertStarting(newJob);

    let stdoutFd = -1;
    let stderrFd = -1;
    let child: ChildProcess | null = null;
    let spawnIdentity: SpawnIdentity | null = null;
    try {
      stdoutFd = openSync(stdoutPath, "a", 0o600);
      stderrFd = openSync(stderrPath, "a", 0o600);
      const spawned = spawn("/bin/bash", [wrapperPath, jobDir, input.command], {
        cwd: input.cwd,
        env: normalizeEnv(input.env),
        stdio: ["ignore", stdoutFd, stderrFd],
        detached: true,
      });
      child = spawned;
      if (!spawned.pid) {
        throw new Error("spawn did not return a pid");
      }
      spawnIdentity = {
        pid: spawned.pid,
        pgid: spawned.pid,
        start_id: readProcessStartId(spawned.pid) ?? null,
      };
      // Journal before the ledger write. The record is the witness that a
      // process was created, so it has to exist before the write it is meant
      // to cover; a crash between spawn and markRunning then still leaves a
      // group that recovery can find. (The job dir's own pid/start_id files
      // are a second path back, but only if the wrapper got that far.)
      this.appendJournalActive({ id: job.id, ...spawnIdentity });
      const running = this.store.markRunning(job.id, {
        pid: spawnIdentity.pid,
        pgid: spawnIdentity.pgid,
        start_id: spawnIdentity.start_id,
        boot_id: this.bootId,
        started_at: new Date().toISOString(),
      });
      this.children.set(job.id, spawned);
      spawned.once("exit", (code, signal) => {
        void this.finishChild(job.id, code, signal);
      });
      spawned.once("error", (error) => {
        void this.failChild(job.id, error);
      });
      spawned.unref();

      if (input.kind === "command" && input.timeout_ms && input.timeout_ms > 0) {
        const timer = setTimeout(() => {
          void this.stop(job.id, { reason: "timeout" }).catch((error) => {
            console.warn(`[jobs] timeout stop failed for ${job.id}:`, error);
          });
        }, input.timeout_ms);
        timer.unref?.();
        this.timeouts.set(job.id, timer);
      }

      this.emitJob("job_started", running);
      return running;
    } catch (error: any) {
      if (child?.pid) {
        void killProcessGroup(child.pid, { graceMs: 500 });
      }
      this.store.markFailed(job.id);
      // The journal already carries this group (it was written before the
      // ledger update), so close it out with the identity we hold rather than
      // leaving an active record for a group we just killed ourselves.
      this.appendJournalInactive(job.id, spawnIdentity ?? undefined);
      throw new Error(`failed to spawn job ${job.id}: ${error?.message ?? error}`);
    } finally {
      if (stdoutFd >= 0) closeSync(stdoutFd);
      if (stderrFd >= 0) closeSync(stderrFd);
    }
  }

  async stop(
    id: string,
    opts: { force?: boolean; reason?: JobStopReason } = {},
  ): Promise<JobRecord> {
    if (this.closed) throw new Error("job supervisor is shutting down");
    const row = this.store.get(id);
    if (!row) throw new Error(`job ${id} not found`);
    if (isTerminal(row.state)) return row;

    this.stopping.add(id);
    try {
      const pgid = row.pgid ?? row.pid;
      if (pgid != null) {
        await killProcessGroup(pgid, { graceMs: opts.force ? 100 : 3000 });
      }
      if (this.closed) return row;
      const after = this.store.get(id);
      if (after && isTerminal(after.state)) return after;

      const endedAt = new Date().toISOString();
      const duration = durationBetween(row.started_at, endedAt);
      const reason = opts.reason ?? (opts.force ? "user-force" : "user");
      const stopped = this.store.stop(id, reason, endedAt, duration);
      this.children.delete(id);
      this.adopted.delete(id);
      this.clearTimeout(id);
      this.appendJournalInactive(id);
      this.emitJob("job_stopped", stopped);
      this.ensurePoll();
      this.pruneJournal();
      return stopped;
    } finally {
      this.stopping.delete(id);
    }
  }

  async stopChat(chatId: string): Promise<number> {
    if (this.closed) return 0;
    const rows = this.store.list({
      chat_id: chatId,
      states: ["starting", "running"],
      limit: 1000,
    });
    let count = 0;
    for (const row of rows) {
      try {
        await this.stop(row.id, { reason: "chat-deleted" });
        count += 1;
      } catch (error) {
        console.warn(`[jobs] stop_chat ${chatId} failed for ${row.id}:`, error);
      }
    }
    return count;
  }

  async stopAll(): Promise<number> {
    if (this.closed) return 0;
    const rows = this.store.list({ states: ["starting", "running"], limit: 1000 });
    let count = 0;
    for (const row of rows) {
      try {
        await this.stop(row.id, { reason: "system-stop" });
        count += 1;
      } catch (error) {
        console.warn(`[jobs] stop_all failed for ${row.id}:`, error);
      }
    }
    return count;
  }

  async waitFor(id: string, pattern: string, timeoutMs: number): Promise<WaitForResult> {
    if (!pattern) throw new Error("wait_for requires a non-empty pattern");
    const row = this.store.get(id);
    if (!row) throw new Error(`job ${id} not found`);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const [stdout, stderr] = await Promise.all([
        readCappedText(row.stdout_path, MAX_WAIT_SCAN_BYTES),
        readCappedText(row.stderr_path, MAX_WAIT_SCAN_BYTES),
      ]);
      const text = `${stdout}\n${stderr}`;
      if (text.trim() && pattern) {
        const index = text.indexOf(pattern);
        if (index >= 0) {
          return { matched: true, line: lineAt(text, index), finished: false };
        }
      }
      if (this.closed) return { matched: false, line: null, finished: true };
      const current = this.store.get(id);
      if (!current || isTerminal(current.state)) {
        return { matched: false, line: null, finished: true };
      }
      if (Date.now() >= deadline) return { matched: false, line: null, finished: false };
      await delay(100);
    }
  }

  /** Stop accepting work and detach. Never kills a running job. */
  close(): void {
    this.closed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    this.timeouts.clear();
    this.children.clear();
    this.adopted.clear();
  }

  private async finishChild(
    id: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.closed || this.stopping.has(id)) return;
    this.children.delete(id);
    this.clearTimeout(id);
    const row = this.store.get(id);
    if (!row || isTerminal(row.state)) return;

    const status = readStatusFile(row.status_path);
    let daemonized = false;
    const pgid = row.pgid ?? row.pid;
    if (pgid != null && isGroupAlive(pgid)) {
      await killProcessGroup(pgid, { graceMs: 1000 });
      daemonized = true;
    }
    if (this.closed || this.stopping.has(id)) return;

    if (!status && code == null && signal == null) {
      this.markLost(row);
      return;
    }
    const endedAt = status?.ended_at ?? new Date().toISOString();
    const duration =
      status?.duration_ms ?? durationBetween(row.started_at, endedAt);
    const updated = this.store.finish(id, {
      exit_code: status?.exit_code ?? code ?? null,
      signal: status?.signal ?? signal ?? null,
      ended_at: endedAt,
      duration_ms: duration,
      stop_reason: daemonized ? "daemonized" : null,
    });
    this.appendJournalInactive(id);
    this.emitJob("job_finished", updated);
  }

  private async failChild(id: string, error: Error): Promise<void> {
    if (this.closed || this.stopping.has(id)) return;
    this.children.delete(id);
    this.clearTimeout(id);
    const row = this.store.get(id);
    if (!row || isTerminal(row.state)) return;
    console.warn(`[jobs] ${id} spawn error: ${error.message}`);
    const failed = this.store.markFailed(id);
    this.appendJournalInactive(id);
    this.emitJob("job_finished", failed);
  }

  private recoverFromStatus(row: JobRecord): void {
    const status = readStatusFile(row.status_path);
    if (status) {
      const endedAt = status.ended_at ?? new Date().toISOString();
      const duration =
        status.duration_ms ?? durationBetween(row.started_at, endedAt);
      const updated = this.store.finish(row.id, {
        exit_code: status.exit_code ?? null,
        signal: status.signal ?? null,
        ended_at: endedAt,
        duration_ms: duration,
      });
      this.appendJournalInactive(row.id);
      this.emitJob("job_finished", updated);
      return;
    }
    if (row.state === "starting") {
      const failed = this.store.markFailed(row.id);
      this.appendJournalInactive(row.id);
      this.emitJob("job_finished", failed);
      return;
    }
    this.markLost(row);
  }

  private markLost(row: JobRecord): void {
    const updated = this.store.markLost(row.id);
    this.appendJournalInactive(row.id);
    this.emitJob("job_lost", updated);
  }

  private adoptPoll(): void {
    if (this.closed) return;
    for (const [id, adopted] of [...this.adopted]) {
      const current = this.store.get(id);
      if (!current || isTerminal(current.state)) {
        this.adopted.delete(id);
        continue;
      }
      const status = readStatusFile(current.status_path);
      if (status) {
        this.recoverFromStatus(current);
        this.adopted.delete(id);
        continue;
      }
      if (adopted.pgid == null || !isGroupAlive(adopted.pgid)) {
        this.markLost(current);
        this.adopted.delete(id);
      }
    }
    this.ensurePoll();
  }

  private ensurePoll(): void {
    if (this.adopted.size === 0) {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      return;
    }
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.adoptPoll(), ADOPT_POLL_MS);
    this.pollTimer.unref?.();
  }

  private async reapUnclaimedJournalGroups(): Promise<void> {
    const active = new Map(
      this.store
        .list({ states: ["starting", "running"], limit: 1000 })
        .map((row) => [row.id, row]),
    );
    for (const record of latestJournalRecords(this.journalPath).values()) {
      if (!record.active || active.has(record.job_id)) continue;
      // A previous boot's pid/pgid can be recycled. Only act on a group whose
      // boot and start-time identity matches this generation.
      if (record.boot_id !== this.bootId) continue;
      const actualStart = readProcessStartId(record.pid);
      // Reaping needs positive identity. A record whose start time cannot be
      // confirmed against the live process is not evidence that this group is
      // ours to kill — and with the journal written before the ledger update,
      // unconfirmed records are now expected to exist.
      if (!record.start_id || !actualStart || record.start_id !== actualStart) continue;
      if (isGroupAlive(record.pgid)) {
        console.warn(`[jobs] reaping unclaimed group ${record.pgid} (${record.job_id})`);
        await killProcessGroup(record.pgid, { graceMs: 500 });
      }
    }
  }

  private pruneJournal(): void {
    const keep = new Set<string>([...this.children.keys(), ...this.adopted.keys()]);
    for (const row of this.store.list({ states: ["starting", "running"], limit: 1000 })) {
      keep.add(row.id);
    }
    pruneJobJournal(this.journalPath, keep);
  }

  /** Identity captured at spawn time — may exist before any ledger write does. */
  private appendJournalActive(job: { id: string } & SpawnIdentity): void {
    appendJobJournal(this.journalPath, {
      version: 1,
      job_id: job.id,
      pid: job.pid,
      pgid: job.pgid,
      start_id: job.start_id,
      boot_id: this.bootId,
      active: true,
      recorded_at: new Date().toISOString(),
    });
  }

  private appendJournalInactive(id: string, identity?: SpawnIdentity): void {
    const row = this.store.get(id);
    const pid = identity?.pid ?? row?.pid ?? null;
    const pgid = identity?.pgid ?? row?.pgid ?? pid;
    if (pid == null || pgid == null) return;
    appendJobJournal(this.journalPath, {
      version: 1,
      job_id: id,
      pid,
      pgid,
      start_id: identity?.start_id ?? row?.start_id ?? null,
      boot_id: this.bootId,
      active: false,
      recorded_at: new Date().toISOString(),
    });
  }

  private emitJob(type: JobEvent["event"], job: JobRecord): void {
    if (this.closed) return;
    const event = this.store.appendEvent(type, job);
    this.emit("event", event);
  }

  private enforceCaps(input: StartJobInput, active: JobRecord[]): void {
    const perChat = active.filter((row) => row.chat_id === input.chat_id).length;
    if (perChat >= this.caps.per_chat || active.length >= this.caps.box) {
      throw new Error(
        `job limit reached: ${perChat}/${this.caps.per_chat} in this chat, ` +
          `${active.length}/${this.caps.box} box-wide`,
      );
    }
    if (input.kind === "service") {
      const servicesPerChat = active.filter(
        (row) => row.chat_id === input.chat_id && row.kind === "service",
      ).length;
      const servicesBox = active.filter((row) => row.kind === "service").length;
      if (
        servicesPerChat >= this.caps.services_per_chat ||
        servicesBox >= this.caps.services_box
      ) {
        throw new Error(
          `service limit reached: ${servicesPerChat}/${this.caps.services_per_chat} in this chat, ` +
            `${servicesBox}/${this.caps.services_box} box-wide`,
        );
      }
    }
  }

  private clearTimeout(id: string): void {
    const timer = this.timeouts.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(id);
    }
  }

  private jobDir(chatId: string, jobId: string): string {
    return join(this.jobsDir, safeDir(chatId), safeDir(jobId));
  }
}

function validateStart(input: StartJobInput): void {
  if (!input || typeof input !== "object") throw new Error("start requires an object");
  if (typeof input.job_id !== "string" || !input.job_id.trim()) {
    throw new Error("start requires job_id");
  }
  if (typeof input.chat_id !== "string" || !input.chat_id.trim()) {
    throw new Error("start requires chat_id");
  }
  if (input.kind !== "command" && input.kind !== "service") {
    throw new Error("start requires kind=command|service");
  }
  if (typeof input.command !== "string" || !input.command.trim()) {
    throw new Error("start requires a non-empty command");
  }
  if (typeof input.cwd !== "string" || !input.cwd.trim()) {
    throw new Error("start requires cwd");
  }
  try {
    if (!statSync(input.cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`cwd does not exist or is not a directory: ${input.cwd}`);
  }
}

function normalizeEnv(input?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const source = input ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") env[key] = value;
  }
  if (!env.PATH) env.PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  if (!env.HOME) env.HOME = process.env.HOME ?? homedir();
  return env;
}

function safeDir(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${safe || "x"}-${hash}`;
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

function readStatusFile(path: string): JobStatusFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as JobStatusFile;
    if (
      parsed &&
      (typeof parsed.exit_code === "number" || parsed.exit_code === null || parsed.exit_code === undefined) &&
      (typeof parsed.signal === "string" || parsed.signal === null || parsed.signal === undefined)
    ) {
      return parsed;
    }
  } catch {
    // Missing or torn status: fall back to the child exit.
  }
  return null;
}

function readIntFile(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

async function readCappedText(path: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let end = text.indexOf("\n", index);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim();
}

function durationBetween(startedAt: string | null, endedAt: string): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}