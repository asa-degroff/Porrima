/**
 * kernel-tool-stats — dispatch telemetry store
 * (docs/design/kernel-codemode.md §4.9, Phase D evidence base).
 *
 * The store is gated off under NODE_ENV=test (vitest's default) so protocol
 * tests never pollute the real porrima.db; PORRIMA_KERNEL_STATS=1 force-
 * enables it for these unit tests, which point PORRIMA_DATA_DIR at a temp
 * dir before the dynamic import (paths.ts pins APP_DATA_DIR at module load
 * — the established resetModules pattern).
 */
import { access, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir = "";

async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  // NODE_ENV is pinned to "test" for every import in this file — vitest only
  // sets it when unset, so an ambient NODE_ENV (e.g. a shell that sources the
  // service's production env) would leak in and flip the module's gating.
  for (const [k, v] of Object.entries({ NODE_ENV: "test", ...env })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return await import("./kernel-tool-stats.js");
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "porrima-kstats-"));
});

afterEach(async () => {
  delete process.env.PORRIMA_KERNEL_STATS;
  delete process.env.PORRIMA_DATA_DIR;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const baseSample = {
  chatId: "chat-1",
  cellId: "cell-1",
  tool: "read_file",
  outcome: "ok" as const,
  durationMs: 12,
  valueChars: 100,
  argsChars: 20,
  spilled: false,
  truncated: false,
  structured: false,
};

describe("kernel-tool-stats", () => {
  it("is disabled under NODE_ENV=test by default — the db file is never even opened", async () => {
    const s = await loadModule({ PORRIMA_DATA_DIR: dataDir, PORRIMA_KERNEL_STATS: undefined });
    expect(process.env.NODE_ENV).toBe("test");
    s.recordKernelToolDispatch(baseSample);
    await expect(access(join(dataDir, "porrima.db"))).rejects.toThrow();
    expect(s.getKernelToolSamples()).toEqual([]);
  });

  it("records outcomes and aggregates per tool", async () => {
    const s = await loadModule({ PORRIMA_DATA_DIR: dataDir, PORRIMA_KERNEL_STATS: "1" });
    s.recordKernelToolDispatch(baseSample);
    s.recordKernelToolDispatch({ ...baseSample, outcome: "error", detail: "boom", durationMs: 30, valueChars: 0 });
    s.recordKernelToolDispatch({ ...baseSample, tool: "code_search", outcome: "ok", structured: true, valueChars: 5000, argsChars: 80 });
    s.recordKernelToolDispatch({ ...baseSample, tool: "code_search", outcome: "refused", detail: "budget exhausted", valueChars: 0 });

    const agg = s.getKernelToolAggregates();
    const rf = agg.find((a) => a.tool === "read_file")!;
    expect(rf.calls).toBe(2);
    expect(rf.ok).toBe(1);
    expect(rf.error).toBe(1);
    expect(rf.totalValueChars).toBe(100);

    const cs = agg.find((a) => a.tool === "code_search")!;
    expect(cs.calls).toBe(2);
    expect(cs.ok).toBe(1);
    expect(cs.refused).toBe(1);
    expect(cs.structuredCount).toBe(1);
    expect(cs.totalValueChars).toBe(5000);

    const samples = s.getKernelToolSamples(10);
    expect(samples.length).toBe(4);
    expect(samples.find((x) => x.outcome === "refused")!.detail).toBe("budget exhausted");
    expect(samples.find((x) => x.structured)!.tool).toBe("code_search");
    // aggregates order: most calls first; both tools have 2 — order between
    // them is not asserted, only presence.
    expect(agg.length).toBe(2);
  });

  it("round-trips sample fields and caps detail length", async () => {
    const s = await loadModule({ PORRIMA_DATA_DIR: dataDir, PORRIMA_KERNEL_STATS: "1" });
    s.recordKernelToolDispatch({
      ...baseSample,
      tool: "code_search",
      outcome: "ok",
      spilled: true,
      truncated: false,
      structured: true,
      argsChars: 1234,
      valueChars: 2_000_000,
      detail: "x".repeat(500),
    });
    const [row] = s.getKernelToolSamples(1);
    expect(row.tool).toBe("code_search");
    expect(row.spilled).toBe(true);
    expect(row.structured).toBe(true);
    expect(row.argsChars).toBe(1234);
    expect(row.valueChars).toBe(2_000_000);
    expect(row.detail!.length).toBe(300);
    expect(row.chatId).toBe("chat-1");
    expect(row.cellId).toBe("cell-1");
  });

  it("prunes to the 1000-row cap, keeping the newest", async () => {
    const s = await loadModule({ PORRIMA_DATA_DIR: dataDir, PORRIMA_KERNEL_STATS: "1" });
    for (let i = 0; i < 1005; i++) {
      s.recordKernelToolDispatch({ ...baseSample, cellId: `cell-${i}`, timestamp: 1_000_000 + i });
    }
    const samples = s.getKernelToolSamples(2000);
    expect(samples.length).toBe(1000);
    const ids = new Set(samples.map((x) => x.cellId));
    expect(ids.has("cell-1004")).toBe(true);
    expect(ids.has("cell-5")).toBe(true); // oldest survivor
    expect(ids.has("cell-4")).toBe(false); // pruned
    expect(ids.has("cell-0")).toBe(false);
  });

  it("clear empties the store", async () => {
    const s = await loadModule({ PORRIMA_DATA_DIR: dataDir, PORRIMA_KERNEL_STATS: "1" });
    s.recordKernelToolDispatch(baseSample);
    expect(s.getKernelToolSamples().length).toBe(1);
    s.clearKernelToolStats();
    expect(s.getKernelToolSamples().length).toBe(0);
    expect(s.getKernelToolAggregates()).toEqual([]);
  });
});
