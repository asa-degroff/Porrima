/**
 * Kernel tool dispatch telemetry (docs/design/kernel-codemode.md §4.9).
 *
 * Every kernel-origin tool call records one outcome sample to
 * `kernel_tool_stats` in porrima.db: tool, outcome (ok/error/refused/
 * aborted), duration, payload sizes, spill/truncation/structured flags,
 * chat + cell. This is the evidence base the plan otherwise assumes:
 * Phase D's shrinkage gate (§5) is "evidence-gated on kernel-usage
 * telemetry", §7 Q2's budget numbers are "placeholders to tune with
 * usage", and the code-search battery showed kernel-side adoption is
 * invisible in transcript metrics (it rides under run_python).
 *
 * Recording is fire-and-forget: telemetry must never fail or slow a
 * dispatch (the record call swallows and logs its own errors). Disabled
 * under NODE_ENV=test so protocol tests never pollute the real store;
 * PORRIMA_KERNEL_STATS=1/0 overrides in either direction.
 *
 * The `codeSearchShapeTag` helper carries the density-readout convention
 * (kernel-codemode.md §4.9 Q1): code_search ok samples record their loop
 * shape in `detail` without storing raw args.
 */
import { createHash } from "crypto";
import Database from "better-sqlite3";
import { appDataPath } from "./paths.js";

const DB_PATH = appDataPath("porrima.db");
// Samples are tiny and dispatch volume is low (the per-cell call budget
// caps it); 1000 rows is months of evidence in ~200 KB.
const MAX_SAMPLES = 1000;
const DETAIL_CAP = 300;

export type KernelToolOutcome = "ok" | "error" | "refused" | "aborted";

/**
 * Density-readout shape tag (kernel-codemode.md §4.9 readout protocol, Q1).
 * For `code_search` ok samples: the route the dispatcher took (snippet test
 * vs file scan — the same `code`-present check the executors branch on) plus
 * an 8-hex digest of the pattern. Per-cell chains become countable —
 * snippet → scan → refined-rescan = hasSnippet && distinct patterns >= 2 —
 * without ever storing raw args. Undefined for other tools and odd inputs;
 * callers pass it as `detail`, which stays reserved for error/refusal
 * reasons on every other path.
 */
export function codeSearchShapeTag(tool: string, args: unknown): string | undefined {
  if (tool !== "code_search") return undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const a = args as Record<string, unknown>;
  const kind = typeof a.code === "string" ? "snippet" : "scan";
  const pat = typeof a.pattern === "string"
    ? createHash("sha256").update(a.pattern).digest("hex").slice(0, 8)
    : "-";
  return `${kind} pat:${pat}`;
}

export interface KernelToolDispatchSample {
  id: string;
  timestamp: number;
  chatId: string;
  /** Cell id, or the job id a background job's dispatcher was re-keyed onto. */
  cellId: string;
  tool: string;
  outcome: KernelToolOutcome;
  durationMs: number;
  /** Result payload chars on the wire (post-stringify, pre-spill head). */
  valueChars: number;
  /** JSON-encoded args size — snippet-mode `code=` payloads ride here. */
  argsChars: number;
  spilled: boolean;
  truncated: boolean;
  /** value_json: a structured projection (code_search's dict), not text. */
  structured: boolean;
  /** Refusal reason or error text (capped). */
  detail?: string;
}

export interface KernelToolAggregate {
  tool: string;
  calls: number;
  ok: number;
  error: number;
  refused: number;
  aborted: number;
  avgDurationMs: number;
  maxDurationMs: number;
  totalValueChars: number;
  spilledCount: number;
  structuredCount: number;
  lastTimestamp: number;
}

