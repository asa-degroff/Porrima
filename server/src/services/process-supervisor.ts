import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import type { Readable } from "node:stream";
import { appDataPath } from "./paths.js";

// ---------------------------------------------------------------------------
// Shared process supervisor — one spawn/kill/journal primitive for bash and
// the Python kernel (docs/design/pi-1.0-migration.md §3).
//
// Lifecycle:
// - POSIX children spawn detached (own process group). kill() signals the
//   group: SIGTERM, grace, SIGKILL, then confirms group death with a bounded
//   killpg(pid, 0) poll so no descendant lands a side effect after the caller
//   returns.
// - exited resolves on leader exit plus a short stdio grace, never on pipe
//   EOF: a daemonized grandchild holding the pipe cannot hang the caller.
// - A daemonized child keeps the group alive after the leader exits; the
//   registry retains it (so killAllSupervised still reaches it) until the
//   group is confirmed dead.
// - Every spawn is journalled to ~/.porrima/supervisor/children.jsonl so a
//   startup sweep can reap groups orphaned by a server SIGKILL. An in-memory
//   registry cannot survive the crash the journal exists for.
//
// Stream contract: stdout/stderr are piped and consumed by the caller. The
// supervisor attaches a no-op 'data' listener to re-arm the stdio grace; Node
// broadcasts every chunk to all listeners, so callers must attach their own
// 'data' listeners synchronously after spawn (do not use async iteration).
// ---------------------------------------------------------------------------

const DEFAULT_KILL_GRACE_MS = 3000;
const GROUP_CONFIRM_TIMEOUT_MS = 2000;
const GROUP_POLL_INTERVAL_MS = 25;
const TERM_POLL_INTERVAL_MS = 50;
const EXIT_STDIO_GRACE_MS = 100;
const REAPER_INTERVAL_MS = 5000;

export interface SupervisedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface SupervisedProcess {
  key: string;
  pid: number;
  startedAt: number;
  stdout: Readable | null;
  stderr: Readable | null;
  /** True once the leader has exited (the group may still be alive). */
  readonly leaderExited: boolean;
  /** Live stdin channel; false on backpressure or a closed pipe. */
  write(data: string | Buffer): boolean;
  endStdin(): void;
  /** Resolves on leader exit + stdio grace; never rejects. */
  exited: Promise<SupervisedExit>;
  /** SIGTERM → grace → SIGKILL on the process group, confirmed. Idempotent. */
  kill(opts?: { graceMs?: number }): Promise<void>;
}

export interface SpawnSupervisedOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Registry key and diagnostics label, e.g. "bash:<chatId>". */
  key: string;
  /** Convenience: written to stdin and closed before return. */
  stdinPayload?: string | Buffer;
  killGraceMs?: number;
  /** Test/embedding override; defaults to the data-dir journal. */
  journalPath?: string;
}

interface JournalRecord {
  version: 1;
  pid: number;
  pgid: number;
  startId?: string;
  key: string;
  active: boolean;
  recordedAt: string;
}

class SupervisedProcessImpl implements SupervisedProcess {
  readonly key: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly startId?: string;
  readonly exited: Promise<SupervisedExit>;
  leaderExited = false;

  private readonly child: ChildProcess;
  private readonly journalPath: string;
  private readonly defaultGraceMs: number;
  private finalized = false;
  private killPromise: Promise<void> | null = null;

