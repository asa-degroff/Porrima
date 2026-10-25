import Database from "better-sqlite3";
import { appDataPath } from "./paths.js";
import type { JobRecord } from "./job-protocol.js";

/**
 * The server's unified job read model (docs/design/job-supervisor.md §4).
 *
 * `jobs.db` remains authoritative for supervisor-owned command/service
 * execution; `job_view` mirrors it for the `jobs` tool/UI and owns the notice
 * fields. Cell rows come from the kernel manager. A missing supervisor must
 * never make a row look lost: reconciliation only runs against a connected
 * supervisor.
 */

const DB_PATH = appDataPath("porrima.db");

export type JobViewKind = "cell" | "command" | "service" | "remote";
export type JobViewSource = "kernel" | "supervisor";
export type JobViewState = "starting" | "running" | "finished" | "stopped" | "lost" | "failed";
export type JobViewNoticeState = "none" | "pending" | "appended" | "delivered" | "suppressed";

export interface JobViewRow {
  job_id: string;
  chat_id: string;
  workspace: string | null;
  kind: JobViewKind;
  source: JobViewSource;
  command: string | null;
  cwd: string | null;
  pid: number | null;
  pgid: number | null;
  start_id: string | null;
  boot_id: string | null;
  state: JobViewState;
  exit_code: number | null;
  signal: string | null;
  stop_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  output_paths: string[];
  origin_turn_id: string | null;
  notify: boolean;
  notice_group: string | null;
  notice_message_id: string | null;
  notice_state: JobViewNoticeState;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSupervisorView {
  job: JobRecord;
  workspace?: string | null;
  notify?: boolean;
}

export interface UpsertSupervisorOptions {
  /**
   * The supervisor list/get is authoritative for execution state. This lets a
   * false `lost`/`failed` (start in flight, timed-out start response) be
   * corrected to `running`, while the event path keeps the terminal guard for
   * out-of-order frames.
   */
  authoritative?: boolean;
}

export interface CellJobStart {
  jobId: string;
  chatId: string;
  command?: string | null;
  cwd?: string | null;
  workspace?: string | null;
  startedAt: string;
  originTurnId?: string | null;
}

export interface CellJobFinish {
  state: "finished" | "stopped" | "lost" | "failed";
  exitCode?: number | null;
  signal?: string | null;
  stopReason?: string | null;
  endedAt: string;
  durationMs?: number | null;
  outputPaths?: string[] | null;
}

export interface SupervisorJobStart {
  jobId: string;
  chatId: string;
  kind: "command" | "service";
  command: string;
  cwd: string;
  workspace?: string | null;
  originTurnId?: string | null;
  notify?: boolean;
}

let db: Database.Database | null = null;
let dbPath = DB_PATH;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    initSchema(db);
  }
  return db;
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_view (
      job_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      workspace TEXT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      command TEXT,
      cwd TEXT,
      pid INTEGER,
      pgid INTEGER,
      start_id TEXT,
      boot_id TEXT,
      state TEXT NOT NULL,
      exit_code INTEGER,
      signal TEXT,
      stop_reason TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_ms INTEGER,
      output_paths TEXT,
      origin_turn_id TEXT,
      notify INTEGER NOT NULL DEFAULT 1,
      notice_group TEXT,
      notice_message_id TEXT,
      notice_state TEXT NOT NULL DEFAULT 'none',
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_view_chat ON job_view(chat_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_view_state ON job_view(state);
  `);
}

export function initJobView(path = DB_PATH): void {
  dbPath = path;
  getDb();
}

export function closeJobView(): void {
  if (!db) return;
  const current = db;
  db = null;
  try {
    current.close();
  } catch {
    // Already closed.
  }
}

export function upsertSupervisorJob(
  input: NewSupervisorView,
  options: UpsertSupervisorOptions = {},
): JobViewRow {
  const job = input.job;
  const now = new Date().toISOString();
  const outputPaths = JSON.stringify(
    [job.stdout_path, job.stderr_path, job.status_path].filter(Boolean),
  );
  getDb()
    .prepare(
      `INSERT INTO job_view (
        job_id, chat_id, workspace, kind, source, command, cwd,
        pid, pgid, start_id, boot_id, state, exit_code, signal, stop_reason,
        started_at, ended_at, duration_ms, output_paths, origin_turn_id,
        notify, notice_state, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'supervisor', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        workspace = COALESCE(excluded.workspace, job_view.workspace),
        command = excluded.command,
        cwd = excluded.cwd,
        pid = excluded.pid,
        pgid = excluded.pgid,
        start_id = excluded.start_id,
        boot_id = excluded.boot_id,
        state = CASE
          WHEN job_view.state IN ('finished', 'stopped', 'lost', 'failed')
               AND excluded.state NOT IN ('finished', 'stopped', 'lost', 'failed')
          THEN job_view.state
          ELSE excluded.state
        END,
        exit_code = excluded.exit_code,
        signal = excluded.signal,
        stop_reason = excluded.stop_reason,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        output_paths = excluded.output_paths,
        origin_turn_id = COALESCE(excluded.origin_turn_id, job_view.origin_turn_id),
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at`,
    )
    .run(
      job.id,
      job.chat_id,
      input.workspace ?? null,
      job.kind,
      job.command,
      job.cwd,
      job.pid,
      job.pgid,
      job.start_id,
      job.boot_id,
      job.state,
      job.exit_code,
      job.signal,
      job.stop_reason,
      job.started_at,
      job.ended_at,
      job.duration_ms,
      outputPaths,
      job.origin_turn_id,
      input.notify === false ? 0 : 1,
      now,
      job.created_at,
      now,
    );
  if (options.authoritative) {
    // `lost` and `failed` are uncertainty/server-side start failures, not
    // execution outcomes. A live supervisor report corrects them; finished
    // and stopped stay protected by the CASE above.
    const current = getDb()
      .prepare("SELECT state FROM job_view WHERE job_id = ?")
      .get(job.id) as { state: string } | undefined;
    if (
      current &&
      (current.state === "lost" || current.state === "failed") &&
      job.state !== current.state
    ) {
      // A queued notice claims the outcome is unknown. If the supervisor
      // reports the job live, the view no longer believes that claim, so the
      // pending wake is withdrawn before it can be delivered. A notice already
      // `appended` is in the transcript and stays as the record it truthfully
      // was at the time.
      const reportsLive = job.state === "running" || job.state === "starting";
      if (reportsLive) {
        getDb()
          .prepare(
            `UPDATE job_view SET state = ?, updated_at = ?,
             notice_state = CASE WHEN notice_state = 'pending'
               THEN 'none' ELSE notice_state END,
             notice_group = CASE WHEN notice_state = 'pending'
               THEN NULL ELSE notice_group END,
             notice_message_id = CASE WHEN notice_state = 'pending'
               THEN NULL ELSE notice_message_id END
             WHERE job_id = ?`,
          )
          .run(job.state, now, job.id);
      } else {
        getDb()
          .prepare("UPDATE job_view SET state = ?, updated_at = ? WHERE job_id = ?")
          .run(job.state, now, job.id);
      }
    }
  }
  return getJobView(job.id)!;
}

export function recordSupervisorStarting(input: SupervisorJobStart): JobViewRow {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO job_view (
        job_id, chat_id, workspace, kind, source, command, cwd, state,
        origin_turn_id, notify, notice_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'supervisor', ?, ?, 'starting', ?, ?, 'none', ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        workspace = COALESCE(excluded.workspace, job_view.workspace),
        command = excluded.command,
        cwd = excluded.cwd,
        state = CASE
          WHEN job_view.state IN ('finished', 'stopped', 'lost', 'failed')
          THEN job_view.state
          ELSE 'starting'
        END,
        origin_turn_id = COALESCE(excluded.origin_turn_id, job_view.origin_turn_id),
        updated_at = excluded.updated_at`,
    )
    .run(
      input.jobId,
      input.chatId,
      input.workspace ?? null,
      input.kind,
      input.command,
      input.cwd,
      input.originTurnId ?? null,
      input.notify === false ? 0 : 1,
      now,
      now,
    );
  return getJobView(input.jobId)!;
}

export function markJobViewFailed(jobId: string, reason: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE job_view SET state = 'failed', stop_reason = ?, ended_at = ?,
       updated_at = ?, last_synced_at = NULL WHERE job_id = ?`,
    )
    .run(reason, now, now, jobId);
}

export function recordCellStarted(input: CellJobStart): JobViewRow {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO job_view (
        job_id, chat_id, workspace, kind, source, command, cwd, state,
        started_at, origin_turn_id, notify, notice_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'cell', 'kernel', ?, ?, 'running', ?, ?, 1, 'none', ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        state = 'running',
        started_at = COALESCE(excluded.started_at, job_view.started_at),
        cwd = COALESCE(excluded.cwd, job_view.cwd),
        updated_at = excluded.updated_at`,
    )
    .run(
      input.jobId,
      input.chatId,
      input.workspace ?? null,
      input.command ?? null,
      input.cwd ?? null,
      input.startedAt,
      input.originTurnId ?? null,
      now,
      now,
    );
  return getJobView(input.jobId)!;
}

