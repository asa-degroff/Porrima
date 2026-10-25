import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startJobsDaemon, type JobsDaemonHandle } from "../jobs-daemon.js";
import { JobsClient } from "./jobs-client.js";
import { readBootId } from "./job-lock.js";
import { isGroupAlive } from "./process-supervisor.js";

const cleanups: Array<() => Promise<void> | void> = [];

const testEnv = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? tmpdir(),
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(
  client: JobsClient,
  id: string,
  state: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await client.getJob(id);
    if (job?.state === state) return job;
    await delay(50);
  }
  throw new Error(`job ${id} did not reach ${state}`);
}

async function startHarness(): Promise<{ root: string; daemon: JobsDaemonHandle; client: JobsClient }> {
  const root = await mkdtemp(join(tmpdir(), "porrima-jobs-daemon-"));
  const daemon = await startJobsDaemon({
    jobsDir: join(root, "jobs"),
    dbPath: join(root, "jobs.db"),
    socketPath: join(root, "jobs.sock"),
    lockPath: join(root, "jobs.lock"),
    journalPath: join(root, "jobs", "journal.jsonl"),
    bootId: readBootId(),
  });
  const client = new JobsClient({ socketPath: daemon.config.socketPath });
  await client.connect();
  cleanups.push(async () => {
    await client.close().catch(() => {});
    await daemon.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, daemon, client };
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("jobs daemon", () => {
  it("serves the handshake, stats, and a finished command", async () => {
    const { root, client } = await startHarness();
    const stats = await client.stats();
    expect(stats.protocol).toBe(1);
    expect(stats.pid).toBeGreaterThan(0);
    expect(stats.socket_path).toContain("jobs.sock");

    const job = await client.startJob({
      job_id: randomUUID(),
      chat_id: "demo",
      kind: "command",
      command: "echo hello",
      cwd: root,
      env: testEnv,
    });
    const finished = await waitForState(client, job.id, "finished");
    expect(finished.exit_code).toBe(0);
    expect(await readFile(finished.stdout_path, "utf8")).toContain("hello");

    const jobs = await client.listJobs({ chat_id: "demo" });
    expect(jobs.map((row) => row.id)).toContain(job.id);
  });

  it("waits for a readiness pattern and stops a running job", async () => {
    const { root, client } = await startHarness();
    const readyJob = await client.startJob({
      job_id: randomUUID(),
      chat_id: "demo",
      kind: "command",
      command: "sleep 0.2; echo READY",
      cwd: root,
      env: testEnv,
    });
    const readiness = await client.waitFor(readyJob.id, "READY", 3000);
    expect(readiness.matched).toBe(true);

    const longJob = await client.startJob({
      job_id: randomUUID(),
      chat_id: "demo",
      kind: "command",
      command: "sleep 30",
      cwd: root,
      env: testEnv,
    });
    await delay(100);
    const stopped = await client.stopJob(longJob.id, true);
    expect(stopped.state).toBe("stopped");
    expect(stopped.stop_reason).toBe("user-force");
  });

  it("stops all jobs for a chat", async () => {
    const { root, client } = await startHarness();
    await client.startJob({
      job_id: randomUUID(),
      chat_id: "demo",
      kind: "command",
      command: "sleep 30",
      cwd: root,
      env: testEnv,
    });
    await delay(100);
    const count = await client.stopChat("demo");
    expect(count).toBe(1);
    const jobs = await client.listJobs({ chat_id: "demo" });
    expect(jobs.every((row) => row.state === "stopped")).toBe(true);
  });

  it("detaches on close and adopts the job on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "porrima-jobs-restart-"));
    const config = {
      jobsDir: join(root, "jobs"),
      dbPath: join(root, "jobs.db"),
      socketPath: join(root, "jobs.sock"),
      lockPath: join(root, "jobs.lock"),
      journalPath: join(root, "jobs", "journal.jsonl"),
      bootId: readBootId(),
    };
    let first: JobsDaemonHandle | null = null;
    let second: JobsDaemonHandle | null = null;
    let firstClient: JobsClient | null = null;
    let secondClient: JobsClient | null = null;
    try {
      first = await startJobsDaemon(config);
      firstClient = new JobsClient({ socketPath: config.socketPath });
      await firstClient.connect();
      const job = await firstClient.startJob({
        job_id: randomUUID(),
        chat_id: "demo",
        kind: "command",
        command: "sleep 30",
        cwd: root,
        env: testEnv,
      });
      await delay(100);

      await firstClient.close();
      firstClient = null;
      await first.close();
      first = null;
      expect(job.pid != null && isGroupAlive(job.pid)).toBe(true);

      second = await startJobsDaemon({ ...config, bootId: readBootId() });
      secondClient = new JobsClient({ socketPath: config.socketPath });
      await secondClient.connect();
      const adopted = await secondClient.getJob(job.id);
      expect(adopted?.state).toBe("running");
      expect(adopted?.pid).toBe(job.pid);
      await secondClient.stopJob(job.id, true);
    } finally {
      await firstClient?.close().catch(() => {});
      await secondClient?.close().catch(() => {});
      await first?.close().catch(() => {});
      await second?.close().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});