import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord } from "./job-protocol.js";

const wake = vi.hoisted(() => ({
  runNoticeTurn: vi.fn(async () => false),
}));

vi.mock("./notice-runner.js", () => ({
  NOTICE_TURN_TIMEOUT_MS: 600_000,
  runNoticeTurn: wake.runNoticeTurn,
}));

let root = "";
let chatStorage: typeof import("./chat-storage.js");
let jobView: typeof import("./job-view.js");
let notices: typeof import("./job-notices.js");

beforeEach(async () => {
  vi.resetModules();
  wake.runNoticeTurn.mockClear();
  root = await mkdtemp(join(tmpdir(), "porrima-job-notices-wake-"));
  process.env.PORRIMA_DATA_DIR = root;
  delete process.env.PORRIMA_JOB_NOTICE_WAKE;
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
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

function doneJob(id: string): JobRecord {
  const now = new Date().toISOString();
  return {
    id,
    chat_id: "notice-chat",
    kind: "command",
    command: "echo hi",
    cwd: "/tmp",
    state: "finished",
    pid: 123,
    pgid: 123,
    start_id: "proc:1",
    boot_id: "boot-1",
    exit_code: 0,
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
  };
}

describe("job notice wake failure", () => {
  it("leaves the notice row standing and does not retry a failed wake", async () => {
    jobView.upsertSupervisorJob({ job: doneJob("job-wake-fails") });
    expect(notices.evaluateJobNotices()).toBe(1);

    await notices.deliverChatNotices("notice-chat");

    expect(wake.runNoticeTurn).toHaveBeenCalledTimes(1);
    expect(jobView.getJobView("job-wake-fails")?.notice_state).toBe("delivered");
    const chat = await chatStorage.getChat("notice-chat");
    expect(chat?.messages.filter((message) => message._isJobNotice)).toHaveLength(1);

    // Delivered is terminal for the notice plane; the row remains for the next
    // real turn, but a failed wake is not re-paid on the next tick.
    await notices.deliverChatNotices("notice-chat");
    expect(wake.runNoticeTurn).toHaveBeenCalledTimes(1);
  });
});