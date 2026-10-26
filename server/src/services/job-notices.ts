import { randomUUID } from "node:crypto";
import { appendChatMessageRow, getChat, getDb } from "./chat-storage.js";
import { buildTimeAnchor } from "./memory-context.js";
import { getStoredSystemPauseState } from "./system-pause.js";
import {
  acquireTurn,
  releaseTurn,
  type TurnLease,
} from "./turn-gate.js";
import {
  listAppendedJobNotices,
  listChatsWithPendingNotices,
  listJobNoticeCandidates,
  listPendingJobNotices,
  markJobNoticeAppended,
  markJobNoticeDelivered,
  markJobNoticePending,
  prepareJobNoticeDelivery,
  reopenJobNotice,
  suppressJobNotices,
  type JobViewRow,
} from "./job-view.js";
import type { ChatMessage, JobNoticeJob, JobNoticeMetadata } from "../types.js";

/**
 * Host-owned L1 completion notices (docs/design/kernel-durability.md §3.3).
 *
 * A terminal job with an unread result becomes `pending`; a scheduler tick
 * coalesces the chat's pending jobs into one notice row, appends it while
 * holding the turn-gate lease, and optionally starts a headless wake turn.
 * `jobs` reads suppress the notice; UI views do not.
 */

const TICK_MS = 5000;
const RETRY_DELAY_MS = 500;
const DELIVERY_WAIT_MS = 2000;
const MAX_JOBS_PER_NOTICE = 100;
const MAX_DETAILED_JOBS = 10;
const NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const MAX_WAKES_PER_HOUR = envInt("PORRIMA_JOB_NOTICE_WAKES_PER_HOUR", 3);
const MAX_WAKES_PER_DAY = envInt("PORRIMA_JOB_NOTICE_WAKES_PER_DAY", 10);
const WAKE_ENABLED = process.env.PORRIMA_JOB_NOTICE_WAKE !== "0";

let initialized = false;
let intervalTimer: NodeJS.Timeout | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let ticking = false;
const deliveringChats = new Set<string>();
const wakeHistory = new Map<string, number[]>();

export function initJobNotices(): void {
  if (initialized) return;
  initialized = true;
  recoverAppendedNotices();
  scheduleNoticeTick(1000);
  intervalTimer = setInterval(() => {
    void tick();
  }, TICK_MS);
  intervalTimer.unref?.();
}

export function shutdownJobNotices(): void {
  initialized = false;
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
  deliveringChats.clear();
  wakeHistory.clear();
}

/** Prompt a delivery attempt after a terminal job event. */
export function scheduleNoticeTick(delayMs = RETRY_DELAY_MS): void {
  if (!initialized || tickTimer) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    void tick();
  }, Math.max(0, delayMs));
  tickTimer.unref?.();
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    evaluateJobNotices();
    recoverAppendedNotices();
    for (const chatId of listChatsWithPendingNotices()) {
      await deliverChatNotices(chatId);
    }
  } catch (error) {
    console.warn("[jobs] notice tick failed:", error);
  } finally {
    ticking = false;
    if (initialized && listChatsWithPendingNotices().length > 0) {
      scheduleNoticeTick(TICK_MS);
    }
  }
}

/** Classify terminal rows into pending/suppressed. Exported for tests. */
export function evaluateJobNotices(): number {
  let pending = 0;
  for (const job of listJobNoticeCandidates(300)) {
    if (shouldNotify(job) && !isExpired(job)) {
      markJobNoticePending(job.job_id);
      pending += 1;
    } else {
      suppressJobNotices([job.job_id]);
    }
  }
  return pending;
}