  constructor(child: ChildProcess, opts: SpawnSupervisedOptions, journalPath: string) {
    this.child = child;
    this.key = opts.key;
    this.journalPath = journalPath;
    this.defaultGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.pid = child.pid ?? 0;
    this.startedAt = Date.now();
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.startId = this.pid > 0 ? readProcessStartId(this.pid) : undefined;

    // Writes after child exit raise EPIPE; never let that crash the server.
    child.stdin?.on("error", () => {});

    this.exited = new Promise<SupervisedExit>((resolve) => {
      let settled = false;
      let exited = false;
      let code: number | null = null;
      let signal: NodeJS.Signals | null = null;
      let error: Error | undefined;
      let stdoutEnded = !this.stdout;
      let stderrEnded = !this.stderr;
      let idleTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        this.stdout?.removeListener("end", onStdoutEnd);
        this.stderr?.removeListener("end", onStderrEnd);
        this.stdout?.removeListener("data", onActivity);
        this.stderr?.removeListener("data", onActivity);
      };
      const finalizeExit = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.stdout?.destroy();
        this.stderr?.destroy();
        this.leaderExited = true;
        resolve({ code, signal, error });
        this.afterLeaderExit();
      };
      const maybeFinalize = () => {
        if (exited && stdoutEnded && stderrEnded) finalizeExit();
      };
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(finalizeExit, EXIT_STDIO_GRACE_MS);
        idleTimer.unref?.();
      };
      const onActivity = () => {
        if (exited && !settled) armIdleTimer();
      };
      const onStdoutEnd = () => {
        stdoutEnded = true;
        maybeFinalize();
      };
      const onStderrEnd = () => {
        stderrEnded = true;
        maybeFinalize();
      };
      const onError = (err: Error) => {
        error = err;
        exited = true;
        finalizeExit();
      };
      const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
        exited = true;
        code = exitCode;
        signal = exitSignal;
        maybeFinalize();
        if (!settled) armIdleTimer();
      };

      child.on("error", onError);
      child.on("exit", onExit);
      this.stdout?.on("end", onStdoutEnd);
      this.stderr?.on("end", onStderrEnd);
      this.stdout?.on("data", onActivity);
      this.stderr?.on("data", onActivity);
    });
  }

  write(data: string | Buffer): boolean {
    if (this.finalized || !this.child.stdin || this.child.stdin.destroyed) return false;
    return this.child.stdin.write(data);
  }

  endStdin(): void {
    this.child.stdin?.end();
  }

  kill(opts?: { graceMs?: number }): Promise<void> {
    if (this.killPromise) return this.killPromise;
    this.killPromise = this.performKill(opts?.graceMs ?? this.defaultGraceMs);
    return this.killPromise;
  }

  private async performKill(graceMs: number): Promise<void> {
    if (this.finalized) return;
    if (this.pid <= 0 || !isGroupAlive(this.pid)) {
      this.finalize();
      return;
    }
    if (process.platform === "win32") {
      await taskkillTree(this.pid);
      this.finalize();
      return;
    }
    const confirmed = await killGroupAndConfirm(this.pid, graceMs);
    if (confirmed) {
      this.finalize();
    } else {
      console.warn(`[supervisor] group ${this.pid} (${this.key}) did not confirm exit after SIGKILL`);
    }
  }

  /** Internal: deregister + close the journal record once the group is dead. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    live.delete(this);
    if (this.pid > 0) {
      appendJournalRecord(this.journalPath, {
        version: 1,
        pid: this.pid,
        pgid: this.pid,
        startId: this.startId,
        key: this.key,
        active: false,
        recordedAt: new Date().toISOString(),
      });
    }
    stopReaperIfIdle();
  }

  private afterLeaderExit(): void {
    if (this.finalized) return;
    if (this.pid <= 0 || !isGroupAlive(this.pid)) {
      this.finalize();
      return;
    }
    ensureReaper();
  }
}

const live = new Set<SupervisedProcessImpl>();
let reaperTimer: NodeJS.Timeout | null = null;

function ensureReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    for (const proc of [...live]) {
      if (proc.leaderExited && !isGroupAlive(proc.pid)) proc.finalize();
    }
  }, REAPER_INTERVAL_MS);
  reaperTimer.unref?.();
}

function stopReaperIfIdle(): void {
  if (live.size === 0 && reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

export function spawnSupervised(opts: SpawnSupervisedOptions): SupervisedProcess {
  const journalPath = opts.journalPath ?? supervisorJournalPath();
  const child = spawn(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const proc = new SupervisedProcessImpl(child, opts, journalPath);
  if (proc.pid > 0) {
    live.add(proc);
    appendJournalRecord(journalPath, {
      version: 1,
      pid: proc.pid,
      pgid: proc.pid,
      startId: proc.startId,
      key: opts.key,
      active: true,
      recordedAt: new Date().toISOString(),
    });
  }
  if (opts.stdinPayload !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.stdinPayload);
  }
  return proc;
}

export function listSupervised(): Array<{
  key: string;
  pid: number;
  startedAt: number;
  leaderExited: boolean;
}> {
  return [...live].map((proc) => ({
    key: proc.key,
    pid: proc.pid,
    startedAt: proc.startedAt,
    leaderExited: proc.leaderExited,
  }));
}

/** Kill every supervised group, including lingering daemonized ones. Each
 *  child's kill is individually bounded, so one wedged child cannot delay the
 *  rest. */
