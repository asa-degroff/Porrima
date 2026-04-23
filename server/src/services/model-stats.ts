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
}

export interface ModelStatsSummary {
  lastRun: ModelStatsEntry | null;
  avgPromptTokensPerSec: number | null;
  avgPredictedTokensPerSec: number | null;
  avgPromptMs: number | null;
  avgPredictedMs: number | null;
  runCount: number;
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
}

/**
 * Record a single model run's stats.
 * Returns the created entry.
 */
export function recordModelStats(
  modelId: string,
  provider: string,
  timings: LlamaTimings,
  timestamp?: number
): ModelStatsEntry {
  const database = getDb();
  const ts = timestamp ?? Date.now();
  const id = `${modelId}_${ts}`;

  const stmt = database.prepare(`
    INSERT INTO model_stats (
      id, modelId, provider, timestamp,
      promptTokens, predictedTokens,
      promptMs, predictedMs, sampleMs,
      promptTokensPerSec, predictedTokensPerSec
    ) VALUES (@id, @modelId, @provider, @timestamp,
      @promptTokens, @predictedTokens,
      @promptMs, @predictedMs, @sampleMs,
      @promptTokensPerSec, @predictedTokensPerSec)
  `);

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
      promptTokensPerSec, predictedTokensPerSec
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
      promptTokensPerSec, predictedTokensPerSec
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
  } as ModelStatsEntry) : null;

  // Compute EMA from all runs (chronological order for proper EMA)
  const allRows = database.prepare(`
    SELECT promptTokensPerSec, predictedTokensPerSec, promptMs, predictedMs
    FROM model_stats
    WHERE modelId = ?
    ORDER BY timestamp ASC
  `).all(modelId) as Row[];

  let avgPromptTokensPerSec: number | null = null;
  let avgPredictedTokensPerSec: number | null = null;
  let avgPromptMs: number | null = null;
  let avgPredictedMs: number | null = null;

  for (const row of allRows) {
    const ptps = row.promptTokensPerSec as number;
    const dtps = row.predictedTokensPerSec as number;
    const pMs = row.promptMs as number;
    const dMs = row.predictedMs as number;
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
  }

  return {
    lastRun,
    avgPromptTokensPerSec,
    avgPredictedTokensPerSec,
    avgPromptMs,
    avgPredictedMs,
    runCount: allRows.length,
  };
}

/**
 * Get all models that have recorded stats, with their summaries.
 */
export function getAllModelSummaries(): { modelId: string; provider: string; summary: ModelStatsSummary }[] {
  const database = getDb();
  const models = database.prepare(`
    SELECT DISTINCT modelId, provider
    FROM model_stats
    ORDER BY modelId
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