/** Deliver one chat's pending notices (coalesced). Exported for tests. */
export async function deliverChatNotices(chatId: string): Promise<void> {
  if (deliveringChats.has(chatId)) return;
  deliveringChats.add(chatId);
  let lease: TurnLease | null = null;
  try {
    if (await noticesPaused()) return;
    if (listPendingJobNotices(chatId, 1).length === 0) return;

    lease = await acquireNoticeLease(chatId);
    if (!lease) return;
    if (await noticesPaused()) return;

    const pending = listPendingJobNotices(chatId, MAX_JOBS_PER_NOTICE);
    const expired = pending.filter(isExpired);
    if (expired.length > 0) {
      suppressJobNotices(expired.map((job) => job.job_id));
    }
    const fresh = pending.filter((job) => !isExpired(job));
    if (fresh.length === 0) return;

    const chat = await getChat(chatId);
    if (!chat) {
      suppressJobNotices(fresh.map((job) => job.job_id));
      return;
    }

    // Reuse an identity minted by a delivery that crashed before marking the
    // rows appended. Rows prepared under a different identity keep waiting for
    // their own batch rather than being folded into this one.
    const prepared = fresh.find((job) => job.notice_group && job.notice_message_id);
    const group = prepared?.notice_group ?? randomUUID();
    const rowId = prepared?.notice_message_id ?? randomUUID();
    const rowAlreadyAppended =
      prepared != null && chatMessageRowExists(chatId, rowId);
    // Once the row is durable its payload is fixed: new jobs cannot join that
    // batch or they would be marked delivered without ever being announced.
    const batch = prepared
      ? fresh.filter((job) =>
          rowAlreadyAppended
            ? job.notice_message_id === rowId
            : !job.notice_message_id || job.notice_message_id === rowId,
        )
      : fresh;
    if (!rowAlreadyAppended) {
      prepareJobNoticeDelivery(
        batch.map((job) => job.job_id),
        group,
        rowId,
      );
    }

    const notice = buildNotice(batch, group);
    const message: ChatMessage = {
      role: "user",
      content: notice.modelText,
      timestamp: Date.now(),
      timeAnchor: buildTimeAnchor(chat.messages, chat.id),
      _isJobNotice: true,
      _jobNotice: notice.meta,
      _rowId: rowId,
    };
    if (!rowAlreadyAppended) {
      try {
        await appendChatMessageRow(chatId, message);
      } catch (error) {
        // A retry after a crash between append and the job_view update finds
        // the pre-minted row already there; treat the unique-key failure as
        // success, never append a second notice.
        if (!isDuplicateRowError(error)) throw error;
      }
    }
    markJobNoticeAppended(
      batch.map((job) => job.job_id),
      group,
      rowId,
    );

    const wake = WAKE_ENABLED && chat.type !== "system" && canWake(chatId);
    let woke = false;
    if (wake) {
      // Charged before the attempt on purpose: a failed wake is the expensive
      // case (it just paid a full prefill for nothing), and the quota is what
      // stops this chat from re-paying it every tick.
      recordWake(chatId);
      try {
        const { runNoticeTurn } = await import("./notice-runner.js");
        woke = await runNoticeTurn(chatId, notice.meta);
      } catch (error) {
        console.warn(`[jobs] notice wake turn failed for chat=${chatId}:`, error);
      }
      if (!woke) {
        // The wake is what makes the agent act on the notice, so a failed wake
        // is a real outcome and must not look like a delivered one. The payload
        // itself is not lost: the notice row is the tail of this chat's
        // transcript, so the next turn reads it. What is lost is the wake, and
        // it is not retried — retrying would need a state the notice plane does
        // not have (see docs/design/kernel-durability.md §3.3).
        console.warn(
          `[jobs] notice wake did not complete for chat=${chatId} group=${group} ` +
            `(jobs=${batch.length}); notice row stands, no wake retry`,
        );
      }
    }
    markJobNoticeDelivered(group);
  } finally {
    if (lease) releaseTurn(lease);
    deliveringChats.delete(chatId);
  }
}

/** True when the notice should wake/announce (docs §3.3 wake table). */
export function shouldNotify(job: JobViewRow): boolean {
  if (!job.notify) return false;
  if (job.kind === "remote") return false;
  if (job.state === "failed") return false;

  if (job.kind === "cell") {
    if (job.state === "finished" || job.state === "lost") return true;
    return false;
  }

  if (job.state === "lost") {
    if (job.stop_reason === "chat-deleted" || job.stop_reason === "system-stop") return false;
    return true;
  }

  if (
    job.stop_reason === "user" ||
    job.stop_reason === "user-force" ||
    job.stop_reason === "chat-deleted" ||
    job.stop_reason === "system-stop" ||
    job.stop_reason === "workspace-change"
  ) {
    return false;
  }

  if (job.kind === "service") {
    // "daemonized" means the launcher exited but the service's process group
    // still runs — normal continuation, not news.
    if (job.stop_reason === "daemonized") return false;
    return job.state === "finished" || job.state === "stopped";
  }
  if (job.kind === "command") {
    if (job.state === "finished") return true;
    if (job.state === "stopped") {
      return (
        job.stop_reason === "timeout" ||
        job.stop_reason === "log-cap" ||
        job.output_capped === true ||
        job.stop_reason === "memory-cap"
      );
    }
  }
  return false;
}

/** Recover an `appended` row after a crash: existing row → delivered, missing → pending. */
export function recoverAppendedNotices(): void {
  const rows = listAppendedJobNotices();
  if (rows.length === 0) return;
  const groups = new Map<string, JobViewRow[]>();
  for (const row of rows) {
    const key = row.notice_group ?? `job:${row.job_id}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [group, jobs] of groups) {
    const first = jobs[0];
    const exists =
      first.notice_message_id != null &&
      chatMessageRowExists(first.chat_id, first.notice_message_id);
    if (exists) {
      markJobNoticeDelivered(group);
    } else {
      for (const job of jobs) reopenJobNotice(job.job_id);
    }
  }
}

function buildNotice(
  jobs: JobViewRow[],
  group: string,
): { modelText: string; meta: JobNoticeMetadata } {
  const metaJobs: JobNoticeJob[] = jobs.map((job) => ({
    id: job.job_id,
    kind: job.kind,
    state: job.state,
    exitCode: job.exit_code,
    signal: job.signal,
    stopReason: job.stop_reason,
    command: job.command == null ? null : shortCommand(job.command),
    outputPath: job.output_paths[0] ?? null,
  }));
  const count = jobs.length;
  const display =
    count === 1
      ? noticeDisplayLine(jobs[0])
      : `${count} background jobs finished`;
  const lines: string[] = [
    `[Job notice — no user sent this. ${
      count === 1 ? "A background job has news." : `${count} background jobs have news.`
    }]`,
  ];
  for (const job of jobs.slice(0, MAX_DETAILED_JOBS)) lines.push(noticeModelLine(job));
  if (jobs.length > MAX_DETAILED_JOBS) {
    lines.push(
      `- ...and ${jobs.length - MAX_DETAILED_JOBS} more background jobs; use \`jobs list\` for the full set.`,
    );
  }
  lines.push(
    "Use `jobs status <jobId>` or `jobs tail <jobId>` if you need the result. " +
      "If nothing here needs action, acknowledge briefly and stay idle; do not poll.",
  );
  return {
    modelText: lines.join("\n"),
    meta: { group, jobs: metaJobs, display },
  };
}