export function finishCellJob(jobId: string, finish: CellJobFinish): JobViewRow {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE job_view SET
        state = ?, exit_code = ?, signal = ?, stop_reason = ?,
        ended_at = ?, duration_ms = ?, output_paths = COALESCE(?, output_paths),
        updated_at = ?
       WHERE job_id = ?`,
    )
    .run(
      finish.state,
      finish.exitCode ?? null,
      finish.signal ?? null,
      finish.stopReason ?? null,
      finish.endedAt,
      finish.durationMs ?? null,
      finish.outputPaths ? JSON.stringify(finish.outputPaths) : null,
      now,
      jobId,
    );
  return getJobView(jobId)!;
}

export function stopJobView(
  jobId: string,
  reason: string,
  endedAt = new Date().toISOString(),
): void {
  getDb()
    .prepare(
      `UPDATE job_view SET state = 'stopped', stop_reason = ?, ended_at = ?,
       updated_at = ? WHERE job_id = ?`,
    )
    .run(reason, endedAt, new Date().toISOString(), jobId);
}

export function markJobViewLost(
  jobId: string,
  reason: string | null = null,
  endedAt = new Date().toISOString(),
): void {
  getDb()
    .prepare(
      `UPDATE job_view SET state = 'lost', stop_reason = COALESCE(?, stop_reason),
       ended_at = COALESCE(ended_at, ?), updated_at = ?, last_synced_at = NULL
       WHERE job_id = ?`,
    )
    .run(reason, endedAt, new Date().toISOString(), jobId);
}

export function markKernelJobsLostAtStartup(): number {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `UPDATE job_view SET state = 'lost', stop_reason = 'server-restart',
       ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE source = 'kernel' AND state IN ('starting', 'running')`,
    )
    .run(now, now);
  return info.changes;
}

/**
 * What the supervisor says about one row that its live list did not mention.
 * A list that is not complete for the live states is not evidence of absence,
 * so absence has to be established per job id rather than inferred from a page:
 *   found   — the supervisor knows this job (usually a terminal state reached
 *             while the server was away); mirror it instead of declaring loss
 *   absent  — the supervisor has no row for it; that is real evidence
 *   unknown — the lookup itself failed; leave the row alone
 */
export type MissingSupervisorJob =
  | { status: "found"; job: JobRecord }
  | { status: "absent" }
  | { status: "unknown" };

/** Rows the view believes are live on the supervisor side, optionally per chat. */
export function liveSupervisorJobIds(chatId?: string): string[] {
  const rows = chatId
    ? (getDb()
        .prepare(
          `SELECT job_id FROM job_view
           WHERE source = 'supervisor' AND state IN ('starting', 'running') AND chat_id = ?`,
        )
        .all(chatId) as Array<{ job_id: string }>)
    : (getDb()
        .prepare(
          `SELECT job_id FROM job_view
           WHERE source = 'supervisor' AND state IN ('starting', 'running')`,
        )
        .all() as Array<{ job_id: string }>);
  return rows.map((row) => row.job_id);
}

/** How long a probed uncertain row waits before it is worth another `get`. */
const UNCERTAIN_RECHECK_MS = 10 * 60_000;
/**
 * Past this age, automatic repair stops. A week-old lost/failed outcome is
 * no longer worth recurring supervisor round trips; `jobs status <jobId>`
 * remains the explicit on-demand path.
 */
const UNCERTAIN_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface UncertainJobProbeOptions {
  /** Clock to evaluate due/horizon cutoffs against. Test seam. */
  nowMs?: number;
  /** Minimum interval between probes of the same row. */
  recheckMs?: number;
  /** Uncertainty older than this is left for an explicit status call. */
  maxAgeMs?: number;
}

/**
 * Uncertain rows that are due for a supervisor `get`. One `get` can resolve a
 * job that finished while the server was away, turning a false `lost`/`failed`
 * into the real terminal outcome.
 *
 * The window is bounded per call and rotates: never-probed rows come first
 * (most recent uncertainty first, so fresh losses are repaired promptly), then
 * the rows probed longest ago. `markSupervisorJobsProbed` records every attempt, so a
 * burst of `jobs list` calls cannot re-ask the same ids, and 200+ uncertain
 * rows are swept in successive batches instead of starving the oldest.
 */
export function uncertainSupervisorJobIds(
  chatId?: string,
  limit = 50,
  options: UncertainJobProbeOptions = {},
): string[] {
  const nowMs = options.nowMs ?? Date.now();
  const recheckMs = options.recheckMs ?? UNCERTAIN_RECHECK_MS;
  const maxAgeMs = options.maxAgeMs ?? UNCERTAIN_MAX_AGE_MS;
  const dueBefore = new Date(nowMs - recheckMs).toISOString();
  const notBefore = new Date(nowMs - maxAgeMs).toISOString();

  const clauses = [
    "source = 'supervisor'",
    "state IN ('lost', 'failed')",
    "COALESCE(ended_at, updated_at) >= ?",
    "(last_synced_at IS NULL OR last_synced_at <= ?)",
  ];
  const params: unknown[] = [notBefore, dueBefore];
  if (chatId) {
    clauses.push("chat_id = ?");
    params.push(chatId);
  }
  const rows = getDb()
    .prepare(
      `SELECT job_id FROM job_view WHERE ${clauses.join(" AND ")}
       ORDER BY (last_synced_at IS NOT NULL) ASC,
                CASE WHEN last_synced_at IS NULL
                     THEN COALESCE(ended_at, updated_at) END DESC,
                last_synced_at ASC,
                COALESCE(ended_at, updated_at) ASC,
                job_id ASC
       LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, 200))) as Array<{ job_id: string }>;
  return rows.map((row) => row.job_id);
}

