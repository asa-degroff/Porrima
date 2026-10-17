/**
 * readout-kernel-density.ts — the §4.9 density readout protocol, computed.
 * (docs/design/kernel-codemode.md §4.9 "Density readout protocol"; the
 * code_search claim under test comes from code-search.md §3.3/§4.2.)
 *
 * Read-only: porrima.db `kernel_tool_stats` for kernel-origin dispatches,
 * app.db chat rows for the model-level counterpart and the run_python
 * checklist. No LLM calls, no chat writes, no GPU. Prints the protocol's
 * frozen questions with the pre-declared verdict shapes — it reports, it
 * does not judge; substitution (Q1's second half) stays the transcript
 * pass this readout only schedules.
 *
 * Usage (from server/):
 *   npx tsx src/scripts/readout-kernel-density.ts [--days 7] [--tool code_search] [--json]
 */
import Database from "better-sqlite3";
import { appDataPath } from "../services/paths.js";

const argv = process.argv.slice(2);
const valOf = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const days = Math.max(1, Number(valOf("days", "7")) || 7);
const tool = valOf("tool", "code_search");
const asJson = argv.includes("--json");
const since = Date.now() - days * 86_400_000;

interface Sample {
  timestamp: number; chat_id: string; cell_id: string; outcome: string;
  duration_ms: number; value_chars: number; args_chars: number;
  spilled: number; truncated: number; structured: number; detail: string | null;
}

const pct = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const when = (ms: number): string => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

// --- kernel side -----------------------------------------------------------
let rows: Sample[] = [];
let tableRows = 0;
try {
  const stats = new Database(appDataPath("porrima.db"), { readonly: true });
  tableRows = (stats.prepare("SELECT COUNT(*) AS n FROM kernel_tool_stats").get() as { n: number }).n;
  rows = stats.prepare(
    "SELECT timestamp, chat_id, cell_id, outcome, duration_ms, value_chars, args_chars," +
    " spilled, truncated, structured, detail FROM kernel_tool_stats" +
    " WHERE tool = ? AND timestamp >= ? ORDER BY timestamp ASC",
  ).all(tool, since) as Sample[];
  stats.close();
} catch (e: any) {
  console.log(`kernel_tool_stats unreadable: ${e?.message ?? e}`);
}

// Q1 — chain depth + signature shape (detail tag: `snippet|scan pat:<hex8>`)
const cells = new Map<string, Sample[]>();
for (const r of rows) {
  const key = `${r.chat_id}|${r.cell_id}`;
  const list = cells.get(key);
  if (list) list.push(r); else cells.set(key, [r]);
}
interface CellReport {
  cell: string; dispatches: number; hasSnippet: boolean; distinctPatterns: number; fires: boolean;
}
const cellReports: CellReport[] = [];
for (const [cell, list] of cells) {
  const oks = list.filter((r) => r.outcome === "ok");
  const pats = new Set<string>();
  let hasSnippet = false;
  for (const r of oks) {
    const m = /^(snippet|scan) pat:([0-9a-f]{8}|-)$/.exec(r.detail ?? "");
    if (!m) continue;
    if (m[1] === "snippet") hasSnippet = true;
    if (m[2] !== "-") pats.add(m[2]);
  }
  const fires = list.length >= 2 && hasSnippet && pats.size >= 2;
  cellReports.push({ cell, dispatches: list.length, hasSnippet, distinctPatterns: pats.size, fires });
}
const depths = cellReports.map((c) => c.dispatches);
const medianDepth = depths.length ? pct(depths, 0.5) : 0;
const hist = new Map<number, number>();
for (const d of depths) hist.set(d, (hist.get(d) ?? 0) + 1);
const firing = cellReports.filter((c) => c.fires);

// Q3 — wire-shape health
const outcomes = new Map<string, number>();
for (const r of rows) outcomes.set(r.outcome, (outcomes.get(r.outcome) ?? 0) + 1);
const oks = rows.filter((r) => r.outcome === "ok");
const durations = oks.map((r) => r.duration_ms);
const bad = rows.filter((r) => r.outcome !== "ok").slice(0, 10);

// --- model side (app.db) -----------------------------------------------------
let modelCalls = 0;
let modelChats = 0;
const runPython: Map<string, { title: string; calls: number }> = new Map();
try {
  const app = new Database(appDataPath("app.db"), { readonly: true });
  const hit = app.prepare(
    "SELECT c.id AS chatId, c.title AS title, m.payload_json AS pj FROM chat_message_rows m" +
    " JOIN chats c ON c.id = m.chat_id" +
    " WHERE m.role = 'assistant' AND m.timestamp >= ? AND c.title NOT LIKE 'eval[%'",
  ).all(since) as { chatId: string; title: string; pj: string }[];
  const toolChats = new Set<string>();
  for (const row of hit) {
    let calls: { name?: string }[] = [];
    try {
      const msg = JSON.parse(row.pj);
      calls = Array.isArray(msg.toolCalls) ? msg.toolCalls : [];
    } catch { continue; }
    const t = calls.filter((c) => c.name === tool).length;
    if (t > 0) {
      modelCalls += t;
      toolChats.add(row.chatId);
    }
    const rp = calls.filter((c) => c.name === "run_python").length;
    if (rp > 0) {
      const e = runPython.get(row.chatId) ?? { title: row.title, calls: 0 };
      e.calls += rp;
      runPython.set(row.chatId, e);
    }
  }
  modelChats = toolChats.size;
  app.close();
} catch (e: any) {
  console.log(`app.db unreadable: ${e?.message ?? e}`);
}

