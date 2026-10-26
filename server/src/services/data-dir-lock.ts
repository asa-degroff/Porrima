import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { readBootId } from "./job-lock.js";
import { readProcessStartId } from "./process-supervisor.js";
import { appDataPath } from "./paths.js";

/**
 * One server per data directory (docs/design/job-supervisor.md §7).
 *
 * Two servers over one `~/.porrima` is a destructive race, not a cosmetic
 * collision: each one owns the chats, the scheduler, the kernels, and a job
 * supervisor client that can stop another's jobs. A dev instance pointed at
 * the production data dir can stop production chats, and a second instance can
 * dispose a live kernel with work running in it.
 *
 * The lock is a file with pid + process start identity + boot id, the same
 * shape as the supervisor's singleton lock: a stale lock from a crash is
 * recoverable, and a recycled pid can never be mistaken for the live holder.
 */

export const DATA_DIR_LOCK_NAME = "server.lock";

export interface DataDirLockRecord {
  pid: number;
  start_id: string | null;
  boot_id: string;
  started_at: string;
  port: number | null;
}

export interface DataDirLock {
  path: string;
  record: DataDirLockRecord;
  release(): void;
}

export class DataDirAlreadyRunningError extends Error {
  constructor(readonly lockPath: string, readonly holder: DataDirLockRecord | null) {
    super(
      `another Porrima server already holds this data directory: ${describeHolder(holder)} ` +
        `(lock ${lockPath}). Stop that instance, point this one at its own ` +
        `PORRIMA_DATA_DIR, or set PORRIMA_DATA_DIR_LOCK=0 to accept the race.`,
    );
    this.name = "DataDirAlreadyRunningError";
  }
}

export function dataDirLockPath(): string {
  return appDataPath(DATA_DIR_LOCK_NAME);
}

/** `PORRIMA_DATA_DIR_LOCK=0` opts out — a documented escape hatch, not a default. */
export function dataDirLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORRIMA_DATA_DIR_LOCK !== "0";
}

export function describeHolder(holder: DataDirLockRecord | null): string {
  if (!holder) return "holder unknown";
  const port = holder.port != null ? ` port ${holder.port}` : "";
  return `pid ${holder.pid}${port}, started ${holder.started_at}`;
}

/** The current holder, or null when the lock is absent, torn, or unreadable. */
export function readDataDirLock(lockPath = dataDirLockPath()): DataDirLockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<DataDirLockRecord>;
    if (
      typeof parsed.pid === "number" &&
      parsed.pid > 0 &&
      typeof parsed.boot_id === "string" &&
      typeof parsed.started_at === "string" &&
      (typeof parsed.start_id === "string" || parsed.start_id === null)
    ) {
      return {
        pid: parsed.pid,
        start_id: parsed.start_id,
        boot_id: parsed.boot_id,
        started_at: parsed.started_at,
        port: typeof parsed.port === "number" ? parsed.port : null,
      };
    }
  } catch {
    // Absent or torn lock: nothing to honor.
  }
  return null;
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

/** A holder is real only when its pid is alive *and* still the same process. */
function isLiveHolder(record: DataDirLockRecord, bootId: string): boolean {
  return (
    record.boot_id === bootId &&
    isProcessAlive(record.pid) &&
    record.start_id === (readProcessStartId(record.pid) ?? null)
  );
}

export function acquireDataDirLock(
  options: { lockPath?: string; port?: number; bootId?: string } = {},
): DataDirLock {
  const lockPath = options.lockPath ?? dataDirLockPath();
  const bootId = options.bootId ?? readBootId();
  const record: DataDirLockRecord = {
    pid: process.pid,
    start_id: readProcessStartId(process.pid) ?? null,
    boot_id: bootId,
    started_at: new Date().toISOString(),
    port: options.port ?? null,
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
        record,
        release: () => {
          if (released) return;
          released = true;
          const current = readDataDirLock(lockPath);
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
      const existing = readDataDirLock(lockPath);
      if (existing && isLiveHolder(existing, bootId)) {
        throw new DataDirAlreadyRunningError(lockPath, existing);
      }
      // Stale (dead pid, recycled pid, different boot, torn record): take it over.
      try {
        unlinkSync(lockPath);
      } catch {
        // Another contender may have removed it first.
      }
    }
  }

  const existing = readDataDirLock(lockPath);
  if (existing && isLiveHolder(existing, bootId)) {
    throw new DataDirAlreadyRunningError(lockPath, existing);
  }
  throw new DataDirAlreadyRunningError(lockPath, existing);
}