function noticeDisplayLine(job: JobViewRow): string {
  const duration = job.duration_ms != null ? `, ${formatDuration(job.duration_ms)}` : "";
  const command = shortCommand(job.command);
  if (job.state === "lost") return `${job.kind} outcome unknown: ${command}`;
  if (job.stop_reason === "log-cap" || job.output_capped) {
    return `${job.kind} output capped${duration}: ${command}`;
  }
  if (job.kind === "service" && job.state === "finished") {
    return `service exited unexpectedly (exit ${job.exit_code ?? "?"}${duration}): ${command}`;
  }
  if (job.state === "finished") {
    return `${job.kind} finished (exit ${job.exit_code ?? "?"}${duration}): ${command}`;
  }
  if (job.state === "stopped") {
    return `${job.kind} stopped (${job.stop_reason ?? "stopped"}${duration}): ${command}`;
  }
  return `${job.kind} ${job.state}: ${command}`;
}

function noticeModelLine(job: JobViewRow): string {
  const bits = [
    `- ${job.job_id} [${job.kind}]`,
    job.state,
    job.exit_code != null ? `exit=${job.exit_code}` : "",
    job.signal ? `signal=${job.signal}` : "",
    job.stop_reason ?? "",
    job.duration_ms != null ? formatDuration(job.duration_ms) : "",
  ].filter(Boolean);
  const command = shortCommand(job.command);
  const output = job.output_paths[0] ? `\n  output: ${job.output_paths[0]}` : "";
  const lost =
    job.state === "lost"
      ? "\n  Outcome unknown — check side effects before re-running; never re-run automatically."
      : "";
  return `${bits.join(" ")}${command ? `: ${command}` : ""}${output}${lost}`;
}

function shortCommand(command: string | null): string {
  if (!command) return "(cell)";
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder > 0 ? `${minutes}m${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const hourRemainder = minutes % 60;
  return hourRemainder > 0 ? `${hours}h${hourRemainder}m` : `${hours}h`;
}

function isExpired(job: JobViewRow): boolean {
  const at = Date.parse(job.ended_at ?? job.started_at ?? job.created_at);
  return Number.isFinite(at) && Date.now() - at > NOTICE_MAX_AGE_MS;
}

async function noticesPaused(): Promise<boolean> {
  const pause = await getStoredSystemPauseState().catch(() => null);
  return pause?.active === true;
}

async function acquireNoticeLease(chatId: string): Promise<TurnLease | null> {
  // The delivery holds the gate for the notice row and, when a wake runs, for a
  // whole headless turn — so the lease carries that turn's declared budget and
  // is judged against it rather than against silence. Imported lazily, exactly
  // as the wake turn itself is imported below.
  const { NOTICE_TURN_TIMEOUT_MS } = await import("./notice-runner.js");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_WAIT_MS);
  timer.unref?.();
  try {
    return await acquireTurn(chatId, {
      kind: "chat",
      priority: "background",
      maxHoldMs: NOTICE_TURN_TIMEOUT_MS,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function canWake(chatId: string): boolean {
  const now = Date.now();
  const history = (wakeHistory.get(chatId) ?? []).filter(
    (at) => now - at < 24 * 60 * 60 * 1000,
  );
  wakeHistory.set(chatId, history);
  const lastHour = history.filter((at) => now - at < 60 * 60 * 1000).length;
  return lastHour < MAX_WAKES_PER_HOUR && history.length < MAX_WAKES_PER_DAY;
}

function recordWake(chatId: string): void {
  const history = wakeHistory.get(chatId) ?? [];
  history.push(Date.now());
  wakeHistory.set(chatId, history);
}

function chatMessageRowExists(chatId: string, rowId: string): boolean {
  try {
    return Boolean(
      getDb()
        .prepare("SELECT 1 FROM chat_message_rows WHERE chat_id = ? AND row_id = ?")
        .get(chatId, rowId),
    );
  } catch {
    return false;
  }
}

function isDuplicateRowError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed.*row_id/i.test(message);
}