import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobsDaemonHandle } from "../jobs-daemon.js";

/**
 * Reconcile-on-connect (docs/design/job-supervisor.md §8).
 *
 * The subscription carries no history, so a job that terminalized while the
 * server was disconnected has no path into `job_view` unless establishing the
 * connection re-derives state. A stale live row is not a display wart: the
 * notice layer only wakes on terminal rows, so an unsettled row is a job whose
 * outcome nobody is ever told about.
 */

const ENV_KEYS = [
  "PORRIMA_DATA_DIR",
  "PORRIMA_JOBS_DIR",
  "PORRIMA_JOBS_DB",
  "PORRIMA_JOBS_SOCKET",
  "PORRIMA_JOBS_LOCK",
];

let dataDir = "";
let jobsDir = "";
let daemon: JobsDaemonHandle | null = null;
let runtime: typeof import("./job-runtime.js") | null = null;
let view: typeof import("./job-view.js") | null = null;

async function setup() {
  // paths.ts resolves the data dir when it is first imported, so the override
  // has to be in place before a resetModules() re-imports the world.
  vi.resetModules();
  dataDir = await mkdtemp(join(tmpdir(), "porrima-runtime-"));
  jobsDir = await mkdtemp(join(tmpdir(), "porrima-runtime-plane-"));
  process.env.PORRIMA_DATA_DIR = dataDir;
  process.env.PORRIMA_JOBS_DIR = join(jobsDir, "jobs");
  process.env.PORRIMA_JOBS_DB = join(jobsDir, "jobs.db");
  process.env.PORRIMA_JOBS_SOCKET = join(jobsDir, "jobs.sock");
  process.env.PORRIMA_JOBS_LOCK = join(jobsDir, "jobs.lock");

  const { startJobsDaemon } = await import("../jobs-daemon.js");
  daemon = await startJobsDaemon({
    jobsDir: join(jobsDir, "jobs"),
    dbPath: join(jobsDir, "jobs.db"),
    socketPath: join(jobsDir, "jobs.sock"),
    lockPath: join(jobsDir, "jobs.lock"),
    journalPath: join(jobsDir, "jobs", "journal.jsonl"),
  });
  runtime = await import("./job-runtime.js");
  view = await import("./job-view.js");
}

async function teardown() {
  runtime?.shutdownJobRuntime();
  runtime = null;
  view = null;
  await daemon?.close().catch(() => {});
  daemon = null;
  for (const key of ENV_KEYS) delete process.env[key];
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (jobsDir) await rm(jobsDir, { recursive: true, force: true }).catch(() => {});
  dataDir = "";
  jobsDir = "";
}

afterEach(teardown);

/** Wait for an async settle without assuming it already happened. */
async function until<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = read();
  }
  return value;
}

describe("job runtime reconcile on connect", () => {
  it("settles a live view row whose job terminalized while the server was away", async () => {
    await setup();
    const jobId = "gap-stopped-1";
    const chatId = "chat-nobody-lists";

    // The daemon's ledger is authoritative: this job started and was stopped by
    // a path the server was not part of, so no event ever reached the mirror.
    daemon!.store.insertStarting({
      id: jobId,
      chat_id: chatId,
      kind: "command",
      command: "sleep 30",
      cwd: dataDir,
      stdout_path: join(jobsDir, "jobs", "gap-stopped-1.out"),
      stderr_path: join(jobsDir, "jobs", "gap-stopped-1.err"),
      status_path: join(jobsDir, "jobs", "gap-stopped-1.status.json"),
    });
    // The server's view still believes it is live.
    view!.recordSupervisorStarting({
      jobId,
      chatId,
      kind: "command",
      command: "sleep 30",
      cwd: dataDir,
    });
    expect(view!.listJobView(chatId)[0].state).toBe("starting");

    // The gap happens the way it happens in the field: the socket dies (a daemon
    // restart, a server-side timeout) and something else later terminalizes the
    // job. `initJobRuntime()` is deliberately NOT called again — startup has its
    // own reconcile, and that is not what this is testing.
    await runtime!.getJobsClient().close();

    daemon!.store.stop(jobId, "user-force", new Date().toISOString(), 1200);

    // An unrelated job start in another chat is the only thing that touches the
    // supervisor afterwards. It reconnects — and the reconnect must settle the
    // row nobody asked about.
    const unrelated = await runtime!.startSupervisorJob({
      chat_id: "chat-unrelated",
      kind: "command",
      command: "true",
      cwd: dataDir,
    });

    const row = await until(
      () => view!.listJobView(chatId)[0],
      (r) => r?.state === "stopped",
    );
    expect(row.state).toBe("stopped");
    expect(row.stop_reason).toBe("user-force");

    await runtime!.stopSupervisorJob(unrelated.job_id, true);
  });

  it("makes a job that terminalized during the gap eligible for a notice", async () => {
    await setup();
    const jobId = "gap-noticed-1";
    const chatId = "chat-nobody-lists";

    daemon!.store.insertStarting({
      id: jobId,
      chat_id: chatId,
      kind: "command",
      command: "make -j8",
      cwd: dataDir,
      stdout_path: join(jobsDir, "jobs", "gap-noticed-1.out"),
      stderr_path: join(jobsDir, "jobs", "gap-noticed-1.err"),
      status_path: join(jobsDir, "jobs", "gap-noticed-1.status.json"),
    });
    daemon!.store.finish(jobId, {
      exit_code: 0,
      signal: null,
      stop_reason: null,
      ended_at: new Date().toISOString(),
      duration_ms: 800,
    });

    view!.recordSupervisorStarting({
      jobId,
      chatId,
      kind: "command",
      command: "make -j8",
      cwd: dataDir,
    });

    await runtime!.getJobsClient().close();

    const unrelated = await runtime!.startSupervisorJob({
      chat_id: "chat-unrelated-2",
      kind: "command",
      command: "true",
      cwd: dataDir,
    });

    await until(
      () => view!.listJobView(chatId)[0],
      (r) => r?.state === "finished",
    );

    // The whole point of the notice layer: unread finished work must wake
    // someone. It can only do that once the settle made the row terminal.
    const notices = await import("./job-notices.js");
    const pending = notices.evaluateJobNotices();
    expect(pending).toBeGreaterThanOrEqual(1);
    expect(view!.listJobView(chatId)[0].notice_state).toBe("pending");

    await runtime!.stopSupervisorJob(unrelated.job_id, true);
  });

  it("single-flights concurrent global reconciles", async () => {
    await setup();
    const client = runtime!.getJobsClient();
    const spy = vi.spyOn(client, "listJobs");

    await Promise.all([
      runtime!.reconcileJobRuntime(),
      runtime!.reconcileJobRuntime(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("leaves a live job alone when the reconnect finds it still running", async () => {
    await setup();
    const row = await runtime!.startSupervisorJob({
      chat_id: "chat-live-job",
      kind: "command",
      command: "sleep 5",
      cwd: dataDir,
    });

    await runtime!.getJobsClient().close();
    await runtime!.startSupervisorJob({
      chat_id: "chat-unrelated-3",
      kind: "command",
      command: "true",
      cwd: dataDir,
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const settled = view!.listJobView("chat-live-job").find((r) => r.job_id === row.job_id);
    expect(settled?.state).toBe("running");
    expect(settled?.notice_state).toBe("none");

    await runtime!.stopSupervisorJob(row.job_id, true);
  });
});