/**
 * Record that the supervisor was asked about these uncertain rows. Called for
 * found, absent, and failed lookups alike: the point is to pace attempts, not
 * to claim a result. Found rows leave the uncertain set as `upsertSupervisorJob`
 * mirrors their terminal state; absent/unknown rows simply wait out the
 * recheck interval.
 */
export function markSupervisorJobsProbed(
  jobIds: string[],
  at = new Date().toISOString(),
): number {
  if (jobIds.length === 0) return 0;
  const ids = [...new Set(jobIds)].slice(0, 300);
  const placeholders = ids.map(() => "?").join(", ");
  const info = getDb()
    .prepare(
      `UPDATE job_view SET last_synced_at = ?
       WHERE job_id IN (${placeholders})
         AND source = 'supervisor'
         AND state IN ('lost', 'failed')`,
    )
    .run(at, ...ids);
  return info.changes;
}

/**
 * Mirror a supervisor list into the view, then resolve the live rows it left
 * out one id at a time. `jobs` must be complete for the live states it was
 * asked for; terminal rows outside it are never treated as missing.
 */
export function reconcileSupervisorJobs(
  jobs: JobRecord[],
  options: {
    chatId?: string;
    resolveMissing?: (jobId: string) => MissingSupervisorJob;
  } = {},
): number {
  for (const job of jobs) upsertSupervisorJob({ job }, { authoritative: true });
  const listed = new Set(jobs.map((job) => job.id));
  let lost = 0;
  for (const jobId of liveSupervisorJobIds(options.chatId)) {
    if (listed.has(jobId)) continue;
    const resolution = options.resolveMissing?.(jobId) ?? { status: "absent" };
    if (resolution.status === "unknown") continue;
    if (resolution.status === "found") {
      upsertSupervisorJob({ job: resolution.job }, { authoritative: true });
      continue;
    }
    markJobViewLost(jobId, "supervisor-no-row");
    // The absent result was itself a probe; do not immediately ask again.
    markSupervisorJobsProbed([jobId]);
    lost += 1;
  }
  return lost;
}

