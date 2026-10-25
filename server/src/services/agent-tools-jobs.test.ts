import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobsDaemonHandle } from "../jobs-daemon.js";

const fake = vi.hoisted(() => ({ rootPath: "/tmp" }));

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  const adapter = {
    kind: "local" as const,
    get label(): string {
      return fake.rootPath;
    },
    get localRoot(): string {
      return fake.rootPath;
    },
    async readFile() {
      return { content: "", isError: false };
    },
    async bash() {
      return { content: "foreground", isError: false };
    },
    async listFiles() {
      return { content: "", isError: false };
    },
    async writeFile() {
      return { content: "", isError: false };
    },
    async editFile() {
      return { content: "", isError: false };
    },
    async runPython() {
      throw new Error("run_python must not run in this test");
    },
  };
  return { ...actual, getWorkspaceForProject: () => Promise.resolve(adapter as any) };
});

const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
const CHAT = "jobs-tools-chat";

let dataDir = "";
let jobsDir = "";
let daemon: JobsDaemonHandle | null = null;
let runtime: typeof import("./job-runtime.js") | null = null;

async function setup() {
  vi.resetModules();
  dataDir = await mkdtemp(join(tmpdir(), "porrima-jobs-tools-"));
  jobsDir = await mkdtemp(join(tmpdir(), "porrima-jobs-tools-plane-"));
  fake.rootPath = dataDir;
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
  const agentTools = await import("./agent-tools.js");
  runtime = await import("./job-runtime.js");
  await runtime.initJobRuntime();
  return { agentTools };
}

function resultText(result: { content: unknown }): string {
  const content = result.content as Array<{ text?: string }>;
  return content.map((part) => part?.text ?? "").join("\n");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  runtime?.shutdownJobRuntime();
  runtime = null;
  await daemon?.close().catch(() => {});
  daemon = null;
  for (const key of [
    "PORRIMA_DATA_DIR",
    "PORRIMA_JOBS_DIR",
    "PORRIMA_JOBS_DB",
    "PORRIMA_JOBS_SOCKET",
    "PORRIMA_JOBS_LOCK",
  ]) {
    delete process.env[key];
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (jobsDir) await rm(jobsDir, { recursive: true, force: true }).catch(() => {});
  dataDir = "";
  jobsDir = "";
});