export async function killAllSupervised(opts?: { graceMs?: number }): Promise<void> {
  const procs = [...live];
  await Promise.allSettled(procs.map((proc) => proc.kill(opts)));
}

export function supervisorJournalPath(): string {
  return process.env.PORRIMA_SUPERVISOR_JOURNAL || appDataPath("supervisor", "children.jsonl");
}

/**
 * Reap groups journalled by a previous server run, then truncate the journal.
 * Runs once at startup before anything can spawn. Records are last-wins per
 * pid; an active record whose leader pid has been reused (startId mismatch) is
 * left alone.
 */
export async function sweepSupervisorJournal(journalPath = supervisorJournalPath()): Promise<number> {
  let text: string;
  try {
    text = await readFile(journalPath, "utf8");
  } catch {
    return 0;
  }
  const last = new Map<number, JournalRecord>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as JournalRecord;
      if (typeof record?.pid === "number" && record.pid > 0) last.set(record.pid, record);
    } catch {
      // Torn tail line from a crash mid-append.
    }
  }

  let reaped = 0;
  for (const record of last.values()) {
    if (record.active === false) continue;
    if (!isGroupAlive(record.pid)) continue;
    const currentStartId = readProcessStartId(record.pid);
    if (record.startId && currentStartId && currentStartId !== record.startId) {
      continue; // pid reused by an unrelated process
    }
    console.log(
      `[supervisor] reaping orphaned group ${record.pid} (${record.key}, recorded ${record.recordedAt})`,
    );
    if (process.platform === "win32") {
      await taskkillTree(record.pid);
      reaped++;
      continue;
    }
    if (await killGroupAndConfirm(record.pid, DEFAULT_KILL_GRACE_MS)) reaped++;
  }

  try {
    await truncate(journalPath, 0);
  } catch {
    // Best effort; stale records are harmless (liveness-checked next time).
  }
  return reaped;
}

/** True when the process group still has members (EPERM counts as alive). */
export function isGroupAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

/** TERM → grace → KILL on a process group, confirming death. Shared by the
 *  supervisor's own teardown and the kernel child-journal sweep. */
export async function killProcessGroup(pid: number, opts?: { graceMs?: number }): Promise<boolean> {
  if (pid <= 0) return true;
  if (process.platform === "win32") {
    await taskkillTree(pid);
    return true;
  }
  return killGroupAndConfirm(pid, opts?.graceMs ?? DEFAULT_KILL_GRACE_MS);
}

export function readProcessStartId(pid: number): string | undefined {
  if (process.platform !== "linux" || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).split(" ");
    const starttime = fields[19]; // field 22 overall; state is field 3
    return starttime ? `proc:${starttime}` : undefined;
  } catch {
    return undefined;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: any) {
    return error?.code === "ESRCH";
  }
}

async function killGroupAndConfirm(pid: number, graceMs: number): Promise<boolean> {
  if (pid <= 0) return true;
  signalGroup(pid, "SIGTERM");
  const termDeadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < termDeadline && isGroupAlive(pid)) await delay(TERM_POLL_INTERVAL_MS);
  if (isGroupAlive(pid)) {
    signalGroup(pid, "SIGKILL");
    const killDeadline = Date.now() + GROUP_CONFIRM_TIMEOUT_MS;
    while (Date.now() < killDeadline && isGroupAlive(pid)) await delay(GROUP_POLL_INTERVAL_MS);
  }
  return !isGroupAlive(pid);
}

async function taskkillTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function appendJournalRecord(journalPath: string, record: JournalRecord): void {
  try {
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    const fd = openSync(journalPath, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error: any) {
    // Best effort: a journal failure must never fail the spawn. The group is
    // still tracked in memory and killed on graceful paths; only the
    // after-crash sweep loses this record.
    console.warn(`[supervisor] failed to write journal ${journalPath}: ${error?.message ?? error}`);
  }
}
