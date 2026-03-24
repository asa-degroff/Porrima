import { useEffect, useRef, useState, useCallback } from "react";
import {
  fetchDirections,
  executeCorpusDirection,
  type CorpusDirection,
} from "../api/client";

interface CorpusViewProps {
  onOpenCluster?: (clusterId: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  remix: "bg-purple-500/20 text-purple-300",
  explore: "bg-blue-500/20 text-blue-300",
  deepen: "bg-emerald-500/20 text-emerald-300",
  contrast: "bg-amber-500/20 text-amber-300",
  "gap-fill": "bg-rose-500/20 text-rose-300",
};

export default function CorpusView({ onOpenCluster }: CorpusViewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{
    total: number;
    enriched: number;
    clusters: number;
    topThemes: Array<{ theme: string; count: number }>;
  } | null>(null);

  // Directions state
  const [directionsOpen, setDirectionsOpen] = useState(false);
  const [directions, setDirections] = useState<CorpusDirection[]>([]);
  const [loadingDirections, setLoadingDirections] = useState(false);
  const [directionsFetched, setDirectionsFetched] = useState(false);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);
  const resultTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch stats
  useEffect(() => {
    fetch("/api/corpus/stats", { credentials: "include" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch stats");
        return res.json();
      })
      .then((data) => {
        setStats(data);
      })
      .catch((err) => {
        console.error("[corpus] stats error:", err);
        setError("Failed to load corpus stats");
        setLoading(false);
      });
  }, []);

