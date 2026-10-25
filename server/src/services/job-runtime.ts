import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { JobsClient, type StartJobClientInput } from "./jobs-client.js";
import {
  closeJobView,
  initJobView,
  listJobView,
  markChatJobsLost,
  markChatJobsStopped,
  markJobViewFailed,
  markKernelJobsLostAtStartup,
  recordSupervisorStarting,
  reconcileSupervisorJobs,
  upsertSupervisorJob,
  type JobViewRow,
  type JobViewState,
} from "./job-view.js";
import type { JobRecord } from "./job-protocol.js";

/**
 * Server-side integration seam for the job supervisor
 * (docs/design/job-supervisor.md §8). Keeps one lazy client, mirrors supervisor
 * state into `job_view`, and degrades to the last known view when the daemon is
 * unavailable. A missing daemon must never make a running command look lost.
 */

export interface StartSupervisorJobInput extends Omit<StartJobClientInput, "job_id"> {
  job_id?: string;
  workspace?: string;
  notify?: boolean;
}

let client: JobsClient | null = null;
let subscribed = false;
let unsubscribe: (() => void) | null = null;
let connectPromise: Promise<boolean> | null = null;
let initialized = false;

export function getJobsClient(): JobsClient {
  if (!client) client = new JobsClient({ requestTimeoutMs: 2000 });
  return client;
}

export function isSupervisorConnected(): boolean {
  return client?.connected === true;
}

export async function initJobRuntime(): Promise<void> {
  if (initialized) return;
  initialized = true;
  initJobView();
  markKernelJobsLostAtStartup();
  void ensureSupervisorConnection().then((connected) => {
    if (connected) {
      void reconcileJobRuntime();
    } else {
      console.log("[jobs] supervisor unavailable; background commands will fail until it starts");
    }
  });
}

export function shutdownJobRuntime(): void {
  unsubscribe?.();
  unsubscribe = null;
  subscribed = false;
  connectPromise = null;
  initialized = false;
  const current = client;
  client = null;
  void current?.close().catch(() => {});
  closeJobView();
}

export async function ensureSupervisorConnection(): Promise<boolean> {
  if (client?.connected && subscribed) return true;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    const c = getJobsClient();
    if (!c.connected) {
      subscribed = false;
      try {
        await c.connect();
      } catch {
        return false;
      }
    }
    if (!subscribed) {
      try {
        unsubscribe?.();
        unsubscribe = await c.subscribe((event) => {
          try {
            upsertSupervisorJob({ job: event.job });
          } catch (error) {
            console.warn("[jobs] failed to mirror supervisor event:", error);
          }
        }, Number.MAX_SAFE_INTEGER);
        subscribed = true;
      } catch {
        subscribed = false;
        return false;
      }
    }
    return true;
  })();

  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

/** Pull the connected supervisor's full list into `job_view`. */
export async function reconcileJobRuntime(): Promise<void> {
  if (!(await ensureSupervisorConnection())) return;
  try {
    const jobs = await getJobsClient().listJobs({ limit: 500 });
    reconcileSupervisorJobs(jobs);
  } catch (error) {
    console.warn("[jobs] supervisor reconcile failed:", error);
  }
}

export async function startSupervisorJob(input: StartSupervisorJobInput): Promise<JobViewRow> {
  const jobId = input.job_id ?? randomUUID();
  recordSupervisorStarting({
    jobId,
    chatId: input.chat_id,
    kind: input.kind,
    command: input.command,
    cwd: input.cwd,
    workspace: input.workspace ?? null,
    originTurnId: input.origin_turn_id ?? null,
    notify: input.notify !== false,
  });

  if (!(await ensureSupervisorConnection())) {
    markJobViewFailed(jobId, "supervisor-unavailable");
    throw new Error("job supervisor unavailable");
  }
  try {
    const job = await getJobsClient().startJob({ ...input, job_id: jobId });
    return upsertSupervisorJob({
      job,
      workspace: input.workspace,
      notify: input.notify,
    });
  } catch (error) {
    markJobViewFailed(jobId, "spawn-failed");
    throw error;
  }
}

export async function stopSupervisorJob(
  jobId: string,
  force = false,
): Promise<JobViewRow> {
  if (!(await ensureSupervisorConnection())) {
    throw new Error("job supervisor unavailable");
  }
  const job = await getJobsClient().stopJob(jobId, force);
  return upsertSupervisorJob({ job });
}

export async function stopChatSupervisorJobs(chatId: string): Promise<number> {
  if (!(await ensureSupervisorConnection())) {
    const marked = markChatJobsLost(chatId, "supervisor-unavailable");
    return marked;
  }
  try {
    const count = await getJobsClient().stopChat(chatId);
    markChatJobsStopped(chatId, "chat-deleted");
    return count;
  } catch (error) {
    console.warn(`[jobs] stop_chat ${chatId} failed:`, error);
    return markChatJobsLost(chatId, "stop-failed");
  }
}

export async function waitForSupervisorJob(
  jobId: string,
  pattern: string,
  timeoutMs: number,
): Promise<{ matched: boolean; line: string | null; finished: boolean }> {
  if (!(await ensureSupervisorConnection())) {
    throw new Error("job supervisor unavailable");
  }
  const result = await getJobsClient().waitFor(jobId, pattern, timeoutMs);
  try {
    const job = await getJobsClient().getJob(jobId);
    if (job) upsertSupervisorJob({ job });
  } catch {
    // A refresh failure must not discard a successful wait result.
  }
  return result;
}

/** Refresh supervisor rows, then return this chat's unified view. */
export async function listJobsForChat(
  chatId: string,
  stateFilter?: JobViewState[],
): Promise<JobViewRow[]> {
  const c = getJobsClient();
  if (c.connected) {
    try {
      const jobs = await c.listJobs({ limit: 500 });
      reconcileSupervisorJobs(jobs);
    } catch {
      // Keep the durable view.
    }
  } else {
    void ensureSupervisorConnection().then((connected) => {
      if (connected) void reconcileJobRuntime();
    });
  }
  return listJobView(chatId, { states: stateFilter });
}

export async function refreshSupervisorJob(jobId: string): Promise<JobRecord | null> {
  if (!getJobsClient().connected) return null;
  try {
    const job = await getJobsClient().getJob(jobId);
    if (job) upsertSupervisorJob({ job });
    return job;
  } catch {
    return null;
  }
}

/** Read the last `lines` lines from a job output file (bounded read). */
export async function readJobOutputTail(path: string, lines = 50): Promise<string> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, 128 * 1024);
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer
      .toString("utf8")
      .split("\n")
      .slice(-Math.max(1, Math.min(lines, 200)))
      .join("\n");
  } finally {
    await handle.close();
  }
}