import { useEffect, useRef, useState, useCallback } from "react";

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
  const loadStats = useCallback(() => {
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

  useEffect(() => {
    loadStats();

    // Listen for image deletion events to refresh stats
    const handleImageDeleted = () => {
      console.log("[corpus] Image deleted, refreshing stats");
      loadStats();
    };

    window.addEventListener('corpus-image-deleted', handleImageDeleted);
    return () => window.removeEventListener('corpus-image-deleted', handleImageDeleted);
  }, [loadStats]);

  // Load visualization in iframe and sync theme
  useEffect(() => {
    if (!iframeRef.current) return;

    const iframe = iframeRef.current;
    iframe.src = "/api/corpus/visualization";

    const handleLoad = () => {
      setLoading(false);
      // Send initial theme to iframe
      const theme = document.documentElement.getAttribute('data-theme') || 'default';
      iframe.contentWindow?.postMessage({ type: 'theme-change', theme }, window.location.origin);
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

    // Listen for theme changes and sync to iframe
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const theme = document.documentElement.getAttribute('data-theme') || 'default';
          iframe.contentWindow?.postMessage({ type: 'theme-change', theme }, window.location.origin);
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true });

    return () => {
      iframe.removeEventListener("load", handleLoad);
      window.removeEventListener("message", handleMessage);
      observer.disconnect();
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
          className="mt-4 px-4 py-2 bg-white/[0.05] hover:bg-white/[0.08] text-white/80 rounded transition-colors"
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
        <div className="flex items-center gap-6 px-4 py-3 bg-white/[0.05] border-b border-white/10">
          <div className="flex items-center gap-2">
            <span className="text-white/50 text-sm">Images:</span>
            <span className="theme-accent-text font-semibold">{stats.total}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white/50 text-sm">Clusters:</span>
            <span className="theme-primary-text font-semibold">{stats.clusters}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white/50 text-sm">Enriched:</span>
            <span className="theme-secondary-text font-semibold">{stats.enriched}/{stats.total}</span>
          </div>
          {stats.topThemes?.length > 0 && (
            <div className="hidden lg:flex items-center gap-3">
              <span className="text-white/50 text-sm">Top themes:</span>
              {stats.topThemes.slice(0, 5).map(({ theme, count }) => (
                <span
                  key={theme}
                  className="px-2 py-1 bg-white/[0.05] rounded text-xs text-white/70"
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