describe("bash background + jobs tools", () => {
  it("starts a supervisor command and lists, statuses, and tails it", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const jobs = tools.find((tool) => tool.name === "jobs")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-start",
      { command: "echo hi from supervisor", background: true },
      signal,
    );
    const startedText = resultText(started);
    expect(startedText).toContain("Started background command");
    const jobId = startedText.match(/Started background command (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    await delay(300);
    const listed = resultText(await jobs.execute("call-list", { action: "list" }, signal));
    expect(listed).toContain(jobId!);
    expect(listed).toContain("command");

    const status = resultText(
      await jobs.execute("call-status", { action: "status", jobId }, signal),
    );
    expect(status).toContain("finished");

    const tail = resultText(
      await jobs.execute("call-tail", { action: "tail", jobId }, signal),
    );
    expect(tail).toContain("hi from supervisor");
  });

  it("waits for a service readiness line", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-ready",
      {
        command: "sleep 0.2; echo READY",
        background: true,
        ready_when: "READY",
        ready_timeout: 5,
      },
      signal,
    );
    expect(resultText(started)).toContain('Readiness: matched "READY"');
  });

  it("starts and stops a service", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const jobs = tools.find((tool) => tool.name === "jobs")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-service",
      { command: "sleep 30", service: true },
      signal,
    );
    const startedText = resultText(started);
    expect(startedText).toContain("Started service");
    const jobId = startedText.match(/Started service (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    const killed = resultText(
      await jobs.execute("call-kill", { action: "kill", jobId, force: true }, signal),
    );
    expect(killed).toContain("Stopped");
  });

  it("stops every supervisor job for a chat", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const signal = new AbortController().signal;

    await bash.execute("call-chat-stop", { command: "sleep 30", service: true }, signal);
    await delay(100);
    const count = await runtime!.stopChatSupervisorJobs(CHAT);
    expect(count).toBe(1);
    const rows = await runtime!.listJobsForChat(CHAT);
    expect(rows.every((row) => row.state === "stopped")).toBe(true);
  });

  it("gives background commands the same hardened environment as the foreground shell", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const jobs = tools.find((tool) => tool.name === "jobs")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-env",
      {
        command: "printf '%s|%s|%s|%s\\n' \"$TERM\" \"$GIT_TERMINAL_PROMPTS\" \"$PAGER\" \"$DEBIAN_FRONTEND\"",
        background: true,
      },
      signal,
    );
    const jobId = resultText(started).match(/Started background command (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    await delay(300);
    const tail = resultText(await jobs.execute("call-env-tail", { action: "tail", jobId }, signal));
    expect(tail).toContain("dumb|0|cat|noninteractive");
  });

  it("does not mistake a service for lost when terminal rows flood the ledger", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-flood-start",
      { command: "sleep 30", service: true },
      signal,
    );
    const jobId = resultText(started).match(/Started service (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    // 501 terminal rows, all newer than the service and belonging to another
    // chat: a window over every state would not contain the live service.
    const { JobStore } = await import("./job-store.js");
    const store = JobStore.open(process.env.PORRIMA_JOBS_DB!);
    const now = new Date().toISOString();
    for (let i = 0; i < 501; i += 1) {
      const id = `z-flood-${String(i).padStart(3, "0")}`;
      store.insertStarting({
        id,
        chat_id: "flood-chat",
        kind: "command",
        command: "echo flood",
        cwd: "/tmp",
        stdout_path: `/tmp/${id}/stdout.log`,
        stderr_path: `/tmp/${id}/stderr.log`,
        status_path: `/tmp/${id}/status.json`,
        origin_turn_id: null,
      });
      store.markRunning(id, {
        pid: 900000 + i,
        pgid: 900000 + i,
        start_id: `proc:${i}`,
        boot_id: "flood-boot",
        started_at: now,
      });
      store.finish(id, { exit_code: 0, signal: null, ended_at: now, duration_ms: 5 });
    }
    store.close();

    const rows = await runtime!.listJobsForChat(CHAT);
    const service = rows.find((row) => row.job_id === jobId);
    expect(service?.state).toBe("running");
    expect(service?.stop_reason).not.toBe("supervisor-no-row");

    await runtime!.stopChatSupervisorJobs(CHAT);
  });

  it("mirrors a command that finished while the server was disconnected", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-away",
      { command: "sleep 0.6; echo done-while-away", background: true },
      signal,
    );
    const jobId = resultText(started).match(/Started background command (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    // The server loses its supervisor connection before the completion event
    // arrives, so the view keeps a 'running' row with no mirror to update it.
    runtime!.shutdownJobRuntime();
    runtime = null;
    await delay(1200);

    runtime = await import("./job-runtime.js");
    await runtime.initJobRuntime();
    await delay(200);
    const rows = await runtime.listJobsForChat(CHAT);
    const row = rows.find((job) => job.job_id === jobId);
    expect(row?.state).toBe("finished");
    expect(row?.exit_code).toBe(0);
  });

  it("stamps uncertain rows after a list and does not re-probe inside the window", async () => {
    const { agentTools } = await setup();
    // Drain the connect-time reconcile so the clock under test belongs to the
    // list calls below, not to startup.
    await runtime!.ensureSupervisorConnection();
    await delay(50);

    const { getJobView, markJobViewFailed, recordSupervisorStarting } = await import(
      "./job-view.js"
    );
    recordSupervisorStarting({
      jobId: "uncertain-list",
      chatId: CHAT,
      kind: "command",
      command: "echo never-started",
      cwd: dataDir,
    });
    markJobViewFailed("uncertain-list", "spawn-failed");
    expect(getJobView("uncertain-list")?.last_synced_at).toBeNull();

    const tools = await agentTools.getAgentTools(CHAT, effects);
    const jobs = tools.find((tool) => tool.name === "jobs")!;
    const signal = new AbortController().signal;

    await jobs.execute("call-list-probe-1", { action: "list" }, signal);
    const firstProbe = getJobView("uncertain-list")?.last_synced_at;
    expect(firstProbe).toBeTruthy();

    await delay(10);
    await jobs.execute("call-list-probe-2", { action: "list" }, signal);
    expect(getJobView("uncertain-list")?.last_synced_at).toBe(firstProbe);
  });

  it("deletes chat output after a finished job and reports an expired tail", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const jobs = tools.find((tool) => tool.name === "jobs")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-retained-output",
      { command: "echo retained-output", background: true },
      signal,
    );
    const jobId = resultText(started).match(/Started background command (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    const { getJobView } = await import("./job-view.js");
    let job = getJobView(jobId!);
    for (let i = 0; i < 20 && job?.state !== "finished"; i += 1) {
      await delay(50);
      job = getJobView(jobId!);
    }
    expect(job?.state).toBe("finished");
    const stdout = job!.output_paths[0];
    expect(stdout).toBeTruthy();

    expect(await runtime!.deleteChatSupervisorOutputs(CHAT)).toEqual({
      deleted: true,
    });
    await expect(access(stdout!)).rejects.toThrow();
    expect(getJobView(jobId!)).not.toBeNull();

    const tail = resultText(
      await jobs.execute("call-expired-tail", { action: "tail", jobId }, signal),
    );
    expect(tail).toContain("output expired by retention");
  });

  it("mirrors a job when the start response is lost but the daemon spawned it", async () => {
    await setup();
    const runtimeMod = runtime!;
    const client = runtimeMod.getJobsClient();
    const realStart = client.startJob.bind(client);
    const jobId = randomUUID();
    const spy = vi.spyOn(client, "startJob").mockImplementationOnce(async (input) => {
      await realStart(input);
      throw new Error("simulated start timeout");
    });

    try {
      const job = await runtimeMod.startSupervisorJob({
        job_id: jobId,
        chat_id: CHAT,
        kind: "command",
        command: "sleep 30",
        cwd: dataDir,
      });
      expect(job.state).toBe("running");

      // A false lost row must be corrected by the next authoritative read.
      const { markJobViewLost } = await import("./job-view.js");
      markJobViewLost(jobId, "test");
      const rows = await runtimeMod.listJobsForChat(CHAT);
      expect(rows.find((row) => row.job_id === jobId)?.state).toBe("running");
    } finally {
      spy.mockRestore();
      await runtimeMod.stopSupervisorJob(jobId, true).catch(() => {});
    }
  });

  it("resolves a false lost row after the command finishes while disconnected", async () => {
    const { agentTools } = await setup();
    const tools = await agentTools.getAgentTools(CHAT, effects);
    const bash = tools.find((tool) => tool.name === "bash")!;
    const signal = new AbortController().signal;

    const started = await bash.execute(
      "call-lost-finish",
      { command: "sleep 0.2; echo finished-after-lost", background: true },
      signal,
    );
    const jobId = resultText(started).match(/Started background command (\S+)/)?.[1];
    expect(jobId).toBeTruthy();

    const { markJobViewLost } = await import("./job-view.js");
    markJobViewLost(jobId!, "test");
    await delay(1000);

    const rows = await runtime!.listJobsForChat(CHAT);
    const row = rows.find((entry) => entry.job_id === jobId);
    expect(row?.state).toBe("finished");
    expect(row?.exit_code).toBe(0);
  });
});