import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBootId } from "./job-lock.js";
import {
  DataDirAlreadyRunningError,
  acquireDataDirLock,
  dataDirLockEnabled,
  readDataDirLock,
  type DataDirLockRecord,
} from "./data-dir-lock.js";
import { readProcessStartId } from "./process-supervisor.js";

/**
 * One server per data directory (docs/design/job-supervisor.md §7). The lock is
 * an identity claim, not a file's existence: it has to survive crashes, pid
 * reuse, and reboots without either deadlocking a restart or letting two
 * servers share one ~/.porrima.
 */

let dir = "";
let lockPath = "";

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "porrima-lock-"));
  lockPath = join(dir, "server.lock");
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
  lockPath = "";
  delete process.env.PORRIMA_DATA_DIR_LOCK;
});

function foreignRecord(overrides: Partial<DataDirLockRecord> = {}): DataDirLockRecord {
  return {
    pid: 2147483647,
    start_id: "proc:1",
    boot_id: readBootId(),
    started_at: new Date().toISOString(),
    port: 3001,
    ...overrides,
  };
}

describe("data-dir instance lock", () => {
  it("claims the data dir and releases the claim", async () => {
    await setup();
    const lock = acquireDataDirLock({ lockPath, port: 3001 });

    const record = readDataDirLock(lockPath);
    expect(record?.pid).toBe(process.pid);
    expect(record?.port).toBe(3001);
    expect(record?.start_id).toBe(readProcessStartId(process.pid));
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);

    lock.release();
    expect(readDataDirLock(lockPath)).toBeNull();
  });

  it("refuses a second server while a live holder exists, and says who", async () => {
    await setup();
    const held = acquireDataDirLock({ lockPath, port: 3001 });

    let error: unknown = null;
    try {
      acquireDataDirLock({ lockPath, port: 3002 });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DataDirAlreadyRunningError);
    const message = (error as Error).message;
    expect(message).toContain(String(process.pid));
    expect(message).toContain("port 3001");
    expect(message).toContain("PORRIMA_DATA_DIR_LOCK=0");
    // Refusing must not destroy the holder's claim.
    expect(readDataDirLock(lockPath)?.port).toBe(3001);

    held.release();
  });

  it("reclaims a lock whose pid is alive but is a different process", async () => {
    await setup();
    // Pid reuse: this process exists, but it is not the one that wrote the file.
    await writeFile(
      lockPath,
      JSON.stringify({ ...foreignRecord(), pid: process.pid, start_id: "proc:not-this-process" }),
      { mode: 0o600 },
    );

    const lock = acquireDataDirLock({ lockPath, port: 3001 });
    expect(readDataDirLock(lockPath)?.start_id).toBe(readProcessStartId(process.pid));
    lock.release();
  });

  it("reclaims a lock left by another boot", async () => {
    await setup();
    await writeFile(
      lockPath,
      JSON.stringify({
        ...foreignRecord(),
        pid: process.pid,
        start_id: readProcessStartId(process.pid),
        boot_id: "a-boot-that-is-not-this-one",
      }),
      { mode: 0o600 },
    );

    const lock = acquireDataDirLock({ lockPath, port: 3001 });
    expect(readDataDirLock(lockPath)?.boot_id).toBe(readBootId());
    lock.release();
  });

  it("reclaims a torn or unreadable lock", async () => {
    await setup();
    await writeFile(lockPath, '{"pid": 12', { mode: 0o600 });

    const lock = acquireDataDirLock({ lockPath, port: 3001 });
    expect(readDataDirLock(lockPath)?.pid).toBe(process.pid);
    lock.release();
  });

  it("does not release a claim someone else now holds", async () => {
    await setup();
    const lock = acquireDataDirLock({ lockPath, port: 3001 });

    // Simulate a takeover (crash recovery by another instance): the file no
    // longer describes us, so our release must leave it alone.
    const other = foreignRecord();
    await writeFile(lockPath, JSON.stringify(other), { mode: 0o600 });

    lock.release();
    expect(readDataDirLock(lockPath)?.pid).toBe(other.pid);
  });

  it("is opt-out only by explicit setting", () => {
    expect(dataDirLockEnabled({})).toBe(true);
    expect(dataDirLockEnabled({ PORRIMA_DATA_DIR_LOCK: "1" })).toBe(true);
    expect(dataDirLockEnabled({ PORRIMA_DATA_DIR_LOCK: "0" })).toBe(false);
  });

  it("keeps the lock file out of the way of the data it protects", async () => {
    await setup();
    const lock = acquireDataDirLock({ lockPath, port: 3001 });
    const raw = JSON.parse(await readFile(lockPath, "utf8"));
    expect(Object.keys(raw).sort()).toEqual(
      ["boot_id", "pid", "port", "start_id", "started_at"].sort(),
    );
    lock.release();
  });
});
