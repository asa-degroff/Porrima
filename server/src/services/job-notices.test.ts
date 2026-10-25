import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "./job-protocol.js";
import type { JobViewRow } from "./job-view.js";

let root = "";
let chatStorage: typeof import("./chat-storage.js");
let jobView: typeof import("./job-view.js");
let notices: typeof import("./job-notices.js");

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), "porrima-job-notices-"));
  process.env.PORRIMA_DATA_DIR = root;
  process.env.PORRIMA_JOB_NOTICE_WAKE = "0";
  chatStorage = await import("./chat-storage.js");
  jobView = await import("./job-view.js");
  notices = await import("./job-notices.js");
  jobView.initJobView();
  await chatStorage.createChat({
    id: "notice-chat",
    title: "Notice chat",
    type: "agent",
    modelId: "test-model",
    messages: [],
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  });
});

afterEach(async () => {
  notices.shutdownJobNotices();
  jobView.closeJobView();
  chatStorage.closeChatDb();
  delete process.env.PORRIMA_DATA_DIR;
  delete process.env.PORRIMA_JOB_NOTICE_WAKE;
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function job(
  id: string,
  state: JobRecord["state"] = "finished",
  overrides: Partial<JobRecord> = {},
): JobRecord {
  const now = new Date().toISOString();
  return {
    id,
    chat_id: "notice-chat",
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
    ended_at: now,
    duration_ms: 1200,
    stdout_path: join(root, "stdout.log"),
    stderr_path: join(root, "stderr.log"),
    status_path: join(root, "status.json"),
    origin_turn_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("job notices", () => {
  it("evaluates terminal jobs and delivers one teach-only notice row", async () => {
    jobView.upsertSupervisorJob({ job: job("job-1") });
    expect(notices.evaluateJobNotices()).toBe(1);
    expect(jobView.listPendingJobNotices("notice-chat")).toHaveLength(1);

    await notices.deliverChatNotices("notice-chat");

    const view = jobView.getJobView("job-1");
    expect(view?.notice_state).toBe("delivered");
    expect(view?.notice_message_id).toBeTruthy();
    const chat = await chatStorage.getChat("notice-chat");
    const row = chat?.messages.find((message) => message._isJobNotice);
    expect(row).toBeTruthy();
    expect(row?.content).toContain("no user sent this");
    expect(row?.content).toContain("jobs status");
    expect(row?.content).toContain("echo hi");
    expect(row?._jobNotice?.jobs.map((entry) => entry.id)).toEqual(["job-1"]);
    expect(row?._jobNotice?.display).toContain("finished");
  });

  it("coalesces multiple pending completions into one row", async () => {
    jobView.upsertSupervisorJob({ job: job("job-a") });
    jobView.upsertSupervisorJob({ job: job("job-b", "finished", { command: "echo two" }) });
    expect(notices.evaluateJobNotices()).toBe(2);

    await notices.deliverChatNotices("notice-chat");

    const chat = await chatStorage.getChat("notice-chat");
    const rows = chat?.messages.filter((message) => message._isJobNotice) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]._jobNotice?.jobs).toHaveLength(2);
    expect(jobView.getJobView("job-a")?.notice_group).toBe(
      jobView.getJobView("job-b")?.notice_group,
    );
  });

  it("coalesces a large batch into one bounded row", async () => {
    for (let i = 0; i < 12; i += 1) {
      jobView.upsertSupervisorJob({
        job: job(`job-batch-${i}`, "finished", { command: `echo batch ${i}` }),
      });
    }
    expect(notices.evaluateJobNotices()).toBe(12);

    await notices.deliverChatNotices("notice-chat");

    const chat = await chatStorage.getChat("notice-chat");
    const rows = chat?.messages.filter((message) => message._isJobNotice) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]._jobNotice?.jobs).toHaveLength(12);
    expect(rows[0].content).toContain("and 2 more background jobs");
    expect(jobView.listPendingJobNotices("notice-chat")).toHaveLength(0);
  });

  it("does not queue a notice for a consumed or ineligible job", async () => {
    jobView.upsertSupervisorJob({ job: job("job-user-stop", "stopped", { stop_reason: "user" }) });
    jobView.upsertSupervisorJob({ job: job("job-failed", "failed") });
    jobView.upsertSupervisorJob({
      job: job("job-notify-off", "finished", { command: "echo quiet" }),
      notify: false,
    });
    jobView.upsertSupervisorJob({ job: job("job-read", "finished") });

    expect(notices.evaluateJobNotices()).toBe(1);
    jobView.suppressJobNotices(["job-read"]);
    await notices.deliverChatNotices("notice-chat");

    expect(jobView.getJobView("job-user-stop")?.notice_state).toBe("suppressed");
    expect(jobView.getJobView("job-failed")?.notice_state).toBe("suppressed");
    expect(jobView.getJobView("job-notify-off")?.notice_state).toBe("suppressed");
    expect(jobView.getJobView("job-read")?.notice_state).toBe("suppressed");
  });

  it("classifies service, cell, lost, and stopped outcomes", () => {
    const base = jobView.getJobView("missing") ?? ({
      job_id: "x",
      chat_id: "notice-chat",
      workspace: null,
      kind: "command",
      source: "supervisor",
      command: null,
      cwd: null,
      pid: null,
      pgid: null,
      start_id: null,
      boot_id: null,
      state: "finished",
      exit_code: 0,
      signal: null,
      stop_reason: null,
      started_at: null,
      ended_at: null,
      duration_ms: null,
      output_paths: [],
      origin_turn_id: null,
      notify: true,
      notice_group: null,
      notice_message_id: null,
      notice_state: "none",
      last_synced_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies JobViewRow);

    expect(notices.shouldNotify({ ...base, kind: "command", state: "finished" })).toBe(true);
    expect(
      notices.shouldNotify({ ...base, kind: "command", state: "stopped", stop_reason: "timeout" }),
    ).toBe(true);
    expect(
      notices.shouldNotify({ ...base, kind: "command", state: "stopped", stop_reason: "user" }),
    ).toBe(false);
    expect(notices.shouldNotify({ ...base, kind: "service", state: "finished" })).toBe(true);
    expect(
      notices.shouldNotify({
        ...base,
        kind: "service",
        state: "finished",
        stop_reason: "daemonized",
      }),
    ).toBe(false);
    expect(
      notices.shouldNotify({ ...base, kind: "service", state: "stopped", stop_reason: "user" }),
    ).toBe(false);
    expect(notices.shouldNotify({ ...base, kind: "cell", state: "lost" })).toBe(true);
    expect(notices.shouldNotify({ ...base, kind: "cell", state: "failed" })).toBe(false);
    expect(notices.shouldNotify({ ...base, kind: "remote" })).toBe(false);
    expect(notices.shouldNotify({ ...base, notify: false })).toBe(false);
  });

  it("reopens an appended notice whose row is missing", () => {
    jobView.upsertSupervisorJob({ job: job("job-recover") });
    jobView.markJobNoticePending("job-recover");
    jobView.markJobNoticeAppended(["job-recover"], "group-1", "missing-row");

    notices.recoverAppendedNotices();
    expect(jobView.getJobView("job-recover")?.notice_state).toBe("pending");
  });

  it("suppresses a pending notice that aged out while undeliverable", async () => {
    const ended = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    jobView.upsertSupervisorJob({ job: job("job-stale", "finished", { ended_at: ended }) });
    jobView.markJobNoticePending("job-stale");

    await notices.deliverChatNotices("notice-chat");

    expect(jobView.getJobView("job-stale")?.notice_state).toBe("suppressed");
    const chat = await chatStorage.getChat("notice-chat");
    expect(chat?.messages.filter((message) => message._isJobNotice)).toHaveLength(0);
  });

  it("reuses a pre-minted row id after a crash before the append", async () => {
    jobView.upsertSupervisorJob({ job: job("job-prepare") });
    expect(notices.evaluateJobNotices()).toBe(1);
    jobView.prepareJobNoticeDelivery(["job-prepare"], "prepared-group", "prepared-row");

    await notices.deliverChatNotices("notice-chat");

    const view = jobView.getJobView("job-prepare");
    expect(view?.notice_state).toBe("delivered");
    expect(view?.notice_message_id).toBe("prepared-row");
    const chat = await chatStorage.getChat("notice-chat");
    expect(chat?.messages).toHaveLength(1);
    expect(chat?.messages[0]._rowId).toBe("prepared-row");
  });

  it("merges a new job into a prepared batch that was never appended", async () => {
    jobView.upsertSupervisorJob({ job: job("job-first") });
    expect(notices.evaluateJobNotices()).toBe(1);
    jobView.prepareJobNoticeDelivery(["job-first"], "prepared-group", "prepared-row");
    jobView.upsertSupervisorJob({ job: job("job-second") });
    expect(notices.evaluateJobNotices()).toBe(1);

    await notices.deliverChatNotices("notice-chat");

    const chat = await chatStorage.getChat("notice-chat");
    const rows = chat?.messages.filter((message) => message._isJobNotice) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]._rowId).toBe("prepared-row");
    expect(rows[0]._jobNotice?.jobs.map((entry) => entry.id).sort()).toEqual([
      "job-first",
      "job-second",
    ]);
    expect(jobView.listPendingJobNotices("notice-chat")).toHaveLength(0);
  });

  it("does not append twice when the prepared row already exists", async () => {
    jobView.upsertSupervisorJob({ job: job("job-appended") });
    expect(notices.evaluateJobNotices()).toBe(1);
    jobView.prepareJobNoticeDelivery(["job-appended"], "prepared-group", "prepared-row");
    await chatStorage.appendChatMessageRow("notice-chat", {
      role: "user",
      content: "already appended",
      timestamp: Date.now(),
      _isJobNotice: true,
      _rowId: "prepared-row",
    });
    jobView.upsertSupervisorJob({ job: job("job-later") });
    expect(notices.evaluateJobNotices()).toBe(1);

    await notices.deliverChatNotices("notice-chat");

    expect(jobView.getJobView("job-appended")?.notice_state).toBe("delivered");
    // The durable row cannot grow a job that was never announced, so the
    // later completion keeps its own pending notice.
    expect(jobView.getJobView("job-later")?.notice_state).toBe("pending");
    let chat = await chatStorage.getChat("notice-chat");
    expect(chat?.messages).toHaveLength(1);

    await notices.deliverChatNotices("notice-chat");

    chat = await chatStorage.getChat("notice-chat");
    const rows = chat?.messages.filter((message) => message._isJobNotice) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[1]._jobNotice?.jobs.map((entry) => entry.id)).toEqual(["job-later"]);
  });
});