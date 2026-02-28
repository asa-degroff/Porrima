import { useState, useEffect, useCallback } from "react";
import type { Artifact } from "../types";

interface Props {
  artifact: Artifact;
}

export function ArtifactPanel({ artifact }: Props) {
  const [showCode, setShowCode] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [sourceCode, setSourceCode] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);

  const handleIframeLoad = useCallback(() => setIframeLoaded(true), []);

  // Fetch artifact HTML and create a blob URL so the iframe is same-origin,
  // avoiding Chrome's requestAnimationFrame throttling for cross-origin iframes.
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetch(artifact.url, { credentials: "include" })
      .then((r) => r.text())
      .then((html) => {
        if (cancelled) return;
        setSourceCode(html);
        setIframeLoaded(false);
        const blob = new Blob([html], { type: "text/html" });
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch(() => {
        if (!cancelled) setIframeError(true);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.url]);

  return (
    <div className="mt-3 rounded-xl border border-white/10 overflow-hidden bg-black/20">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-white/[0.03]">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span className="text-xs font-medium text-white/70">{artifact.title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowCode(false)}
            className={`px-2 py-0.5 text-[10px] rounded ${!showCode ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/60"}`}
          >
            Preview
          </button>
          <button
            onClick={() => setShowCode(true)}
            className={`px-2 py-0.5 text-[10px] rounded ${showCode ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/60"}`}
          >
            Code
          </button>
          <a
            href={artifact.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-0.5 text-[10px] text-white/40 hover:text-white/60"
          >
            Open
          </a>
        </div>
      </div>

      {/* Content */}
      {showCode ? (
        <div className="p-3 max-h-[400px] overflow-auto">
          <pre className="text-xs text-white/70 font-mono whitespace-pre-wrap">
            {sourceCode ?? "Loading source..."}
          </pre>
        </div>
      ) : (
        <div className={`rounded-b-xl transition-colors duration-150 ${iframeLoaded ? "bg-white" : "bg-black/20"}`}>
          {iframeError ? (
            <div className="p-4 text-center text-sm text-gray-500">
              Failed to load artifact preview
            </div>
          ) : blobUrl ? (
            <iframe
              src={blobUrl}
              className={`w-full h-[400px] border-0 transition-opacity duration-150 ${iframeLoaded ? "opacity-100" : "opacity-0"}`}
              style={{ colorScheme: "normal", background: "transparent" }}
              title={artifact.title}
              onLoad={handleIframeLoad}
              onError={() => setIframeError(true)}
            />
          ) : (
            <div className="flex items-center justify-center h-[400px]">
              <div className="text-sm text-white/40">Loading preview...</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
