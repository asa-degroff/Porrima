/**
 * Per-job durable output budget. The cap is the combined size of a job's
 * stdout.log and stderr.log; status files, wrappers, and command metadata are
 * outside it.
 */

export const DEFAULT_JOB_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MIN_JOB_MAX_OUTPUT_BYTES = 1024;
const MAX_JOB_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * `PORRIMA_JOBS_MAX_OUTPUT_BYTES` overrides the 64 MiB default. Values are
 * clamped to 1 KiB..256 MiB so the tail-trim buffer stays bounded.
 */
export function jobMaxOutputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.PORRIMA_JOBS_MAX_OUTPUT_BYTES);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_JOB_MAX_OUTPUT_BYTES;
  return Math.max(
    MIN_JOB_MAX_OUTPUT_BYTES,
    Math.min(Math.floor(value), MAX_JOB_MAX_OUTPUT_BYTES),
  );
}