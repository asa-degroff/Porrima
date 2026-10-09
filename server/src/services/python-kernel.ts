import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, readdir, rm, stat, truncate } from "fs/promises";
import { dirname, join } from "path";
import { StringDecoder } from "string_decoder";
import { fileURLToPath } from "url";
import { createHash, randomUUID } from "crypto";
import { appDataPath } from "./paths.js";
import { createOutputCapture, type OutputCapture } from "./output-capture.js";
import { DEFAULT_SPILL_MAX_BYTES, createSpillPath } from "./tool-output-store.js";
import { getStoredSystemPauseState } from "./system-pause.js";
import {
  isGroupAlive,
  killProcessGroup,
  readProcessStartId,
  spawnSupervised,
  type SupervisedProcess,
} from "./process-supervisor.js";

// ---------------------------------------------------------------------------
// Session Python kernel manager — one persistent REPL per agent chat
// (docs/design/session-python-kernel.md §4).
//
// The driver (server/python/porrima_kernel.py) runs on the shared process
// supervisor. This module owns: lazy per-chat kernels, the JSON-lines protocol
// client, timeout/abort mapping onto L1/L2 interrupts, the wedge policy,
// TTL/LRU eviction, one-shot fallback signalling, disposal, and the startup
// sweep of child journals left by a crashed server.
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = 1;
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024;
const READY_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_KERNELS = 4;
const DEFAULT_WEDGE_GRACE_MS = 12_000;
const SHUTDOWN_WAIT_MS = 3000;
const REAPER_INTERVAL_MS = 60_000;
const KERNEL_KILL_GRACE_MS = 1000;
const STDERR_RING_BYTES = 64 * 1024;
/** Live view updates are throttled: pi-agent-core queues one promise per
 *  update until the tool settles, so a fast-printing cell must not emit one
 *  per stdout frame. The final result carries the full output regardless. */
const UPDATE_THROTTLE_MS = 100;

// Background jobs (§4.7).
const JOB_WINDOW_BYTES = 1024 * 1024;
const JOB_MAX_LINES = 1_000_000;
const JOB_MAX_PER_KERNEL = 4;
const JOB_MAX_BOX = 8;
const JOB_RETENTION = 64;
const JOB_ACK_TIMEOUT_MS = 10_000;
const JOB_TAIL_BYTES = 16 * 1024;

// Snapshot / restore (§4.8).
const SNAPSHOT_DEBOUNCE_MS = 1500;
const SNAPSHOT_CONTROL_TIMEOUT_MS = 15_000;
const RESTORE_CONTROL_TIMEOUT_MS = 15_000;
const SNAPSHOT_MAX_BYTES_DEFAULT = 64 * 1024 * 1024;
const SNAPSHOT_MAX_VARIABLE_BYTES_DEFAULT = 16 * 1024 * 1024;
const KERNEL_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DISPLAY_MAX_IMAGES = 4;

function snapshotMaxBytes(): number {
  return readPositiveIntEnv("PORRIMA_KERNEL_SNAPSHOT_MAX_BYTES", SNAPSHOT_MAX_BYTES_DEFAULT);
}

function snapshotMaxVariableBytes(): number {
  return readPositiveIntEnv("PORRIMA_KERNEL_SNAPSHOT_MAX_VARIABLE_BYTES", SNAPSHOT_MAX_VARIABLE_BYTES_DEFAULT);
}

export type KernelFallbackReason = "capacity" | "spawn-failed" | "wedge" | "broken" | "transport";

// ---------------------------------------------------------------------------
// KernelHost — the transport/state seam for remote-python-kernel.md §4.1.
//
// Everything the manager does that is filesystem-shaped or process-shaped
// goes through this handle. LocalKernelHost reproduces the pre-P4 behavior
// exactly; the SSH adapter (workspace.ts) supplies a host whose launch plan
// is an `ssh` client process and whose state paths live on the remote host.
// The protocol machinery (execute/interrupt/snapshot/jobs) cannot tell the
// difference: it only ever touches `proc.write` / stdout / exited.
// ---------------------------------------------------------------------------

export interface KernelSpawnPlan {
  command: string;
  args: string[];
  /** Local cwd/env for the spawned transport process (the ssh client's own
   *  cwd/env is irrelevant to the remote side). */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Host-resolved absolute state dir for this chat; snapshot/restore
   *  request paths are derived from it (remote paths live on the host). */
  stateDir: string;
  /** sha256[:16] the driver's `ready` event must report (§4.3 skew check). */
  driverHash: string;
}

export interface KernelHost {
  /** Log label: "local" or "ssh:<target>". */
  readonly kind: string;
  /** Fallback reason reported when prepare()/spawn fails (§4.9 notices). */
  readonly failureReason: KernelFallbackReason;
  /** Verify transport liveness, stage the driver, build the launch plan.
   *  `cwd` is the chat's workspace label: a real local directory for the
   *  local host (today's kernel-cwd semantics), irrelevant to ssh clients.
   *  Null on any failure — the call degrades to one-shot, never a retry loop. */
  prepare(chatId: string, cwd: string): Promise<KernelSpawnPlan | null>;
  /** Manifest text iff both payload and manifest exist on the host; else null. */
  readSnapshotManifest(stateDir: string): Promise<string | null>;
  /** mtime in ms, or null when not observable (freshness memo skips remote). */
  statMtime(path: string): Promise<number | null>;
  /** Best-effort host-side state removal (workspace change, chat deletion). */
  removeState(chatId: string): Promise<void>;
}

export type KernelRunOutcome =
  | {
      mode: "kernel";
      content: string;
      isError: boolean;
      jobId?: string;
      /** Images emitted via `emit({"image/png": ...})` (base64 payloads). */
      images?: Array<{ data: string; mimeType: string }>;
    }
  | { mode: "fallback"; reason: KernelFallbackReason };

