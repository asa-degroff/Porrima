import { existsSync } from "fs";
import { mkdir, readFile, readdir, rm } from "fs/promises";
import { dirname, join } from "path";
import { StringDecoder } from "string_decoder";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { appDataPath } from "./paths.js";
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

export type KernelFallbackReason = "capacity" | "spawn-failed" | "wedge" | "broken";

export type KernelRunOutcome =
  | { mode: "kernel"; content: string; isError: boolean }
  | { mode: "fallback"; reason: KernelFallbackReason };

export interface KernelRunOptions {
  chatId: string;
  cwd: string;
  code: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Live view updates (stdout+stderr so far) for the streaming seam. */
  onUpdate?: (text: string) => void;
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
  signal?: AbortSignal;
  onAbort?: () => void;
  onUpdate?: (text: string) => void;
  resolve: (outcome: KernelRunOutcome) => void;
}

interface KernelInstance {
  chatId: string;
  cwd: string;
  proc: SupervisedProcess;
  pending: Map<string, PendingExecution>;
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

function formatError(error: KernelErrorEvent, output: string): string {
  const traceback = (error.traceback ?? []).join("").trimEnd();
  const head = traceback || `${error.ename}: ${error.evalue}`;
  return output ? `${head}\n${output}` : head;
}

function settlePending(
  instance: KernelInstance,
  pending: PendingExecution,
  status: "ok" | "error",
): void {
  if (pending.settled) return;
  pending.settled = true;
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
  pending.resolve({ mode: "kernel", content, isError });
}

function failPending(instance: KernelInstance, pending: PendingExecution, message: string): void {
  if (pending.settled) return;
  pending.settled = true;
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
  switch (event.event) {
    case "stdout":
    case "stderr": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (!pending) return;
      const text = typeof event.text === "string" ? event.text : "";
      (event.event === "stdout" ? pending.stdout : pending.stderr).push(text);
      pending.onUpdate?.(outputView(instance, pending));
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
    case "done": {
      const pending = typeof event.id === "string" ? instance.pending.get(event.id) : undefined;
      if (!pending) return;
      if (event.timed_out === true) pending.timedOut = true;
      settlePending(instance, pending, event.status === "ok" ? "ok" : "error");
      return;
    }
    case "parked_interrupt":
      console.log(`[kernel] chat=${shortId(instance.chatId)} interrupt parked for ${event.for_id}`);
      return;
    default:
      // Unknown events are tolerated for forward compatibility (display, jobs).
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

async function spawnKernel(chatId: string, cwd: string): Promise<KernelInstance | null> {
  const driver = resolveDriverPath();
  if (!driver) {
    console.warn("[kernel] driver not found; run_python stays stateless");
    return null;
  }
  const stateDir = kernelStateDir(chatId);
  await mkdir(stateDir, { recursive: true, mode: 0o700 }).catch(() => {});

  let proc: SupervisedProcess;
  try {
    proc = spawnSupervised({
      command: process.env.PORRIMA_PYTHON || "python3",
      args: ["-u", driver],
      cwd,
      env: {
        ...process.env,
        PORRIMA_KERNEL_DIR: stateDir,
        PORRIMA_KERNEL_OWNER_PID: String(process.pid),
        PYTHONDONTWRITEBYTECODE: "1",
      },
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
    proc,
    pending: new Map(),
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

  kernels.set(chatId, instance);
  startKernelReaper();
  return instance;
}

async function evictIdleKernels(needed: number): Promise<void> {
  const idle = [...kernels.values()]
    .filter((instance) => !instance.busy)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (kernels.size >= needed && idle.length > 0) {
    const victim = idle.shift()!;
    console.log(`[kernel] evicting idle kernel for chat=${shortId(victim.chatId)} (LRU)`);
    await disposeKernel(victim.chatId).catch(() => {});
  }
}

export async function executeInKernel(opts: KernelRunOptions): Promise<KernelRunOutcome> {
  const { chatId, cwd, code, timeoutMs, signal } = opts;
  if (brokenChats.has(chatId)) return { mode: "fallback", reason: "broken" };

  let instance = kernels.get(chatId);
  if (instance?.wedged) return { mode: "fallback", reason: "wedge" };
  if (instance?.busy) return { mode: "fallback", reason: "capacity" };

  let notice: string | null = null;
  if (instance && instance.cwd !== cwd) {
    await disposeKernel(chatId).catch(() => {});
    instance = undefined;
    notice = "[kernel: workspace changed; started a fresh namespace]";
  }
  if (!instance) {
    await evictIdleKernels(maxKernels());
    if (kernels.size >= maxKernels()) return { mode: "fallback", reason: "capacity" };
    instance = (await spawnKernel(chatId, cwd)) ?? undefined;
    if (!instance) return { mode: "fallback", reason: "spawn-failed" };
  }

  const id = randomUUID();
  const timeoutSec = Math.max(1, Math.round(timeoutMs / 1000));
  return new Promise<KernelRunOutcome>((resolve) => {
    const pending: PendingExecution = {
      id,
      timeoutSec,
      startedAt: Date.now(),
      stdout: [],
      stderr: [],
      resultText: null,
      error: null,
      timedOut: false,
      aborted: false,
      settled: false,
      deadline: setTimeout(() => {}, 0),
      signal,
      onUpdate: opts.onUpdate,
      resolve: (outcome) => {
        if (notice && outcome.mode === "kernel") {
          resolve({ ...outcome, content: `${notice}\n${outcome.content}` });
        } else {
          resolve(outcome);
        }
      },
    };

    const armDeadline = (ms: number) => {
      clearTimeout(pending.deadline);
      pending.deadline = setTimeout(() => wedgePending(instance!, pending), ms);
    };
    armDeadline(timeoutMs + wedgeGraceMs());

    pending.onAbort = () => {
      if (pending.settled) return;
      pending.aborted = true;
      sendRequest(instance!, { type: "interrupt", id });
      armDeadline(wedgeGraceMs());
    };
    if (signal) {
      signal.addEventListener("abort", pending.onAbort, { once: true });
      if (signal.aborted) pending.onAbort();
    }

    instance!.pending.set(id, pending);
    instance!.busy = true;
    sendRequest(instance!, { type: "execute", id, code, timeout_ms: timeoutMs });
  });
}

export async function disposeKernel(chatId: string): Promise<void> {
  const instance = kernels.get(chatId);
  if (!instance) return;
  kernels.delete(chatId);
  // Protocol shutdown goes out BEFORE marking disposed (sendRequest checks
  // that flag); the driver kills its own journaled child groups and exits.
  try {
    instance.proc.write(`${JSON.stringify({ type: "shutdown", id: randomUUID() })}\n`);
  } catch {
    // fall through to the kill
  }
  instance.disposed = true;
  for (const pending of [...instance.pending.values()]) {
    failPending(instance, pending, "Python kernel disposed.");
  }
  if (!instance.wedged) {
    // A wedged loop cannot process the shutdown request; skip straight to the
    // kill instead of waiting out the protocol timeout.
    try {
      await Promise.race([instance.proc.exited, delay(SHUTDOWN_WAIT_MS)]);
    } catch {
      // fall through to the kill
    }
  }
  await instance.proc.kill({ graceMs: KERNEL_KILL_GRACE_MS }).catch(() => {});
  await rm(kernelStateDir(chatId), { recursive: true, force: true }).catch(() => {});
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
    if (instance.busy) continue;
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
    let text: string;
    try {
      text = await readFile(join(dir, "children.jsonl"), "utf8");
    } catch {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
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
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return reaped;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
