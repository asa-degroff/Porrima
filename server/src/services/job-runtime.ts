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
  markJobViewLost,
  markKernelJobsLostAtStartup,
  markSupervisorJobsProbed,
  recordSupervisorStarting,
  reconcileSupervisorJobs,
  liveSupervisorJobIds,
  uncertainSupervisorJobIds,
  upsertSupervisorJob,
  type JobViewRow,
  type JobViewState,
  type MissingSupervisorJob,
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
            if (
              event.event === "job_finished" ||
              event.event === "job_lost" ||
              event.event === "job_stopped"
            ) {
              void import("./job-notices.js")
                .then((notices) => notices.scheduleNoticeTick())
                .catch(() => {});
            }
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

/**
 * Pull the connected supervisor's live jobs into `job_view`.
 *
 * The list is filtered to the live states on purpose. Live rows are bounded by
 * the supervisor's own caps, so a states-filtered list is complete, while a
 * window over every state is not: a service started before 500 short commands
 * would fall off the page and be mistaken for a lost job. Rows the live list
 * does not mention are resolved individually — a command that finished while
 * the server was disconnected is `finished`, not `lost`.
 */
const LIVE_STATES: JobViewState[] = ["starting", "running"];
const LIVE_LIST_LIMIT = 1000;

async function reconcileAgainstSupervisor(chatId?: string): Promise<void> {
  const c = getJobsClient();
  const live = await c.listJobs({
    chat_id: chatId,
    states: LIVE_STATES,
    limit: LIVE_LIST_LIMIT,
  });
  const liveIds = new Set(live.map((job) => job.id));
  const unresolved = new Set(
    liveSupervisorJobIds(chatId).filter((id) => !liveIds.has(id)),
  );
  const uncertain = uncertainSupervisorJobIds(chatId).filter(
    (id) => !liveIds.has(id),
  );
  for (const id of uncertain) unresolved.add(id);
  const resolutions = new Map<string, MissingSupervisorJob>();
  await Promise.all(
    [...unresolved].map(async (jobId) => {
      try {
        const job = await c.getJob(jobId);
        resolutions.set(jobId, job ? { status: "found", job } : { status: "absent" });
      } catch {
        resolutions.set(jobId, { status: "unknown" });
      }
    }),
  );
  // Stamp the uncertain ids we just asked about, including absent and failed
  // lookups. Without this clock the same newest rows are re-asked on every
  // `jobs list` and older uncertainty is never swept.
  if (uncertain.length > 0) markSupervisorJobsProbed(uncertain);
  reconcileSupervisorJobs(live, {
    chatId,
    resolveMissing: (jobId) => resolutions.get(jobId) ?? { status: "unknown" },
  });
  // An uncertain row is not live in the view, so reconcileSupervisorJobs does
  // not judge it. A found row is authoritative; absent/unknown leaves the
  // uncertainty in place rather than pretending to know.
  for (const jobId of uncertain) {
    const resolution = resolutions.get(jobId);
    if (resolution?.status === "found") {
      upsertSupervisorJob({ job: resolution.job }, { authoritative: true });
    }
  }
}

export async function reconcileJobRuntime(): Promise<void> {
  if (!(await ensureSupervisorConnection())) return;
  try {
    await reconcileAgainstSupervisor();
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
    return upsertSupervisorJob(
      {
        job,
        workspace: input.workspace,
        notify: input.notify,
      },
      { authoritative: true },
    );
  } catch (error) {
    // The request can time out or lose its socket after the daemon already
    // spawned the job. Ask by id before declaring failure; a found row is the
    // real state, an absent row is a start failure, and a failed lookup is
    // uncertainty rather than a fabricated failure.
    let lookupFailed = false;
    let found: JobRecord | null = null;
    try {
      found = await getJobsClient().getJob(jobId);
    } catch {
      lookupFailed = true;
    }
    if (found) {
      const view = upsertSupervisorJob(
        { job: found, workspace: input.workspace, notify: input.notify },
        { authoritative: true },
      );
      if (view.state === "failed" || view.state === "lost") {
        throw new Error(`job supervisor start failed for ${jobId} (${view.state})`);
      }
      return view;
    }
    if (lookupFailed) {
      markJobViewLost(jobId, "start-unknown");
      void import("./job-notices.js")
        .then((notices) => notices.scheduleNoticeTick())
        .catch(() => {});
      throw new Error(
        `job supervisor start outcome unknown for ${jobId}; check jobs status`,
      );
    }
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
  return upsertSupervisorJob({ job }, { authoritative: true });
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

/** Refresh this chat's supervisor rows, then return its unified view. */
export async function listJobsForChat(
  chatId: string,
  stateFilter?: JobViewState[],
): Promise<JobViewRow[]> {
  const c = getJobsClient();
  if (c.connected) {
    try {
      await reconcileAgainstSupervisor(chatId);
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
    if (job) upsertSupervisorJob({ job }, { authoritative: true });
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