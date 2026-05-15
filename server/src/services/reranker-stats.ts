import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";

const DB_PATH = join(homedir(), ".quje-agent", "quje-agent.db");
const MAX_RUNS = 100;

// EMA decay for averages
const EMA_ALPHA = 0.3;

// --- Types ---

export interface SelectedResult {
  text: string;
  score: number;
}

export interface RerankerStatsEntry {
  id: string;
  timestamp: number;
  usedModel: boolean;
  latencyMs: number;
  documentCount: number;
  topN: number;
  totalTokens: number;
  scoreMin: number;
  scoreMax: number;
  scoreMedian: number;
  chatType: string;
  source: string;
  query?: string;
  documents?: string[];
  selectedResults?: SelectedResult[];
}

export interface RerankerStatsSummary {
  lastRun: RerankerStatsEntry | null;
  runCount: number;
  modelRunCount: number;
  fallbackRunCount: number;
  modelSuccessRate: number | null; // 0–1
  avgLatencyMs: number | null;
  avgModelLatencyMs: number | null;
  avgFallbackLatencyMs: number | null;
  avgDocumentCount: number | null;
  avgTotalTokens: number | null;
  avgScoreSpread: number | null; // max - median as a quality signal
  timeoutCount: number;         // latencies >= 95% of the configured timeout
}

type Row = Record<string, unknown>;

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initSchema();
  }
  return db;
}

