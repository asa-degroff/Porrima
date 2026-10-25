/**
 * Retention policy for durable background jobs
 * (docs/design/job-supervisor.md §4/§11, docs/design/kernel-durability.md §8).
 *
 * Output files and ledger rows age on separate clocks: the audit record
 * outlives the potentially large stdout/stderr files. The server's `job_view`
 * record is kept at least as long as the supervisor ledger.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JOB_OUTPUT_RETENTION_DAYS = 14;
export const DEFAULT_JOB_RECORD_RETENTION_DAYS = 30;
export const DEFAULT_JOB_ORPHAN_GRACE_MS = DAY_MS;
export const JOB_RETENTION_SWEEP_INTERVAL_MS = DAY_MS;
export const JOB_RETENTION_BATCH = 500;

function envDays(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(Math.floor(value), 365));
}

/** Command/service output directories, including stdout, stderr, and status. */
export function jobOutputRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    envDays(
      env,
      "PORRIMA_JOBS_OUTPUT_RETENTION_DAYS",
      DEFAULT_JOB_OUTPUT_RETENTION_DAYS,
    ) * DAY_MS
  );
}

/** Supervisor `jobs.db` rows and, by default, the server's `job_view` rows. */
export function jobRecordRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  return (
    envDays(
      env,
      "PORRIMA_JOBS_RECORD_RETENTION_DAYS",
      DEFAULT_JOB_RECORD_RETENTION_DAYS,
    ) * DAY_MS
  );
}

/**
 * The view is the audit fallback when the supervisor ledger is unavailable.
 * It may be configured longer, but never shorter than the ledger.
 */
export function jobViewRetentionMs(env: NodeJS.ProcessEnv = process.env): number {
  const recordMs = jobRecordRetentionMs(env);
  const viewDays = envDays(
    env,
    "PORRIMA_JOB_VIEW_RETENTION_DAYS",
    DEFAULT_JOB_RECORD_RETENTION_DAYS,
  );
  return Math.max(recordMs, viewDays * DAY_MS);
}

/** Unreferenced directories get a grace period before the orphan sweep. */
export function jobOrphanGraceMs(): number {
  return DEFAULT_JOB_ORPHAN_GRACE_MS;
}