export interface KernelRunOptions {
  chatId: string;
  cwd: string;
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Run as a background job; resolves with the ack and a jobId. */
  background?: boolean;
  /** Live view updates (stdout+stderr so far) for the streaming seam. */
  onUpdate?: (text: string) => void;
  /** Transport/state host (§4.1). Defaults to localKernelHost — every
   *  pre-P4 caller keeps working unchanged. */
  host?: KernelHost;
}

interface KernelErrorEvent {
  ename: string;
  evalue: string;
  traceback: string[];
}

interface PendingExecution {
  id: string;
  timeoutSec: number;
  startedAt: number;
  stdout: string[];
  stderr: string[];
  resultText: string | null;
  error: KernelErrorEvent | null;
  timedOut: boolean;
  aborted: boolean;
  settled: boolean;
  deadline: NodeJS.Timeout;
  lastUpdateAt: number;
  pendingUpdateText: string | null;
  updateTimer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  onUpdate?: (text: string) => void;
  /** Images from display events (base64 payloads), attached on success. */
  images: Array<{ data: string; mimeType: string }>;
  /** Background acks resolve with the started message, not cell output. */
  background?: boolean;
  notice?: string | null;
  resolve: (outcome: KernelRunOutcome) => void;
}

interface KernelJob {
  id: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt: number | null;
  timedOut: boolean;
  capture: OutputCapture;
  resultText: string | null;
  error: KernelErrorEvent | null;
  spillPath?: string;
}

interface KernelInstance {
  chatId: string;
  cwd: string;
  /** Transport/state owner for this kernel (§4.1). */
  host: KernelHost;
  /** Host-resolved state dir (local dir, or remote dir string on the host). */
  stateDir: string;
  /** Driver content hash the `ready` event must report (§4.3). */
  expectedDriverHash: string;
  proc: SupervisedProcess;
  pending: Map<string, PendingExecution>;
  jobs: Map<string, KernelJob>;
  jobOrder: string[];
  /** Control-request (snapshot/restore) resolvers keyed by request id. */
  control: Map<string, (event: Record<string, any>) => void>;
  pythonVersion: string;
  firstNotice: string | null;
  restoreIncomplete: boolean;
  executions: number;
  lastSnapshot: { executions: number; payloadMtimeMs: number; manifestMtimeMs: number } | null;
  snapshotTimer: NodeJS.Timeout | null;
  busy: boolean;
  wedged: boolean;
  wedgedAt: number | null;
  lastUsedAt: number;
  stderrTail: string;
  lineBuffer: string;
  decoder: StringDecoder;
  disposed: boolean;
  readyResolve?: (value: boolean) => void;
}

const kernels = new Map<string, KernelInstance>();
const brokenChats = new Set<string>();
let reaperTimer: NodeJS.Timeout | null = null;

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function idleTtlMs(): number {
  return readPositiveIntEnv("PORRIMA_KERNEL_IDLE_TTL_MS", DEFAULT_IDLE_TTL_MS);
}

function maxKernels(): number {
  return readPositiveIntEnv("PORRIMA_KERNEL_MAX", DEFAULT_MAX_KERNELS);
}

function wedgeGraceMs(): number {
  return readPositiveIntEnv("PORRIMA_KERNEL_WEDGE_GRACE_MS", DEFAULT_WEDGE_GRACE_MS);
}

export function kernelRoot(): string {
  return process.env.PORRIMA_KERNEL_ROOT || appDataPath("kernels");
}

