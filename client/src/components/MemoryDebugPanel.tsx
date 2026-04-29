import { useEffect, useRef, useState, useCallback } from "react";
import { searchMemories, fetchAllMemories, deleteMemory, fetchMemoryLineage, fetchMemoryBlocks, updateMemoryBlockApi, deleteMemoryBlockApi } from "../api/client";
import type { MemorySummary, MemoryLineage, MemoryBlock } from "../types";

// ── Extraction types ──────────────────────────────────────────────────────
// Kept aligned with server/src/services/memory-extraction-observability.ts.
type ExtractionTrigger = "immediate" | "delayed" | "pre-compaction" | "notebook" | "other";
type ExtractionStatus = "running" | "success" | "error";

interface ExtractionMessageView {
  role: string;
  content: string;
}

interface ExtractionParsedFact {
  text: string;
  category?: string;
  importance?: number;
}

interface ExtractionChunkInfo {
  count: number;
  failures: number;
  timingsMs: number[];
}

interface ExtractionResults {
  facts: ExtractionParsedFact[];
  saved: number;
  superseded: number;
  skippedDuplicates: number;
  errors: number;
  chunks?: ExtractionChunkInfo;
}

interface ExtractionRun {
  id: string;
  trigger: ExtractionTrigger;
  chatId?: string;
  chatTitle?: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: ExtractionStatus;
  priorMemoryCount: number;
  messages: ExtractionMessageView[];
  systemPrompt: string;
  userPrompt: string;
  rawOutput?: string;
  results?: ExtractionResults;
  error?: string;
}

interface ExtractionEvent {
  type: "start" | "output" | "complete" | "error";
  run: ExtractionRun;
}

// ── Props ─────────────────────────────────────────────────────────────────
interface Props {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = "extraction" | "memories" | "blocks";

// ── Helpers ───────────────────────────────────────────────────────────────
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: ExtractionStatus): string {
  switch (status) {
    case "running": return "text-amber-300/70";
    case "success": return "text-emerald-300/70";
    case "error":   return "text-red-300/70";
  }
}

function triggerColor(trigger: ExtractionTrigger): string {
  switch (trigger) {
    case "immediate":      return "text-purple-300/70 border-purple-400/20 bg-purple-500/5";
    case "delayed":        return "text-sky-300/70 border-sky-400/20 bg-sky-500/5";
    case "pre-compaction": return "text-amber-300/70 border-amber-400/20 bg-amber-500/5";
    case "notebook":       return "text-emerald-300/70 border-emerald-400/20 bg-emerald-500/5";
    default:               return "text-white/50 border-white/10 bg-white/5";
  }
}

