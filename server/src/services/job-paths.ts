import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDataPath } from "./paths.js";

/**
 * Path/config resolution for the job supervisor (docs/design/job-supervisor.md
 * §3/§4). The daemon and the server client must resolve the same socket; an
 * explicit env override wins so tests and development instances can isolate
 * themselves.
 */

export interface JobsConfig {
  jobsDir: string;
  dbPath: string;
  socketPath: string;
  lockPath: string;
  journalPath: string;
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "porrima", "jobs.sock");
  return appDataPath("jobs.sock");
}

export function jobsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const jobsDir = env.PORRIMA_JOBS_DIR || appDataPath("jobs");
  return {
    jobsDir,
    dbPath: env.PORRIMA_JOBS_DB || appDataPath("jobs.db"),
    socketPath: env.PORRIMA_JOBS_SOCKET || defaultSocketPath(env),
    lockPath: env.PORRIMA_JOBS_LOCK || appDataPath("jobs.lock"),
    journalPath: join(jobsDir, "journal.jsonl"),
  };
}

export function ensureJobsDirs(config: JobsConfig): void {
  mkdirSync(config.jobsDir, { recursive: true, mode: 0o700 });
  chmodSync(config.jobsDir, 0o700);
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.lockPath), { recursive: true, mode: 0o700 });
}