  // Load visualization in iframe
  useEffect(() => {
    if (!iframeRef.current) return;

    const iframe = iframeRef.current;
    iframe.src = "/api/corpus/visualization";

    const handleLoad = () => {
      setLoading(false);
    };
    iframe.addEventListener("load", handleLoad);

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "corpus-node-click") {
        const { clusterId, imageId } = event.data.payload;
        console.log("[corpus] node clicked:", { clusterId, imageId });
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      iframe.removeEventListener("load", handleLoad);
      window.removeEventListener("message", handleMessage);
    };
  }, []);

  // Fetch directions, polling if a background job is running
  const loadDirections = useCallback(async (refresh = false) => {
    setLoadingDirections(true);
    try {
      const data = await fetchDirections(refresh);

      if (data.directions.length > 0) {
        setDirections(data.directions);
        setDirectionsFetched(true);
        setLoadingDirections(false);
        return;
      }

      // If a job is running, poll every 5s until it completes
      if (data.jobRunning) {
        const poll = async () => {
          try {
            const check = await fetchDirections(false);
            if (check.directions.length > 0) {
              setDirections(check.directions);
              setLoadingDirections(false);
              setDirectionsFetched(true);
            } else if (check.jobRunning) {
              setTimeout(poll, 5000);
            } else {
              // Job finished but no directions
              setLoadingDirections(false);
              setDirectionsFetched(true);
            }
          } catch {
            setLoadingDirections(false);
            setDirectionsFetched(true);
          }
        };
        setTimeout(poll, 5000);
        return;
      }

      // No directions and no job — nothing to do
      setDirectionsFetched(true);
      setLoadingDirections(false);
    } catch (err: any) {
      console.error("[corpus] directions error:", err);
      setLoadingDirections(false);
      setDirectionsFetched(true);
    }
  }, []);

  // Load directions once when panel opens
  useEffect(() => {
    if (directionsOpen && !directionsFetched && !loadingDirections) {
      loadDirections();
    }
  }, [directionsOpen, directionsFetched, loadingDirections, loadDirections]);

  // Execute a direction
  const handleExecute = useCallback(async (directionId: string) => {
    setExecutingId(directionId);
    setResult(null);
    if (resultTimeout.current) clearTimeout(resultTimeout.current);

    try {
      const res = await executeCorpusDirection(directionId);
      if (res.success) {
        setResult({ success: true, message: `Image generated: ${res.imageId?.slice(0, 8)}...` });
      } else {
        setResult({ success: false, message: res.error || "Generation failed" });
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message });
    } finally {
      setExecutingId(null);
      resultTimeout.current = setTimeout(() => setResult(null), 8000);
    }
  }, []);

  // Cleanup timeout
  useEffect(() => {
    return () => {
      if (resultTimeout.current) clearTimeout(resultTimeout.current);
    };
  }, []);

  if (error) {
    return (
      <div className="w-full p-8 text-center text-red-400">
        <div>{error}</div>
        <button
          onClick={() => {
            setLoading(true);
            setError(null);
          }}
          className="mt-4 px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* Stats bar */}
      {stats && (
        <div className="flex items-center gap-6 px-4 py-3 bg-slate-900/50 border-b border-slate-700/50">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-sm">Images:</span>
            <span className="text-emerald-400 font-semibold">{stats.total}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-sm">Clusters:</span>
            <span className="text-purple-400 font-semibold">{stats.clusters}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 text-sm">Enriched:</span>
            <span className="text-blue-400 font-semibold">{stats.enriched}/{stats.total}</span>
          </div>
          {stats.topThemes?.length > 0 && (
            <div className="hidden lg:flex items-center gap-3">
              <span className="text-slate-400 text-sm">Top themes:</span>
              {stats.topThemes.slice(0, 5).map(({ theme, count }) => (
                <span
                  key={theme}
                  className="px-2 py-1 bg-slate-800 rounded text-xs text-slate-300"
                >
                  {theme} ({count})
                </span>
              ))}
            </div>
          )}
          <button
            onClick={() => setDirectionsOpen(!directionsOpen)}
            className="ml-auto px-3 py-1.5 text-xs rounded-md bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 transition-colors flex items-center gap-1.5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            Directions
            <span className="text-[10px] opacity-60">{directionsOpen ? "\u25B2" : "\u25BC"}</span>
          </button>
        </div>
      )}

      {/* Directions panel */}
      {directionsOpen && (
        <div className="shrink-0 border-b border-purple-500/20 bg-slate-900/70 backdrop-blur-sm">
          {/* Result banner */}
          {result && (
            <div
              className={`px-4 py-2 text-sm ${
                result.success
                  ? "bg-emerald-500/10 text-emerald-300 border-b border-emerald-500/20"
                  : "bg-red-500/10 text-red-300 border-b border-red-500/20"
              }`}
            >
              {result.message}
            </div>
          )}

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
            <span className="text-xs text-slate-400">
              {loadingDirections
                ? "Generating directions..."
                : `${directions.length} direction${directions.length !== 1 ? "s" : ""}`}
            </span>
            <button
              onClick={() => loadDirections(true)}
              disabled={loadingDirections}
              className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-40 transition-colors"
            >
              Refresh
            </button>
          </div>

          {/* Direction cards */}
          <div className="max-h-64 overflow-y-auto p-2 space-y-2">
            {loadingDirections && directions.length === 0 ? (
              <div className="py-6 text-center text-slate-500 text-sm animate-pulse">
                Generating creative directions...
              </div>
            ) : directions.length === 0 ? (
              <div className="py-6 text-center text-slate-500 text-sm">
                No directions generated. Try clicking Refresh to generate new ones.
              </div>
            ) : (
              directions.map((dir) => (
                <div
                  key={dir.id}
                  className="rounded-lg bg-white/[0.03] border border-white/5 p-3 hover:border-purple-500/20 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      {/* Type badge + novelty */}
                      <div className="flex items-center gap-2 mb-1.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider ${
                            TYPE_COLORS[dir.type] || "bg-slate-500/20 text-slate-300"
                          }`}
                        >
                          {dir.type}
                        </span>
                        <span className="text-[10px] text-slate-500">
                          {(dir.noveltyScore * 100).toFixed(0)}% novel
                        </span>
                      </div>

                      {/* Description */}
                      <p className="text-sm text-slate-300 mb-1.5 line-clamp-1">
                        {dir.description}
                      </p>

                      {/* Prompt (expandable) */}
                      <button
                        onClick={() =>
                          setExpandedPrompt(expandedPrompt === dir.id ? null : dir.id)
                        }
                        className="text-left w-full"
                      >
                        <p
                          className={`text-xs text-slate-500 ${
                            expandedPrompt === dir.id ? "" : "line-clamp-2"
                          }`}
                        >
                          {dir.proposedPrompt}
                        </p>
                      </button>
                    </div>

                    {/* Generate button */}
                    <button
                      onClick={() => handleExecute(dir.id)}
                      disabled={executingId !== null}
                      className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-purple-500/20 text-purple-300 hover:bg-purple-500/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {executingId === dir.id ? (
                        <span className="flex items-center gap-1.5">
                          <span className="w-3 h-3 border-2 border-purple-300/30 border-t-purple-300 rounded-full animate-spin" />
                          Generating...
                        </span>
                      ) : (
                        "Generate"
                      )}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Visualization iframe - always in DOM so ref is available */}
      <div className="flex-1 min-h-0 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-slate-400 z-10">
            <div className="animate-pulse">Loading corpus visualization...</div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          title="Corpus Force-Directed Graph"
          className="absolute inset-0 w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  );
}