export function kernelStateDir(chatId: string): string {
  return join(kernelRoot(), chatId);
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function resolveDriverPath(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "python", "porrima_kernel.py"), // src/services or dist/services -> server/python
    join(here, "..", "python", "porrima_kernel.py"), // dist-only packaging: dist/services -> dist/python
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * The driver source plus its content hash (first 16 hex of sha256). Cached
 * per server process — the file cannot change within a build. Both the local
 * host and the SSH staging path (§4.3) use it: locally it feeds the `ready`
 * comparison trivially, remotely it is the staging marker and the expected
 * handshake value.
 */
let driverInfoCache: { path: string; text: string; hash: string } | null | undefined;
export function localDriverInfo(): { path: string; text: string; hash: string } | null {
  if (driverInfoCache !== undefined) return driverInfoCache;
  const path = resolveDriverPath();
  if (!path) {
    driverInfoCache = null;
    return null;
  }
  try {
    const text = readFileSync(path, "utf8");
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    driverInfoCache = { path, text, hash };
  } catch {
    driverInfoCache = null;
  }
  return driverInfoCache;
}

/**
 * Build the remote launch line executed by the host shell
 * (remote-python-kernel.md §4.2): cd into the workspace root, create the
 * 0700 state dir, and start the staged driver with PORRIMA_KERNEL_DIR set.
 * PORRIMA_KERNEL_OWNER_PID is deliberately absent — unset env makes the
 * driver's watchdog watch its direct parent (the per-connection sshd child),
 * which is exactly the right liveness signal over ssh (§3.3). Quoting lives
 * here so it is unit-testable against hostile roots.
 */
export function buildRemoteKernelLaunchLine(opts: {
  root: string;
  pythonPath: string;
  driverPath: string;
  stateDir: string;
}): string {
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [
    `cd -- ${q(opts.root)}`,
    `mkdir -p ${q(opts.stateDir)}`,
    `chmod 700 ${q(opts.stateDir)}`,
    `PORRIMA_KERNEL_DIR=${q(opts.stateDir)} PYTHONDONTWRITEBYTECODE=1 ${q(opts.pythonPath)} -u ${q(opts.driverPath)}`,
  ].join(" && ");
}

/** The pre-P4 default host: state under ~/.porrima/kernels, driver spawned
 *  directly through the supervisor, §4.10 "a local kernel cannot have a
 *  remote cwd" made literal by `cwd` being a real local directory. */
export const localKernelHost: KernelHost = {
  kind: "local",
  failureReason: "spawn-failed",
  async prepare(chatId: string, cwd: string): Promise<KernelSpawnPlan | null> {
    const driver = localDriverInfo();
    if (!driver) return null;
    const stateDir = kernelStateDir(chatId);
    await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {});
    return {
      command: process.env.PORRIMA_PYTHON || "python3",
      args: ["-u", driver.path],
      cwd,
      env: {
        ...process.env,
        PORRIMA_KERNEL_DIR: stateDir,
        PORRIMA_KERNEL_OWNER_PID: String(process.pid),
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stateDir,
      driverHash: driver.hash,
    };
  },
  async readSnapshotManifest(stateDir: string): Promise<string | null> {
    const payloadPath = join(stateDir, "namespace.pkl");
    const manifestPath = join(stateDir, "manifest.json");
    if (!existsSync(payloadPath) || !existsSync(manifestPath)) return null;
    return readFile(manifestPath, "utf8").catch(() => null);
  },
  async statMtime(path: string): Promise<number | null> {
    return (await stat(path).catch(() => null))?.mtimeMs ?? null;
  },
  async removeState(chatId: string): Promise<void> {
    await rm(kernelStateDir(chatId), { recursive: true, force: true }).catch(() => {});
  },
};

function sendRequest(instance: KernelInstance, request: Record<string, unknown>): void {
  if (instance.disposed) return;
  instance.proc.write(`${JSON.stringify(request)}\n`);
}

function outputView(instance: KernelInstance, pending: PendingExecution): string {
  const stdout = pending.stdout.join("").trimEnd();
  const stderr = pending.stderr.join("").trimEnd();
  const parts: string[] = [];
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr] ${stderr}`);
  return parts.join("\n");
}

function schedulePendingUpdate(pending: PendingExecution): void {
  if (!pending.onUpdate) return;
  const elapsed = Date.now() - pending.lastUpdateAt;
  if (elapsed >= UPDATE_THROTTLE_MS) {
    pending.lastUpdateAt = Date.now();
    pending.onUpdate(pending.pendingUpdateText ?? "");
    return;
  }
  if (pending.updateTimer) return;
  pending.updateTimer = setTimeout(() => {
    pending.updateTimer = undefined;
    if (pending.settled) return;
    pending.lastUpdateAt = Date.now();
    if (pending.pendingUpdateText !== null) pending.onUpdate?.(pending.pendingUpdateText);
  }, UPDATE_THROTTLE_MS - elapsed);
  pending.updateTimer.unref?.();
}

function clearPendingUpdate(pending: PendingExecution): void {
  if (pending.updateTimer) {
    clearTimeout(pending.updateTimer);
    pending.updateTimer = undefined;
  }
}

function formatError(error: KernelErrorEvent, output: string): string {
  const traceback = (error.traceback ?? []).join("").trimEnd();
  const head = traceback || `${error.ename}: ${error.evalue}`;
  return output ? `${head}\n${output}` : head;
}

// ---------------------------------------------------------------------------
// Background jobs (§4.7): server-side state fed by tagged events. list/status/
// tail answer without a kernel round-trip, so they work while a cell runs or
// the kernel is wedged.
// ---------------------------------------------------------------------------

function createJob(instance: KernelInstance, jobId: string): KernelJob {
  const capture = createOutputCapture({
    limits: { maxBytes: JOB_WINDOW_BYTES, maxLines: JOB_MAX_LINES, retain: "tail" },
    spill: {
      path: createSpillPath(instance.chatId, "py", `job-${jobId.slice(0, 8)}`),
      maxBytes: DEFAULT_SPILL_MAX_BYTES,
    },
  });
  return {
    id: jobId,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    timedOut: false,
    capture,
    resultText: null,
    error: null,
  };
}

function handleJobEvent(job: KernelJob, event: Record<string, any>): void {
  switch (event.event) {
    case "stdout":
    case "stderr":
      job.capture.push(typeof event.text === "string" ? event.text : "");
      return;
    case "result":
      job.resultText = typeof event.text === "string" ? event.text : null;
      return;
    case "error":
      job.error = {
        ename: String(event.ename ?? "Error"),
        evalue: String(event.evalue ?? ""),
        traceback: Array.isArray(event.traceback) ? event.traceback.map(String) : [],
      };
      return;
    default:
      return;
  }
}

async function finishJob(instance: KernelInstance, event: Record<string, any>): Promise<void> {
  const jobId = typeof event.job_id === "string" ? event.job_id : null;
  const job = jobId ? instance.jobs.get(jobId) : undefined;
  if (!job || job.status !== "running") return;
  job.status = event.status === "ok" ? "done" : "error";
  job.timedOut = event.timed_out === true;
  job.finishedAt = Date.now();
  const result = await job.capture.finish().catch(() => null);
  if (result?.spillPath) job.spillPath = result.spillPath;
  pruneJobs(instance);
}

function pruneJobs(instance: KernelInstance): void {
  while (instance.jobOrder.length > JOB_RETENTION) {
    const oldest = instance.jobOrder[0];
    const job = instance.jobs.get(oldest);
    if (job?.status === "running") break;
    instance.jobOrder.shift();
    if (job) instance.jobs.delete(oldest);
  }
}

function countRunningJobs(instance: KernelInstance): number {
  let count = 0;
  for (const job of instance.jobs.values()) if (job.status === "running") count++;
  return count;
}

function countRunningJobsBox(): number {
  let count = 0;
  for (const instance of kernels.values()) count += countRunningJobs(instance);
  return count;
}

export interface KernelJobInfo {
  id: string;
  status: "running" | "done" | "error";
  durationMs: number;
  timedOut: boolean;
  spillPath?: string;
}

/** Server-side job view: works while a cell runs or the kernel is wedged. */
export function listKernelJobs(chatId: string): KernelJobInfo[] {
  const instance = kernels.get(chatId);
  if (!instance) return [];
  return [...instance.jobs.values()]
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    .map((job) => ({
      id: job.id,
      status: job.status,
      durationMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      timedOut: job.timedOut,
      spillPath: job.spillPath ?? job.capture.snapshot().spillPath,
    }));
}

export function tailKernelJob(
  chatId: string,
  jobId: string,
  lines = 50,
): { found: boolean; status?: "running" | "done" | "error"; text?: string } {
  const job = kernels.get(chatId)?.jobs.get(jobId);
  if (!job) return { found: false };
  const text = job.capture.snapshot().text;
  const tail = text.split("\n").slice(-lines).join("\n");
  return {
    found: true,
    status: job.status,
    text: tail.length > JOB_TAIL_BYTES ? tail.slice(tail.length - JOB_TAIL_BYTES) : tail,
  };
}

export function killKernelJob(
  chatId: string,
  jobId: string,
  force = false,
): { ok: boolean; reason?: string } {
  const instance = kernels.get(chatId);
  if (!instance) return { ok: false, reason: "no kernel" };
  const job = instance.jobs.get(jobId);
  if (!job) return { ok: false, reason: "unknown job" };
  if (force) {
    // L3: kernel kill, state loss — the only model-reachable path.
    void disposeKernel(chatId, { force: true });
    return { ok: true };
  }
  if (instance.wedged) return { ok: false, reason: "kernel wedged" };
  sendRequest(instance, { type: "interrupt", id: jobId });
  return { ok: true };
}

function sendControl(
  instance: KernelInstance,
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, any> | null> {
  const id = String(request.id);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      instance.control.delete(id);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    instance.control.set(id, (event) => {
      clearTimeout(timer);
      resolve(event);
    });
    sendRequest(instance, request);
  });
}

function snapshotPaths(instance: KernelInstance): { payloadPath: string; manifestPath: string } {
  const dir = instance.stateDir;
  return { payloadPath: join(dir, "namespace.pkl"), manifestPath: join(dir, "manifest.json") };
}

function scheduleSnapshot(instance: KernelInstance): void {
  if (instance.disposed || instance.restoreIncomplete) return;
  if (instance.snapshotTimer) clearTimeout(instance.snapshotTimer);
  instance.snapshotTimer = setTimeout(() => {
    instance.snapshotTimer = null;
    void runSnapshot(instance);
  }, SNAPSHOT_DEBOUNCE_MS);
  instance.snapshotTimer.unref?.();
}

async function runSnapshot(
  instance: KernelInstance,
  controlTimeoutMs = SNAPSHOT_CONTROL_TIMEOUT_MS,
): Promise<void> {
  // Idle means no foreground cell; background jobs never block the flush
  // (asyncio tasks are not serializable and are never captured).
  if (instance.disposed || instance.busy || instance.restoreIncomplete) return;
  const { payloadPath, manifestPath } = snapshotPaths(instance);
  // Capture-freshness memo: skip the re-dump while provably unchanged. The
  // witness is a host stat (§4.1) — a remote host whose stat is not
  // observable yields null and the memo simply never fires.
  if (instance.lastSnapshot && instance.lastSnapshot.executions === instance.executions) {
    const payloadMtime = await instance.host.statMtime(payloadPath);
    if (payloadMtime !== null && payloadMtime === instance.lastSnapshot.payloadMtimeMs) return;
  }
  const result = await sendControl(
    instance,
    {
      type: "snapshot",
      id: randomUUID(),
      path: payloadPath,
      manifest_path: manifestPath,
      max_bytes: snapshotMaxBytes(),
      max_variable_bytes: snapshotMaxVariableBytes(),
    },
    controlTimeoutMs,
  );
  if (result?.status === "ok") {
    const payloadMtime = await instance.host.statMtime(payloadPath);
    const manifestMtime = await instance.host.statMtime(manifestPath);
    instance.lastSnapshot = {
      executions: instance.executions,
      payloadMtimeMs: payloadMtime ?? 0,
      manifestMtimeMs: manifestMtime ?? 0,
    };
  } else if (result) {
    console.warn(`[kernel] chat=${shortId(instance.chatId)} snapshot failed: ${result.reason ?? "unknown"}`);
  }
}

function settlePending(
  instance: KernelInstance,
  pending: PendingExecution,
  status: "ok" | "error",
): void {
  if (pending.settled) return;
  pending.settled = true;
  clearPendingUpdate(pending);
  clearTimeout(pending.deadline);
  pending.signal?.removeEventListener("abort", pending.onAbort!);
  instance.pending.delete(pending.id);
  instance.busy = false;
  instance.lastUsedAt = Date.now();

  const output = outputView(instance, pending);
  const parts: string[] = [];
  if (output) parts.push(output);
  if (pending.resultText !== null) parts.push(pending.resultText);
  let content = parts.join("\n") || "(no output)";
  let isError = false;

  if (pending.timedOut) {
    content = `Python execution timed out after ${pending.timeoutSec}s\n${content}`;
    isError = true;
  } else if (pending.aborted) {
    content = `Python execution aborted\n${content}`.trimEnd();
    isError = true;
  } else if (pending.error) {
    content = formatError(pending.error, output);
    isError = true;
  } else if (status === "error") {
    content = `Python execution failed\n${content}`;
    isError = true;
  }
  instance.executions++;
  scheduleSnapshot(instance);
  const outcome: {
    mode: "kernel";
    content: string;
    isError: boolean;
    images?: Array<{ data: string; mimeType: string }>;
  } = { mode: "kernel", content, isError };
  if (!isError && pending.images.length > 0) {
    outcome.images = pending.images;
  }
  pending.resolve(outcome);
}

function failPending(instance: KernelInstance, pending: PendingExecution, message: string): void {
  if (pending.settled) return;
  pending.settled = true;
  clearPendingUpdate(pending);
  clearTimeout(pending.deadline);
  pending.signal?.removeEventListener("abort", pending.onAbort!);
  instance.pending.delete(pending.id);
  instance.busy = false;
  const tail = instance.stderrTail.trim();
  pending.resolve({
    mode: "kernel",
    content: `${message}${tail ? `\n${tail}` : ""}`,
    isError: true,
  });
}

function wedgePending(instance: KernelInstance, pending: PendingExecution): void {
  if (pending.settled) return;
  pending.settled = true;
  clearPendingUpdate(pending);
  clearTimeout(pending.deadline);
  pending.signal?.removeEventListener("abort", pending.onAbort!);
  instance.pending.delete(pending.id);
  instance.busy = false;
  instance.wedged = true;
  instance.wedgedAt = Date.now();
  console.warn(`[kernel] chat=${shortId(instance.chatId)} wedged: cell did not settle after interrupt`);
  pending.resolve({
    mode: "kernel",
    isError: true,
    content: pending.aborted
      ? "Python execution aborted; the kernel cell is wedged and the namespace is preserved. The next call in this chat runs stateless."
      : "Python execution timed out; the kernel cell is wedged and the namespace is preserved. The next call in this chat runs stateless.",
  });
}

function protocolFailure(instance: KernelInstance, reason: string): void {
  if (instance.disposed) return;
  console.warn(`[kernel] chat=${shortId(instance.chatId)} protocol failure: ${reason}`);
  brokenChats.add(instance.chatId);
  for (const pending of [...instance.pending.values()]) {
    failPending(instance, pending, "Python kernel protocol failure; the kernel was stopped.");
  }
  void instance.proc.kill({ graceMs: 300 });
}

function handleEvent(instance: KernelInstance, event: Record<string, any>): void {
  if (event.event === "job_done") {
    void finishJob(instance, event);
    return;
  }
  if (event.event === "done" && typeof event.id === "string") {
    const control = instance.control.get(event.id);
    if (control) {
      instance.control.delete(event.id);
      control(event);
      return;
    }
  }
  const job = typeof event.id === "string" ? instance.jobs.get(event.id) : undefined;
  if (job) {
    handleJobEvent(job, event);
    return;
  }
  switch (event.event) {
    case "stdout":
    case "stderr": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (!pending) return;
      const text = typeof event.text === "string" ? event.text : "";
      (event.event === "stdout" ? pending.stdout : pending.stderr).push(text);
      pending.pendingUpdateText = outputView(instance, pending);
      schedulePendingUpdate(pending);
      return;
    }
    case "result": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (pending) pending.resultText = typeof event.text === "string" ? event.text : null;
      return;
    }
    case "error": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (pending) {
        pending.error = {
          ename: String(event.ename ?? "Error"),
          evalue: String(event.evalue ?? ""),
          traceback: Array.isArray(event.traceback) ? event.traceback.map(String) : [],
        };
      }
      return;
    }
    case "display": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (!pending || !event.data || typeof event.data !== "object") return;
      for (const [mimeType, payload] of Object.entries(event.data)) {
        if (!mimeType.startsWith("image/") || typeof payload !== "string") continue;
        if (pending.images.length >= DISPLAY_MAX_IMAGES) break;
        pending.images.push({ mimeType, data: payload });
      }
      return;
    }
    case "done": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (!pending) return;
      if (event.timed_out === true) pending.timedOut = true;
      if (pending.background) {
        // Ack for a background execute: register the job and return the id.
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.deadline);
        instance.pending.delete(pending.id);
        const jobId = typeof event.job_id === "string" ? event.job_id : null;
        if (jobId && event.status === "ok") {
          instance.jobs.set(jobId, createJob(instance, jobId));
          instance.jobOrder.push(jobId);
          pending.resolve({
            mode: "kernel",
            isError: false,
            jobId,
            content: `${pending.notice ? `${pending.notice}\n` : ""}Started background job ${jobId}. It runs without holding the turn; end your turn and check python_jobs on a later turn.`,
          });
        } else {
          pending.resolve({
            mode: "kernel",
            isError: true,
            content: "Background job was not acknowledged by the kernel.",
          });
        }
        return;
      }
      settlePending(instance, pending, event.status === "ok" ? "ok" : "error");
      return;
    }
    case "parked_interrupt":
      console.log(`[kernel] chat=${shortId(instance.chatId)} interrupt parked for ${event.for_id}`);
      return;
    default:
      // Unknown events are tolerated for forward compatibility (display, …).
      return;
  }
}

function handleLine(instance: KernelInstance, line: string): void {
  if (line.length > MAX_PROTOCOL_LINE_BYTES) {
    protocolFailure(instance, "oversized protocol frame");
    return;
  }
  let event: Record<string, any>;
  try {
    event = JSON.parse(line);
  } catch {
    protocolFailure(instance, "malformed protocol frame");
    return;
  }
  if (event.event === "ready") {
    if (event.protocol !== PROTOCOL_VERSION) {
      protocolFailure(instance, `protocol mismatch (driver ${event.protocol}, expected ${PROTOCOL_VERSION})`);
      return;
    }
    // §4.3 driver skew: the staged file is not what we launched expecting
    // (another install touched it). Fail the handshake — spawnKernel kills
    // the client and the call degrades to one-shot. Never mark the chat
    // broken: this is stale staging, not protocol corruption.
    if (
      instance.expectedDriverHash &&
      typeof event.driver === "string" &&
      event.driver !== instance.expectedDriverHash
    ) {
      console.warn(
        `[kernel] chat=${shortId(instance.chatId)} driver skew (host ${event.driver}, expected ${instance.expectedDriverHash})`,
      );
      instance.readyResolve?.(false);
      instance.readyResolve = undefined;
      return;
    }
    instance.pythonVersion = String(event.python ?? "");
    instance.readyResolve?.(true);
    instance.readyResolve = undefined;
    return;
  }
  handleEvent(instance, event);
}

function attachReaders(instance: KernelInstance): void {
  instance.proc.stdout?.on("data", (chunk: Buffer) => {
    instance.lineBuffer += instance.decoder.write(chunk);
    if (instance.lineBuffer.length > MAX_PROTOCOL_LINE_BYTES) {
      protocolFailure(instance, "oversized protocol frame");
      return;
    }
    let index: number;
    while ((index = instance.lineBuffer.indexOf("\n")) !== -1) {
      const line = instance.lineBuffer.slice(0, index);
      instance.lineBuffer = instance.lineBuffer.slice(index + 1);
      if (line.trim()) handleLine(instance, line);
    }
  });
  instance.proc.stderr?.on("data", (chunk: Buffer) => {
    instance.stderrTail = (instance.stderrTail + chunk.toString("utf8")).slice(-STDERR_RING_BYTES);
  });
}

async function spawnKernel(chatId: string, cwd: string, host: KernelHost): Promise<KernelInstance | null> {
  const plan = await host.prepare(chatId, cwd).catch(() => null);
  if (!plan) {
    console.warn(`[kernel] host prepare failed for chat=${shortId(chatId)} (${host.kind}); staying stateless`);
    return null;
  }

  let proc: SupervisedProcess;
  try {
    proc = spawnSupervised({
      command: plan.command,
      args: plan.args,
      cwd: plan.cwd,
      env: plan.env,
      key: `kernel:${chatId}`,
      killGraceMs: KERNEL_KILL_GRACE_MS,
    });
  } catch (error) {
    console.warn(`[kernel] spawn failed for chat=${shortId(chatId)}:`, error);
    return null;
  }

  const instance: KernelInstance = {
    chatId,
    cwd,
    host,
    stateDir: plan.stateDir,
    expectedDriverHash: plan.driverHash,
    proc,
    pending: new Map(),
    jobs: new Map(),
    jobOrder: [],
    control: new Map(),
    pythonVersion: "",
    firstNotice: null,
    restoreIncomplete: false,
    executions: 0,
    lastSnapshot: null,
    snapshotTimer: null,
    busy: false,
    wedged: false,
    wedgedAt: null,
    lastUsedAt: Date.now(),
    stderrTail: "",
    lineBuffer: "",
    decoder: new StringDecoder("utf8"),
    disposed: false,
  };
  attachReaders(instance);

  const ready = new Promise<boolean>((resolve) => {
    instance.readyResolve = resolve;
  });
  const readyTimeout = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), READY_TIMEOUT_MS);
    timer.unref?.();
  });
  const exitedFirst = proc.exited.then(() => false);

  const ok = await Promise.race([ready, readyTimeout, exitedFirst]);
  if (!ok || instance.disposed) {
    void proc.kill({ graceMs: 300 });
    return null;
  }

  instance.proc.exited.then(() => {
    if (instance.disposed) return;
    instance.disposed = true;
    if (kernels.get(chatId) === instance) kernels.delete(chatId);
    instance.readyResolve?.(false);
    for (const pending of [...instance.pending.values()]) {
      failPending(instance, pending, "Python kernel exited unexpectedly.");
    }
  });

  // Restore a previous snapshot before the kernel serves any cell. A failed
  // or partial restore marks the kernel so the debounced flush never
  // overwrites a fuller on-disk payload. Existence is checked host-side
  // (§4.1): on a remote host the manager never sees the files themselves.
  const manifestText = await instance.host.readSnapshotManifest(instance.stateDir).catch(() => null);
  if (manifestText) {
    try {
      const manifest = JSON.parse(manifestText);
      const manifestMajor = String(manifest.pythonVersion ?? "").split(".")[0];
      const runningMajor = instance.pythonVersion.split(".")[0];
      if (manifestMajor && runningMajor && manifestMajor !== runningMajor) {
        instance.firstNotice = `[kernel: snapshot skipped (python ${manifest.pythonVersion} -> ${instance.pythonVersion})]`;
      } else {
        const { payloadPath } = snapshotPaths(instance);
        const restored = await sendControl(
          instance,
          { type: "restore", id: randomUUID(), path: payloadPath },
          RESTORE_CONTROL_TIMEOUT_MS,
        );
        if (restored?.status === "ok") {
          const count = Array.isArray(restored.restored) ? restored.restored.length : 0;
          const failed = Array.isArray(restored.failed) ? restored.failed.length : 0;
          const fallbackNote =
            failed > 0 && restored.engine === "pickle" ? " (pickle fallback: plain data only)" : "";
          if (count > 0 || failed > 0) {
            instance.firstNotice = `[kernel: restored ${count} name(s)${failed ? `; ${failed} failed${fallbackNote}` : ""}]`;
          }
          if (failed > 0) instance.restoreIncomplete = true;
        } else {
          instance.restoreIncomplete = true;
          if (restored?.reason) instance.firstNotice = `[kernel: restore failed: ${restored.reason}]`;
        }
      }
    } catch (error) {
      instance.restoreIncomplete = true;
      console.warn(`[kernel] restore failed for chat=${shortId(chatId)}:`, error);
    }
  }

  kernels.set(chatId, instance);
  startKernelReaper();
  return instance;
}

async function evictIdleKernels(needed: number): Promise<void> {
  const idle = [...kernels.values()]
    .filter((instance) => !instance.busy && countRunningJobs(instance) === 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (kernels.size >= needed && idle.length > 0) {
    const victim = idle.shift()!;
    console.log(`[kernel] evicting idle kernel for chat=${shortId(victim.chatId)} (LRU)`);
    await disposeKernel(victim.chatId).catch(() => {});
  }
}

type KernelAcquisition =
  | { instance: KernelInstance; recreated: boolean }
  | { reason: KernelFallbackReason };

async function acquireKernel(chatId: string, cwd: string, host: KernelHost): Promise<KernelAcquisition> {
  const existing = kernels.get(chatId);
  if (existing?.wedged) return { reason: "wedge" };
  if (existing && existing.cwd === cwd && existing.host.kind === host.kind) return { instance: existing, recreated: false };
  if (existing) {
    // Project/location change (or a switch to a different host/transport): a
    // kernel's cwd is fixed at creation, and the snapshot belongs to the old
    // workspace — remove it rather than restore stale paths into the new one.
    await disposeKernel(chatId, { removeState: true }).catch(() => {});
  }
  await evictIdleKernels(maxKernels());
  if (kernels.size >= maxKernels()) return { reason: "capacity" };
  const instance = await spawnKernel(chatId, cwd, host);
  if (!instance) return { reason: host.failureReason };
  return { instance, recreated: Boolean(existing) };
}

function consumeNotice(instance: KernelInstance, recreated: boolean): string | null {
  const notices: string[] = [];
  if (recreated) notices.push("[kernel: workspace changed; started a fresh namespace]");
  if (instance.firstNotice) {
    notices.push(instance.firstNotice);
    instance.firstNotice = null;
  }
  return notices.length ? notices.join("\n") : null;
}

function makePendingBase(
  id: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onUpdate: ((text: string) => void) | undefined,
  notice: string | null,
): PendingExecution {
  return {
    id,
    timeoutSec: Math.max(1, Math.round(timeoutMs / 1000)),
    startedAt: Date.now(),
    stdout: [],
    stderr: [],
    resultText: null,
    error: null,
    timedOut: false,
    aborted: false,
    settled: false,
    deadline: setTimeout(() => {}, 0),
    lastUpdateAt: 0,
    pendingUpdateText: null,
    signal,
    onUpdate,
    images: [],
    notice,
    resolve: () => {},
  };
}

export async function executeInKernel(opts: KernelRunOptions): Promise<KernelRunOutcome> {
  const { chatId, cwd, code, timeoutMs, signal, background } = opts;
  const host = opts.host ?? localKernelHost;
  if (brokenChats.has(chatId)) return { mode: "fallback", reason: "broken" };

  if (background) {
    const pause = await getStoredSystemPauseState().catch(() => null);
    if (pause?.active) {
      return { mode: "kernel", isError: true, content: "[system paused: background jobs cannot start]" };
    }
    const acquisition = await acquireKernel(chatId, cwd, host);
    if ("reason" in acquisition) return { mode: "fallback", reason: acquisition.reason };
    const instance = acquisition.instance;
    const runningOnKernel = countRunningJobs(instance);
    const runningBox = countRunningJobsBox();
    if (runningOnKernel >= JOB_MAX_PER_KERNEL || runningBox >= JOB_MAX_BOX) {
      return {
        mode: "kernel",
        isError: true,
        content: `[job limit reached: ${runningOnKernel}/${JOB_MAX_PER_KERNEL} running in this chat, ${runningBox}/${JOB_MAX_BOX} box-wide]`,
      };
    }
    const notice = consumeNotice(instance, acquisition.recreated);
    const id = randomUUID();
    return new Promise<KernelRunOutcome>((resolve) => {
      const pending = makePendingBase(id, timeoutMs, signal, undefined, notice);
      pending.background = true;
      pending.resolve = resolve;
      // The ack deadline is short: the driver acks before running the job.
      pending.deadline = setTimeout(() => {
        if (pending.settled) return;
        pending.settled = true;
        instance.pending.delete(id);
        pending.resolve({
          mode: "kernel",
          isError: true,
          content: "Background job was not acknowledged by the kernel.",
        });
      }, JOB_ACK_TIMEOUT_MS);
      pending.deadline.unref?.();
      instance.pending.set(id, pending);
      sendRequest(instance, { type: "execute", id, code, timeout_ms: timeoutMs, background: true });
    });
  }

  const acquisition = await acquireKernel(chatId, cwd, host);
  if ("reason" in acquisition) return { mode: "fallback", reason: acquisition.reason };
  const instance = acquisition.instance;
  if (instance.busy) return { mode: "fallback", reason: "capacity" };
  // A synchronous background job blocks the driver's event loop: a foreground
  // cell sent now would sit queued past its deadline, and the wedge policy
  // would then kill a healthy kernel — and the job with it. Reject fast
  // instead of letting the send time out silently (10-05 fifth review,
  // finding C). Background sends are unaffected — they are the mechanism that
  // runs behind a blocked loop.
  const runningJobIds = [...instance.jobs.values()]
    .filter((job) => job.status === "running")
    .map((job) => job.id);
  if (runningJobIds.length > 0) {
    return {
      mode: "kernel",
      isError: true,
      content:
        `[foreground execution rejected: ${runningJobIds.length} background job(s) still running in this kernel (${runningJobIds.join(", ")}). ` +
        "A synchronous job blocks the kernel's event loop, so this cell would queue past its deadline and the wedge policy would kill a healthy kernel — and the job with it. " +
        "Inspect or kill the job with python_jobs, or send this work as a background job.",
    };
  }
  const notice = consumeNotice(instance, acquisition.recreated);

  const id = randomUUID();
  return new Promise<KernelRunOutcome>((resolve) => {
    const pending = makePendingBase(id, timeoutMs, signal, opts.onUpdate, notice);
    pending.resolve = (outcome) => {
      if (notice && outcome.mode === "kernel") {
        resolve({ ...outcome, content: `${notice}\n${outcome.content}` });
      } else {
        resolve(outcome);
      }
    };

    const armDeadline = (ms: number) => {
      clearTimeout(pending.deadline);
      pending.deadline = setTimeout(() => wedgePending(instance, pending), ms);
    };
    armDeadline(timeoutMs + wedgeGraceMs());

    pending.onAbort = () => {
      if (pending.settled) return;
      pending.aborted = true;
      sendRequest(instance, { type: "interrupt", id });
      armDeadline(wedgeGraceMs());
    };
    if (signal) {
      signal.addEventListener("abort", pending.onAbort, { once: true });
      if (signal.aborted) pending.onAbort();
    }

    instance.pending.set(id, pending);
    instance.busy = true;
    sendRequest(instance, { type: "execute", id, code, timeout_ms: timeoutMs });
  });
}

export async function disposeKernel(
  chatId: string,
  opts?: { force?: boolean; removeState?: boolean },
): Promise<void> {
  // Disposal clears the protocol-failure disable: the flag exists to stop a
  // respawn loop against one broken kernel generation, and every fresh
  // generation gets a clean attempt (a repeat corruption re-marks it,
  // protocolFailure §4.3). Sticky-until-restart would silently strand a
  // long-lived chat — the system chat is never deleted, so its kernel would
  // stay stateless for the server's whole lifetime.
  const wasBroken = brokenChats.has(chatId);
  brokenChats.delete(chatId);
  const instance = kernels.get(chatId);
  if (!instance) {
    if (opts?.removeState) {
      await rm(kernelStateDir(chatId), { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  kernels.delete(chatId);
  if (instance.snapshotTimer) {
    clearTimeout(instance.snapshotTimer);
    instance.snapshotTimer = null;
  }
  // Flush only when idle: a snapshot queued behind a running cell would never
  // finish before SIGKILL, so a busy kernel gets hard-crash semantics. A
  // protocol-broken kernel cannot serve the control request either — skip the
  // bounded attempt.
  if (!opts?.force && !wasBroken && !instance.wedged && !instance.busy && !instance.restoreIncomplete) {
    // Bounded: a sync job can block the loop, and disposal must not wait the
    // full control timeout for a snapshot that cannot be served.
    await runSnapshot(instance, 2000).catch(() => {});
  }
  // Protocol shutdown goes out BEFORE marking disposed (sendRequest checks
  // that flag); the driver kills its own journaled child groups and exits.
  // `force` (L3) skips the protocol path entirely.
  if (!opts?.force) {
    try {
      instance.proc.write(`${JSON.stringify({ type: "shutdown", id: randomUUID() })}\n`);
    } catch {
      // fall through to the kill
    }
  }
  instance.disposed = true;
  for (const pending of [...instance.pending.values()]) {
    failPending(instance, pending, "Python kernel disposed.");
  }
  for (const job of instance.jobs.values()) {
    if (job.status !== "running") continue;
    job.status = "error";
    job.finishedAt = Date.now();
    void job.capture.finish().catch(() => {});
  }
  if (!instance.wedged && !opts?.force) {
    // A wedged loop cannot process the shutdown request; skip straight to the
    // kill instead of waiting out the protocol timeout.
    try {
      await Promise.race([instance.proc.exited, delay(SHUTDOWN_WAIT_MS)]);
    } catch {
      // fall through to the kill
    }
  }
  await instance.proc.kill({ graceMs: opts?.force ? 300 : KERNEL_KILL_GRACE_MS }).catch(() => {});
  // Ordinary disposal (TTL, LRU, shutdown) keeps the snapshot for the next
  // kernel to restore; only a workspace change or chat deletion removes it.
  // Removal is host-side (§4.4) — for an ssh kernel the state lives on the
  // host; a dropped channel makes it a best-effort no-op and the driver's
  // boot prune expires it there eventually.
  if (opts?.removeState) {
    await instance.host.removeState(chatId).catch(() => {});
  }
}

export async function disposeAllKernels(): Promise<void> {
  const ids = [...kernels.keys()];
  await Promise.allSettled(ids.map((chatId) => disposeKernel(chatId)));
}

export function isKernelWedge(chatId: string): boolean {
  return kernels.get(chatId)?.wedged === true;
}

export function startKernelReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    void reapIdleKernels();
  }, REAPER_INTERVAL_MS);
  reaperTimer.unref?.();
}

async function reapIdleKernels(): Promise<void> {
  const ttl = idleTtlMs();
  const now = Date.now();
  for (const instance of [...kernels.values()]) {
    // Never evict a kernel with a running cell or live background job.
    if (instance.busy || countRunningJobs(instance) > 0) continue;
    const anchor = instance.wedged ? instance.wedgedAt ?? instance.lastUsedAt : instance.lastUsedAt;
    if (now - anchor > ttl) {
      console.log(`[kernel] reaping idle kernel for chat=${shortId(instance.chatId)}`);
      await disposeKernel(instance.chatId).catch(() => {});
    }
  }
}

interface ChildJournalRecord {
  version: number;
  pid: number;
  pgid: number;
  startId?: string;
  cell?: string | null;
  active: boolean;
  recordedAt: string;
}

/**
 * Reap subprocess groups journaled by a previous server run, then remove the
 * stale state directories. The kernel process itself is covered by the
 * supervisor journal (swept earlier at startup); this covers its setsid'd
 * children. Runs before any kernel can spawn.
 */
/**
 * Reap subprocess groups journaled by a previous server run, then remove
 * expired state directories. The kernel process itself is covered by the
 * supervisor journal (swept earlier at startup); this covers its setsid'd
 * children. Runs before any kernel can spawn.
 *
 * Young directories are KEPT: they hold the snapshots the next kernel
 * restores from. A missing journal means "nothing to reap", not "remove" —
 * only directories past the 14-day TTL are deleted here.
 */
export async function sweepKernelJournals(): Promise<number> {
  const root = kernelRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let reaped = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      const info = await stat(dir);
      if (Date.now() - info.mtimeMs > KERNEL_STATE_TTL_MS) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      continue;
    }
    const journalPath = join(dir, "children.jsonl");
    let text: string;
    try {
      text = await readFile(journalPath, "utf8");
    } catch {
      // No journal: nothing to reap; keep the snapshot.
      continue;
    }
    const last = new Map<number, ChildJournalRecord>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as ChildJournalRecord;
        if (typeof record?.pid === "number" && record.pid > 0) last.set(record.pid, record);
      } catch {
        // Torn tail line.
      }
    }
    for (const record of last.values()) {
      if (record.active === false) continue;
      const pgid = typeof record.pgid === "number" && record.pgid > 0 ? record.pgid : record.pid;
      if (!isGroupAlive(pgid)) continue;
      const currentStartId = readProcessStartId(record.pid);
      if (record.startId && currentStartId && currentStartId !== record.startId) continue;
      console.log(`[kernel] reaping orphaned child group ${pgid} (chat=${shortId(entry.name)})`);
      if (await killProcessGroup(pgid, { graceMs: 500 })) reaped++;
    }
    // The previous kernel is dead (the supervisor sweep ran first); clear its
    // journal so it does not grow across runs, and keep the directory for the
    // snapshot restore.
    await truncate(journalPath, 0).catch(() => {});
  }
  return reaped;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