function initSchema() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS reranker_stats (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      usedModel INTEGER NOT NULL,
      latencyMs REAL NOT NULL,
      documentCount INTEGER NOT NULL,
      topN INTEGER NOT NULL,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      scoreMin REAL NOT NULL DEFAULT 0,
      scoreMax REAL NOT NULL DEFAULT 0,
      scoreMedian REAL NOT NULL DEFAULT 0,
      chatType TEXT NOT NULL DEFAULT 'agent',
      source TEXT NOT NULL DEFAULT 'memory-context',
      query TEXT,
      documents TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reranker_stats_ts ON reranker_stats(timestamp DESC);
  `);
  ensureColumn(database, "reranker_stats", "source", "TEXT NOT NULL DEFAULT 'memory-context'");
  ensureColumn(database, "reranker_stats", "query", "TEXT");
  ensureColumn(database, "reranker_stats", "documents", "TEXT");
  ensureColumn(database, "reranker_stats", "selectedResults", "TEXT");
}

function ensureColumn(database: Database.Database, table: string, column: string, definition: string): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

let runSequence = 0;

/**
 * Record a single reranker call.
 */
export function recordRerankerStats(entry: Omit<RerankerStatsEntry, "id">): RerankerStatsEntry {
  const database = getDb();
  const ts = entry.timestamp ?? Date.now();
  const id = `reranker_${ts}_${runSequence++}`;

  const row: RerankerStatsEntry = { id, ...entry, timestamp: ts };

  database.prepare(`
    INSERT INTO reranker_stats (
      id, timestamp, usedModel, latencyMs, documentCount, topN,
      totalTokens, scoreMin, scoreMax, scoreMedian, chatType, source, query, documents, selectedResults
    ) VALUES (
      @id, @timestamp, @usedModel, @latencyMs, @documentCount, @topN,
      @totalTokens, @scoreMin, @scoreMax, @scoreMedian, @chatType, @source, @query, @documents, @selectedResults
    )
  `).run({
    id,
    timestamp: ts,
    usedModel: entry.usedModel ? 1 : 0,
    latencyMs: entry.latencyMs,
    documentCount: entry.documentCount,
    topN: entry.topN,
    totalTokens: entry.totalTokens,
    scoreMin: entry.scoreMin,
    scoreMax: entry.scoreMax,
    scoreMedian: entry.scoreMedian,
    chatType: entry.chatType,
    source: entry.source,
    query: entry.query ?? null,
    documents: entry.documents ? JSON.stringify(entry.documents) : null,
    selectedResults: entry.selectedResults ? JSON.stringify(entry.selectedResults) : null,
  });

  pruneOldRuns();
  return row;
}

function pruneOldRuns() {
  const database = getDb();
  database.prepare(`
    DELETE FROM reranker_stats
    WHERE id IN (
      SELECT id FROM reranker_stats
      ORDER BY timestamp DESC
      LIMIT -1 OFFSET ?
    )
  `).run(MAX_RUNS);
}

/**
 * Get recent runs, most recent first.
 */
export function getRerankerRuns(limit = 50): RerankerStatsEntry[] {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, timestamp, usedModel, latencyMs, documentCount, topN,
      totalTokens, scoreMin, scoreMax, scoreMedian, chatType, source, query, documents, selectedResults
    FROM reranker_stats
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as Row[];

  return rows.map(rowToEntry);
}

function rowToEntry(r: Row): RerankerStatsEntry {
  let documents: string[] | undefined;
  if (r.documents) {
    try { documents = JSON.parse(r.documents as string); } catch { /* ignore */ }
  }
  let selectedResults: SelectedResult[] | undefined;
  if (r.selectedResults) {
    try { selectedResults = JSON.parse(r.selectedResults as string); } catch { /* ignore */ }
  }
  return {
    id: r.id as string,
    timestamp: r.timestamp as number,
    usedModel: !!r.usedModel,
    latencyMs: r.latencyMs as number,
    documentCount: r.documentCount as number,
    topN: r.topN as number,
    totalTokens: r.totalTokens as number,
    scoreMin: r.scoreMin as number,
    scoreMax: r.scoreMax as number,
    scoreMedian: r.scoreMedian as number,
    chatType: r.chatType as string,
    source: (r.source as string | undefined) || "memory-context",
    query: (r.query as string | null) || undefined,
    documents,
    selectedResults,
  };
}

/**
 * Get a summary of reranker performance.
 * @param timeoutMs The configured reranker timeout, used to count timeouts.
 */
export function getRerankerStatsSummary(timeoutMs = 25_000): RerankerStatsSummary {
  const database = getDb();

  const lastRow = database.prepare(`
    SELECT id, timestamp, usedModel, latencyMs, documentCount, topN,
      totalTokens, scoreMin, scoreMax, scoreMedian, chatType, source
    FROM reranker_stats
    ORDER BY timestamp DESC
    LIMIT 1
  `).get() as Row | undefined;

  const lastRun = lastRow ? rowToEntry(lastRow) : null;

  // Compute aggregates from all rows
  const allRows = database.prepare(`
    SELECT usedModel, latencyMs, documentCount, totalTokens,
      scoreMin, scoreMax, scoreMedian
    FROM reranker_stats
    ORDER BY timestamp ASC
  `).all() as Row[];

  if (allRows.length === 0) {
    return {
      lastRun: null,
      runCount: 0,
      modelRunCount: 0,
      fallbackRunCount: 0,
      modelSuccessRate: null,
      avgLatencyMs: null,
      avgModelLatencyMs: null,
      avgFallbackLatencyMs: null,
      avgDocumentCount: null,
      avgTotalTokens: null,
      avgScoreSpread: null,
      timeoutCount: 0,
    };
  }

  let modelCount = 0;
  let fallbackCount = 0;
  let timeoutCount = 0;
  let totalLatency = 0;
  let modelLatencyEma: number | null = null;
  let fallbackLatencyEma: number | null = null;
  let latencyEma: number | null = null;
  let docCountEma: number | null = null;
  let tokensEma: number | null = null;
  let spreadEma: number | null = null;

  const timeoutThreshold = timeoutMs * 0.95;

  for (const r of allRows) {
    const usedModel = !!r.usedModel;
    const lat = r.latencyMs as number;
    const docCount = r.documentCount as number;
    const tokens = r.totalTokens as number;
    const spread = (r.scoreMax as number) - (r.scoreMedian as number);

    if (usedModel) modelCount++; else fallbackCount++;
    totalLatency += lat;
    if (lat >= timeoutThreshold) timeoutCount++;

    // EMA updates
    latencyEma = latencyEma === null ? lat : EMA_ALPHA * lat + (1 - EMA_ALPHA) * latencyEma;
    docCountEma = docCountEma === null ? docCount : EMA_ALPHA * docCount + (1 - EMA_ALPHA) * docCountEma;
    tokensEma = tokensEma === null ? tokens : EMA_ALPHA * tokens + (1 - EMA_ALPHA) * tokensEma;
    spreadEma = spreadEma === null ? spread : EMA_ALPHA * spread + (1 - EMA_ALPHA) * spreadEma;

    if (usedModel) {
      modelLatencyEma = modelLatencyEma === null ? lat : EMA_ALPHA * lat + (1 - EMA_ALPHA) * modelLatencyEma;
    } else {
      fallbackLatencyEma = fallbackLatencyEma === null ? lat : EMA_ALPHA * lat + (1 - EMA_ALPHA) * fallbackLatencyEma;
    }
  }

  const runCount = allRows.length;
  const modelSuccessRate = runCount > 0 ? modelCount / runCount : null;

  return {
    lastRun,
    runCount,
    modelRunCount: modelCount,
    fallbackRunCount: fallbackCount,
    modelSuccessRate,
    avgLatencyMs: latencyEma,
    avgModelLatencyMs: modelLatencyEma,
    avgFallbackLatencyMs: fallbackLatencyEma,
    avgDocumentCount: docCountEma,
    avgTotalTokens: tokensEma,
    avgScoreSpread: spreadEma,
    timeoutCount,
  };
}

/** Clear all reranker stats (for testing/reset) */
export function clearRerankerStats() {
  const database = getDb();
  database.exec("DELETE FROM reranker_stats");
}
