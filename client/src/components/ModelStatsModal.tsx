import { useEffect, useState, useCallback } from "react";
import { getCacheResidency, type CacheResidency } from "../api/client";

// --- Types (aligned with server model-stats.ts) ---

interface LlamaTimingsEntry {
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

interface ModelSummary {
  lastRun: LlamaTimingsEntry | null;
  avgPromptTokensPerSec: number | null;
  avgPredictedTokensPerSec: number | null;
  avgPromptMs: number | null;
  avgPredictedMs: number | null;
  avgInferredCacheHitRatio: number | null;
  avgInferredCachedTokens: number | null;
  runCount: number;
}

interface ModelStatsRecord {
  modelId: string;
  provider: string;
  summary: ModelSummary;
}

interface ModelStatsDetail {
  modelId: string;
  provider: string;
  summary: ModelSummary;
  runs: LlamaTimingsEntry[];
}

// --- Reranker Stats Types (aligned with server reranker-stats.ts) ---

interface RerankerStatsRun {
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
  selectedResults?: Array<{ text: string; score: number }>;
}

interface RerankerStatsSummary {
  lastRun: RerankerStatsRun | null;
  runCount: number;
  modelRunCount: number;
  fallbackRunCount: number;
  modelSuccessRate: number | null;
  avgLatencyMs: number | null;
  avgModelLatencyMs: number | null;
  avgFallbackLatencyMs: number | null;
  avgDocumentCount: number | null;
  avgTotalTokens: number | null;
  avgScoreSpread: number | null;
  timeoutCount: number;
}

interface RerankerStatsData {
  summary: RerankerStatsSummary;
  runs: RerankerStatsRun[];
  timeoutMs?: number;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

// --- Helpers ---

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat().format(Math.round(n));
}

function formatPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${Math.round(n * 100)}%`;
}

function formatChars(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(1)}k chars`;
}

function truncateModelId(id: string): string {
  // llama.cpp model ids are often long file paths; show the basename
  const basename = id.replace(/^.*[\/\\]/, "");
  // Further shorten sha prefixes if present (e.g. "qwen3-35b-a3b-q4_k_m-00001-of-00004.gguf")
  const sha = basename.match(/^(.+?)-[0-9a-f]{8}-/);
  if (sha) return sha[1] + "…";
  if (basename.length > 35) return basename.slice(0, 35) + "…";
  return basename;
}

// Decode speed color: green is fast, red is slow
function speedColor(tokPerSec: number | null, isDecode = true): string {
  if (tokPerSec === null) return "text-white/30";
  const threshold = isDecode ? 30 : 100;
  if (tokPerSec >= threshold * 3) return "text-emerald-300";
  if (tokPerSec >= threshold * 1.5) return "text-emerald-400/80";
  if (tokPerSec >= threshold) return "text-amber-300";
  return "text-red-300/80";
}

// Speed bar width relative to a max reasonable value
function speedBarWidth(tokPerSec: number | null, maxRef: number): string {
  if (tokPerSec === null) return "w-0";
  const pct = Math.min(tokPerSec / maxRef * 100, 100);
  return `w-[${pct.toFixed(1)}%]`;
}

// --- Components ---