export function markChatJobsStopped(chatId: string, reason: string): number {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `UPDATE job_view SET state = 'stopped', stop_reason = ?, ended_at = COALESCE(ended_at, ?),
       updated_at = ? WHERE chat_id = ? AND state IN ('starting', 'running')`,
    )
    .run(reason, now, now, chatId);
  return info.changes;
}

export function markChatJobsLost(chatId: string, reason: string): number {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `UPDATE job_view SET state = 'lost', stop_reason = ?, ended_at = COALESCE(ended_at, ?),
       updated_at = ?, last_synced_at = NULL
       WHERE chat_id = ? AND state IN ('starting', 'running')`,
    )
    .run(reason, now, now, chatId);
  return info.changes;
}

export function getJobView(jobId: string): JobViewRow | null {
  const row = getDb().prepare("SELECT * FROM job_view WHERE job_id = ?").get(jobId) as
    | JobViewDbRow
    | undefined;
  return row ? rowToView(row) : null;
}

export function listJobView(
  chatId: string,
  opts: { states?: JobViewState[]; limit?: number } = {},
): JobViewRow[] {
  const clauses = ["chat_id = ?"];
  const params: unknown[] = [chatId];
  if (opts.states && opts.states.length > 0) {
    clauses.push(`state IN (${opts.states.map(() => "?").join(", ")})`);
    params.push(...opts.states);
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const rows = getDb()
    .prepare(
      `SELECT * FROM job_view WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC, job_id DESC LIMIT ?`,
    )
    .all(...params, limit) as JobViewDbRow[];
  return rows.map(rowToView);
}

/**
 * Delete terminal rows older than the record cutoff. The supervisor owns the
 * larger output directories; this is the server's audit/read-model half.
 * Live rows are never candidates. Notices are already capped at 24h, far
 * inside the retention window, so a stale pending row cannot pin history.
 */
export function pruneTerminalJobView(olderThanIso: string, limit = 500): number {
  const db = getDb();
  const run = db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT job_id FROM job_view
         WHERE state IN ('finished', 'stopped', 'lost', 'failed')
           AND COALESCE(ended_at, updated_at) < ?
         ORDER BY COALESCE(ended_at, updated_at) ASC, job_id ASC
         LIMIT ?`,
      )
      .all(olderThanIso, Math.max(1, Math.min(limit, 500))) as Array<{
      job_id: string;
    }>;
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.job_id);
    const placeholders = ids.map(() => "?").join(", ");
    const info = db
      .prepare(
        `DELETE FROM job_view WHERE job_id IN (${placeholders})
         AND state IN ('finished', 'stopped', 'lost', 'failed')`,
      )
      .run(...ids);
    return info.changes;
  });
  return run();
}

export function setNoticesSuppressedForChat(chatId: string): void {
  getDb()
    .prepare(
      `UPDATE job_view SET notice_state = 'suppressed', updated_at = ?
       WHERE chat_id = ? AND notice_state IN ('none', 'pending', 'appended')`,
    )
    .run(new Date().toISOString(), chatId);
}

/** Terminal rows not yet evaluated for a completion notice. */
export function listJobNoticeCandidates(limit = 200): JobViewRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM job_view
       WHERE notice_state = 'none'
         AND state IN ('finished', 'stopped', 'lost', 'failed')
       ORDER BY COALESCE(ended_at, created_at) ASC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 1000))) as JobViewDbRow[];
  return rows.map(rowToView);
}

export function listPendingJobNotices(chatId?: string, limit = 200): JobViewRow[] {
  const rows = chatId
    ? (getDb()
        .prepare(
          `SELECT * FROM job_view
           WHERE notice_state = 'pending' AND chat_id = ?
           ORDER BY COALESCE(ended_at, created_at) ASC LIMIT ?`,
        )
        .all(chatId, Math.max(1, Math.min(limit, 1000))) as JobViewDbRow[])
    : (getDb()
        .prepare(
          `SELECT * FROM job_view
           WHERE notice_state = 'pending'
           ORDER BY COALESCE(ended_at, created_at) ASC LIMIT ?`,
        )
        .all(Math.max(1, Math.min(limit, 1000))) as JobViewDbRow[]);
  return rows.map(rowToView);
}

export function listChatsWithPendingNotices(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT chat_id FROM job_view WHERE notice_state = 'pending'`,
    )
    .all() as Array<{ chat_id: string }>;
  return rows.map((row) => row.chat_id);
}

