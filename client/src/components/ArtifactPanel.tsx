import { useState } from "react";
import type { Artifact } from "../types";

interface Props {
  artifact: Artifact;
}

export function ArtifactPanel({ artifact }: Props) {
  const [showCode, setShowCode] = useState(false);
  const [iframeError, setIframeError] = useState(false);

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
            Loading source...
          </pre>
        </div>
      ) : (
        <div className="bg-white rounded-b-xl">
          {iframeError ? (
            <div className="p-4 text-center text-sm text-gray-500">
              Failed to load artifact preview
            </div>
          ) : (
            <iframe
              src={artifact.url}
              sandbox="allow-scripts allow-forms allow-same-origin"
              className="w-full h-[400px] border-0"
              title={artifact.title}
              onError={() => setIframeError(true)}
            />
          )}
        </div>
      )}
    </div>
  );
}
