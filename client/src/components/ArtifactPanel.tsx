import { useState, useEffect, useCallback, useRef } from "react";
import type { Artifact } from "../types";
import type { ArtifactRuntimeErrorReport } from "../api/client";
import { usePinnedItem } from "../contexts/PinnedItemContext";
import { useIsDesktop } from "../hooks/useIsDesktop";
import { injectArtifactErrorForwarder } from "../utils/artifactErrorForwarder";

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 1200;
const DEFAULT_HEIGHT = 400;

interface Props {
  artifact: Artifact;
  onArtifactUpdate?: (artifactId: string, newVersion: number) => void;
  isPinnedView?: boolean;
  chatId?: string;
  onArtifactRuntimeError?: (report: ArtifactRuntimeErrorReport) => void;
}

interface VersionInfo {
  version: number;
  createdAt: string;
  changeSummary?: string;
}

function getSourceExcerpt(source: string | null, lineNumber?: number, radius = 5): string | undefined {
  if (!source || !lineNumber || lineNumber < 1) return undefined;
  const lines = source.split("\n");
  const start = Math.max(0, lineNumber - radius - 1);
  const end = Math.min(lines.length, lineNumber + radius);
  return lines
    .slice(start, end)
    .map((line, idx) => `${start + idx + 1}: ${line}`)
    .join("\n");
}

