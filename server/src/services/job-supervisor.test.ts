import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, utimes } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBootId } from "./job-lock.js";
import { appendJobJournal, latestJournalRecords, type JobJournalRecord } from "./job-journal.js";
import { JobStore } from "./job-store.js";
import { JobSupervisor, type StartJobInput } from "./job-supervisor.js";
import { isGroupAlive, killProcessGroup, readProcessStartId } from "./process-supervisor.js";

const cleanups: Array<() => Promise<void> | void> = [];
const roots = new Set<string>();

interface Harness {
  root: string;
  dbPath: string;
  jobsDir: string;
  journalPath: string;
  bootId: string;
  store: JobStore;
  supervisor: JobSupervisor;
}

const testEnv = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? tmpdir(),
};
const DAY_MS = 24 * 60 * 60 * 1000;

async function makeHarness(caps?: {
  per_chat?: number;
  box?: number;
  services_per_chat?: number;
  services_box?: number;
}, killGroup?: (pid: number, opts?: { graceMs?: number }) => Promise<boolean>): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "porrima-job-supervisor-"));
  roots.add(root);
  const dbPath = join(root, "jobs.db");
  const jobsDir = join(root, "jobs");
  const journalPath = join(jobsDir, "journal.jsonl");
  const bootId = readBootId();
  const store = JobStore.open(dbPath);
  const supervisor = new JobSupervisor({ store, jobsDir, journalPath, bootId, caps, killGroup });
  cleanups.push(async () => {
    await supervisor.stopAll().catch(() => {});
    supervisor.close();
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  });
  return { root, dbPath, jobsDir, journalPath, bootId, store, supervisor };
}

function startInput(
  harness: Harness,
  overrides: Partial<StartJobInput> = {},
): StartJobInput {
  return {
    job_id: randomUUID(),
    chat_id: "chat-1",
    kind: "command",
    command: "echo hello",
    cwd: harness.root,
    env: testEnv,
    ...overrides,
  };
}

