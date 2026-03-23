import { useEffect, useRef, useState } from "react";

interface CorpusViewProps {
  onOpenCluster?: (clusterId: string) => void;
}

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
            <div className="flex items-center gap-3 ml-auto">
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
