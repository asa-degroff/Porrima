import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { APP_DATA_DIR } from "./paths.js";

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
  // An explicit data dir owns its supervisor endpoint. Otherwise a user
  // service uses the short XDG runtime path, and a plain process falls back to
  // the default data dir.
  if (env.PORRIMA_DATA_DIR) return join(env.PORRIMA_DATA_DIR, "jobs.sock");
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "porrima", "jobs.sock");
  return join(APP_DATA_DIR, "jobs.sock");
}

export function jobsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JobsConfig {
  const dataDir = env.PORRIMA_DATA_DIR || APP_DATA_DIR;
  const jobsDir = env.PORRIMA_JOBS_DIR || join(dataDir, "jobs");
  return {
    jobsDir,
    dbPath: env.PORRIMA_JOBS_DB || join(dataDir, "jobs.db"),
    socketPath: env.PORRIMA_JOBS_SOCKET || defaultSocketPath(env),
    lockPath: env.PORRIMA_JOBS_LOCK || join(dataDir, "jobs.lock"),
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