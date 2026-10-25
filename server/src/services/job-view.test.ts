import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobRecord } from "./job-protocol.js";
import {
  closeJobView,
  finishCellJob,
  getJobView,
  initJobView,
  listJobView,
  markChatJobsStopped,
  markKernelJobsLostAtStartup,
  recordCellStarted,
  recordSupervisorStarting,
  reconcileSupervisorJobs,
  upsertSupervisorJob,
} from "./job-view.js";

let root = "";
let dbPath = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "porrima-job-view-"));
  dbPath = join(root, "porrima.db");
  initJobView(dbPath);
});

afterEach(async () => {
  closeJobView();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function supervisorJob(
  id: string,
  state: JobRecord["state"] = "running",
  chatId = "chat-1",
): JobRecord {
  const now = new Date().toISOString();
  return {
    id,
    chat_id: chatId,
    kind: "command",
    command: "echo hi",
    cwd: "/tmp",
    state,
    pid: 123,
    pgid: 123,
    start_id: "proc:1",
    boot_id: "boot-1",
    exit_code: state === "finished" ? 0 : null,
    signal: null,
    stop_reason: null,
    started_at: now,
    ended_at: state === "finished" ? now : null,
    duration_ms: state === "finished" ? 10 : null,
    stdout_path: join(root, "stdout.log"),
    stderr_path: join(root, "stderr.log"),
    status_path: join(root, "status.json"),
    origin_turn_id: "turn-1",
    created_at: now,
    updated_at: now,
  };
}

describe("job view", () => {
  it("records a supervisor starting row and mirrors the running job", () => {
    const starting = recordSupervisorStarting({
      jobId: "sup-1",
      chatId: "chat-1",
      kind: "command",
      command: "echo hi",
      cwd: "/tmp",
      workspace: "/tmp/project",
      originTurnId: "turn-1",
    });
    expect(starting.state).toBe("starting");
    expect(starting.workspace).toBe("/tmp/project");

    const running = upsertSupervisorJob({
      job: supervisorJob("sup-1"),
      workspace: "/tmp/project",
    });
    expect(running.state).toBe("running");
    expect(running.output_paths).toContain(join(root, "stdout.log"));
    expect(listJobView("chat-1").map((job) => job.job_id)).toEqual(["sup-1"]);
  });

  it("reconciles missing supervisor rows to lost only against a real list", () => {
    recordSupervisorStarting({
      jobId: "sup-2",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 10",
      cwd: "/tmp",
    });
    upsertSupervisorJob({ job: supervisorJob("sup-2") });

    reconcileSupervisorJobs([]);
    expect(getJobView("sup-2")?.state).toBe("lost");
  });

  it("records a cell lifecycle and marks running cells lost at startup", () => {
    recordCellStarted({
      jobId: "cell-1",
      chatId: "chat-1",
      command: "print('hi')",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    expect(getJobView("cell-1")?.state).toBe("running");

    finishCellJob("cell-1", {
      state: "finished",
      exitCode: 0,
      endedAt: new Date().toISOString(),
      durationMs: 100,
      outputPaths: ["/tmp/cell-1.log"],
    });
    expect(getJobView("cell-1")?.state).toBe("finished");
    expect(getJobView("cell-1")?.output_paths).toEqual(["/tmp/cell-1.log"]);

    recordCellStarted({
      jobId: "cell-2",
      chatId: "chat-1",
      command: "print('later')",
      cwd: "/tmp",
      startedAt: new Date().toISOString(),
    });
    expect(markKernelJobsLostAtStartup()).toBe(1);
    expect(getJobView("cell-2")?.state).toBe("lost");
  });

  it("marks running chat rows stopped for deletion", () => {
    recordSupervisorStarting({
      jobId: "sup-3",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 10",
      cwd: "/tmp",
    });
    expect(markChatJobsStopped("chat-1", "chat-deleted")).toBe(1);
    expect(getJobView("sup-3")?.state).toBe("stopped");
    expect(getJobView("sup-3")?.stop_reason).toBe("chat-deleted");
  });

  it("mirrors a resolved terminal row instead of declaring a live job lost", () => {
    recordSupervisorStarting({
      jobId: "sup-4",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 10",
      cwd: "/tmp",
    });
    upsertSupervisorJob({ job: supervisorJob("sup-4") });

    // The live list omits sup-4 because it finished while the server was away.
    // Asking about that id individually recovers the real outcome.
    reconcileSupervisorJobs([], {
      resolveMissing: (jobId) =>
        jobId === "sup-4"
          ? { status: "found", job: supervisorJob("sup-4", "finished") }
          : { status: "absent" },
    });
    expect(getJobView("sup-4")?.state).toBe("finished");
  });

  it("leaves a live row alone when the supervisor lookup itself failed", () => {
    recordSupervisorStarting({
      jobId: "sup-5",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 10",
      cwd: "/tmp",
    });
    upsertSupervisorJob({ job: supervisorJob("sup-5") });

    reconcileSupervisorJobs([], { resolveMissing: () => ({ status: "unknown" }) });
    expect(getJobView("sup-5")?.state).toBe("running");
  });

  it("scopes a chat reconcile so other chats' live rows are not judged", () => {
    recordSupervisorStarting({
      jobId: "sup-6",
      chatId: "chat-2",
      kind: "service",
      command: "sleep 60",
      cwd: "/tmp",
    });
    upsertSupervisorJob({ job: supervisorJob("sup-6", "running", "chat-2") });

    // chat-1's reconcile sees no live rows at all, and must not reach into
    // chat-2 to declare its service lost.
    reconcileSupervisorJobs([], { chatId: "chat-1" });
    expect(getJobView("sup-6")?.state).toBe("running");
  });
});