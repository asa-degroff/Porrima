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

describe("getModelStatsSummary prefill-rate aggregation", () => {
  it("stays null when only micro-runs exist", () => {
    const provider = "llamacpp-only-micro";
    recordRun(provider, timings({ prompt_n: 4, prompt_ms: 1, prompt_per_second: 4000 }));
    recordRun(provider, timings({ prompt_n: 8, prompt_ms: 2, prompt_per_second: 4000 }));
    const summary = stats.getModelStatsSummary(MODEL, provider);
    expect(summary.avgPromptTokensPerSec).toBeNull();
    expect(summary.promptRunCount).toBe(0);
    // Decode/timing averages are unaffected by the prefill floor.
    expect(summary.avgPredictedTokensPerSec).not.toBeNull();
    expect(summary.runCount).toBe(2);
  });

  it("ignores interleaved micro-runs and weights the real prefills by tokens", () => {
    const provider = "llamacpp-mixed";
    recordRun(provider, timings({ prompt_n: 500, prompt_ms: 5000, prompt_per_second: 100 }));
    recordRun(provider, timings({ prompt_n: 4, prompt_ms: 1, prompt_per_second: 4000 }));
    recordRun(provider, timings({ prompt_n: 300, prompt_ms: 1500, prompt_per_second: 200 }));
    const summary = stats.getModelStatsSummary(MODEL, provider);
    // EMA the totals: (0.7*500 + 0.3*300) / (0.7*5000 + 0.3*1500).
    const expected = ((0.7 * 500 + 0.3 * 300) / (0.7 * 5000 + 0.3 * 1500)) * 1000;
    expect(summary.avgPromptTokensPerSec).toBeCloseTo(expected, 5);
    expect(summary.promptRunCount).toBe(2);
  });

  it("seeds the aggregate from the first qualifying run, not the first run", () => {
    const provider = "llamacpp-leading-micro";
    recordRun(provider, timings({ prompt_n: 2, prompt_ms: 0.5, prompt_per_second: 4000 }));
    recordRun(provider, timings({ prompt_n: 600, prompt_ms: 4000, prompt_per_second: 150 }));
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
    expect(summary.promptRunCount).toBe(1);
  });

  it("does not let many small turns dominate one large prefill", () => {
    const provider = "llamacpp-weighted-prefill";
    // 20 small turns: 100 new tokens in 2.5s each -> 40 tok/s.
    for (let i = 0; i < 20; i++) {
      recordRun(provider, timings({ prompt_n: 100, prompt_ms: 2500, prompt_per_second: 40 }));
    }
    // One real prefill: 10k tokens in 35s -> ~286 tok/s.
    recordRun(provider, timings({ prompt_n: 10_000, prompt_ms: 35_000, prompt_per_second: 285.7 }));

    const summary = stats.getModelStatsSummary(MODEL, provider);
    // The old per-run EMA would sit near the small-turn rate (~114 t/s
    // after α=0.3); the weighted aggregate should be much closer to the
    // large run's rate.
    expect(summary.avgPromptTokensPerSec).toBeGreaterThan(200);
  });

  it("reports the steady-state rate from >=1k-token runs only", () => {
    const provider = "llamacpp-large-prefill";
    recordRun(provider, timings({ prompt_n: 500, prompt_ms: 5000, prompt_per_second: 100 }));
    recordRun(provider, timings({ prompt_n: 2000, prompt_ms: 10_000, prompt_per_second: 200 }));
    recordRun(provider, timings({ prompt_n: 1000, prompt_ms: 10_000, prompt_per_second: 100 }));

    const summary = stats.getModelStatsSummary(MODEL, provider);
    expect(summary.promptRunCount).toBe(3);
    expect(summary.largePromptRunCount).toBe(1);
    expect(summary.largePromptTokensPerSec).toBeCloseTo(200, 5);
  });

  it("weights decode by generated tokens, not by run count", () => {
    const provider = "llamacpp-weighted-decode";
    // 10 short generations: 10 tokens in 1s each -> 10 tok/s.
    for (let i = 0; i < 10; i++) {
      recordRun(provider, timings({ predicted_n: 10, predicted_ms: 1000, predicted_per_second: 10 }));
    }
    // One long generation: 4k tokens in 100s -> 40 tok/s.
    recordRun(provider, timings({ predicted_n: 4000, predicted_ms: 100_000, predicted_per_second: 40 }));

    const summary = stats.getModelStatsSummary(MODEL, provider);
    expect(summary.avgPredictedTokensPerSec).toBeGreaterThan(35);
  });
});
