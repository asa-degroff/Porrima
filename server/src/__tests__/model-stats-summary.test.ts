import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type {
  LlamaTimings,
  ModelStatsEntry,
} from "../services/model-stats.js";

// The service module binds its DB path at import time (paths.ts reads
// PORRIMA_DATA_DIR during evaluation), so point it at a temp dir BEFORE
// importing. Static imports in this test file must not touch model-stats.js;
// everything goes through a post-setup dynamic import.
let dataDir = "";
type StatsModule = typeof import("../services/model-stats.js");
let stats: StatsModule;

function timings(over: Partial<LlamaTimings>): LlamaTimings {
  return {
    prompt_n: 1000,
    prompt_ms: 1000,
    prompt_per_token_ms: 1,
    prompt_per_second: 1000,
    predicted_n: 100,
    predicted_ms: 2000,
    predicted_per_token_ms: 20,
    predicted_per_second: 50,
    ...over,
  };
}

const MODEL = "test-model-ema-floor";
let ts = Date.now() - 100_000;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "porrima-model-stats-summary-"));
  process.env.PORRIMA_DATA_DIR = dataDir;
  stats = await import("../services/model-stats.js");
});

afterAll(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // WAL handles may still be open on some platforms; temp dirs are
    // disposable so cleanup failure is harmless.
  }
});

function recordRun(provider: string, t: LlamaTimings): ModelStatsEntry {
  ts += 1000;
  return stats.recordModelStats(MODEL, provider, t, undefined, ts);
}

describe("getModelStatsSummary prefill-rate EMA floor", () => {
  it("stays null when only micro-runs exist", () => {
    const provider = "llamacpp-only-micro";
    recordRun(provider, timings({ prompt_n: 4, prompt_ms: 1, prompt_per_second: 4000 }));
    recordRun(provider, timings({ prompt_n: 8, prompt_ms: 2, prompt_per_second: 4000 }));
    const summary = stats.getModelStatsSummary(MODEL, provider);
    expect(summary.avgPromptTokensPerSec).toBeNull();
    // Decode/timing averages are unaffected by the prefill filter.
    expect(summary.avgPredictedTokensPerSec).not.toBeNull();
    expect(summary.runCount).toBe(2);
  });

  it("ignores interleaved micro-runs when averaging real prefills", () => {
    const provider = "llamacpp-mixed";
    recordRun(provider, timings({ prompt_n: 500, prompt_ms: 5000, prompt_per_second: 100 }));
    recordRun(provider, timings({ prompt_n: 4, prompt_ms: 1, prompt_per_second: 4000 }));
    recordRun(provider, timings({ prompt_n: 300, prompt_ms: 1500, prompt_per_second: 200 }));
    const summary = stats.getModelStatsSummary(MODEL, provider);
    // EMA over qualifying runs only: seed 100, then α=0.3 update with 200.
    const expected = Math.round((0.3 * 200 + 0.7 * 100) * 10) / 10;
    expect(Math.round(summary.avgPromptTokensPerSec! * 10) / 10).toBe(expected);
  });

  it("seeds the EMA from the first qualifying run, not the first run", () => {
    const provider = "llamacpp-leading-micro";
    recordRun(provider, timings({ prompt_n: 2, prompt_ms: 0.5, prompt_per_second: 4000 }));
    recordRun(provider, timings({ prompt_n: 600, prompt_ms: 3000, prompt_per_second: 150 }));
    const summary = stats.getModelStatsSummary(MODEL, provider);
    expect(summary.avgPromptTokensPerSec).toBeCloseTo(150, 5);
  });

  it("includes runs exactly at the token floor", () => {
    const provider = "llamacpp-boundary";
    recordRun(
      provider,
      timings({ prompt_n: 32, prompt_ms: 320, prompt_per_second: 100 }),
    );
    const summary = stats.getModelStatsSummary(MODEL, provider);
    expect(summary.avgPromptTokensPerSec).not.toBeNull();
  });
});