export function listAppendedJobNotices(): JobViewRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM job_view WHERE notice_state = 'appended'
       ORDER BY COALESCE(ended_at, created_at) ASC LIMIT 500`,
    )
    .all() as JobViewDbRow[];
  return rows.map(rowToView);
}

/** Promote an evaluated terminal row to the pending queue (once). */
export function markJobNoticePending(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE job_view SET notice_state = 'pending', updated_at = ?
       WHERE job_id = ? AND notice_state = 'none'`,
    )
    .run(new Date().toISOString(), jobId);
}

/** Consumed/read or ineligible: never wake for these rows. */
export function suppressJobNotices(jobIds: string[]): number {
  if (jobIds.length === 0) return 0;
  const ids = [...new Set(jobIds)].slice(0, 300);
  const placeholders = ids.map(() => "?").join(", ");
  const info = getDb()
    .prepare(
      `UPDATE job_view SET notice_state = 'suppressed', updated_at = ?
       WHERE job_id IN (${placeholders})
         AND notice_state IN ('none', 'pending', 'appended')`,
    )
    .run(new Date().toISOString(), ...ids);
  return info.changes;
}

/**
 * Persist the pre-minted notice row identity while rows are still `pending`.
 *
 * The append into `app.db` and this update cannot share a transaction. Writing
 * the id first makes a crash between them recoverable: the retry sees the same
 * id, skips the append when that row already exists, and never lands a second
 * notice for the same batch.
 */