// --- verdict shapes (pre-declared in §4.9; reported, not judged) -------------
const shapeA = medianDepth >= 2 && firing.length > 0;
const shapeB = modelCalls > 0 && rows.length === 0;
const shapeC = modelCalls === 0 && rows.length === 0;

const report = {
  window: { days, since, tool, coverage: rows.length ? { first: rows[0].timestamp, last: rows[rows.length - 1].timestamp } : null },
  q1: {
    kernelDispatches: rows.length, cells: cellReports.length,
    depthHistogram: Object.fromEntries([...hist].sort(([a], [b]) => a - b)),
    medianDepth, cellsGe2: cellReports.filter((c) => c.dispatches >= 2).length,
    signatureCells: firing.length, examples: firing.slice(0, 5).map((c) => c.cell),
  },
  q3: {
    outcomes: Object.fromEntries(outcomes),
    durationMs: { p50: pct(durations, 0.5), p90: pct(durations, 0.9), max: durations.length ? Math.max(...durations) : 0 },
    spilled: oks.filter((r) => r.spilled).length,
    truncated: oks.filter((r) => r.truncated).length,
    structuredShare: oks.length ? oks.filter((r) => r.structured).length / oks.length : 0,
    nonOkSamples: bad.map((r) => ({ ts: r.timestamp, outcome: r.outcome, detail: r.detail })),
  },
  q2: { modelSide: { calls: modelCalls, chats: modelChats }, runPythonChecklist: [...runPython].sort((a, b) => b[1].calls - a[1].calls).slice(0, 10) },
  verdictShapes: { a_density: shapeA, b_discoverability: shapeB, c_dark: shapeC },
  rotationWarning: tableRows >= 1000,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const hr = "-".repeat(72);
console.log(`density readout — ${tool} — window ${days}d (since ${when(since)})`);
console.log(hr);
console.log("Q1 — chain depth (per chat+cell)");
console.log(`  kernel dispatches in window: ${rows.length} across ${cellReports.length} cells` +
  (rows.length ? ` (coverage ${when(rows[0].timestamp)} → ${when(rows[rows.length - 1].timestamp)})` : ""));
console.log(`  depth histogram (dispatches→cells): ${JSON.stringify(report.q1.depthHistogram)}  median=${medianDepth}`);
console.log(`  cells ≥2 dispatches: ${report.q1.cellsGe2} | signature cells (snippet+refined pat): ${firing.length}` +
  (firing.length ? `\n  firing: ${firing.slice(0, 5).map((c) => c.cell.slice(0, 26)).join(", ")}` : ""));
if (rows.length === 0) console.log("  (no kernel dispatches — chain stats vacuous)");
console.log(hr);
console.log("Q2 — model level (app.db; substitution itself is the transcript pass)");
console.log(`  model-level ${tool} calls: ${modelCalls} in ${modelChats} chats`);
console.log(`  run_python checklist (top ${Math.min(10, runPython.size)} chats for the qualitative pass):`);
for (const [id, e] of [...runPython].sort((a, b) => b[1].calls - a[1].calls).slice(0, 10)) {
  console.log(`    ${id.slice(0, 8)}  ${String(e.calls).padStart(3)}×  ${e.title.slice(0, 46)}`);
}
if (runPython.size === 0) console.log("    (none)");
console.log(hr);
console.log("Q3 — wire-shape health");
console.log(`  outcomes: ${JSON.stringify(report.q3.outcomes)}`);
console.log(`  durations ms: p50=${report.q3.durationMs.p50} p90=${report.q3.durationMs.p90} max=${report.q3.durationMs.max} (measured ~50/scan expected)`);
console.log(`  ok samples: spilled=${report.q3.spilled} truncated=${report.q3.truncated} structured=${(report.q3.structuredShare * 100).toFixed(0)}%`);
for (const b of report.q3.nonOkSamples) console.log(`    ${when(b.ts)} ${b.outcome}: ${(b.detail ?? "").slice(0, 70)}`);
console.log(hr);
console.log("verdict shapes (§4.9 pre-declared — reported, not judged)");
console.log(`  (a) density fires:            ${shapeA ? "MATCH" : "no  "} — needs medianDepth≥2 + signature cells`);
console.log(`  (b) discoverability gap:      ${shapeB ? "MATCH" : "no  "} — model alive, kernel dark`);
console.log(`  (c) both dark:                ${shapeC ? "MATCH" : "no  "} — window has no adoption either side`);
if (report.rotationWarning) console.log("  WARNING: stats table at 1000-row cap — history may have rotated; dump mid-window");
console.log(hr);
process.exit(0);
