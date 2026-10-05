import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isGroupAlive,
  killAllSupervised,
  listSupervised,
  spawnSupervised,
  sweepSupervisorJournal,
} from "./process-supervisor.js";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "porrima-supervisor-"));
  roots.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Attach synchronously after spawnSupervised returns (stream contract). */
function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve) => {
    if (!stream) {
      resolve("");
      return;
    }
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

afterEach(async () => {
  await killAllSupervised({ graceMs: 200 });
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("process supervisor", () => {
  it("captures stdout and resolves the exit code", async () => {
    const cwd = await tempDir();
    const proc = spawnSupervised({ command: "bash", args: ["-c", "printf hello"], cwd, key: "test:hello" });
    const out = collect(proc.stdout);
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(exit.error).toBeUndefined();
    expect(await out).toBe("hello");
  });

  it("writes stdinPayload and closes stdin", async () => {
    const cwd = await tempDir();
    const proc = spawnSupervised({ command: "cat", cwd, key: "test:cat-payload", stdinPayload: "ping" });
    const out = collect(proc.stdout);
    await proc.exited;
    expect(await out).toBe("ping");
  });

  it("keeps stdin open for write/endStdin", async () => {
    const cwd = await tempDir();
    const proc = spawnSupervised({ command: "cat", cwd, key: "test:cat-live" });
    const out = collect(proc.stdout);
    proc.write("a");
    proc.endStdin();
    await proc.exited;
    expect(await out).toBe("a");
  });

  it("kills a TERM-ignoring group and confirms death", async () => {
    const cwd = await tempDir();
    const proc = spawnSupervised({
      command: "bash",
      args: ["-c", "trap '' TERM; echo ready; sleep 30"],
      cwd,
      key: "test:stubborn",
    });
    await withTimeout(
      new Promise<void>((resolve) => {
        proc.stdout!.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("ready")) resolve();
        });
      }),
      2000,
      "trap install",
    );
    const started = Date.now();
    await proc.kill({ graceMs: 150 });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(isGroupAlive(proc.pid)).toBe(false);
  });

  it("does not let a daemonized grandchild hold exited, and still reaps it", async () => {
    const cwd = await tempDir();
    const proc = spawnSupervised({
      command: "bash",
      args: ["-c", "sleep 30 & echo done"],
      cwd,
      key: "test:daemon",
    });
    const gotDone = new Promise<void>((resolve) => {
      proc.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString("utf8").includes("done")) resolve();
      });
    });
    const exit = await withTimeout(proc.exited, 1500, "exited");
    await gotDone;
    expect(exit.code).toBe(0);
    // The sleep outlived the shell; the registry must still track the group.
    expect(isGroupAlive(proc.pid)).toBe(true);
    await proc.kill({ graceMs: 100 });
    expect(isGroupAlive(proc.pid)).toBe(false);
  });

  it("journals spawns and sweeps orphaned groups", async () => {
    const cwd = await tempDir();
    const journal = join(await tempDir(), "children.jsonl");
    const proc = spawnSupervised({
      command: "bash",
      args: ["-c", "sleep 30"],
      cwd,
      key: "test:orphan",
      journalPath: journal,
    });
    await delay(150);
    const records = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ pid: proc.pid, key: "test:orphan", active: true });
    expect(records[0].startId).toMatch(/^proc:/);

    const reaped = await sweepSupervisorJournal(journal);
    expect(reaped).toBe(1);
    expect(isGroupAlive(proc.pid)).toBe(false);
    expect((await readFile(journal, "utf8")).trim()).toBe("");
  });

  it("skips journal records whose leader startId no longer matches", async () => {
    const cwd = await tempDir();
    const journal = join(await tempDir(), "children.jsonl");
    const proc = spawnSupervised({
      command: "bash",
      args: ["-c", "sleep 30"],
      cwd,
      key: "test:reused-pid",
      journalPath: journal,
    });
    await delay(150);
    const record = JSON.parse((await readFile(journal, "utf8")).trim().split("\n")[0]);
    await writeFile(journal, `${JSON.stringify({ ...record, startId: "proc:1" })}\n`);

    const reaped = await sweepSupervisorJournal(journal);
    expect(reaped).toBe(0);
    expect(isGroupAlive(proc.pid)).toBe(true);
    await proc.kill({ graceMs: 100 });
  });

  it("resolves spawn errors without throwing and journals nothing", async () => {
    const cwd = await tempDir();
    const journal = join(await tempDir(), "children.jsonl");
    const proc = spawnSupervised({
      command: "/nonexistent-porrima-binary",
      cwd,
      key: "test:enoent",
      journalPath: journal,
    });
    const exit = await proc.exited;
    expect(exit.error).toBeInstanceOf(Error);
    await expect(readFile(journal, "utf8")).rejects.toThrow();
  });

  it("does not fail the spawn when the journal is unwritable", async () => {
    const cwd = await tempDir();
    // A file where a directory is expected fails fast (ENOTDIR); do not use
    // /proc paths here — mkdir under procfs can block on this kernel.
    const blocker = join(await tempDir(), "not-a-dir");
    await writeFile(blocker, "x");
    const proc = spawnSupervised({
      command: "bash",
      args: ["-c", "printf ok"],
      cwd,
      key: "test:journal-fail",
      journalPath: join(blocker, "children.jsonl"),
    });
    const out = collect(proc.stdout);
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(await out).toBe("ok");
  });

  it("killAllSupervised kills every tracked group", async () => {
    const cwd = await tempDir();
    const a = spawnSupervised({ command: "bash", args: ["-c", "sleep 30"], cwd, key: "test:all-a" });
    const b = spawnSupervised({ command: "bash", args: ["-c", "sleep 30"], cwd, key: "test:all-b" });
    await delay(150);
    expect(listSupervised().length).toBeGreaterThanOrEqual(2);
    await killAllSupervised({ graceMs: 100 });
    expect(isGroupAlive(a.pid)).toBe(false);
    expect(isGroupAlive(b.pid)).toBe(false);
  });
});