export function ArtifactPanel({ artifact, onArtifactUpdate, isPinnedView, chatId, onArtifactRuntimeError }: Props) {
  const { pinArtifact, unpin, isPinned } = usePinnedItem();
  const isDesktop = useIsDesktop();
  const pinned = isPinned("artifact", artifact.id);
  const [showCode, setShowCode] = useState(false);
  const [iframeError, setIframeError] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [sourceCode, setSourceCode] = useState<string | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [showVersionMenu, setShowVersionMenu] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<number>(artifact.version ?? 1);
  const [isLoadingVersion, setIsLoadingVersion] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const heightRef = useRef(DEFAULT_HEIGHT);
  const versionMenuRef = useRef<HTMLDivElement>(null);
  const runtimeErrorRef = useRef<string | null>(null);
  const reportedErrorKeyRef = useRef<string | null>(null);

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true);
    setIsLoadingVersion(false);
    // Auto-size to content since blob URLs are same-origin.
    // Temporarily neutralise viewport-relative units so scrollHeight reflects
    // the actual content size rather than the iframe's current viewport.
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc) {
        const body = doc.body;
        const html = doc.documentElement;
        const prevBodyHeight = body.style.height;
        const prevBodyMinHeight = body.style.minHeight;
        const prevHtmlHeight = html.style.height;
        const prevHtmlMinHeight = html.style.minHeight;
        body.style.height = 'auto';
        body.style.minHeight = '0';
        html.style.height = 'auto';
        html.style.minHeight = '0';
        const contentHeight = doc.documentElement.scrollHeight;
        body.style.height = prevBodyHeight;
        body.style.minHeight = prevBodyMinHeight;
        html.style.height = prevHtmlHeight;
        html.style.minHeight = prevHtmlMinHeight;
        const clamped = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, contentHeight));
        setHeight(clamped);
        heightRef.current = clamped;
      }
    } catch {
      // cross-origin fallback — keep default
    }
  }, []);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = heightRef.current;
    setDragging(true);

    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_HEIGHT, startHeight + (ev.clientY - startY));
      heightRef.current = next;
      setHeight(next);
    };
    const onUp = () => {
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Fetch artifact metadata on mount
  useEffect(() => {
    fetch(`/api/artifacts/${artifact.id}/metadata`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.versions) {
          setVersions(data.versions);
        }
      })
      .catch(() => {
        // Fallback: create a single version entry
        setVersions([{ version: artifact.version ?? 1, createdAt: new Date().toISOString() }]);
      });
  }, [artifact.id, artifact.version]);

  // Fetch artifact HTML and create a blob URL
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setIsLoadingVersion(true);
    
    const artifactUrl = `/api/artifacts/${artifact.id}/versions/${selectedVersion}`;
    
    fetch(artifactUrl, { credentials: "include" })
      .then((r) => r.text())
      .then((html) => {
        if (cancelled) return;
        setSourceCode(html);
        setIframeLoaded(false);
        setRuntimeError(null);
        runtimeErrorRef.current = null;
        reportedErrorKeyRef.current = null;
        // Inject error-forwarding script so JS runtime errors in the iframe
        // surface as messages the parent can display (iframe onError only
        // fires on network failures, not JS exceptions).
        const injected = injectArtifactErrorForwarder(html);
        const blob = new Blob([injected], { type: "text/html" });
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
      })
      .catch(() => {
        if (!cancelled) setIframeError(true);
        setIsLoadingVersion(false);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [artifact.id, selectedVersion]);

  // Listen for runtime errors forwarded from the iframe
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === "artifact-error") {
        const msg = e.data.message || "Unknown runtime error";
        const diagnosticKind = typeof e.data.diagnosticKind === "string" ? e.data.diagnosticKind : undefined;
        const stage = e.data.vertex || e.data.fragment || e.data.compute || {};
        const shaderLine = typeof e.data.shaderLine === "number" ? e.data.shaderLine : undefined;
        const shaderColumn = typeof e.data.shaderColumn === "number" ? e.data.shaderColumn : undefined;
        setRuntimeError(msg);
        runtimeErrorRef.current = msg;
        setIframeError(false);
        if (chatId && onArtifactRuntimeError) {
          const key = [
            artifact.id,
            selectedVersion,
            diagnosticKind ?? "",
            msg,
            shaderLine ?? e.data.lineno ?? "",
            shaderColumn ?? e.data.colno ?? "",
          ].join(":");
          if (reportedErrorKeyRef.current !== key) {
            reportedErrorKeyRef.current = key;
            onArtifactRuntimeError({
              chatId,
              artifactId: artifact.id,
              version: selectedVersion,
              title: artifact.title,
              url: `/api/artifacts/${artifact.id}/versions/${selectedVersion}`,
              diagnosticKind: diagnosticKind as ArtifactRuntimeErrorReport["diagnosticKind"],
              message: msg,
              stack: typeof e.data.stack === "string" ? e.data.stack : undefined,
              filename: typeof e.data.filename === "string" ? e.data.filename : undefined,
              lineno: diagnosticKind?.startsWith("webgpu") ? undefined : (typeof e.data.lineno === "number" ? e.data.lineno : undefined),
              colno: diagnosticKind?.startsWith("webgpu") ? undefined : (typeof e.data.colno === "number" ? e.data.colno : undefined),
              sourceExcerpt: diagnosticKind?.startsWith("webgpu")
                ? undefined
                : getSourceExcerpt(sourceCode, typeof e.data.lineno === "number" ? e.data.lineno : undefined),
              shaderLabel: typeof e.data.shaderLabel === "string" ? e.data.shaderLabel : (typeof stage.shaderLabel === "string" ? stage.shaderLabel : undefined),
              shaderSource: typeof e.data.shaderSource === "string" ? e.data.shaderSource : (typeof stage.shaderSource === "string" ? stage.shaderSource : undefined),
              shaderLine,
              shaderColumn,
              shaderExcerpt: typeof e.data.shaderExcerpt === "string" ? e.data.shaderExcerpt : undefined,
              pipelineLabel: typeof e.data.pipelineLabel === "string" ? e.data.pipelineLabel : undefined,
              entryPoint: typeof e.data.entryPoint === "string" ? e.data.entryPoint : (typeof stage.entryPoint === "string" ? stage.entryPoint : undefined),
              compilationMessages: Array.isArray(e.data.compilationMessages) ? e.data.compilationMessages : undefined,
            });
          }
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [artifact.id, artifact.title, chatId, onArtifactRuntimeError, selectedVersion, sourceCode]);

  // Close version menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (versionMenuRef.current && !versionMenuRef.current.contains(e.target as Node)) {
        setShowVersionMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleVersionSelect = (version: number) => {
    setSelectedVersion(version);
    setShowVersionMenu(false);
    onArtifactUpdate?.(artifact.id, version);
  };

  const currentVersionInfo = versions.find(v => v.version === selectedVersion);
  const formattedDate = currentVersionInfo 
    ? new Date(currentVersionInfo.createdAt).toLocaleDateString(undefined, { 
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
      })
    : '';

  return (
    <div className={isPinnedView ? "flex-1 min-h-0 flex flex-col rounded-xl border border-white/10 overflow-hidden bg-black/20" : "mt-3 rounded-xl border border-white/10 overflow-hidden bg-black/20"}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-white/[0.03] shrink-0">
        <div className="flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-blue-400">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
          <span className="text-xs font-medium text-white/70">{artifact.title}</span>
          {versions.length > 0 && (
            <div className="relative" ref={versionMenuRef}>
              <button
                onClick={() => setShowVersionMenu(!showVersionMenu)}
                className="px-2 py-0.5 text-[10px] rounded bg-white/10 text-white/60 hover:text-white/80 transition-colors flex items-center gap-1 pressable"
              >
                v{selectedVersion} of {versions.length}
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showVersionMenu && (
                <div className="absolute top-full left-0 mt-1 w-64 max-h-64 overflow-y-auto rounded-lg border border-white/10 app-solid-popover shadow-xl z-50">
                  <div className="p-2">
                    <div className="text-[10px] text-white/40 uppercase tracking-wider mb-2 px-2">Version History</div>
                    {versions.slice().reverse().map((v) => (
                      <button
                        key={v.version}
                        onClick={() => handleVersionSelect(v.version)}
                        className={`w-full text-left px-2 py-1.5 rounded text-xs mb-1 transition-colors ${
                          v.version === selectedVersion
                            ? "bg-blue-500/20 text-blue-300"
                            : "text-white/70 hover:bg-white/5"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium">Version {v.version}</span>
                          {v.version === versions[versions.length - 1]?.version && (
                            <span className="text-[9px] text-green-400 bg-green-500/20 px-1 rounded">Latest</span>
                          )}
                        </div>
                        {v.changeSummary && (
                          <div className="text-white/50 text-[10px] mt-0.5 truncate">{v.changeSummary}</div>
                        )}
                        <div className="text-white/30 text-[9px] mt-0.5">
                          {new Date(v.createdAt).toLocaleDateString(undefined, { 
                            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
                          })}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {currentVersionInfo?.changeSummary && (
            <span className="text-[10px] text-white/40 truncate max-w-[200px]" title={currentVersionInfo.changeSummary}>
              • {currentVersionInfo.changeSummary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowCode(false)}
            className={`px-2 py-0.5 text-[10px] rounded pressable ${!showCode ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/60"}`}
          >
            Preview
          </button>
          <button
            onClick={() => setShowCode(true)}
            className={`px-2 py-0.5 text-[10px] rounded pressable ${showCode ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/60"}`}
          >
            Code
          </button>
          <a
            href={`/api/artifacts/${artifact.id}/versions/${selectedVersion}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2 py-0.5 text-[10px] text-white/40 hover:text-white/60"
          >
            Open
          </a>
          {isDesktop && (
            <button
              onClick={() => (pinned ? unpin() : pinArtifact(artifact))}
              className={`px-2 py-0.5 text-[10px] rounded transition-colors pressable ${
                pinned ? "bg-blue-500/20 text-blue-300" : "text-white/40 hover:text-white/60"
              }`}
              title={pinned ? "Return artifact to inline view" : "Pin artifact to side panel"}
            >
              {pinned ? "Unpin" : "Pin"}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {showCode ? (
        <div className={isPinnedView ? "flex-1 min-h-0 overflow-auto p-3" : "p-3 max-h-[400px] overflow-auto"}>
          <pre className="text-xs text-white/70 font-mono whitespace-pre-wrap">
            {isLoadingVersion ? "Loading..." : (sourceCode ?? "Loading source...")}
          </pre>
        </div>
      ) : (
        <>
          <div className={`transition-colors duration-150 ${iframeLoaded ? "bg-white" : "bg-black/20"} ${isPinnedView ? "flex-1 min-h-0 flex flex-col" : ""}`}>
            {iframeError ? (
              <div className="p-4 text-center text-sm text-gray-500">
                Failed to load artifact preview
              </div>
            ) : runtimeError ? (
              <div className="p-4 space-y-2">
                <div className="flex items-center gap-2 text-amber-400">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                  </svg>
                  <span className="text-sm font-medium">Runtime Error</span>
                </div>
                <pre className="text-xs text-red-300/80 font-mono whitespace-pre-wrap bg-red-950/30 rounded-lg p-3 border border-red-500/20">
                  {runtimeError}
                </pre>
                <p className="text-[10px] text-white/30">
                  This is a JavaScript error from the artifact. The preview is hidden. Switch to the Code tab to inspect the source.
                </p>
              </div>
            ) : blobUrl ? (
              <iframe
                ref={iframeRef}
                src={blobUrl}
                className={`w-full border-0 transition-opacity duration-150 ${iframeLoaded ? "opacity-100" : "opacity-0"} ${isPinnedView ? "flex-1 min-h-0" : ""}`}
                style={isPinnedView ? { colorScheme: "normal", background: "transparent", pointerEvents: dragging ? "none" : "auto" } : { height: `${height}px`, colorScheme: "normal", background: "transparent", pointerEvents: dragging ? "none" : "auto" }}
                title={`${artifact.title} (v${selectedVersion})`}
                onLoad={handleIframeLoad}
                onError={() => setIframeError(true)}
              />
            ) : (
              <div className="flex items-center justify-center" style={{ height: isPinnedView ? "100%" : `${height}px` }}>
                <div className="text-sm text-white/40">
                  {isLoadingVersion ? `Loading version ${selectedVersion}...` : "Loading preview..."}
                </div>
              </div>
            )}
          </div>
          {/* Vertical resize handle — hidden when in pinned side panel */}
          {!isPinnedView && (
            <div
              onMouseDown={handleDragStart}
              className="h-2 cursor-row-resize flex items-center justify-center bg-white/[0.03] hover:bg-white/[0.08] border-t border-white/10 rounded-b-xl transition-colors"
            >
              <div className="w-8 h-0.5 rounded-full bg-white/20" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
