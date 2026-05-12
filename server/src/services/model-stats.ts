import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";

const DB_PATH = join(homedir(), ".quje-agent", "quje-agent.db");
const MAX_RUNS_PER_MODEL = 50;

// EMA decay factor — recent runs matter more, but we smooth out variance.
const EMA_ALPHA = 0.3;

export interface LlamaTimings {
  prompt_n: number;
  prompt_ms: number;
  prompt_per_token_ms: number;
  prompt_per_second: number;
  predicted_n: number;
  predicted_ms: number;
  predicted_per_token_ms: number;
  predicted_per_second: number;
  load_ms?: number;
  sample_ms?: number;
}

export interface ModelStatsEntry {
  id: string;
  modelId: string;
  provider: string;
  timestamp: number;
  promptTokens: number;
  predictedTokens: number;
  promptMs: number;
  predictedMs: number;
  sampleMs?: number;
  promptTokensPerSec: number;
  predictedTokensPerSec: number;
  totalMs: number;
  cachePrompt: boolean;
  cacheMode?: string;
  reportedPromptTokens?: number;
  inferredCachedTokens?: number;
  inferredCacheHitRatio?: number;
  requestMessageCount?: number;
  requestCharCount?: number;
  requestDigest?: string;
}

export interface ModelStatsSummary {
  lastRun: ModelStatsEntry | null;
  avgPromptTokensPerSec: number | null;
  avgPredictedTokensPerSec: number | null;
  avgPromptMs: number | null;
  avgPredictedMs: number | null;
  avgInferredCacheHitRatio: number | null;
  avgInferredCachedTokens: number | null;
  runCount: number;
}

export interface CacheMetrics {
  cachePrompt?: boolean;
  cacheMode?: string;
  requestMessageCount?: number;
  requestCharCount?: number;
  requestDigest?: string;
  reportedPromptTokens?: number;
  promptEvalTokens?: number;
  inferredCachedTokens?: number;
  inferredCacheHitRatio?: number;
}

type Row = Record<string, unknown>;

