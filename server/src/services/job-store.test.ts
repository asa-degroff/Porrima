import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "./job-store.js";

const roots: string[] = [];
let store: JobStore;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "porrima-job-store-"));
  roots.push(root);
  store = JobStore.open(join(root, "jobs.db"));
});

afterEach(async () => {
  store?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function newJob(id = "job-1") {
  return {
    id,
    chat_id: "chat-1",
    kind: "command" as const,
    command: "echo hi",
    cwd: "/tmp",
    stdout_path: `/tmp/${id}/stdout.log`,
    stderr_path: `/tmp/${id}/stderr.log`,
    status_path: `/tmp/${id}/status.json`,
    origin_turn_id: "turn-1",
  };
}

describe("job store", () => {
  it("tracks the starting -> running -> finished lifecycle", () => {
    const starting = store.insertStarting(newJob());
    expect(starting.state).toBe("starting");
    expect(starting.origin_turn_id).toBe("turn-1");

    const running = store.markRunning("job-1", {
      pid: 123,
      pgid: 123,
      start_id: "proc:456",
      boot_id: "boot-1",
      started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(running.state).toBe("running");
    expect(running.pid).toBe(123);

    const finished = store.finish("job-1", {
      exit_code: 0,
      signal: null,
      ended_at: "2026-01-01T00:00:01.000Z",
      duration_ms: 1000,
    });
    expect(finished.state).toBe("finished");
    expect(finished.exit_code).toBe(0);
    expect(finished.duration_ms).toBe(1000);
  });

  it("marks stopped and lost distinctly", () => {
    store.insertStarting(newJob("stop-me"));
    store.markRunning("stop-me", {
      pid: 10,
      pgid: 10,
      start_id: null,
      boot_id: "boot",
      started_at: new Date().toISOString(),
    });
    const stopped = store.stop("stop-me", "user", new Date().toISOString(), 10);
    expect(stopped.state).toBe("stopped");
    expect(stopped.stop_reason).toBe("user");

    store.insertStarting(newJob("lose-me"));
    store.markRunning("lose-me", {
      pid: 11,
      pgid: 11,
      start_id: null,
      boot_id: "boot",
      started_at: new Date().toISOString(),
    });
    const lost = store.markLost("lose-me");
    expect(lost.state).toBe("lost");
  });

  it("lists by chat and state", () => {
    store.insertStarting(newJob("a"));
    store.insertStarting({ ...newJob("b"), chat_id: "chat-2" });
    store.markRunning("a", {
      pid: 1,
      pgid: 1,
      start_id: null,
      boot_id: "boot",
      started_at: new Date().toISOString(),
    });

    expect(store.list({ chat_id: "chat-2" }).map((job) => job.id)).toEqual(["b"]);
    expect(store.list({ states: ["running"] }).map((job) => job.id)).toEqual(["a"]);
    expect(store.countByState().running).toBe(1);
    expect(store.countByState().starting).toBe(1);
  });

  it("appends and replays events, pruning to the newest", () => {
    const job = store.insertStarting(newJob());
    const first = store.appendEvent("job_started", job);
    const second = store.appendEvent("job_finished", job);
    expect(second.seq).toBeGreaterThan(first.seq);

    expect(store.eventsSince(first.seq).map((event) => event.event)).toEqual([
      "job_finished",
    ]);
    expect(store.eventsSince(0)).toHaveLength(2);

    store.pruneEvents(1);
    expect(store.eventsSince(0).map((event) => event.event)).toEqual(["job_finished"]);
  });

  it("keeps a long-running job visible when terminal rows flood the ledger", () => {
    // A service started first, so it is the oldest row in the table.
    store.insertStarting(newJob("a-live-service"));
    store.markRunning("a-live-service", {
      pid: 4242,
      pgid: 4242,
      start_id: "proc:1",
      boot_id: "boot-1",
      started_at: new Date().toISOString(),
    });
    for (let i = 0; i < 501; i += 1) {
      const id = `z-fill-${String(i).padStart(3, "0")}`;
      store.insertStarting(newJob(id));
      store.finish(id, {
        exit_code: 0,
        signal: null,
        ended_at: new Date().toISOString(),
        duration_ms: 10,
      });
    }

    // A window over every state does not contain the live row. This is the
    // shape of the defect that marked long-lived services lost.
    const windowed = store.list({ limit: 500 }).map((job) => job.id);
    expect(windowed).toHaveLength(500);
    expect(windowed).not.toContain("a-live-service");

    // A states-filtered list is complete: live rows are bounded by the
    // supervisor's caps, so what it omits is real evidence.
    const live = store.list({ states: ["starting", "running"], limit: 1000 });
    expect(live.map((job) => job.id)).toEqual(["a-live-service"]);
  });
});