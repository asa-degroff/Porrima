import Database from "better-sqlite3";
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
  markJobViewFailed,
  markJobViewLost,
  markJobNoticeAppended,
  markJobNoticePending,
  markKernelJobsLostAtStartup,
  markSupervisorJobsProbed,
  pruneTerminalJobView,
  recordCellStarted,
  recordSupervisorStarting,
  reconcileSupervisorJobs,
  uncertainSupervisorJobIds,
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

function seedUncertainJob(id: string, chatId = "chat-1"): void {
  recordSupervisorStarting({
    jobId: id,
    chatId,
    kind: "command",
    command: "echo hi",
    cwd: "/tmp",
  });
  markJobViewFailed(id, "spawn-failed");
}

function setEndedAt(id: string, endedAt: string): void {
  const db = new Database(dbPath);
  try {
    db.prepare("UPDATE job_view SET ended_at = ? WHERE job_id = ?").run(endedAt, id);
  } finally {
    db.close();
  }
}

describe("job view", () => {
  it("mirrors the cap fact and keeps it once set", () => {
    const job = supervisorJob("capped-1", "finished");
    job.output_capped = true;
    upsertSupervisorJob({ job });
    expect(getJobView("capped-1")?.output_capped).toBe(true);

    // A mirror refresh that forgot the cap must not erase it.
    job.output_capped = false;
    upsertSupervisorJob({ job });
    expect(getJobView("capped-1")?.output_capped).toBe(true);
  });

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

  it("withdraws a queued notice when an authoritative report says the job is live", () => {
    recordSupervisorStarting({
      jobId: "sup-notice",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 30",
      cwd: "/tmp",
    });
    markJobViewLost("sup-notice", "supervisor-no-row");
    markJobNoticePending("sup-notice");
    expect(getJobView("sup-notice")?.notice_state).toBe("pending");

    // The row was queued to wake the chat with "outcome unknown". A supervisor
    // report that the job is running makes that claim false, so the wake has
    // to be withdrawn before it is delivered.
    upsertSupervisorJob({ job: supervisorJob("sup-notice", "running") }, { authoritative: true });
    const row = getJobView("sup-notice");
    expect(row?.state).toBe("running");
    expect(row?.notice_state).toBe("none");
    expect(row?.notice_group).toBeNull();
    expect(row?.notice_message_id).toBeNull();
  });

  it("keeps an appended notice as the record it was when the row is corrected", () => {
    recordSupervisorStarting({
      jobId: "sup-appended",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 30",
      cwd: "/tmp",
    });
    markJobViewLost("sup-appended", "start-unknown");
    markJobNoticePending("sup-appended");
    markJobNoticeAppended(["sup-appended"], "group-1", "msg-1");

    upsertSupervisorJob({ job: supervisorJob("sup-appended", "running") }, { authoritative: true });
    const row = getJobView("sup-appended");
    expect(row?.state).toBe("running");
    // The notice row already exists in the transcript. Rewriting its state
    // would orphan it, and the claim was true when it was written.
    expect(row?.notice_state).toBe("appended");
    expect(row?.notice_message_id).toBe("msg-1");
  });

  it("sweeps uncertain rows in rotating batches instead of re-asking the newest", () => {
    const now = Date.now();
    const recheckMs = 10 * 60_000;
    const total = 120;
    for (let i = 0; i < total; i += 1) {
      seedUncertainJob(`uncertain-${String(i).padStart(3, "0")}`);
    }

    const seen = new Set<string>();
    let batches = 0;
    for (;;) {
      const batch = uncertainSupervisorJobIds("chat-1", 50, { nowMs: now, recheckMs });
      if (batch.length === 0) break;
      for (const id of batch) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      markSupervisorJobsProbed(batch, new Date(now).toISOString());
      batches += 1;
      expect(batches).toBeLessThanOrEqual(3);
    }

    expect(batches).toBe(3);
    expect(seen.size).toBe(total);

    // The same list a moment later must not re-ask rows inside the recheck
    // window; otherwise every `jobs list` fans out over the same ids.
    expect(uncertainSupervisorJobIds("chat-1", 50, { nowMs: now, recheckMs })).toEqual([]);

    // After the window, the least-recently-probed batch is due again.
    expect(
      uncertainSupervisorJobIds("chat-1", 50, {
        nowMs: now + recheckMs + 1,
        recheckMs,
      }),
    ).toHaveLength(50);
  });

  it("stops automatic probes once uncertainty ages past the horizon", () => {
    const now = Date.now();
    seedUncertainJob("probe-fresh");
    seedUncertainJob("probe-in-window");
    seedUncertainJob("probe-stale");
    setEndedAt("probe-in-window", new Date(now - 6 * 24 * 60 * 60_000).toISOString());
    setEndedAt("probe-stale", new Date(now - 8 * 24 * 60 * 60_000).toISOString());

    const ids = uncertainSupervisorJobIds("chat-1", 50, { nowMs: now });
    expect(ids).toContain("probe-fresh");
    expect(ids).toContain("probe-in-window");
    expect(ids).not.toContain("probe-stale");
  });

  it("prunes terminal rows past the record cutoff and leaves live rows", () => {
    const old = "2020-01-01T00:00:00.000Z";
    upsertSupervisorJob({
      job: { ...supervisorJob("old-view", "finished"), ended_at: old },
    });
    upsertSupervisorJob({ job: supervisorJob("new-view", "finished") });
    recordSupervisorStarting({
      jobId: "live-view",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 30",
      cwd: "/tmp",
    });
    upsertSupervisorJob({ job: supervisorJob("live-view", "running") });

    expect(pruneTerminalJobView("2025-01-01T00:00:00.000Z")).toBe(1);
    expect(getJobView("old-view")).toBeNull();
    expect(getJobView("new-view")?.state).toBe("finished");
    expect(getJobView("live-view")?.state).toBe("running");
  });

  it("stamps the probe clock only on uncertain supervisor rows", () => {
    upsertSupervisorJob({ job: supervisorJob("done-1", "finished") });
    const before = getJobView("done-1")?.last_synced_at;
    expect(before).toBeTruthy();

    expect(markSupervisorJobsProbed(["done-1"], "2000-01-01T00:00:00.000Z")).toBe(0);
    expect(getJobView("done-1")?.last_synced_at).toBe(before);
  });

  it("corrects a false lost/failed row only from an authoritative supervisor report", () => {
    recordSupervisorStarting({
      jobId: "sup-7",
      chatId: "chat-1",
      kind: "command",
      command: "sleep 10",
      cwd: "/tmp",
    });
    upsertSupervisorJob({ job: supervisorJob("sup-7") });
    markJobViewLost("sup-7", "start-unknown");

    // An event-shaped update keeps the terminal guard.
    upsertSupervisorJob({ job: supervisorJob("sup-7", "running") });
    expect(getJobView("sup-7")?.state).toBe("lost");

    // The supervisor list/start response is authoritative: the job is live.
    upsertSupervisorJob({ job: supervisorJob("sup-7", "running") }, { authoritative: true });
    expect(getJobView("sup-7")?.state).toBe("running");

    markJobViewFailed("sup-7", "spawn-failed");
    upsertSupervisorJob({ job: supervisorJob("sup-7", "running") }, { authoritative: true });
    expect(getJobView("sup-7")?.state).toBe("running");
  });
});