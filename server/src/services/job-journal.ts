import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only group journal beside `jobs.db` (docs/design/job-supervisor.md
 * §4/§7). It covers the window where a process was spawned but its DB row was
 * not updated; recovery uses it to reap groups with no ledger row. Records are
 * pruned per job on confirmed death, never truncated as a whole.
 */

export interface JobJournalRecord {
  version: 1;
  job_id: string;
  pid: number;
  pgid: number;
  start_id: string | null;
  boot_id: string;
  active: boolean;
  recorded_at: string;
}

export function appendJobJournal(path: string, record: JobJournalRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error: any) {
    // A journal failure must not fail a spawn; jobs.db remains the primary
    // record and the status file covers the exit.
    console.warn(`[jobs] failed to write journal ${path}: ${error?.message ?? error}`);
  }
}

export function readJobJournal(path: string): JobJournalRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: JobJournalRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<JobJournalRecord>;
      if (
        parsed.version === 1 &&
        typeof parsed.job_id === "string" &&
        typeof parsed.pid === "number" &&
        parsed.pid > 0 &&
        typeof parsed.pgid === "number" &&
        parsed.pgid > 0 &&
        typeof parsed.boot_id === "string" &&
        typeof parsed.active === "boolean" &&
        typeof parsed.recorded_at === "string"
      ) {
        records.push(parsed as JobJournalRecord);
      }
    } catch {
      // Torn tail line: ignore.
    }
  }
  return records;
}

/** Keep one active record per job in `keepJobIds`; drop everything else. */
export function pruneJobJournal(path: string, keepJobIds: Set<string>): void {
  const latest = new Map<string, JobJournalRecord>();
  for (const record of readJobJournal(path)) {
    latest.set(record.job_id, record);
  }
  const kept = [...latest.values()].filter(
    (record) => record.active && keepJobIds.has(record.job_id),
  );
  const body = kept.map((record) => JSON.stringify(record)).join("\n");
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, body ? `${body}\n` : "", { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error: any) {
    console.warn(`[jobs] failed to prune journal ${path}: ${error?.message ?? error}`);
  }
}

export function latestJournalRecords(path: string): Map<number, JobJournalRecord> {
  const latest = new Map<number, JobJournalRecord>();
  for (const record of readJobJournal(path)) {
    latest.set(record.pid, record);
  }
  return latest;
}

/** Latest record per job id. The journal is append-only until prune. */
export function latestJobJournalRecords(path: string): Map<string, JobJournalRecord> {
  const latest = new Map<string, JobJournalRecord>();
  for (const record of readJobJournal(path)) {
    latest.set(record.job_id, record);
  }
  return latest;
}