// ── Main Component ────────────────────────────────────────────────────────
export function MemoryDebugPanel({ isOpen, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>("memories");

  // Extraction tab state
  const [runs, setRuns] = useState<ExtractionRun[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Memories tab state
  const [memoryStatus, setMemoryStatus] = useState<{ memoryCount: number; lastSynthesis: string | null; embeddingModelAvailable: boolean } | null>(null);
  const [synthesisRunning, setSynthesisRunning] = useState(false);
  const [memorySearchQuery, setMemorySearchQuery] = useState("");
  const [memoryResults, setMemoryResults] = useState<(MemorySummary & { score?: number })[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDeleting, setMemoryDeleting] = useState<string | null>(null);
  const [memoryCategoryFilter, setMemoryCategoryFilter] = useState<string>("all");
  const [memorySortBy, setMemorySortBy] = useState<string>("created_at_desc");
  const [expandedLineage, setExpandedLineage] = useState<string | null>(null);
  const [lineageData, setLineageData] = useState<Record<string, MemoryLineage>>({});
  const [lineageLoading, setLineageLoading] = useState<string | null>(null);
  const memorySearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Blocks tab state
  const [blocks, setBlocks] = useState<MemoryBlock[]>([]);
  const [blocksLoading, setBlocksLoading] = useState(false);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editBlockContent, setEditBlockContent] = useState("");
  const [confirmingBlockDelete, setConfirmingBlockDelete] = useState<string | null>(null);
  const [blockScopeFilter, setBlockScopeFilter] = useState<"all" | "global" | "project" | "archived">("all");

  // ── Extraction SSE ────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const es = new EventSource("/api/memory/extraction/stream", { withCredentials: true });
    esRef.current = es;

    es.addEventListener("snapshot", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        setRuns(data.runs ?? []);
        setConnected(true);
      } catch { /* ignore */ }
    });

    es.addEventListener("run", (e) => {
      try {
        const ev = JSON.parse((e as MessageEvent).data) as ExtractionEvent;
        setRuns((prev) => {
          const idx = prev.findIndex((r) => r.id === ev.run.id);
          if (idx === -1) return [ev.run, ...prev].slice(0, 50);
          const next = prev.slice();
          next[idx] = ev.run;
          return next;
        });
      } catch { /* ignore */ }
    });

    es.addEventListener("error", () => setConnected(false));
    es.addEventListener("open", () => setConnected(true));

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
    };
  }, [isOpen]);

  // ── Memory Status ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    fetch("/api/memory/status", { credentials: "include" })
      .then((r) => r.json())
      .then(setMemoryStatus)
      .catch(() => {});
  }, [isOpen]);

  // ── Load memories on tab switch ───────────────────────────────────────
  useEffect(() => {
    if (activeTab !== "memories" || !isOpen) return;
    if (memoryResults.length === 0) {
      setMemoryLoading(true);
      fetchAllMemories(memorySortBy)
        .then(setMemoryResults)
        .catch(() => {})
        .finally(() => setMemoryLoading(false));
    }
  }, [activeTab, isOpen]);

  // ── Load blocks on tab switch ─────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== "blocks" || !isOpen) return;
    if (blocks.length === 0) {
      setBlocksLoading(true);
      fetchMemoryBlocks()
        .then(setBlocks)
        .catch(() => {})
        .finally(() => setBlocksLoading(false));
    }
  }, [activeTab, isOpen]);

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleRunSynthesis = useCallback(async () => {
    setSynthesisRunning(true);
    try {
      const res = await fetch("/api/memory/synthesis/run", { method: "POST", credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setMemoryStatus((prev) =>
          prev ? { ...prev, memoryCount: data.memoryCount, lastSynthesis: data.lastSynthesis } : prev
        );
      }
    } catch {}
    setSynthesisRunning(false);
  }, []);

  const handleMemorySortChange = useCallback((sort: string) => {
    setMemorySortBy(sort);
    setMemoryLoading(true);
    fetchAllMemories(sort)
      .then(setMemoryResults)
      .catch(() => {})
      .finally(() => setMemoryLoading(false));
  }, []);

  const handleMemorySearch = useCallback((query: string) => {
    setMemorySearchQuery(query);
    if (memorySearchTimer.current) clearTimeout(memorySearchTimer.current);
    if (!query.trim()) {
      setMemoryLoading(true);
      fetchAllMemories(memorySortBy)
        .then(setMemoryResults)
        .catch(() => {})
        .finally(() => setMemoryLoading(false));
      return;
    }
    memorySearchTimer.current = setTimeout(async () => {
      setMemoryLoading(true);
      try {
        const results = await searchMemories(query, 20);
        setMemoryResults(results);
      } catch {}
      setMemoryLoading(false);
    }, 300);
  }, [memorySortBy]);

  const handleDeleteMemory = useCallback(async (id: string) => {
    setMemoryDeleting(id);
    try {
      await deleteMemory(id);
      setMemoryResults((prev) => prev.filter((m) => m.id !== id));
      setMemoryStatus((prev) => prev ? { ...prev, memoryCount: prev.memoryCount - 1 } : prev);
    } catch {}
    setMemoryDeleting(null);
  }, []);

  const handleDeleteBlock = useCallback(async (blockId: string) => {
    try {
      await deleteMemoryBlockApi(blockId);
      setBlocks((prev) => prev.filter((b) => b.id !== blockId));
    } catch (err) {
      console.error("Failed to delete block:", err);
    }
    setConfirmingBlockDelete(null);
  }, []);

  const handleToggleLineage = useCallback(async (id: string) => {
    if (expandedLineage === id) {
      setExpandedLineage(null);
      return;
    }
    setExpandedLineage(id);
    if (!lineageData[id]) {
      setLineageLoading(id);
      try {
        const lineage = await fetchMemoryLineage(id);
        setLineageData((prev) => ({ ...prev, [id]: lineage }));
      } catch {
        setLineageData((prev) => ({ ...prev, [id]: { older: [], newer: [] } }));
      }
      setLineageLoading(null);
    }
  }, [expandedLineage, lineageData]);

  // ── Keyboard escape ───────────────────────────────────────────────────
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!isOpen) return null;

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    {
      key: "memories",
      label: "Memories",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <ellipse cx="12" cy="5" rx="9" ry="3"/>
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
        </svg>
      ),
    },
    {
      key: "blocks",
      label: "Blocks",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>
        </svg>
      ),
    },
    {
      key: "extraction",
      label: "Extraction",
      icon: (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      ),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900/95 border border-white/10 rounded-xl w-full max-w-4xl min-h-[400px] max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-medium text-white/90">Memory</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-white/40 hover:text-white/80 transition-colors"
            title="Close"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        {/* Tab bar */}
        <div className="flex items-center gap-1 px-4 py-2 border-b border-white/5 shrink-0">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeTab === tab.key
                  ? "bg-purple-500/20 text-purple-200 border border-purple-400/25"
                  : "text-white/35 hover:text-white/60 hover:bg-white/5 border border-transparent"
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.key === "extraction" && (
                <span className={`ml-1 ${connected ? "text-emerald-400/60" : "text-white/20"}`}>
                  {connected ? "●" : "○"}
                </span>
              )}
              {tab.key === "memories" && memoryStatus && (
                <span className="ml-1 text-white/25">{memoryStatus.memoryCount}</span>
              )}
              {tab.key === "blocks" && blocks.length > 0 && (
                <span className="ml-1 text-white/25">{blocks.length}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "extraction" && <ExtractionTab runs={runs} expandedId={expandedRunId} onToggle={setExpandedRunId} />}
          {activeTab === "memories" && (
            <MemoriesTab
              memoryStatus={memoryStatus}
              synthesisRunning={synthesisRunning}
              searchQuery={memorySearchQuery}
              results={memoryResults}
              loading={memoryLoading}
              deleting={memoryDeleting}
              categoryFilter={memoryCategoryFilter}
              sortBy={memorySortBy}
              expandedLineage={expandedLineage}
              lineageData={lineageData}
              lineageLoading={lineageLoading}
              onRunSynthesis={handleRunSynthesis}
              onSearch={handleMemorySearch}
              onSortChange={handleMemorySortChange}
              onDeleteMemory={handleDeleteMemory}
              onToggleLineage={handleToggleLineage}
              onCategoryFilterChange={setMemoryCategoryFilter}
            />
          )}
          {activeTab === "blocks" && (
            <BlocksTab
              blocks={blocks}
              loading={blocksLoading}
              editingBlockId={editingBlockId}
              editBlockContent={editBlockContent}
              confirmingBlockDelete={confirmingBlockDelete}
              scopeFilter={blockScopeFilter}
              onContentChange={setEditBlockContent}
              onScopeFilterChange={setBlockScopeFilter}
              onStartEdit={(id: string, content: string) => {
                setEditingBlockId(id);
                setEditBlockContent(content);
              }}
              onCancelEdit={() => setEditingBlockId(null)}
              onSaveBlock={(id: string, content: string) => {
                updateMemoryBlockApi(id, { content }).then((updated) => {
                  setBlocks((prev) => prev.map((b) => b.id === id ? updated : b));
                  setEditingBlockId(null);
                });
              }}
              onDeleteBlock={handleDeleteBlock}
              onCancelDelete={() => setConfirmingBlockDelete(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Extraction Tab ────────────────────────────────────────────────────────
function ExtractionTab({
  runs,
  expandedId,
  onToggle,
}: {
  runs: ExtractionRun[];
  expandedId: string | null;
  onToggle: (id: string | null) => void;
}) {
  return runs.length === 0 ? (
    <div className="p-8 text-center text-white/30 text-sm">
      No extraction runs yet. Send a message, trigger compaction, or wait for a delayed extraction.
    </div>
  ) : (
    <ul className="divide-y divide-white/5">
      {runs.map((run) => {
        const isExpanded = expandedId === run.id;
        return (
          <li key={run.id} className="text-xs">
            <button
              onClick={() => onToggle(isExpanded ? null : run.id)}
              className="w-full flex flex-col gap-1.5 px-4 py-2.5 hover:bg-white/5 text-left transition-colors"
            >
              <div className="flex items-center gap-2 w-full min-w-0">
                <span className={`inline-flex items-center gap-1 ${statusColor(run.status)} shrink-0`}>
                  {run.status === "running" ? "●" : run.status === "success" ? "✓" : "✗"}
                  <span className="hidden sm:inline">{run.status}</span>
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] border ${triggerColor(run.trigger)} shrink-0`}>
                  {run.trigger}
                </span>
                <span className="flex-1 min-w-0 truncate text-white/70">
                  {run.chatTitle || run.chatId || "—"}
                </span>
              </div>
              <div className="flex items-center gap-3 text-white/30 text-[10px]">
                <span className="shrink-0">
                  {run.results ? `${run.results.facts.length} fact(s)` : "…"}
                </span>
                {run.results?.chunks && (
                  <span className={`shrink-0 ${run.results.chunks.failures > 0 ? "text-amber-300/60" : "text-white/30"}`}>
                    {run.results.chunks.count === 1
                      ? "1 call"
                      : `${run.results.chunks.count} calls${run.results.chunks.failures > 0 ? ` (${run.results.chunks.failures} fail)` : ""}`}
                  </span>
                )}
                <span className="shrink-0">{formatDuration(run.durationMs)}</span>
                <span className="text-white/20 shrink-0">{formatTime(run.startedAt)}</span>
              </div>
            </button>
            {isExpanded && <RunDetail run={run} />}
          </li>
        );
      })}
    </ul>
  );
}

function RunDetail({ run }: { run: ExtractionRun }) {
  return (
    <div className="px-4 pb-4 space-y-3 bg-black/20">
      {run.error && (
        <Section title="Error" defaultOpen>
          <pre className="text-red-300/80 text-[11px] whitespace-pre-wrap">{run.error}</pre>
        </Section>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-white/40 pt-2">
        <span>model: <span className="text-white/60">{run.model}</span></span>
        <span>prior memories: <span className="text-white/60">{run.priorMemoryCount}</span></span>
        {run.results && (
          <>
            <span>saved: <span className="text-emerald-300/70">{run.results.saved}</span></span>
            <span>superseded: <span className="text-sky-300/70">{run.results.superseded}</span></span>
            <span>skipped: <span className="text-white/40">{run.results.skippedDuplicates}</span></span>
          </>
        )}
      </div>
      {run.results?.chunks && <ChunkBreakdown chunks={run.results.chunks} />}
      {run.results && run.results.facts.length > 0 && (
        <Section title={`Parsed Facts (${run.results.facts.length})`} defaultOpen>
          <ul className="space-y-1.5">
            {run.results.facts.map((f, i) => (
              <li key={i} className="text-[11px] flex gap-2">
                {f.category && <span className="text-white/40 shrink-0 w-20 truncate">[{f.category}]</span>}
                {f.importance !== undefined && <span className="text-white/40 shrink-0 w-8">i{f.importance}</span>}
                <span className="text-white/80 flex-1">{f.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={`Messages (${run.messages.length})`}>
        <div className="space-y-2">
          {run.messages.map((m, i) => (
            <div key={i} className="text-[11px]">
              <div className="text-white/40 mb-0.5">{m.role}:</div>
              <pre className="text-white/70 whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-48 overflow-y-auto">
                {m.content}
              </pre>
            </div>
          ))}
        </div>
      </Section>
      <Section title="System Prompt">
        <pre className="text-white/70 text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-64 overflow-y-auto">
          {run.systemPrompt}
        </pre>
      </Section>
      <Section title="User Prompt">
        <pre className="text-white/70 text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-64 overflow-y-auto">
          {run.userPrompt}
        </pre>
      </Section>
      {run.rawOutput !== undefined && (
        <Section title="Raw Output" defaultOpen>
          <pre className="text-emerald-100/80 text-[11px] whitespace-pre-wrap break-words bg-black/30 p-2 rounded max-h-96 overflow-y-auto">
            {run.rawOutput || <span className="text-white/30">(empty)</span>}
          </pre>
        </Section>
      )}
    </div>
  );
}

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

function ChunkBreakdown({ chunks }: { chunks: ExtractionChunkInfo }) {
  if (chunks.count <= 1) return null;
  return (
    <Section title={`Chunks (${chunks.count} calls, ${chunks.failures} failed)`}>
      <div className="space-y-1">
        {chunks.timingsMs.map((ms, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-white/40 shrink-0 w-16">chunk {i + 1}:</span>
            <span className="text-white/80">{formatDuration(ms)}</span>
          </div>
        ))}
        {chunks.timingsMs.length > 0 && (
          <div className="flex items-center gap-2 pt-1 border-t border-white/10">
            <span className="text-white/40 shrink-0 w-16">total:</span>
            <span className="text-white/60">
              {formatDuration(chunks.timingsMs.reduce((a, b) => a + b, 0))}
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}

// ── Memories Tab ──────────────────────────────────────────────────────────
function MemoriesTab({
  memoryStatus,
  synthesisRunning,
  searchQuery,
  results,
  loading,
  deleting,
  categoryFilter,
  sortBy,
  expandedLineage,
  lineageData,
  lineageLoading,
  onRunSynthesis,
  onSearch,
  onSortChange,
  onDeleteMemory,
  onToggleLineage,
  onCategoryFilterChange,
}: {
  memoryStatus: { memoryCount: number; lastSynthesis: string | null; embeddingModelAvailable: boolean } | null;
  synthesisRunning: boolean;
  searchQuery: string;
  results: (MemorySummary & { score?: number })[];
  loading: boolean;
  deleting: string | null;
  categoryFilter: string;
  sortBy: string;
  expandedLineage: string | null;
  lineageData: Record<string, MemoryLineage>;
  lineageLoading: string | null;
  onRunSynthesis: () => void;
  onSearch: (query: string) => void;
  onSortChange: (sort: string) => void;
  onDeleteMemory: (id: string) => void;
  onToggleLineage: (id: string) => void;
  onCategoryFilterChange: (cat: string) => void;
}) {
  return (
    <div className="p-4 space-y-3">
      {/* Status summary */}
      {memoryStatus && (
        <div className="flex items-center gap-4 text-xs">
          <span className="text-white/50">{memoryStatus.memoryCount} stored</span>
          <span className="text-white/50">Embedding: <span className={memoryStatus.embeddingModelAvailable ? "text-green-400/80" : "text-red-400/80"}>{memoryStatus.embeddingModelAvailable ? "✓" : "✗"}</span></span>
          <span className="text-white/50">Last synthesis: <span className="text-white/70">{memoryStatus.lastSynthesis ? new Date(memoryStatus.lastSynthesis).toLocaleDateString() : "Never"}</span></span>
          <button
            onClick={onRunSynthesis}
            disabled={synthesisRunning || memoryStatus.memoryCount === 0}
            className="ml-auto px-3 py-1 rounded-lg text-xs font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              backgroundColor: `rgba(var(--theme-primary-muted, 140 50 200), 0.15)`,
              borderColor: `rgba(var(--theme-primary-border, 160 80 240), 0.25)`,
              color: `rgba(var(--theme-primary-text, 190 130 255))`,
            }}
          >
            {synthesisRunning ? "Running..." : "Run Synthesis"}
          </button>
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearch(e.target.value)}
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all"
          placeholder="Search memories..."
        />
      </div>

      {/* Category filter + sort */}
      <div className="flex items-center justify-between gap-2">
        {(() => {
          const categories = [...new Set(results.map((m) => m.category))].sort();
          if (categories.length <= 1) return <div />;
          return (
            <div className="flex gap-1 flex-wrap">
              {["all", ...categories].map((cat) => (
                <button
                  key={cat}
                  onClick={() => onCategoryFilterChange(cat)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${
                    categoryFilter === cat
                      ? "bg-purple-500/30 text-purple-200 border border-purple-400/30"
                      : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10"
                  }`}
                >
                  {cat === "all" ? "All" : cat}
                </button>
              ))}
            </div>
          );
        })()}
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value)}
          className="bg-white/5 border border-white/10 rounded-lg px-2 py-0.5 text-[10px] text-white/60 outline-none focus:ring-1 focus:ring-purple-400/30 shrink-0"
        >
          <option value="created_at_desc">Newest</option>
          <option value="created_at_asc">Oldest</option>
          <option value="last_accessed_desc">Recently used</option>
          <option value="importance_desc">Importance</option>
        </select>
      </div>

      {/* Results */}
      <div className="max-h-[360px] overflow-x-hidden overflow-y-auto space-y-1.5 pr-1">
        {loading ? (
          <p className="text-white/30 text-xs text-center py-4">Searching...</p>
        ) : results.length === 0 ? (
          <p className="text-white/30 text-xs text-center py-4">No memories found</p>
        ) : (
          results
            .filter((m) => categoryFilter === "all" || m.category === categoryFilter)
            .map((memory) => {
              const isSuperseded = !!memory.supersededBy;
              const hasLineage = !!(memory.supersededBy || memory.supersedes);
              const lineage = lineageData[memory.id];
              const isExpanded = expandedLineage === memory.id;

              return (
                <div
                  key={memory.id}
                  className={`group p-2.5 rounded-lg border transition-all ${
                    isSuperseded
                      ? "bg-white/[0.02] border-white/[0.04] opacity-60"
                      : "bg-white/[0.04] border-white/[0.06] hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs text-white/70 leading-relaxed flex-1">
                      {isSuperseded && (
                        <span className="text-amber-400/70 text-[9px] font-medium mr-1.5">SUPERSEDED</span>
                      )}
                      {memory.text}
                    </p>
                    <button
                      onClick={() => onDeleteMemory(memory.id)}
                      disabled={deleting === memory.id}
                      className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-all disabled:opacity-50"
                      title="Delete memory"
                    >
                      {deleting === memory.id ? (
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                      memory.category === "fact" ? "bg-blue-500/20 text-blue-300" :
                      memory.category === "preference" ? "bg-purple-500/20 text-purple-300" :
                      memory.category === "behavior" ? "bg-amber-500/20 text-amber-300" :
                      memory.category === "context" ? "bg-cyan-500/20 text-cyan-300" :
                      memory.category === "decision" ? "bg-rose-500/20 text-rose-300" :
                      memory.category === "note" ? "bg-slate-500/20 text-slate-300" :
                      memory.category === "reflection" ? "bg-indigo-500/20 text-indigo-300" :
                      "bg-emerald-500/20 text-emerald-300"
                    }`}>
                      {memory.category}
                    </span>
                    <span className="text-[9px] text-white/25">importance: {memory.importance}/10</span>
                    {memory.score !== undefined && (
                      <span className="text-[9px] text-white/25">relevance: {(memory.score * 100).toFixed(0)}%</span>
                    )}
                    {hasLineage && (
                      <button
                        onClick={() => onToggleLineage(memory.id)}
                        className="text-[9px] text-purple-400/60 hover:text-purple-300 transition-colors"
                        title="View memory lineage"
                      >
                        {isExpanded ? "hide lineage" : "lineage"}
                      </button>
                    )}
                    <span className="text-[9px] text-white/25 ml-auto">
                      {new Date(memory.createdAt).toLocaleDateString()}
                    </span>
                  </div>

                  {/* Lineage panel */}
                  {isExpanded && (
                    <div className="mt-2 pt-2 border-t border-white/[0.06]">
                      {lineageLoading === memory.id ? (
                        <p className="text-[10px] text-white/30">Loading lineage...</p>
                      ) : lineage && (lineage.older.length > 0 || lineage.newer.length > 0) ? (
                        <div className="space-y-1">
                          {lineage.newer.map((entry) => (
                            <div key={entry.id} className="flex items-start gap-1.5 text-[10px]">
                              <span className="text-green-400/60 shrink-0 mt-px" title="Newer version">&#x25B2;</span>
                              <span className="text-white/50">{entry.text}</span>
                              <span className="text-white/20 shrink-0 ml-auto">{new Date(entry.createdAt).toLocaleDateString()}</span>
                            </div>
                          ))}
                          <div className="flex items-start gap-1.5 text-[10px]">
                            <span className="text-purple-400/80 shrink-0 mt-px">&#x25CF;</span>
                            <span className="text-white/70 font-medium">Current</span>
                          </div>
                          {lineage.older.map((entry) => (
                            <div key={entry.id} className="flex items-start gap-1.5 text-[10px]">
                              <span className="text-amber-400/60 shrink-0 mt-px" title="Older version">&#x25BC;</span>
                              <span className="text-white/40">{entry.text}</span>
                              <span className="text-white/20 shrink-0 ml-auto">{new Date(entry.createdAt).toLocaleDateString()}</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[10px] text-white/30">No lineage chain found</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}

// ── Blocks Tab ────────────────────────────────────────────────────────────
function BlocksTab({
  blocks,
  loading,
  editingBlockId,
  editBlockContent,
  confirmingBlockDelete,
  scopeFilter,
  onContentChange,
  onScopeFilterChange,
  onStartEdit,
  onCancelEdit,
  onSaveBlock,
  onDeleteBlock,
  onCancelDelete,
}: {
  blocks: MemoryBlock[];
  loading: boolean;
  editingBlockId: string | null;
  editBlockContent: string;
  confirmingBlockDelete: string | null;
  scopeFilter: "all" | "global" | "project" | "archived";
  onContentChange: (content: string) => void;
  onScopeFilterChange: (scope: "all" | "global" | "project" | "archived") => void;
  onStartEdit: (id: string, content: string) => void;
  onCancelEdit: () => void;
  onSaveBlock: (id: string, content: string) => void;
  onDeleteBlock: (id: string) => void;
  onCancelDelete: () => void;
}) {
  return (
    <div className="p-4 space-y-3">
      <p className="text-white/30 text-xs">
        Structured knowledge documents maintained by the agent. Blocks organize related facts into editable documents that reduce redundant memory extraction.
      </p>

      {/* Scope filter */}
      <div className="flex gap-1">
        {(["all", "global", "project", "archived"] as const).map((scope) => (
          <button
            key={scope}
            onClick={() => onScopeFilterChange(scope)}
            className={`px-2 py-1 rounded text-xs transition-all ${
              scopeFilter === scope ? "text-white" : "text-white/40 hover:text-white/60"
            }`}
            style={{
              backgroundColor: scopeFilter === scope ? `rgba(var(--theme-secondary, 100 100 200), 0.15)` : "transparent",
            }}
          >
            {scope === "all" ? "All" : scope === "global" ? "Global" : scope === "project" ? "Project" : "Archived"}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-white/30 text-xs py-4 text-center">Loading blocks...</p>
      ) : blocks.length === 0 ? (
        <p className="text-white/30 text-xs py-4 text-center">No memory blocks yet. The agent will create blocks as it learns about recurring topics.</p>
      ) : (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {blocks
            .filter((b) => scopeFilter === "all" || b.scope === scopeFilter)
            .map((block) => (
              <div
                key={block.id}
                className="group rounded-lg p-3 transition-all"
                style={{
                  backgroundColor: "rgba(255, 255, 255, 0.03)",
                  border: "1px solid rgba(255, 255, 255, 0.08)",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-white/80">{block.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                        block.scope === "global" ? "bg-blue-500/15 text-blue-300" :
                        block.scope === "project" ? "bg-emerald-500/15 text-emerald-300" :
                        "bg-amber-500/15 text-amber-300"
                      }`}>
                        {block.scope}
                      </span>
                      <span className="text-[10px] text-white/25">{block.tokenEstimate}t</span>
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">{block.description}</p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => editingBlockId === block.id ? onCancelEdit() : onStartEdit(block.id, block.content)}
                      className="p-1 rounded hover:bg-white/10 text-white/30 hover:text-white/60"
                      title="Edit"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    {confirmingBlockDelete === block.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => onDeleteBlock(block.id)}
                          className="px-2 py-0.5 rounded bg-red-500/15 border border-red-400/25 text-red-300 hover:bg-red-500/25 text-xs font-medium"
                        >
                          Confirm
                        </button>
                        <button
                          onClick={onCancelDelete}
                          className="px-2 py-0.5 rounded bg-white/10 border border-white/15 text-white/50 hover:text-white/80 text-xs font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => onDeleteBlock(block.id)}
                        className="p-1 rounded hover:bg-red-500/20 text-white/30 hover:text-red-400"
                        title="Delete"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                      </button>
                    )}
                  </div>
                </div>

                {editingBlockId === block.id ? (
                  <div className="mt-2 space-y-2">
                    <textarea
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 resize-y outline-none focus:ring-1 focus:ring-blue-400/30"
                      value={editBlockContent}
                      onChange={(e) => onContentChange(e.target.value)}
                      rows={6}
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={onCancelEdit}
                        className="px-2 py-1 text-xs text-white/40 hover:text-white/60"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => onSaveBlock(block.id, editBlockContent)}
                        className="px-2 py-1 text-xs rounded"
                        style={{
                          backgroundColor: `rgba(var(--theme-secondary, 100 100 200), 0.15)`,
                          color: `rgba(var(--theme-secondary-text, 160 160 255))`,
                        }}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1.5 text-xs text-white/50 whitespace-pre-wrap line-clamp-3">
                    {block.content}
                  </p>
                )}

                <div className="mt-1.5 text-[10px] text-white/25">
                  Updated {block.updatedAt.slice(0, 10)} by {block.updatedBy}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