let db: Database.Database | null = null;
let runSequence = 0;

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
    CREATE TABLE IF NOT EXISTS model_stats (
      id TEXT PRIMARY KEY,
      modelId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'llamacpp',
      timestamp INTEGER NOT NULL,
      promptTokens INTEGER NOT NULL,
      predictedTokens INTEGER NOT NULL,
      promptMs REAL NOT NULL,
      predictedMs REAL NOT NULL,
      sampleMs REAL,
      promptTokensPerSec REAL NOT NULL,
      predictedTokensPerSec REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_model_stats_modelId ON model_stats(modelId, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_model_stats_timestamp ON model_stats(timestamp DESC);
  `);

  const existingColumns = new Set(
    (database.prepare("PRAGMA table_info(model_stats)").all() as Array<{ name: string }>)
      .map((col) => col.name)
  );
  const addColumn = (name: string, ddl: string) => {
    if (!existingColumns.has(name)) {
      database.exec(`ALTER TABLE model_stats ADD COLUMN ${ddl}`);
      existingColumns.add(name);
    }
  };

  addColumn("cachePrompt", "cachePrompt INTEGER NOT NULL DEFAULT 0");
  addColumn("cacheMode", "cacheMode TEXT");
  addColumn("reportedPromptTokens", "reportedPromptTokens INTEGER");
  addColumn("inferredCachedTokens", "inferredCachedTokens INTEGER");
  addColumn("inferredCacheHitRatio", "inferredCacheHitRatio REAL");
  addColumn("requestMessageCount", "requestMessageCount INTEGER");
  addColumn("requestCharCount", "requestCharCount INTEGER");
  addColumn("requestDigest", "requestDigest TEXT");
}

/**
 * Record a single model run's stats.
 * Returns the created entry.
 */
export function recordModelStats(
  modelId: string,
  provider: string,
  timings: LlamaTimings,
  cacheMetrics?: CacheMetrics,
  timestamp?: number
): ModelStatsEntry {
  const database = getDb();
  const ts = timestamp ?? Date.now();
  const id = `${modelId}_${ts}_${runSequence++}`;

  const stmt = database.prepare(`
    INSERT INTO model_stats (
      id, modelId, provider, timestamp,
      promptTokens, predictedTokens,
      promptMs, predictedMs, sampleMs,
      promptTokensPerSec, predictedTokensPerSec,
      cachePrompt, cacheMode, reportedPromptTokens, inferredCachedTokens,
      inferredCacheHitRatio, requestMessageCount, requestCharCount, requestDigest
    ) VALUES (@id, @modelId, @provider, @timestamp,
      @promptTokens, @predictedTokens,
      @promptMs, @predictedMs, @sampleMs,
      @promptTokensPerSec, @predictedTokensPerSec,
      @cachePrompt, @cacheMode, @reportedPromptTokens, @inferredCachedTokens,
      @inferredCacheHitRatio, @requestMessageCount, @requestCharCount, @requestDigest)
  `);

  const reportedPromptTokens = cacheMetrics?.reportedPromptTokens;
  const promptEvalTokens = cacheMetrics?.promptEvalTokens ?? timings.prompt_n;
  const inferredCachedTokens = cacheMetrics?.inferredCachedTokens ??
    (typeof reportedPromptTokens === "number" ? Math.max(0, reportedPromptTokens - promptEvalTokens) : undefined);
  const inferredCacheHitRatio = cacheMetrics?.inferredCacheHitRatio ??
    (typeof reportedPromptTokens === "number" && reportedPromptTokens > 0 && typeof inferredCachedTokens === "number"
      ? inferredCachedTokens / reportedPromptTokens
      : undefined);

  const entry: ModelStatsEntry = {
    id,
    modelId,
    provider,
    timestamp: ts,
    promptTokens: timings.prompt_n,
    predictedTokens: timings.predicted_n,
    promptMs: timings.prompt_ms,
    predictedMs: timings.predicted_ms,
    sampleMs: timings.sample_ms,
    promptTokensPerSec: timings.prompt_per_second,
    predictedTokensPerSec: timings.predicted_per_second,
    totalMs: timings.prompt_ms + timings.predicted_ms,
    cachePrompt: !!cacheMetrics?.cachePrompt,
    cacheMode: cacheMetrics?.cacheMode,
    reportedPromptTokens,
    inferredCachedTokens,
    inferredCacheHitRatio,
    requestMessageCount: cacheMetrics?.requestMessageCount,
    requestCharCount: cacheMetrics?.requestCharCount,
    requestDigest: cacheMetrics?.requestDigest,
  };

  stmt.run({
    id,
    modelId,
    provider,
    timestamp: ts,
    promptTokens: timings.prompt_n,
    predictedTokens: timings.predicted_n,
    promptMs: timings.prompt_ms,
    predictedMs: timings.predicted_ms,
    sampleMs: timings.sample_ms ?? null,
    promptTokensPerSec: timings.prompt_per_second,
    predictedTokensPerSec: timings.predicted_per_second,
    cachePrompt: cacheMetrics?.cachePrompt ? 1 : 0,
    cacheMode: cacheMetrics?.cacheMode ?? null,
    reportedPromptTokens: reportedPromptTokens ?? null,
    inferredCachedTokens: inferredCachedTokens ?? null,
    inferredCacheHitRatio: inferredCacheHitRatio ?? null,
    requestMessageCount: cacheMetrics?.requestMessageCount ?? null,
    requestCharCount: cacheMetrics?.requestCharCount ?? null,
    requestDigest: cacheMetrics?.requestDigest ?? null,
  });

  pruneOldRuns(modelId);
  return entry;
}

/** Keep only the most recent MAX_RUNS_PER_MODEL entries per model */
function pruneOldRuns(modelId: string) {
  const database = getDb();
  database.prepare(`
    DELETE FROM model_stats
    WHERE id IN (
      SELECT id FROM model_stats
      WHERE modelId = ?
      ORDER BY timestamp DESC
      LIMIT -1 OFFSET ?
    )
  `).run(modelId, MAX_RUNS_PER_MODEL);
}

/**
 * Get recent runs for a specific model, most recent first.
 */
export function getModelRuns(modelId: string, limit = 20): ModelStatsEntry[] {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, modelId, provider, timestamp,
      promptTokens, predictedTokens,
      promptMs, predictedMs, sampleMs,
      promptTokensPerSec, predictedTokensPerSec,
      cachePrompt, cacheMode, reportedPromptTokens, inferredCachedTokens,
      inferredCacheHitRatio, requestMessageCount, requestCharCount, requestDigest
    FROM model_stats
    WHERE modelId = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(modelId, limit) as Row[];

  return rows.map(r => ({
    id: r.id as string,
    modelId: r.modelId as string,
    provider: r.provider as string,
    timestamp: r.timestamp as number,
    promptTokens: r.promptTokens as number,
    predictedTokens: r.predictedTokens as number,
    promptMs: r.promptMs as number,
    predictedMs: r.predictedMs as number,
    sampleMs: r.sampleMs != null ? r.sampleMs as number : undefined,
    promptTokensPerSec: r.promptTokensPerSec as number,
    predictedTokensPerSec: r.predictedTokensPerSec as number,
    totalMs: (r.promptMs as number) + (r.predictedMs as number),
    cachePrompt: !!r.cachePrompt,
    cacheMode: r.cacheMode != null ? r.cacheMode as string : undefined,
    reportedPromptTokens: r.reportedPromptTokens != null ? r.reportedPromptTokens as number : undefined,
    inferredCachedTokens: r.inferredCachedTokens != null ? r.inferredCachedTokens as number : undefined,
    inferredCacheHitRatio: r.inferredCacheHitRatio != null ? r.inferredCacheHitRatio as number : undefined,
    requestMessageCount: r.requestMessageCount != null ? r.requestMessageCount as number : undefined,
    requestCharCount: r.requestCharCount != null ? r.requestCharCount as number : undefined,
    requestDigest: r.requestDigest != null ? r.requestDigest as string : undefined,
  }));
}

/**
 * Get a summary for a specific model: last run + EMA averages.
 */
export function getModelStatsSummary(modelId: string): ModelStatsSummary {
  const database = getDb();

  const lastRow = database.prepare(`
    SELECT id, modelId, provider, timestamp,
      promptTokens, predictedTokens,
      promptMs, predictedMs, sampleMs,
      promptTokensPerSec, predictedTokensPerSec,
      cachePrompt, cacheMode, reportedPromptTokens, inferredCachedTokens,
      inferredCacheHitRatio, requestMessageCount, requestCharCount, requestDigest
    FROM model_stats
    WHERE modelId = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(modelId) as Row | undefined;

  const lastRun = lastRow ? ({
    id: lastRow.id as string,
    modelId: lastRow.modelId as string,
    provider: lastRow.provider as string,
    timestamp: lastRow.timestamp as number,
    promptTokens: lastRow.promptTokens as number,
    predictedTokens: lastRow.predictedTokens as number,
    promptMs: lastRow.promptMs as number,
    predictedMs: lastRow.predictedMs as number,
    sampleMs: lastRow.sampleMs != null ? lastRow.sampleMs as number : undefined,
    promptTokensPerSec: lastRow.promptTokensPerSec as number,
    predictedTokensPerSec: lastRow.predictedTokensPerSec as number,
    totalMs: (lastRow.promptMs as number) + (lastRow.predictedMs as number),
    cachePrompt: !!lastRow.cachePrompt,
    cacheMode: lastRow.cacheMode != null ? lastRow.cacheMode as string : undefined,
    reportedPromptTokens: lastRow.reportedPromptTokens != null ? lastRow.reportedPromptTokens as number : undefined,
    inferredCachedTokens: lastRow.inferredCachedTokens != null ? lastRow.inferredCachedTokens as number : undefined,
    inferredCacheHitRatio: lastRow.inferredCacheHitRatio != null ? lastRow.inferredCacheHitRatio as number : undefined,
    requestMessageCount: lastRow.requestMessageCount != null ? lastRow.requestMessageCount as number : undefined,
    requestCharCount: lastRow.requestCharCount != null ? lastRow.requestCharCount as number : undefined,
    requestDigest: lastRow.requestDigest != null ? lastRow.requestDigest as string : undefined,
  } as ModelStatsEntry) : null;

  // Compute EMA from all runs (chronological order for proper EMA)
  const allRows = database.prepare(`
    SELECT promptTokensPerSec, predictedTokensPerSec, promptMs, predictedMs,
      inferredCacheHitRatio, inferredCachedTokens
    FROM model_stats
    WHERE modelId = ?
    ORDER BY timestamp ASC
  `).all(modelId) as Row[];

  let avgPromptTokensPerSec: number | null = null;
  let avgPredictedTokensPerSec: number | null = null;
  let avgPromptMs: number | null = null;
  let avgPredictedMs: number | null = null;
  let avgInferredCacheHitRatio: number | null = null;
  let avgInferredCachedTokens: number | null = null;

  for (const row of allRows) {
    const ptps = row.promptTokensPerSec as number;
    const dtps = row.predictedTokensPerSec as number;
    const pMs = row.promptMs as number;
    const dMs = row.predictedMs as number;
    const cacheHitRatio = row.inferredCacheHitRatio as number | null;
    const cachedTokens = row.inferredCachedTokens as number | null;
    if (avgPromptTokensPerSec === null) {
      avgPromptTokensPerSec = ptps;
      avgPredictedTokensPerSec = dtps;
      avgPromptMs = pMs;
      avgPredictedMs = dMs;
    } else {
      avgPromptTokensPerSec = EMA_ALPHA * ptps + (1 - EMA_ALPHA) * avgPromptTokensPerSec;
      avgPredictedTokensPerSec = EMA_ALPHA * dtps + (1 - EMA_ALPHA) * avgPredictedTokensPerSec!;
      avgPromptMs = EMA_ALPHA * pMs + (1 - EMA_ALPHA) * avgPromptMs!;
      avgPredictedMs = EMA_ALPHA * dMs + (1 - EMA_ALPHA) * avgPredictedMs!;
    }
    if (typeof cacheHitRatio === "number") {
      avgInferredCacheHitRatio = avgInferredCacheHitRatio === null
        ? cacheHitRatio
        : EMA_ALPHA * cacheHitRatio + (1 - EMA_ALPHA) * avgInferredCacheHitRatio;
    }
    if (typeof cachedTokens === "number") {
      avgInferredCachedTokens = avgInferredCachedTokens === null
        ? cachedTokens
        : EMA_ALPHA * cachedTokens + (1 - EMA_ALPHA) * avgInferredCachedTokens;
    }
  }

  return {
    lastRun,
    avgPromptTokensPerSec,
    avgPredictedTokensPerSec,
    avgPromptMs,
    avgPredictedMs,
    avgInferredCacheHitRatio,
    avgInferredCachedTokens,
    runCount: allRows.length,
  };
}

/**
 * Get all models that have recorded stats, with their summaries.
 */
export function getAllModelSummaries(): { modelId: string; provider: string; summary: ModelStatsSummary }[] {
  const database = getDb();
  const models = database.prepare(`
    SELECT modelId, provider, MAX(timestamp) AS lastUsed
    FROM model_stats
    GROUP BY modelId, provider
    ORDER BY lastUsed DESC
  `).all() as Row[];

  return models.map(m => ({
    modelId: m.modelId as string,
    provider: m.provider as string,
    summary: getModelStatsSummary(m.modelId as string),
  }));
}

/** Clear all stats (for testing/reset) */
export function clearModelStats() {
  const database = getDb();
  database.exec("DELETE FROM model_stats");
}
