import Database from "better-sqlite3";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type {
  JobEvent,
  JobEventType,
  JobKind,
  JobRecord,
  JobState,
  JobStopReason,
} from "./job-protocol.js";

/**
 * The supervisor's execution ledger (docs/design/job-supervisor.md §4).
 * Authoritative for command/service state. The server's `job_view` mirrors
 * this; it never writes here.
 */

export interface NewJob {
  id: string;
  chat_id: string;
  kind: JobKind;
  command: string;
  cwd: string;
  stdout_path: string;
  stderr_path: string;
  status_path: string;
  origin_turn_id?: string | null;
}

export interface JobIdentity {
  pid: number;
  pgid: number;
  start_id: string | null;
  boot_id: string;
  started_at: string;
}

export interface JobOutcome {
  exit_code: number | null;
  signal: string | null;
  ended_at: string;
  duration_ms: number | null;
  stop_reason?: JobStopReason | null;
}

export interface JobListFilter {
  chat_id?: string;
  states?: JobState[];
  limit?: number;
}

/** Paths and flags needed by the supervisor's retention sweep. */
export interface JobRetentionRow {
  id: string;
  chat_id: string;
  stdout_path: string;
  stderr_path: string;
  status_path: string;
  outputs_pruned_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER,
  pgid INTEGER,
  start_id TEXT,
  boot_id TEXT,
  exit_code INTEGER,
  signal TEXT,
  stop_reason TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  status_path TEXT NOT NULL,
  origin_turn_id TEXT,
  outputs_pruned_at TEXT,
  output_capped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

CREATE TABLE IF NOT EXISTS job_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  event TEXT NOT NULL,
  at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, seq DESC);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const EVENT_PRUNE_EVERY = 100;
const EVENT_RETENTION = 1000;

export class JobStore {
  private eventInserts = 0;

  private constructor(
    private readonly db: Database.Database,
    readonly dbPath: string,
  ) {}

