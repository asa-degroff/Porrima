import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket } from "node:net";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { startJobsDaemon, type JobsDaemonHandle } from "../jobs-daemon.js";
import { encodeJobFrame, type JobRecord } from "./job-protocol.js";
import { JobsClient } from "./jobs-client.js";
import { readBootId } from "./job-lock.js";
import { isGroupAlive, killProcessGroup } from "./process-supervisor.js";

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

  it("holds live groups when the ledger is unreadable", async () => {
    const root = await mkdtemp(join(tmpdir(), "porrima-jobs-degraded-"));
    const config = {
      jobsDir: join(root, "jobs"),
      dbPath: join(root, "jobs.db"),
      socketPath: join(root, "jobs.sock"),
      lockPath: join(root, "jobs.lock"),
      journalPath: join(root, "jobs", "journal.jsonl"),
      bootId: readBootId(),
    };
    let first: JobsDaemonHandle | null = null;
    let firstClient: JobsClient | null = null;
    let second: JobsDaemonHandle | null = null;
    let secondClient: JobsClient | null = null;
    let job: JobRecord | null = null;
    try {
      first = await startJobsDaemon(config);
      firstClient = new JobsClient({ socketPath: config.socketPath });
      await firstClient.connect();
      job = await firstClient.startJob({
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
      const pgid = job.pgid ?? job.pid;
      expect(pgid != null && isGroupAlive(pgid)).toBe(true);

      // The ledger is no longer a database. The journal still remembers the group.
      await writeFile(config.dbPath, Buffer.alloc(4096, 0x7a));

      second = await startJobsDaemon(config);
      expect(second.supervisor).toBeNull();
      expect(second.degraded).toContain("jobs.db");

      secondClient = new JobsClient({ socketPath: config.socketPath });
      await secondClient.connect();
      expect(secondClient.degradedReason).toContain("jobs.db");
      await expect(
        secondClient.startJob({
          job_id: randomUUID(),
          chat_id: "demo",
          kind: "command",
          command: "true",
          cwd: root,
          env: testEnv,
        }),
      ).rejects.toThrow(/degraded/);
      await expect(secondClient.listJobs()).rejects.toThrow(/degraded/);

      // The point of the whole exercise: a ledger nobody can read must not
      // turn into a kill order for the groups the journal remembers.
      await delay(400);
      expect(pgid != null && isGroupAlive(pgid)).toBe(true);
    } finally {
      const pgid = job?.pgid ?? job?.pid;
      if (pgid != null) await killProcessGroup(pgid, { graceMs: 200 }).catch(() => {});
      await secondClient?.close().catch(() => {});
      await firstClient?.close().catch(() => {});
      await second?.close().catch(() => {});
      await first?.close().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not reap live groups when the ledger holds no rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "porrima-jobs-wiped-"));
    const config = {
      jobsDir: join(root, "jobs"),
      dbPath: join(root, "jobs.db"),
      socketPath: join(root, "jobs.sock"),
      lockPath: join(root, "jobs.lock"),
      journalPath: join(root, "jobs", "journal.jsonl"),
      bootId: readBootId(),
    };
    let first: JobsDaemonHandle | null = null;
    let firstClient: JobsClient | null = null;
    let second: JobsDaemonHandle | null = null;
    let job: JobRecord | null = null;
    try {
      first = await startJobsDaemon(config);
      firstClient = new JobsClient({ socketPath: config.socketPath });
      await firstClient.connect();
      job = await firstClient.startJob({
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
      const pgid = job.pgid ?? job.pid;
      expect(pgid != null && isGroupAlive(pgid)).toBe(true);

      // A healthy file whose content vanished: restored from a stale snapshot,
      // a torn WAL, a pruning bug. The rows are gone, the group is not.
      const ledger = new Database(config.dbPath);
      ledger.exec("DELETE FROM jobs");
      ledger.close();

      second = await startJobsDaemon(config);
      expect(second.degraded).toBeNull();
      await delay(400);
      expect(pgid != null && isGroupAlive(pgid)).toBe(true);
    } finally {
      const pgid = job?.pgid ?? job?.pid;
      if (pgid != null) await killProcessGroup(pgid, { graceMs: 200 }).catch(() => {});
      await firstClient?.close().catch(() => {});
      await second?.close().catch(() => {});
      await first?.close().catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
async function serveFakeSupervisor(
  welcome: Record<string, unknown>,
): Promise<{ socketPath: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "porrima-fake-supervisor-"));
  const socketPath = join(root, "jobs.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = "";
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      let index = pending.indexOf("\n");
      while (index >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        index = pending.indexOf("\n");
        if (!line) continue;
        let request: Record<string, any>;
        try {
          request = JSON.parse(line) as Record<string, any>;
        } catch {
          continue;
        }
        const id = typeof request.id === "string" ? request.id : undefined;
        if (request.type === "hello") {
          socket.write(
            encodeJobFrame({
              type: "welcome",
              id,
              pid: process.pid,
              start_id: null,
              boot_id: "fake",
              started_at: new Date().toISOString(),
              version: "fake",
              ...welcome,
            }),
          );
          continue;
        }
        if (request.type === "list") {
          socket.write(encodeJobFrame({ type: "jobs", id, jobs: [] }));
          continue;
        }
        socket.write(
          encodeJobFrame({
            type: "error",
            id,
            error: `fake supervisor does not do ${String(request.type)}`,
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

describe("protocol skew", () => {
  it("keeps reading from a supervisor that does not offer every newer request", async () => {
    const peer = await serveFakeSupervisor({
      protocol: 1,
      protocol_min: 1,
      capabilities: ["get", "list", "subscribe", "ping"],
    });
    // A server one protocol ahead, meeting a daemon that survived the deploy.
    const client = new JobsClient({
      socketPath: peer.socketPath,
      protocolMax: 2,
      protocolMin: 1,
    });
    try {
      await client.connect();
      expect(client.supervisorProtocol).toBe(1);
      expect(await client.listJobs()).toEqual([]);
      await expect(
        client.startJob({
          job_id: "skew-start",
          chat_id: "demo",
          kind: "command",
          command: "true",
          cwd: "/tmp",
        }),
      ).rejects.toThrow(/does not advertise "start"/);
      // Refused per request, not per connection: the read paths still answer.
      expect(client.connected).toBe(true);
      expect(await client.listJobs()).toEqual([]);
    } finally {
      await client.close().catch(() => {});
      await peer.close();
    }
  });

  it("refuses a supervisor with no overlap, and names the fix", async () => {
    const peer = await serveFakeSupervisor({
      protocol: 5,
      protocol_min: 5,
      capabilities: ["get", "list"],
    });
    const client = new JobsClient({ socketPath: peer.socketPath });
    try {
      await expect(client.connect()).rejects.toThrow(/Restart porrima-jobs/);
    } finally {
      await client.close().catch(() => {});
      await peer.close();
    }
  });

  it("refuses a client the daemon cannot serve", async () => {
    const { daemon } = await startHarness();
    const socket = connect(daemon.config.socketPath);
    socket.on("error", () => {});
    try {
      const frame = await new Promise<Record<string, any>>((resolve, reject) => {
        socket.once("data", (chunk) => {
          try {
            resolve(JSON.parse(chunk.toString("utf8").trim()) as Record<string, any>);
          } catch (error) {
            reject(error);
          }
        });
        socket.once("error", reject);
        socket.write(
          encodeJobFrame({
            type: "hello",
            id: "future-client",
            client: "future",
            protocol: 99,
            protocol_min: 99,
          }),
        );
      });
      expect(frame.type).toBe("error");
      expect(String(frame.error)).toContain("Deploy matching builds");
    } finally {
      socket.destroy();
    }
  });
});
