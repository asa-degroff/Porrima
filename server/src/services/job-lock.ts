import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { readProcessStartId } from "./process-supervisor.js";

/**
 * One supervisor per user/data dir. The lock is a file with pid + start time +
 * boot id, not an OS lock: a stale lock from a crash is recoverable, and a
 * recycled pid can never be mistaken for the live daemon.
 */

export interface JobLock {
  path: string;
  bootId: string;
  release(): void;
}

interface LockRecord {
  pid: number;
  start_id: string | null;
  boot_id: string;
  started_at: string;
}

export class JobSupervisorAlreadyRunningError extends Error {
  constructor(readonly lockPath: string) {
    super(`job supervisor is already running (${lockPath})`);
    this.name = "JobSupervisorAlreadyRunningError";
  }
}

let cachedBootId: string | null = null;

export function readBootId(): string {
  if (cachedBootId) return cachedBootId;
  try {
    cachedBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || "unknown";
  } catch {
    cachedBootId = "unknown";
  }
  return cachedBootId;
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockRecord>;
    if (
      typeof parsed.pid === "number" &&
      parsed.pid > 0 &&
      typeof parsed.boot_id === "string" &&
      typeof parsed.started_at === "string" &&
      (typeof parsed.start_id === "string" || parsed.start_id === null)
    ) {
      return parsed as LockRecord;
    }
  } catch {
    // Torn or absent lock: treat as stale.
  }
  return null;
}

export function acquireJobLock(lockPath: string, bootId = readBootId()): JobLock {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const ownStart = readProcessStartId(process.pid) ?? null;
  const record: LockRecord = {
    pid: process.pid,
    start_id: ownStart,
    boot_id: bootId,
    started_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify(record));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        path: lockPath,
        bootId,
        release: () => {
          if (released) return;
          released = true;
          const current = readLock(lockPath);
          if (
            current &&
            current.pid === record.pid &&
            current.start_id === record.start_id &&
            current.boot_id === record.boot_id
          ) {
            try {
              unlinkSync(lockPath);
            } catch {
              // Already gone.
            }
          }
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readLock(lockPath);
      if (
        existing &&
        existing.boot_id === bootId &&
        isProcessAlive(existing.pid) &&
        existing.start_id === (readProcessStartId(existing.pid) ?? null)
      ) {
        throw new JobSupervisorAlreadyRunningError(lockPath);
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Another contender may have removed it first.
      }
    }
  }
  throw new JobSupervisorAlreadyRunningError(lockPath);
}