function statsEnabled(): boolean {
  const explicit = process.env.PORRIMA_KERNEL_STATS;
  if (explicit === "1") return true;
  if (explicit === "0") return false;
  return process.env.NODE_ENV !== "test";
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS kernel_tool_stats (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        chat_id TEXT NOT NULL DEFAULT '',
        cell_id TEXT NOT NULL DEFAULT '',
        tool TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms REAL NOT NULL DEFAULT 0,
        value_chars INTEGER NOT NULL DEFAULT 0,
        args_chars INTEGER NOT NULL DEFAULT 0,
        spilled INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        structured INTEGER NOT NULL DEFAULT 0,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_kernel_tool_stats_ts ON kernel_tool_stats(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_kernel_tool_stats_tool ON kernel_tool_stats(tool, timestamp DESC);
    `);
  }
  return db;
}

let sampleSequence = 0;

/**
 * Record one dispatch outcome. Never throws — a telemetry failure must not
 * become a tool failure.
 */
export function recordKernelToolDispatch(
  sample: Omit<KernelToolDispatchSample, "id" | "timestamp"> & { timestamp?: number },
): void {
  if (!statsEnabled()) return;
  try {
    const database = getDb();
    const ts = sample.timestamp ?? Date.now();
    const id = `kts_${ts}_${sampleSequence++}`;
    database.prepare(`
      INSERT INTO kernel_tool_stats (
        id, timestamp, chat_id, cell_id, tool, outcome, duration_ms,
        value_chars, args_chars, spilled, truncated, structured, detail
      ) VALUES (
        @id, @timestamp, @chatId, @cellId, @tool, @outcome, @durationMs,
        @valueChars, @argsChars, @spilled, @truncated, @structured, @detail
      )
    `).run({
      id,
      timestamp: ts,
      chatId: sample.chatId,
      cellId: sample.cellId,
      tool: sample.tool,
      outcome: sample.outcome,
      durationMs: sample.durationMs,
      valueChars: sample.valueChars,
      argsChars: sample.argsChars,
      spilled: sample.spilled ? 1 : 0,
      truncated: sample.truncated ? 1 : 0,
      structured: sample.structured ? 1 : 0,
      detail: sample.detail ? String(sample.detail).slice(0, DETAIL_CAP) : null,
    });
    database.prepare(`
      DELETE FROM kernel_tool_stats
      WHERE id IN (
        SELECT id FROM kernel_tool_stats ORDER BY timestamp DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_SAMPLES);
  } catch (e) {
    console.error("[kernel-tool-stats] record failed:", e);
  }
}

/** Per-tool rollup — the Phase D evidence view. */
export function getKernelToolAggregates(): KernelToolAggregate[] {
  if (!statsEnabled()) return [];
  const rows = getDb().prepare(`
    SELECT tool,
      COUNT(*) AS calls,
      SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
      SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error,
      SUM(CASE WHEN outcome = 'refused' THEN 1 ELSE 0 END) AS refused,
      SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END) AS aborted,
      AVG(duration_ms) AS avgDurationMs,
      MAX(duration_ms) AS maxDurationMs,
      SUM(value_chars) AS totalValueChars,
      SUM(spilled) AS spilledCount,
      SUM(structured) AS structuredCount,
      MAX(timestamp) AS lastTimestamp
    FROM kernel_tool_stats
    GROUP BY tool
    ORDER BY calls DESC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    tool: r.tool as string,
    calls: r.calls as number,
    ok: r.ok as number,
    error: r.error as number,
    refused: r.refused as number,
    aborted: r.aborted as number,
    avgDurationMs: Math.round(r.avgDurationMs as number),
    maxDurationMs: r.maxDurationMs as number,
    totalValueChars: r.totalValueChars as number,
    spilledCount: r.spilledCount as number,
    structuredCount: r.structuredCount as number,
    lastTimestamp: r.lastTimestamp as number,
  }));
}

/** Recent samples, most recent first. */
export function getKernelToolSamples(limit = 100): KernelToolDispatchSample[] {
  if (!statsEnabled()) return [];
  const rows = getDb().prepare(`
    SELECT id, timestamp, chat_id, cell_id, tool, outcome, duration_ms,
      value_chars, args_chars, spilled, truncated, structured, detail
    FROM kernel_tool_stats
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    timestamp: r.timestamp as number,
    chatId: r.chat_id as string,
    cellId: r.cell_id as string,
    tool: r.tool as string,
    outcome: r.outcome as KernelToolOutcome,
    durationMs: r.duration_ms as number,
    valueChars: r.value_chars as number,
    argsChars: r.args_chars as number,
    spilled: !!r.spilled,
    truncated: !!r.truncated,
    structured: !!r.structured,
    detail: (r.detail as string | null) || undefined,
  }));
}

/** Clear all samples (admin/debug). */
export function clearKernelToolStats(): void {
  if (!statsEnabled()) return;
  getDb().exec("DELETE FROM kernel_tool_stats");
}