export function prepareJobNoticeDelivery(
  jobIds: string[],
  group: string,
  messageId: string,
): number {
  if (jobIds.length === 0) return 0;
  const ids = [...new Set(jobIds)].slice(0, 100);
  const placeholders = ids.map(() => "?").join(", ");
  const info = getDb()
    .prepare(
      `UPDATE job_view SET notice_group = ?, notice_message_id = ?, updated_at = ?
       WHERE job_id IN (${placeholders}) AND notice_state = 'pending'
         AND (notice_message_id IS NULL OR notice_message_id = ?)`,
    )
    .run(group, messageId, new Date().toISOString(), ...ids, messageId);
  return info.changes;
}

export function markJobNoticeAppended(
  jobIds: string[],
  group: string,
  messageId: string,
): number {
  if (jobIds.length === 0) return 0;
  const ids = [...new Set(jobIds)].slice(0, 100);
  const placeholders = ids.map(() => "?").join(", ");
  const info = getDb()
    .prepare(
      `UPDATE job_view SET notice_state = 'appended', notice_group = ?,
       notice_message_id = ?, updated_at = ?
       WHERE job_id IN (${placeholders}) AND notice_state = 'pending'`,
    )
    .run(group, messageId, new Date().toISOString(), ...ids);
  return info.changes;
}

export function markJobNoticeDelivered(group: string): number {
  const info = getDb()
    .prepare(
      `UPDATE job_view SET notice_state = 'delivered', updated_at = ?
       WHERE notice_group = ? AND notice_state IN ('pending', 'appended')`,
    )
    .run(new Date().toISOString(), group);
  return info.changes;
}

/** Re-open an appended row whose message was not found on restart. */
export function reopenJobNotice(jobId: string): void {
  getDb()
    .prepare(
      `UPDATE job_view SET notice_state = 'pending', notice_group = NULL,
       notice_message_id = NULL, updated_at = ?
       WHERE job_id = ? AND notice_state = 'appended'`,
    )
    .run(new Date().toISOString(), jobId);
}

interface JobViewDbRow {
  job_id: string;
  chat_id: string;
  workspace: string | null;
  kind: string;
  source: string;
  command: string | null;
  cwd: string | null;
  pid: number | null;
  pgid: number | null;
  start_id: string | null;
  boot_id: string | null;
  state: string;
  exit_code: number | null;
  signal: string | null;
  stop_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  output_paths: string | null;
  origin_turn_id: string | null;
  notify: number;
  notice_group: string | null;
  notice_message_id: string | null;
  notice_state: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToView(row: JobViewDbRow): JobViewRow {
  let outputPaths: string[] = [];
  if (row.output_paths) {
    try {
      const parsed = JSON.parse(row.output_paths);
      if (Array.isArray(parsed)) outputPaths = parsed.filter((path): path is string => typeof path === "string");
    } catch {
      // Legacy/torn value: treat as unknown.
    }
  }
  return {
    job_id: row.job_id,
    chat_id: row.chat_id,
    workspace: row.workspace,
    kind: row.kind as JobViewKind,
    source: row.source as JobViewSource,
    command: row.command,
    cwd: row.cwd,
    pid: row.pid,
    pgid: row.pgid,
    start_id: row.start_id,
    boot_id: row.boot_id,
    state: row.state as JobViewState,
    exit_code: row.exit_code,
    signal: row.signal,
    stop_reason: row.stop_reason,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    output_paths: outputPaths,
    origin_turn_id: row.origin_turn_id,
    notify: row.notify !== 0,
    notice_group: row.notice_group,
    notice_message_id: row.notice_message_id,
    notice_state: row.notice_state as JobViewNoticeState,
    last_synced_at: row.last_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}