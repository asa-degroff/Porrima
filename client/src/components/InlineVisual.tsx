import { useState, useEffect, useCallback, useRef } from "react";
import type { InlineVisual as InlineVisualType } from "../types";

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 1000;
const DEFAULT_HEIGHT = 450;

interface Props {
  visual: InlineVisualType;
}

export function InlineVisual({ visual }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const updateHeight = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const contentHeight = doc.documentElement.scrollHeight;
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, contentHeight)));
      }
    } catch {
      // cross-origin fallback
    }
  }, []);

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true);
    updateHeight();
    
    // Watch for content size changes with ResizeObserver
    const doc = iframeRef.current?.contentDocument;
    if (doc) {
      const observer = new ResizeObserver(() => {
        updateHeight();
      });
      observer.observe(doc.documentElement);
      
      // Also observe body in case documentElement doesn't resize
      observer.observe(doc.body);
    }
  }, [updateHeight]);

  // Inject scrollbar styling into visual HTML to match app aesthetic
  const injectScrollbarStyles = (html: string): string => {
    const scrollbarStyles = `<style>
html, body { background: transparent !important; }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
</style>`;
    
    if (html.includes("</head>")) {
      return html.replace("</head>", `${scrollbarStyles}\n</head>`);
    } else if (html.includes("<body")) {
      return html.replace("<body", `${scrollbarStyles}\n<body`);
    }
    return scrollbarStyles + "\n" + html;
  };

  // Create blob URL from inline HTML with scrollbar styles injected
  useEffect(() => {
    const styledHtml = injectScrollbarStyles(visual.html);
    const blob = new Blob([styledHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [visual.html]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([visual.html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${visual.title.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }, [visual.html, visual.title]);

  return (
    <div
      className="mt-3 rounded-xl overflow-hidden"
      style={{
        border: "1px solid rgba(var(--theme-secondary), 0.2)",
        background: "rgba(var(--theme-secondary), 0.03)",
      }}
    >
      {/* Compact header */}
      <div
        className="flex items-center justify-between px-3 py-1.5"
        style={{
          borderBottom: "1px solid rgba(var(--theme-secondary), 0.15)",
          background: "rgba(var(--theme-secondary), 0.05)",
        }}
      >
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: `rgba(var(--theme-secondary-text), 0.8)` }}>
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
            <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
            <line x1="12" y1="22.08" x2="12" y2="12" />
          </svg>
          <span className="text-[11px] font-medium text-white/60">{visual.title}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleDownload}
            className="px-1.5 py-0.5 text-[10px] text-white/40 hover:text-white/60 transition-colors"
          >
            Download
          </button>
          <a
            href={visual.url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-1.5 py-0.5 text-[10px] text-white/40 hover:text-white/60 transition-colors"
          >
            Open
          </a>
        </div>
      </div>

      {/* Iframe content */}
      <div className={`transition-colors duration-150 ${iframeLoaded ? "bg-transparent" : "bg-black/10"}`}>
        {blobUrl ? (
          <iframe
            ref={iframeRef}
            src={blobUrl}
            className={`w-full border-0 transition-opacity duration-150 ${iframeLoaded ? "opacity-100" : "opacity-0"}`}
            style={{ height: `${height}px`, colorScheme: "normal", background: "transparent" }}
            title={visual.title}
            onLoad={handleIframeLoad}
          />
        ) : (
          <div className="flex items-center justify-center" style={{ height: `${height}px` }}>
            <div className="text-sm text-white/40">Loading...</div>
          </div>
        )}
      </div>
    </div>
  );
}
