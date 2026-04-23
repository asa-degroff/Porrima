import { useEffect, useState, useCallback } from "react";

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
}

interface ModelSummary {
  lastRun: LlamaTimingsEntry | null;
  avgPromptTokensPerSec: number | null;
  avgPredictedTokensPerSec: number | null;
  avgPromptMs: number | null;
  avgPredictedMs: number | null;
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
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

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <SpeedBar value={summary.avgPredictedTokensPerSec} maxRef={80} isDecode label="avg decode" />
          {last && (
            <SpeedBar value={last.predictedTokensPerSec} maxRef={80} isDecode label="last decode" />
          )}
        </div>
        <div className="space-y-1.5">
          <SpeedBar value={summary.avgPromptTokensPerSec} maxRef={200} isDecode={false} label="avg prefill" />
          {last && (
            <SpeedBar value={last.promptTokensPerSec} maxRef={200} isDecode={false} label="last prefill" />
          )}
        </div>
      </div>

      {last && (
        <div className="flex gap-4 text-[10px] text-white/30 pt-1 border-t border-white/5">
          <span>last: {formatTimeAgo(last.timestamp)}</span>
          <span>prefill: {formatDuration(last.promptMs)}</span>
          <span>decode: {formatDuration(last.predictedMs)}</span>
          <span>
            {last.promptTokens}p / {last.predictedTokens}d tokens
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

      <Section title="Last Run" defaultOpen>
        {summary.lastRun ? (
          <div className="space-y-1.5 text-[11px]">
            {(Object.entries({
              "Decode": `${summary.lastRun.predictedTokensPerSec.toFixed(1)} t/s`,
              "Prefill": `${summary.lastRun.promptTokensPerSec.toFixed(1)} t/s`,
              "Decode time": formatDuration(summary.lastRun.predictedMs),
              "Prefill time": formatDuration(summary.lastRun.promptMs),
              "Total time": formatDuration(summary.lastRun.totalMs),
              "Prompt tokens": summary.lastRun.promptTokens,
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
              </div>
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
  const [detailModelId, setDetailModelId] = useState<string | null>(null);
  const [detailData, setDetailData] = useState<ModelStatsDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

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

  useEffect(() => {
    if (isOpen) {
      fetchData();
      setDetailModelId(null);
    }
  }, [isOpen, fetchData]);

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
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-white/90">Model Stats</h2>
            <span className="text-[10px] text-white/30">{records.length} model{records.length !== 1 ? "s" : ""}</span>
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
          {detailModelId && detailData ? (
            <ModelDetail detail={detailData} onBack={() => setDetailModelId(null)} />
          ) : detailLoading ? (
            <div className="text-white/30 text-sm text-center py-8">Loading…</div>
          ) : records.length === 0 && !loading ? (
            <div className="p-8 text-center text-white/30 text-sm">
              No model stats recorded yet. Run at least one message through a llama.cpp model.
            </div>
          ) : (
            <div className="space-y-3">
              {records.map((record) => (
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
