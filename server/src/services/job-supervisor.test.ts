import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBootId } from "./job-lock.js";
import { JobStore } from "./job-store.js";
import { JobSupervisor, type StartJobInput } from "./job-supervisor.js";
import { isGroupAlive } from "./process-supervisor.js";

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

async function makeHarness(caps?: {
  per_chat?: number;
  box?: number;
  services_per_chat?: number;
  services_box?: number;
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "porrima-job-supervisor-"));
  roots.add(root);
  const dbPath = join(root, "jobs.db");
  const jobsDir = join(root, "jobs");
  const journalPath = join(jobsDir, "journal.jsonl");
  const bootId = readBootId();
  const store = JobStore.open(dbPath);
  const supervisor = new JobSupervisor({ store, jobsDir, journalPath, bootId, caps });
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
});