  static open(dbPath: string): JobStore {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    // Read before writing anything: a damaged ledger has to be named, not
    // papered over by the schema statements below. jobs.db is bounded by
    // retention, so a full integrity scan is cheap here.
    let db: Database.Database;
    try {
      db = new Database(dbPath);
    } catch (error) {
      throw new Error(`jobs.db is unreadable: ${errorText(error)}`);
    }
    let integrity: unknown;
    try {
      integrity = db.pragma("integrity_check", { simple: true });
    } catch (error) {
      closeQuietly(db);
      throw new Error(`jobs.db is unreadable: ${errorText(error)}`);
    }
    if (integrity !== "ok") {
      closeQuietly(db);
      throw new Error(`jobs.db failed integrity check: ${String(integrity)}`);
    }
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA);
    const version = Number(db.pragma("user_version", { simple: true }) ?? 0);
    if (version > 3) {
      db.close();
      throw new Error(`jobs.db schema version ${version} is newer than supported version 3`);
    }
    const columns = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (version < 2 && !columns.some((column) => column.name === "outputs_pruned_at")) {
      db.exec("ALTER TABLE jobs ADD COLUMN outputs_pruned_at TEXT");
    }
    // The cap fact lives in its own column: a job can be trimmed by the cap
    // whatever ended it, and `stop_reason` is about why it ended.
    if (!columns.some((column) => column.name === "output_capped")) {
      db.exec("ALTER TABLE jobs ADD COLUMN output_capped INTEGER NOT NULL DEFAULT 0");
    }
    db.pragma("user_version = 3");
    if (dbPath !== ":memory:") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // The 0700 directory is the backstop.
      }
    }
    return new JobStore(db, dbPath);
  }

  /** How many job rows this ledger holds. A ledger with none is its own evidence. */
  countRows(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Record that the output cap discarded bytes from this job. Separate from
   * `stop_reason`: trimming says what was thrown away, the reason says why the
   * job ended, and collapsing them loses one or the other.
   */
  markOutputCapped(id: string): void {
    this.db
      .prepare("UPDATE jobs SET output_capped = 1, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  close(): void {
    this.db.close();
  }

  insertStarting(job: NewJob): JobRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, chat_id, kind, command, cwd, state,
          stdout_path, stderr_path, status_path, origin_turn_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.chat_id,
        job.kind,
        job.command,
        job.cwd,
        job.stdout_path,
        job.stderr_path,
        job.status_path,
        job.origin_turn_id ?? null,
        now,
        now,
      );
    return this.getOrThrow(job.id);
  }

  markRunning(id: string, identity: JobIdentity): JobRecord {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'running', pid = ?, pgid = ?, start_id = ?,
         boot_id = ?, started_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        identity.pid,
        identity.pgid,
        identity.start_id,
        identity.boot_id,
        identity.started_at,
        new Date().toISOString(),
        id,
      );
    return this.getOrThrow(id);
  }

  finish(id: string, outcome: JobOutcome): JobRecord {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'finished', exit_code = ?, signal = ?,
         stop_reason = ?, ended_at = ?, duration_ms = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        outcome.exit_code,
        outcome.signal,
        outcome.stop_reason ?? null,
        outcome.ended_at,
        outcome.duration_ms,
        new Date().toISOString(),
        id,
      );
    return this.getOrThrow(id);
  }

  stop(
    id: string,
    reason: JobStopReason,
    endedAt: string,
    durationMs: number | null,
  ): JobRecord {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'stopped', stop_reason = ?, ended_at = ?,
         duration_ms = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, endedAt, durationMs, new Date().toISOString(), id);
    return this.getOrThrow(id);
  }

  markLost(
    id: string,
    endedAt = new Date().toISOString(),
    reason?: JobStopReason,
  ): JobRecord {
    const row = this.get(id);
    const started = row?.started_at ? Date.parse(row.started_at) : NaN;
    const ended = Date.parse(endedAt);
    const duration =
      Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null;
    this.db
      .prepare(
        `UPDATE jobs SET state = 'lost', stop_reason = COALESCE(?, stop_reason),
         ended_at = ?, duration_ms = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(reason ?? null, endedAt, duration, new Date().toISOString(), id);
    return this.getOrThrow(id);
  }

  markFailed(id: string, endedAt = new Date().toISOString()): JobRecord {
    this.db
      .prepare(
        `UPDATE jobs SET state = 'failed', stop_reason = 'spawn-failed', ended_at = ?,
         updated_at = ? WHERE id = ?`,
      )
      .run(endedAt, new Date().toISOString(), id);
    return this.getOrThrow(id);
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getOrThrow(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new Error(`job ${id} not found`);
    return job;
  }

  list(filter: JobListFilter = {}): JobRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.chat_id) {
      clauses.push("chat_id = ?");
      params.push(filter.chat_id);
    }
    if (filter.states && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1000));
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as JobRow[];
    return rows.map(rowToJob);
  }

  /**
   * Terminal rows whose outcome is older than the cutoff. `excludeIds` keeps
   * protected live/journal-held rows from consuming a batch window.
   */
  listTerminalBefore(
    cutoffIso: string,
    limit = 500,
    excludeIds: string[] = [],
    unprunedOutputsOnly = false,
  ): JobRetentionRow[] {
    const clauses = [
      "state IN ('finished', 'stopped', 'lost', 'failed')",
      "COALESCE(ended_at, updated_at) < ?",
    ];
    const params: unknown[] = [cutoffIso];
    if (unprunedOutputsOnly) clauses.push("outputs_pruned_at IS NULL");
    if (excludeIds.length > 0) {
      const ids = [...new Set(excludeIds)].slice(0, 400);
      clauses.push(`id NOT IN (${ids.map(() => "?").join(", ")})`);
      params.push(...ids);
    }
    const rows = this.db
      .prepare(
        `SELECT id, chat_id, stdout_path, stderr_path, status_path, outputs_pruned_at
         FROM jobs WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(ended_at, updated_at) ASC, id ASC
         LIMIT ?`,
      )
      .all(...params, Math.max(1, Math.min(limit, 500))) as JobRetentionRow[];
    return rows;
  }

  /** Rows whose output is not yet marked as pruned. */
  listOutputsToPrune(
    cutoffIso: string,
    limit = 500,
    excludeIds: string[] = [],
  ): JobRetentionRow[] {
    return this.listTerminalBefore(cutoffIso, limit, excludeIds, true);
  }

  markOutputsPruned(ids: string[], at: string): number {
    if (ids.length === 0) return 0;
    const unique = [...new Set(ids)].slice(0, 400);
    const info = this.db
      .prepare(
        `UPDATE jobs SET outputs_pruned_at = ?
         WHERE id IN (${unique.map(() => "?").join(", ")})
           AND state IN ('finished', 'stopped', 'lost', 'failed')
           AND outputs_pruned_at IS NULL`,
      )
      .run(at, ...unique);
    return info.changes;
  }

  /**
   * Delete terminal ledger rows and their events. Re-checks state and cutoff
   * inside the transaction so a row corrected back to running is never
   * removed by a stale retention candidate.
   */
  deleteTerminal(ids: string[], cutoffIso: string): number {
    if (ids.length === 0) return 0;
    const unique = [...new Set(ids)].slice(0, 400);
    const run = this.db.transaction(() => {
      const placeholders = unique.map(() => "?").join(", ");
      const deletable = this.db
        .prepare(
          `SELECT id FROM jobs
           WHERE id IN (${placeholders})
             AND state IN ('finished', 'stopped', 'lost', 'failed')
             AND COALESCE(ended_at, updated_at) < ?`,
        )
        .all(...unique, cutoffIso) as Array<{ id: string }>;
      if (deletable.length === 0) return 0;
      const deleteIds = deletable.map((row) => row.id);
      const deletePlaceholders = deleteIds.map(() => "?").join(", ");
      this.db
        .prepare(`DELETE FROM job_events WHERE job_id IN (${deletePlaceholders})`)
        .run(...deleteIds);
      const info = this.db
        .prepare(`DELETE FROM jobs WHERE id IN (${deletePlaceholders})`)
        .run(...deleteIds);
      return info.changes;
    });
    return run();
  }

  /** Id + chat id for every row, used to identify orphaned job directories. */
  directoryKeys(): Array<{ id: string; chat_id: string }> {
    return this.db.prepare("SELECT id, chat_id FROM jobs").all() as Array<{
      id: string;
      chat_id: string;
    }>;
  }

  hasLiveForChat(chatId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE chat_id = ? AND state IN ('starting', 'running') LIMIT 1",
        )
        .get(chatId),
    );
  }

  countByState(): Record<JobState, number> {
    const counts: Record<JobState, number> = {
      starting: 0,
      running: 0,
      finished: 0,
      stopped: 0,
      lost: 0,
      failed: 0,
    };
    const rows = this.db.prepare("SELECT state, COUNT(*) AS n FROM jobs GROUP BY state").all() as Array<{
      state: JobState;
      n: number;
    }>;
    for (const row of rows) {
      if (row.state in counts) counts[row.state] = Number(row.n);
    }
    return counts;
  }

  appendEvent(event: JobEventType, job: JobRecord): JobEvent {
    const at = new Date().toISOString();
    const info = this.db
      .prepare(
        "INSERT INTO job_events (job_id, event, at, payload) VALUES (?, ?, ?, ?)",
      )
      .run(job.id, event, at, JSON.stringify(job));
    this.eventInserts += 1;
    if (this.eventInserts % EVENT_PRUNE_EVERY === 0) this.pruneEvents();
    return {
      seq: Number(info.lastInsertRowid),
      event,
      job_id: job.id,
      at,
      job,
    };
  }

  eventsSince(seq: number, limit = 1000): JobEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM job_events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all(seq, Math.max(1, Math.min(limit, 5000))) as EventRow[];
    return rows.map(rowToEvent);
  }

  pruneEvents(keep = EVENT_RETENTION): number {
    const info = this.db
      .prepare(
        `DELETE FROM job_events WHERE seq NOT IN (
           SELECT seq FROM job_events ORDER BY seq DESC LIMIT ?
         )`,
      )
      .run(Math.max(1, keep));
    return info.changes;
  }

  dbSizeBytes(): number {
    if (this.dbPath === ":memory:") return 0;
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }
}

interface JobRow {
  id: string;
  chat_id: string;
  kind: string;
  command: string;
  cwd: string;
  state: string;
  pid: number | null;
  pgid: number | null;
  start_id: string | null;
  boot_id: string | null;
  exit_code: number | null;
  signal: string | null;
  stop_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  stdout_path: string;
  stderr_path: string;
  status_path: string;
  output_capped: number;
  origin_turn_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  seq: number;
  job_id: string;
  event: string;
  at: string;
  payload: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeQuietly(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // The ledger is already the problem.
  }
}

function rowToJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    chat_id: row.chat_id,
    kind: row.kind as JobRecord["kind"],
    command: row.command,
    cwd: row.cwd,
    state: row.state as JobState,
    pid: row.pid,
    pgid: row.pgid,
    start_id: row.start_id,
    boot_id: row.boot_id,
    exit_code: row.exit_code,
    signal: row.signal,
    stop_reason: row.stop_reason as JobStopReason | null,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    stdout_path: row.stdout_path,
    stderr_path: row.stderr_path,
    status_path: row.status_path,
    output_capped: row.output_capped === 1,
    origin_turn_id: row.origin_turn_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToEvent(row: EventRow): JobEvent {
  let job: JobRecord;
  try {
    job = JSON.parse(row.payload) as JobRecord;
  } catch {
    job = {
      id: row.job_id,
      chat_id: "",
      kind: "command",
      command: "",
      cwd: "",
      state: "lost",
      pid: null,
      pgid: null,
      start_id: null,
      boot_id: null,
      exit_code: null,
      signal: null,
      stop_reason: null,
      started_at: null,
      ended_at: row.at,
      duration_ms: null,
      stdout_path: "",
      stderr_path: "",
      status_path: "",
      origin_turn_id: null,
      created_at: row.at,
      updated_at: row.at,
    };
  }
  return {
    seq: row.seq,
    event: row.event as JobEventType,
    job_id: row.job_id,
    at: row.at,
    job,
  };
}