async function waitForState(
  harness: Harness,
  id: string,
  state: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = harness.store.get(id);
    if (job?.state === state) return job;
    await delay(50);
  }
  throw new Error(`job ${id} did not reach ${state}: ${JSON.stringify(harness.store.get(id))}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
  roots.clear();
});

describe("job supervisor", () => {
  it("runs a command to completion with file-backed output and a status file", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(startInput(harness));
    const finished = await waitForState(harness, job.id, "finished");

    expect(finished.exit_code).toBe(0);
    expect(await readFile(finished.stdout_path, "utf8")).toContain("hello");
    const status = JSON.parse(await readFile(finished.status_path, "utf8"));
    expect(status.exit_code).toBe(0);
    expect(status.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("stops a running process group and records the reason", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 30" }),
    );
    await delay(100);
    const stopped = await harness.supervisor.stop(job.id, { force: true });
    expect(stopped.state).toBe("stopped");
    expect(stopped.stop_reason).toBe("user-force");
    if (job.pid != null) {
      expect(isGroupAlive(job.pid)).toBe(false);
    }
  });

  it("is idempotent by job_id", async () => {
    const harness = await makeHarness();
    const input = startInput(harness, { command: "sleep 30" });
    const first = await harness.supervisor.start(input);
    const second = await harness.supervisor.start(input);
    expect(second.id).toBe(first.id);
    expect(second.pid).toBe(first.pid);
    await harness.supervisor.stop(first.id, { force: true });
  });

  it("adopts a live group after a supervisor restart", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 30" }),
    );
    await delay(100);

    harness.supervisor.close();
    const secondStore = JobStore.open(harness.dbPath);
    const second = new JobSupervisor({
      store: secondStore,
      jobsDir: harness.jobsDir,
      journalPath: harness.journalPath,
      bootId: harness.bootId,
    });
    cleanups.push(async () => {
      await second.stopAll().catch(() => {});
      second.close();
      try {
        secondStore.close();
      } catch {
        // Already closed.
      }
    });

    await second.recover();
    const adopted = secondStore.get(job.id);
    expect(adopted?.state).toBe("running");
    expect(adopted?.pid).toBe(job.pid);
    await second.stop(job.id, { force: true });
    expect(secondStore.get(job.id)?.state).toBe("stopped");
  });

  it("marks a running row lost when no group survives", async () => {
    const harness = await makeHarness();
    const job = harness.store.insertStarting({
      id: "lost-job",
      chat_id: "chat-1",
      kind: "command",
      command: "echo gone",
      cwd: harness.root,
      stdout_path: join(harness.jobsDir, "lost", "stdout.log"),
      stderr_path: join(harness.jobsDir, "lost", "stderr.log"),
      status_path: join(harness.jobsDir, "lost", "status.json"),
    });
    harness.store.markRunning(job.id, {
      pid: 999999,
      pgid: 999999,
      start_id: "proc:1",
      boot_id: harness.bootId,
      started_at: new Date().toISOString(),
    });

    await harness.supervisor.recover();
    expect(harness.store.get(job.id)?.state).toBe("lost");
  });

  it("stops a job at its timeout", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 30", timeout_ms: 200 }),
    );
    const stopped = await waitForState(harness, job.id, "stopped");
    expect(stopped.stop_reason).toBe("timeout");
  });

  it("waits for a readiness pattern in the output", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 0.2; echo READY" }),
    );
    const result = await harness.supervisor.waitFor(job.id, "READY", 3000);
    expect(result.matched).toBe(true);
    expect(result.finished).toBe(false);
  });

  it("enforces the per-chat cap at the spawn site", async () => {
    const harness = await makeHarness({ per_chat: 1, box: 2 });
    await harness.supervisor.start(startInput(harness, { command: "sleep 30" }));
    await expect(
      harness.supervisor.start(startInput(harness, { command: "sleep 30" })),
    ).rejects.toThrow(/job limit/);
  });

  it("journals the spawned group before the ledger row is updated", async () => {
    const harness = await makeHarness();
    const realMarkRunning = harness.store.markRunning.bind(harness.store);
    let journalAtWriteTime: JobJournalRecord | undefined;
    harness.store.markRunning = ((
      id: string,
      identity: Parameters<JobStore["markRunning"]>[1],
    ) => {
      // Snapshot the journal at the exact moment the ledger write is about to
      // happen: if the record is already there, a crash between the two leaves
      // a group that recovery can still find.
      journalAtWriteTime = latestJournalRecords(harness.journalPath).get(identity.pid);
      return realMarkRunning(id, identity);
    }) as JobStore["markRunning"];

    const job = await harness.supervisor.start(startInput(harness, { command: "echo journaled" }));

    expect(journalAtWriteTime).toBeDefined();
    expect(journalAtWriteTime?.job_id).toBe(job.id);
    expect(journalAtWriteTime?.pid).toBe(job.pid);
    expect(journalAtWriteTime?.pgid).toBe(job.pgid);
    expect(journalAtWriteTime?.active).toBe(true);
    expect(typeof journalAtWriteTime?.start_id).toBe("string");
    await waitForState(harness, job.id, "finished");
  });

  it("recovers a command that finished while no supervisor was present", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 0.4; echo finished-while-gone" }),
    );
    // A daemon death: tracking is dropped, the detached group keeps running
    // and keeps writing to its own files. Nothing is watching when it exits.
    harness.supervisor.close();
    await delay(1200);

    const store2 = JobStore.open(harness.dbPath);
    const supervisor2 = new JobSupervisor({
      store: store2,
      jobsDir: harness.jobsDir,
      journalPath: harness.journalPath,
      bootId: harness.bootId,
    });
    cleanups.push(async () => {
      supervisor2.close();
      store2.close();
    });
    await supervisor2.recover();

    const recovered = store2.get(job.id);
    expect(recovered?.state).toBe("finished");
    expect(recovered?.exit_code).toBe(0);
    expect(recovered?.duration_ms ?? 0).toBeGreaterThan(0);
    expect(await readFile(job.stdout_path, "utf8")).toContain("finished-while-gone");
  });

  it("reaps an unclaimed group only on positive identity", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(startInput(harness, { command: "sleep 30" }));
    const pgid = job.pgid;
    const pid = job.pid;
    expect(pgid).toBeTruthy();
    expect(pid).toBeTruthy();
    cleanups.push(async () => {
      if (pgid) await killProcessGroup(pgid, { graceMs: 200 }).catch(() => {});
    });
    harness.supervisor.close();
    // Ledger loses its live row; the group is still running and untracked.
    harness.store.markFailed(job.id);

    const supervisor2 = new JobSupervisor({
      store: harness.store,
      jobsDir: harness.jobsDir,
      journalPath: harness.journalPath,
      bootId: harness.bootId,
    });
    cleanups.push(async () => supervisor2.close());

    appendJobJournal(harness.journalPath, {
      version: 1,
      job_id: job.id,
      pid: pid!,
      pgid: pgid!,
      start_id: "proc:not-this-process",
      boot_id: harness.bootId,
      active: true,
      recorded_at: new Date().toISOString(),
    });
    await supervisor2.recover();
    // Absence of confirming identity is not a licence to kill a live group.
    expect(isGroupAlive(pgid!)).toBe(true);

    appendJobJournal(harness.journalPath, {
      version: 1,
      job_id: job.id,
      pid: pid!,
      pgid: pgid!,
      start_id: readProcessStartId(pid!) ?? "",
      boot_id: harness.bootId,
      active: true,
      recorded_at: new Date().toISOString(),
    });
    await supervisor2.recover();
    const deadline = Date.now() + 3000;
    while (isGroupAlive(pgid!) && Date.now() < deadline) {
      await delay(50);
    }
    expect(isGroupAlive(pgid!)).toBe(false);
  });

  it("reports lost and keeps the journal active when a stop cannot confirm death", async () => {
    const harness = await makeHarness(undefined, async () => false);
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 30" }),
    );
    await delay(100);
    cleanups.push(async () => {
      if (job.pid) await killProcessGroup(job.pid, { graceMs: 200 }).catch(() => {});
    });

    const stopped = await harness.supervisor.stop(job.id, { force: true });
    expect(stopped.state).toBe("lost");
    const journal = latestJournalRecords(harness.journalPath).get(job.pid!);
    expect(journal?.active).toBe(true);
  });

  it("settles an unconfirmed stop once the wrapper records its own ending", async () => {
    const harness = await makeHarness(undefined, async () => false);
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 1; echo done" }),
    );
    await delay(50);
    const stopped = await harness.supervisor.stop(job.id, { force: true });
    expect(stopped.state).toBe("lost");
    expect(stopped.stop_reason).toBe("user-force");

    // The group was never killed, so the command runs to completion and the
    // wrapper writes its status file. The ledger follows that evidence rather
    // than carrying the uncertainty forever.
    const settled = await waitForState(harness, job.id, "finished", 8000);
    expect(settled.exit_code).toBe(0);
    expect(settled.duration_ms).not.toBeNull();
    expect(settled.duration_ms!).toBeGreaterThan(0);
    // The uncertainty is not erased: it survives as the reason the row was
    // marked lost, next to the outcome the wrapper proved.
    expect(settled.stop_reason).toBe("user-force");
    const journal = latestJournalRecords(harness.journalPath).get(job.pid!);
    expect(journal?.active).toBeFalsy();
  });

  it("settles a lost row from its status file when a supervisor restarts", async () => {
    const harness = await makeHarness(undefined, async () => false);
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 1; echo done" }),
    );
    await delay(50);
    expect((await harness.supervisor.stop(job.id, { force: true })).state).toBe("lost");
    harness.supervisor.close();

    // The untouched group runs on and records its own ending while no
    // supervisor is watching it.
    const deadline = Date.now() + 6000;
    for (;;) {
      try {
        await access(job.status_path);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error("status file never appeared");
        await delay(50);
      }
    }

    const store2 = JobStore.open(harness.dbPath);
    const supervisor2 = new JobSupervisor({
      store: store2,
      jobsDir: harness.jobsDir,
      journalPath: harness.journalPath,
      bootId: harness.bootId,
    });
    cleanups.push(async () => {
      supervisor2.close();
      store2.close();
    });
    await supervisor2.recover();

    const row = store2.get(job.id);
    expect(row?.state).toBe("finished");
    expect(row?.exit_code).toBe(0);
    expect(row?.stop_reason).toBe("user-force");
  });

  it("prunes old output before its ledger row", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "echo prune-me" }),
    );
    const finished = await waitForState(harness, job.id, "finished");

    const outputPass = await harness.supervisor.pruneRetention({
      nowMs: Date.now() + 15 * DAY_MS,
      outputRetentionMs: 14 * DAY_MS,
      recordRetentionMs: 30 * DAY_MS,
      orphanGraceMs: DAY_MS,
    });
    expect(outputPass.outputs).toBe(1);
    await expect(access(finished.stdout_path)).rejects.toThrow();
    expect(harness.store.get(job.id)?.state).toBe("finished");

    const rowPass = await harness.supervisor.pruneRetention({
      nowMs: Date.now() + 31 * DAY_MS,
      outputRetentionMs: 14 * DAY_MS,
      recordRetentionMs: 30 * DAY_MS,
      orphanGraceMs: DAY_MS,
    });
    expect(rowPass.rows).toBe(1);
    expect(harness.store.get(job.id)).toBeNull();
  });

  it("keeps live jobs and their directories through retention", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 30" }),
    );

    const result = await harness.supervisor.pruneRetention({
      nowMs: Date.now() + 365 * DAY_MS,
      outputRetentionMs: DAY_MS,
      recordRetentionMs: 2 * DAY_MS,
      orphanGraceMs: 0,
    });
    expect(result.outputs).toBe(0);
    expect(result.rows).toBe(0);
    expect(harness.store.get(job.id)?.state).toBe("running");
    await expect(access(job.stdout_path)).resolves.toBeUndefined();
  });

  it("removes orphaned job directories after the grace period", async () => {
    const harness = await makeHarness();
    await mkdir(harness.jobsDir, { recursive: true });
    const chatDir = join(harness.jobsDir, "orphan-chat");
    const jobDir = join(chatDir, "orphan-job");
    await mkdir(jobDir, { recursive: true });
    const old = new Date(Date.now() - 2 * DAY_MS);
    await utimes(jobDir, old, old);
    await utimes(chatDir, old, old);

    const result = await harness.supervisor.pruneRetention({
      nowMs: Date.now(),
      outputRetentionMs: DAY_MS,
      recordRetentionMs: 2 * DAY_MS,
      orphanGraceMs: DAY_MS,
    });
    expect(result.orphans).toBe(1);
    await expect(access(jobDir)).rejects.toThrow();
    await expect(access(chatDir)).rejects.toThrow();
  });

  it("deletes a chat's output tree after its jobs are terminal", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "echo bye" }),
    );
    const finished = await waitForState(harness, job.id, "finished");

    expect(await harness.supervisor.deleteChatOutputs("chat-1")).toEqual({
      deleted: true,
    });
    await expect(access(finished.stdout_path)).rejects.toThrow();
    expect(harness.store.get(job.id)?.state).toBe("finished");
  });

  it("refuses to delete chat output while a job is live", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "sleep 30" }),
    );

    expect(await harness.supervisor.deleteChatOutputs("chat-1")).toEqual({
      deleted: false,
      reason: "live-jobs",
    });
    expect(harness.store.get(job.id)?.state).toBe("running");
  });

  it("refuses to delete chat output while a journal record is active", async () => {
    const harness = await makeHarness();
    const job = await harness.supervisor.start(
      startInput(harness, { command: "echo done" }),
    );
    const finished = await waitForState(harness, job.id, "finished");
    appendJobJournal(harness.journalPath, {
      version: 1,
      job_id: job.id,
      pid: finished.pid ?? 123,
      pgid: finished.pgid ?? 123,
      start_id: finished.start_id,
      boot_id: harness.bootId,
      active: true,
      recorded_at: new Date().toISOString(),
    });

    expect(await harness.supervisor.deleteChatOutputs("chat-1")).toEqual({
      deleted: false,
      reason: "active-journal",
    });
    await expect(access(finished.stdout_path)).resolves.toBeUndefined();
  });
});