function Section({
  title,
  children,
  defaultOpen,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-white/40 hover:text-white/70 transition-colors"
      >
        <span>{open ? "▼" : "▶"}</span>
        <span>{title}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

function SpeedBar({ value, maxRef, isDecode, label }: { value: number | null; maxRef: number; isDecode: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-white/40 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${speedColor(value, isDecode)}`}
          style={{ width: value ? `${Math.min(value / maxRef * 100, 100)}%` : "0%" }}
        />
      </div>
      <span className={`text-[10px] w-16 text-right shrink-0 ${speedColor(value, isDecode)}`}>
        {value !== null ? `${value.toFixed(1)} t/s` : "—"}
      </span>
    </div>
  );
}

function CacheBar({ ratio, label }: { ratio: number | null | undefined; label: string }) {
  const pct = ratio != null ? Math.min(Math.max(ratio * 100, 0), 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-white/40 w-12 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full bg-cyan-300/70 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] w-16 text-right shrink-0 text-cyan-200/80">
        {formatPercent(ratio)}
      </span>
    </div>
  );
}

function ModelCard({
  record,
  onLoadDetail,
}: {
  record: ModelStatsRecord;
  onLoadDetail: (modelId: string) => void;
}) {
  const { summary } = record;
  const last = summary.lastRun;

  return (
    <div className="bg-white/5 rounded-lg p-3 space-y-2 border border-white/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-mono text-white/80 truncate">{truncateModelId(record.modelId)}</span>
          <span className="text-[10px] text-white/30 bg-white/5 px-1.5 py-0.5 rounded">{record.provider}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-white/30">{summary.runCount} run{summary.runCount !== 1 ? "s" : ""}</span>
          <button
            onClick={() => onLoadDetail(record.modelId)}
            className="text-[10px] text-purple-300/60 hover:text-purple-300 transition-colors"
          >
            expand →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
        <div>
          <div className="text-[10px] text-white/30">avg decode</div>
          <div className={`text-sm font-mono ${speedColor(summary.avgPredictedTokensPerSec)}`}>
            {summary.avgPredictedTokensPerSec !== null ? summary.avgPredictedTokensPerSec.toFixed(1) : "—"}
            <span className="text-[9px] text-white/20 ml-0.5">t/s</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-white/30">last decode</div>
          <div className={`text-sm font-mono ${speedColor(last?.predictedTokensPerSec ?? null)}`}>
            {last ? last.predictedTokensPerSec.toFixed(1) : "—"}
            <span className="text-[9px] text-white/20 ml-0.5">t/s</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-white/30">avg prefill</div>
          <div className={`text-sm font-mono ${speedColor(summary.avgPromptTokensPerSec, false)}`}>
            {summary.avgPromptTokensPerSec !== null ? summary.avgPromptTokensPerSec.toFixed(1) : "—"}
            <span className="text-[9px] text-white/20 ml-0.5">t/s</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-white/30">last prefill</div>
          <div className={`text-sm font-mono ${speedColor(last?.promptTokensPerSec ?? null, false)}`}>
            {last ? last.promptTokensPerSec.toFixed(1) : "—"}
            <span className="text-[9px] text-white/20 ml-0.5">t/s</span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] pt-1 border-t border-white/5">
        <div className="flex items-center gap-1.5">
          <span className="text-white/40">cache prompt</span>
          <span className={last?.cachePrompt ? "text-cyan-200/80" : "text-white/30"}>
            {last?.cachePrompt ? "enabled" : "not recorded"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-white/40">avg hit</span>
          <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full bg-cyan-300/70"
              style={{ width: summary.avgInferredCacheHitRatio != null ? `${Math.round(summary.avgInferredCacheHitRatio * 100)}%` : "0%" }}
            />
          </div>
          <span className="text-cyan-200/80 font-mono">{formatPercent(summary.avgInferredCacheHitRatio)}</span>
        </div>
      </div>

      {last && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-white/30 pt-1 border-t border-white/5">
          <span>last: {formatTimeAgo(last.timestamp)}</span>
          <span>prefill: {formatDuration(last.promptMs)}</span>
          <span>decode: {formatDuration(last.predictedMs)}</span>
          <span>
            {last.promptTokens}p / {last.predictedTokens}d tokens
          </span>
          <span>
            cache: {formatNumber(last.inferredCachedTokens)}
          </span>
        </div>
      )}
    </div>
  );
}

function ModelDetail({
  detail,
  onBack,
}: {
  detail: ModelStatsDetail;
  onBack: () => void;
}) {
  const { summary, runs } = detail;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="text-[10px] text-purple-300/60 hover:text-purple-300 transition-colors"
        >
          ← back
        </button>
        <span className="text-sm font-mono text-white/80">{truncateModelId(detail.modelId)}</span>
      </div>

      <Section title={`Averages (${summary.runCount} runs)`} defaultOpen>
        <div className="space-y-2">
          <SpeedBar value={summary.avgPredictedTokensPerSec} maxRef={80} isDecode label="decode EMA" />
          <SpeedBar value={summary.avgPromptTokensPerSec} maxRef={200} isDecode={false} label="prefill EMA" />
          {summary.avgPredictedMs !== null && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-white/40 w-12 shrink-0">dec/ms</span>
              <span className="text-[10px] text-white/60">{summary.avgPredictedMs.toFixed(1)}ms avg</span>
            </div>
          )}
        </div>
      </Section>

      <Section title="Cache" defaultOpen>
        <div className="space-y-2">
          <CacheBar ratio={summary.avgInferredCacheHitRatio} label="hit EMA" />
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            <div className="flex justify-between gap-2">
              <span className="text-white/40">Avg cached</span>
              <span className="text-white/70 font-mono">{formatNumber(summary.avgInferredCachedTokens)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-white/40">Last cached</span>
              <span className="text-white/70 font-mono">{formatNumber(summary.lastRun?.inferredCachedTokens)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-white/40">Last hit</span>
              <span className="text-white/70 font-mono">{formatPercent(summary.lastRun?.inferredCacheHitRatio)}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-white/40">Mode</span>
              <span className="text-white/70 font-mono">{summary.lastRun?.cacheMode ?? "—"}</span>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Last Run" defaultOpen>
        {summary.lastRun ? (
          <div className="space-y-1.5 text-[11px]">
            {(Object.entries({
              "Decode": `${summary.lastRun.predictedTokensPerSec.toFixed(1)} t/s`,
              "Prefill": `${summary.lastRun.promptTokensPerSec.toFixed(1)} t/s`,
              "Decode time": formatDuration(summary.lastRun.predictedMs),
              "Prefill time": formatDuration(summary.lastRun.promptMs),
              "Total time": formatDuration(summary.lastRun.totalMs),
              "Prompt eval tokens": summary.lastRun.promptTokens,
              "Reported prompt tokens": formatNumber(summary.lastRun.reportedPromptTokens),
              "Inferred cached tokens": formatNumber(summary.lastRun.inferredCachedTokens),
              "Inferred cache hit": formatPercent(summary.lastRun.inferredCacheHitRatio),
              "Cache prompt": summary.lastRun.cachePrompt ? "enabled" : "disabled/not recorded",
              "Request messages": formatNumber(summary.lastRun.requestMessageCount),
              "Request size": formatChars(summary.lastRun.requestCharCount),
              "Request digest": summary.lastRun.requestDigest || "n/a",
              "Predicted tokens": summary.lastRun.predictedTokens,
            }) as [string, string][]).map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-white/40">{k}</span>
                <span className="text-white/70 font-mono">{v}</span>
              </div>
            ))}
            <div className="text-white/30 pt-1">Run: {formatTimeAgo(summary.lastRun.timestamp)}</div>
          </div>
        ) : (
          <div className="text-white/30 text-xs">No data</div>
        )}
      </Section>

      <Section title={`Run History (${runs.length})`}>
        {runs.length === 0 ? (
          <div className="text-white/30 text-xs">No runs recorded</div>
        ) : (
          <div className="space-y-1">
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex items-center gap-2 text-[10px] py-1 px-2 rounded hover:bg-white/5"
              >
                <span className="text-white/30 w-14 shrink-0">{formatTimeAgo(run.timestamp)}</span>
                <span className={`w-20 shrink-0 font-mono ${speedColor(run.predictedTokensPerSec)}`}>
                  {run.predictedTokensPerSec.toFixed(1)} t/s
                </span>
                <span className={`w-20 shrink-0 font-mono ${speedColor(run.promptTokensPerSec, false)}`}>
                  {run.promptTokensPerSec.toFixed(1)} t/s
                </span>
                <span className="text-white/30 w-14 shrink-0">{formatDuration(run.predictedMs)}</span>
                <span className="text-white/30 w-14 shrink-0">{formatDuration(run.promptMs)}</span>
                <span className="text-white/30 shrink-0">
                  {run.promptTokens}p / {run.predictedTokens}d
                </span>
                <span className="text-cyan-200/60 shrink-0">
                  {formatNumber(run.inferredCachedTokens)} cached
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// --- Reranker Stats Panel ---

function rerankerSuccessColor(rate: number | null): string {
  if (rate === null) return "text-white/30";
  if (rate >= 0.95) return "text-emerald-300";
  if (rate >= 0.8) return "text-emerald-400/80";
  if (rate >= 0.6) return "text-amber-300";
  return "text-red-300";
}

function latencyColor(ms: number, timeoutMs: number): string {
  const ratio = ms / timeoutMs;
  if (ratio < 0.5) return "text-emerald-300";
  if (ratio < 0.7) return "text-emerald-400/80";
  if (ratio < 0.85) return "text-amber-300";
  if (ratio < 0.95) return "text-red-300/80";
  return "text-red-400";
}

function scoreSpreadLabel(spread: number | null): { text: string; color: string } {
  // scoreSpread = scoreMax - scoreMedian. Model runs produce wide spreads (0.5+).
  // Fallback runs produce near-zero spreads (flat scores like 0.04–1.0 / 0.077).
  if (spread === null) return { text: "—", color: "text-white/30" };
  if (spread >= 0.5) return { text: "high", color: "text-emerald-300" };
  if (spread >= 0.2) return { text: "medium", color: "text-amber-300" };
  return { text: "low", color: "text-red-300/80" };
}

function formatRerankerSource(source: string | undefined): string {
  if (source === "passive-memory") return "passive";
  if (source === "memory-context") return "memory";
  return source || "memory";
}

function RerankerRunRow({ run, timeoutMs }: { run: RerankerStatsRun; timeoutMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasQuery = !!run.query;
  const hasDocs = !!run.documents && run.documents.length > 0;
  const hasSelected = !!run.selectedResults && run.selectedResults.length > 0;
  const hasPeek = hasQuery || hasDocs || hasSelected;

  return (
    <div className="border-b border-white/5 last:border-b-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-[10px] py-1.5 px-2 rounded w-full hover:bg-white/5 text-left"
      >
        <span className="text-white/30 w-14 shrink-0">{formatTimeAgo(run.timestamp)}</span>
        <span className={`w-10 shrink-0 font-mono ${run.usedModel ? "text-emerald-300" : "text-red-300/70"}`}>
          {run.usedModel ? "model" : "fall"}
        </span>
        <span className={`w-14 shrink-0 font-mono ${latencyColor(run.latencyMs, timeoutMs)}`}>
          {formatDuration(run.latencyMs)}
        </span>
        <span className="text-white/30 w-10 shrink-0">{run.documentCount}doc</span>
        <span className="text-white/30 w-16 shrink-0">{run.totalTokens.toLocaleString()}tok</span>
        <span className="text-white/35 w-14 shrink-0">{formatRerankerSource(run.source)}</span>
        <span className="text-white/40 shrink-0">
          {run.scoreMin.toFixed(3)}–{run.scoreMax.toFixed(3)}
        </span>
        {hasSelected && (
          <span className="text-emerald-300/50 shrink-0">
            {run.selectedResults?.length} injected
          </span>
        )}
        {hasPeek && (
          <span className="text-purple-300/40 ml-auto shrink-0">
            {expanded ? "▾ hide" : "▸ peek"}
          </span>
        )}
      </button>

      {expanded && hasPeek && (
        <div className="px-3 pb-2 space-y-2">
          {run.query && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-white/30 mb-1">Formatted query sent to model</div>
              <pre className="bg-black/30 rounded p-2 text-[11px] text-white/70 font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto leading-relaxed">
                {run.query}
              </pre>
            </div>
          )}
          {run.documents && run.documents.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-white/30 mb-1">
                Documents ({run.documents.length})
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {run.documents.map((doc, i) => (
                  <div key={i} className="bg-black/20 rounded p-2 text-[10px] text-white/50 font-mono leading-relaxed">
                    <span className="text-purple-300/50 select-none">[{i + 1}] </span>
                    {doc.slice(0, 800)}
                    {doc.length > 800 ? "…" : ""}
                  </div>
                ))}
              </div>
            </div>
          )}
          {run.selectedResults && run.selectedResults.length > 0 && (
            <div>
              <div className="text-[9px] uppercase tracking-wider text-emerald-300/40 mb-1">
                Selected for injection ({run.selectedResults.length})
              </div>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {run.selectedResults.map((result, i) => (
                  <div key={i} className="bg-emerald-900/10 border border-emerald-500/10 rounded p-2 text-[10px] text-emerald-200/60 font-mono leading-relaxed">
                    <span className="text-emerald-400/50 select-none">[{result.score.toFixed(3)}] </span>
                    {result.text.slice(0, 600)}
                    {result.text.length > 600 ? "…" : ""}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RerankerStatsPanel({ data }: { data: RerankerStatsData }) {
  const { summary, runs } = data;
  const last = summary.lastRun;
  const timeoutMs = data.timeoutMs ?? 25_000;

  return (
    <div className="space-y-3">
      {/* Health overview */}
      <div className="bg-white/5 rounded-lg p-3 border border-white/5 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
          <div>
            <div className="text-[10px] text-white/30">model success</div>
            <div className={`text-lg font-mono ${rerankerSuccessColor(summary.modelSuccessRate)}`}>
              {summary.modelSuccessRate !== null ? `${(summary.modelSuccessRate * 100).toFixed(0)}%` : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-white/30">avg latency</div>
            <div className={`text-lg font-mono ${latencyColor(summary.avgLatencyMs ?? 0, timeoutMs)}`}>
              {summary.avgLatencyMs !== null ? formatDuration(summary.avgLatencyMs) : "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-white/30">timeouts</div>
            <div className={`text-lg font-mono ${summary.timeoutCount > 0 ? "text-red-300" : "text-white/30"}`}>
              {summary.timeoutCount}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-white/30">score quality</div>
            <div className={`text-lg font-mono ${scoreSpreadLabel(summary.avgScoreSpread).color}`}>
              {scoreSpreadLabel(summary.avgScoreSpread).text}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] pt-1 border-t border-white/5">
          <span className="text-white/30">
            {summary.modelRunCount} model / {summary.fallbackRunCount} fallback
          </span>
          <span className="text-white/30">
            avg model: {formatDuration(summary.avgModelLatencyMs ?? 0)}
          </span>
          <span className="text-white/30">
            avg fallback: {formatDuration(summary.avgFallbackLatencyMs ?? 0)}
          </span>
        </div>
      </div>

      {/* Latency bar */}
      <Section title="Latency" defaultOpen>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 w-14 shrink-0">model</span>
            <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${latencyColor(summary.avgModelLatencyMs ?? 0, timeoutMs)}`}
                style={{ width: summary.avgModelLatencyMs != null ? `${Math.min(summary.avgModelLatencyMs / timeoutMs * 100, 100)}%` : "0%" }}
              />
            </div>
            <span className={`text-[10px] w-20 text-right shrink-0 font-mono ${latencyColor(summary.avgModelLatencyMs ?? 0, timeoutMs)}`}>
              {formatDuration(summary.avgModelLatencyMs ?? 0)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 w-14 shrink-0">fallback</span>
            <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-300 ${latencyColor(summary.avgFallbackLatencyMs ?? 0, timeoutMs)}`}
                style={{ width: summary.avgFallbackLatencyMs != null ? `${Math.min(summary.avgFallbackLatencyMs / timeoutMs * 100, 100)}%` : "0%" }}
              />
            </div>
            <span className={`text-[10px] w-20 text-right shrink-0 font-mono ${latencyColor(summary.avgFallbackLatencyMs ?? 0, timeoutMs)}`}>
              {formatDuration(summary.avgFallbackLatencyMs ?? 0)}
            </span>
          </div>
          {/* Timeout threshold marker */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 w-14 shrink-0">timeout</span>
            <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-red-400/40" style={{ width: "100%" }} />
            </div>
            <span className="text-[10px] w-20 text-right shrink-0 font-mono text-red-300/60">
              {Math.round(timeoutMs / 1000)}s
            </span>
          </div>
        </div>
      </Section>

      {/* Throughput & scores */}
      <Section title="Per-Run Metrics" defaultOpen>
        <div className="space-y-1.5">
          {(Object.entries({
            "Avg documents": `${summary.avgDocumentCount !== null ? summary.avgDocumentCount.toFixed(0) : "—"} per call`,
            "Avg tokens": `${summary.avgTotalTokens !== null ? Math.round(summary.avgTotalTokens).toLocaleString() : "—"} prompt`,
            "Avg score spread": scoreSpreadLabel(summary.avgScoreSpread).text,
            "Last run": last ? (last.usedModel ? "model" : "fallback") : "—",
            "Last latency": last ? formatDuration(last.latencyMs) : "—",
            "Last docs/tokens": last ? `${last.documentCount} / ${last.totalTokens.toLocaleString()}` : "—",
            "Last scores": last ? `${last.scoreMin.toFixed(4)} – ${last.scoreMax.toFixed(4)} (med: ${last.scoreMedian.toFixed(4)})` : "—",
            "Last chat type": last ? last.chatType : "—",
            "Last source": last ? formatRerankerSource(last.source) : "—",
          }) as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex justify-between text-[11px]">
              <span className="text-white/40">{k}</span>
              <span className="text-white/70 font-mono">{v}</span>
            </div>
          ))}
          {last && (
            <div className="text-white/30 pt-1 text-[10px]">Run: {formatTimeAgo(last.timestamp)}</div>
          )}
        </div>
      </Section>

      {/* Run history */}
      <Section title={`Run History (${runs.length})`}>
        {runs.length === 0 ? (
          <div className="text-white/30 text-xs">No runs recorded</div>
        ) : (
          <div className="space-y-0">
            {runs.map((run) => (
              <RerankerRunRow key={run.id} run={run} timeoutMs={timeoutMs} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// --- Main Modal ---

export function ModelStatsModal({ isOpen, onClose }: Props) {
  const [records, setRecords] = useState<ModelStatsRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"chat" | "extraction" | "reranker" | "cache">("chat");
  const [detailModelId, setDetailModelId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<ModelStatsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [cacheResidency, setCacheResidency] = useState<CacheResidency[]>([]);
  const [cacheLoading, setCacheLoading] = useState(false);
  const [rerankerData, setRerankerData] = useState<RerankerStatsData | null>(null);
  const [rerankerLoading, setRerankerLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/model-stats", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setRecords(data);
      }
    } catch (err) {
      console.error("[model-stats] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (modelId: string) => {
    setDetailModelId(modelId);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/model-stats/${encodeURIComponent(modelId)}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setDetailData(data);
      }
    } catch (err) {
      console.error("[model-stats] detail fetch failed:", err);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const fetchCacheResidency = useCallback(async () => {
    setCacheLoading(true);
    try {
      const data = await getCacheResidency();
      setCacheResidency(data);
    } catch {
      setCacheResidency([]);
    } finally {
      setCacheLoading(false);
    }
  }, []);

  const fetchRerankerStats = useCallback(async () => {
    setRerankerLoading(true);
    try {
      const res = await fetch("/api/reranker-stats", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setRerankerData(data);
      }
    } catch (err) {
      console.error("[reranker-stats] fetch failed:", err);
    } finally {
      setRerankerLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchData();
      fetchCacheResidency();
      fetchRerankerStats();
      setDetailModelId(null);
      setActiveTab("chat");
    }
  }, [isOpen, fetchData, fetchCacheResidency, fetchRerankerStats]);

  // Filter records by tab: extraction models have provider containing "extraction"
  const filteredRecords = records.filter((r) => {
    const isExtraction = r.provider.toLowerCase().includes("extraction");
    return activeTab === "extraction" ? isExtraction : !isExtraction;
  });

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center flex-wrap gap-2">
            <h2 className="text-sm font-medium text-white/90">Model Stats & Cache</h2>
            <div className="flex items-center bg-white/5 rounded-lg p-0.5">
              <button
                onClick={() => { setActiveTab("chat"); setDetailModelId(null); }}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${activeTab === "chat" ? "bg-purple-500/30 text-purple-200" : "text-white/30 hover:text-white/60"}`}
              >
                Chat
              </button>
              <button
                onClick={() => { setActiveTab("extraction"); setDetailModelId(null); }}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${activeTab === "extraction" ? "bg-purple-500/30 text-purple-200" : "text-white/30 hover:text-white/60"}`}
              >
                Extraction
              </button>
              <button
                onClick={() => { setActiveTab("reranker"); setDetailModelId(null); fetchRerankerStats(); }}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${activeTab === "reranker" ? "bg-purple-500/30 text-purple-200" : "text-white/30 hover:text-white/60"}`}
              >
                Reranker
              </button>
              <button
                onClick={() => { setActiveTab("cache"); setDetailModelId(null); fetchCacheResidency(); }}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${activeTab === "cache" ? "bg-purple-500/30 text-purple-200" : "text-white/30 hover:text-white/60"}`}
              >
                Cache
              </button>
            </div>
            <span className="text-[10px] text-white/30">{activeTab === "cache" ? `${cacheResidency.length} tracked` : activeTab === "reranker" ? `${rerankerData?.summary.runCount ?? 0} runs` : `${filteredRecords.length} model${filteredRecords.length !== 1 ? "s" : ""}`}</span>
          </div>
          <div className="flex items-center gap-2">
            {loading && <span className="text-[10px] text-amber-300/60">loading…</span>}
            <button
              onClick={onClose}
              className="p-1 text-white/40 hover:text-white/80 transition-colors"
              title="Close"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === "reranker" ? (
            rerankerLoading ? (
              <div className="text-white/30 text-sm text-center py-8">Loading…</div>
            ) : !rerankerData || rerankerData.summary.runCount === 0 ? (
              <div className="p-8 text-center text-white/30 text-sm">
                No reranker stats recorded yet. Reranker stats are captured during memory retrieval.
              </div>
            ) : (
              <RerankerStatsPanel data={rerankerData} />
            )
          ) : activeTab === "cache" ? (
            cacheLoading ? (
              <div className="text-white/30 text-sm text-center py-8">Loading…</div>
            ) : cacheResidency.length === 0 ? (
              <div className="p-8 text-center text-white/30 text-sm">
                No observed warm prompt-cache entries yet. Warmth is recorded after a llama.cpp turn completes.
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-[10px] text-white/30 mb-2">
                  Observed llama.cpp prompt-cache residency. Auto mode does not enforce physical slot ownership.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-white/30 text-left">
                        <th className="pb-2 pr-4 font-normal">Chat</th>
                        <th className="pb-2 pr-4 font-normal">Mode</th>
                        <th className="pb-2 pr-4 font-normal">Model</th>
                        <th className="pb-2 pr-4 font-normal">Hit</th>
                        <th className="pb-2 font-normal">Last Used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cacheResidency.map((a) => (
                        <tr key={a.chatId} className="border-t border-white/5">
                          <td className="py-1.5 pr-4">
                            <span className="text-white/70 font-mono">{a.chatId.slice(0, 8)}…</span>
                          </td>
                          <td className="py-1.5 pr-4">
                            <span className="text-amber-300/90 font-mono">
                              {typeof a.slotId === "number" ? `slot ${a.slotId}` : a.bindingMode}
                            </span>
                          </td>
                          <td className="py-1.5 pr-4">
                            <span className="text-white/50">{truncateModelId(a.modelId)}</span>
                          </td>
                          <td className="py-1.5 pr-4">
                            <span className={`inline-flex items-center gap-1 ${a.active ? "text-amber-300/80" : "text-white/40"}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${a.active ? "bg-amber-400/90" : "bg-amber-400/50"}`} />
                              {typeof a.inferredCacheHitRatio === "number"
                                ? `${(a.inferredCacheHitRatio * 100).toFixed(1)}%`
                                : a.confidence}
                            </span>
                          </td>
                          <td className="py-1.5">
                            <span className="text-white/30">{formatTimeAgo(a.lastUsedAt)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          ) : detailModelId && detailData ? (
            <ModelDetail detail={detailData} onBack={() => setDetailModelId(null)} />
          ) : detailLoading ? (
            <div className="text-white/30 text-sm text-center py-8">Loading…</div>
          ) : filteredRecords.length === 0 && !loading ? (
            <div className="p-8 text-center text-white/30 text-sm">
              {activeTab === "extraction"
                ? "No extraction model stats recorded yet. Configure an extraction model to start tracking."
                : "No model stats recorded yet. Run at least one message through a llama.cpp model."}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRecords.map((record) => (
                <ModelCard
                  key={record.modelId}
                  record={record}
                  onLoadDetail={loadDetail}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
