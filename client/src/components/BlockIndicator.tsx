import { useState, useRef, useEffect, useCallback } from "react";
import { fetchMemoryBlocks, fetchBlockHistory } from "../api/client";
import type { MemoryBlock } from "../types";

interface Props {
  projectId?: string;
}

// Hide blocks that are NOT loaded into the chat's system prompt. The zeitgeist
// continuity block IS loaded (as the "Continuity Context" section), so it
// stays visible. Archives, synthesis, and notebook-cycle blocks are only
// reachable via search/read_memory_block and shouldn't appear here.
function isUserBlock(b: MemoryBlock): boolean {
  if (b.id.startsWith("blk-archive-")) return false;
  if (b.id.startsWith("blk-synth-")) return false;
  if (b.id.startsWith("blk-notebook-")) return false;
  return true;
}

export function BlockIndicator({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<MemoryBlock[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedBlockId, setExpandedBlockId] = useState<string | null>(null);
  const [history, setHistory] = useState<MemoryBlock[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedBlockId(null);
        setHistory(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Reset cached blocks when projectId changes (different chat/project)
  const lastProjectIdRef = useRef(projectId);
  if (lastProjectIdRef.current !== projectId) {
    lastProjectIdRef.current = projectId;
    setBlocks(null);
    setOpen(false);
    setExpandedBlockId(null);
    setHistory(null);
  }

  const handleClick = useCallback(() => {
    const opening = !open;
    setOpen(opening);
    if (opening && !blocks) {
      setLoading(true);
      Promise.all([
        fetchMemoryBlocks("global"),
        projectId ? fetchMemoryBlocks("project", projectId) : Promise.resolve([]),
      ])
        .then(([global, project]) => setBlocks([...global, ...project].filter(isUserBlock)))
        .catch(() => setBlocks([]))
        .finally(() => setLoading(false));
    }
  }, [open, blocks, projectId]);

  const handleBlockClick = useCallback((blockId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (expandedBlockId === blockId) {
      setExpandedBlockId(null);
      setHistory(null);
    } else {
      setExpandedBlockId(blockId);
      setHistory(null);
    }
  }, [expandedBlockId]);

  const handleViewHistory = useCallback(async (block: MemoryBlock, e: React.MouseEvent) => {
    e.stopPropagation();
    if (expandedBlockId !== block.id) {
      setExpandedBlockId(block.id);
    }
    setLoadingHistory(true);
    try {
      const hist = await fetchBlockHistory(block.id);
      setHistory(hist);
    } catch {
      setHistory([]);
    } finally {
      setLoadingHistory(false);
    }
  }, [expandedBlockId]);

  const handleCopyContent = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      // Fallback or silent fail
    }
  }, []);

  const handleEditBlock = useCallback((block: MemoryBlock, e: React.MouseEvent) => {
    e.stopPropagation();
    // TODO: Open edit modal - for now, just log
    console.log("Edit block:", block.id);
  }, []);

  const count = blocks?.length;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleClick}
        className="flex items-center gap-1 text-xs text-white/35 hover:text-white/55 transition-colors px-1.5 py-1"
        title="Memory blocks loaded for this chat"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {count != null && <span>{count}</span>}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 min-w-[280px] max-w-[400px] backdrop-blur-xl border rounded-xl shadow-2xl py-2 px-1"
          style={{
            backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
            borderColor: `rgba(var(--theme-primary-border))`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2 pb-1.5 text-[10px] uppercase tracking-wider text-white/30 font-medium">
            Loaded Memory Blocks
          </div>

          {loading ? (
            <div className="px-2 py-3 text-xs text-white/30 text-center">Loading...</div>
          ) : !blocks || blocks.length === 0 ? (
            <div className="px-2 py-3 text-xs text-white/30 text-center">No blocks loaded</div>
          ) : (
            <div className="max-h-[400px] overflow-y-auto space-y-0.5">
              {blocks.map((block) => {
                const isExpanded = expandedBlockId === block.id;
                return (
                  <div
                    key={block.id}
                    className={`rounded-lg transition-all ${
                      isExpanded
                        ? "bg-white/10 border border-white/20"
                        : "hover:bg-white/5"
                    }`}
                  >
                    {/* Block header - clickable */}
                    <div
                      onClick={(e) => handleBlockClick(block.id, e)}
                      className="px-2 py-1.5 cursor-pointer"
                    >
                      <div className="flex items-center gap-1.5">
                        {/* Expand/collapse arrow */}
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`text-white/40 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        
                        <span className="text-xs text-white/70 font-medium truncate flex-1">{block.name}</span>
                        <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${
                          block.scope === "global" ? "bg-blue-500/15 text-blue-300" : "bg-emerald-500/15 text-emerald-300"
                        }`}>
                          {block.scope}
                        </span>
                      </div>
                      <p className="text-[10px] text-white/35 truncate mt-0.5 flex items-center gap-1">
                        {block.description}
                        <span className="text-white/20 shrink-0">• {block.tokenEstimate} tokens</span>
                      </p>
                    </div>

                    {/* Expanded content */}
                    {isExpanded && (
                      <div className="px-2 pb-2 border-t border-white/10 mt-1 pt-2">
                        {/* Action buttons */}
                        <div className="flex items-center gap-1 mb-2">
                          <button
                            onClick={(e) => handleViewHistory(block, e)}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/80 transition-colors"
                            title="View revision history"
                          >
                            History
                          </button>
                          <button
                            onClick={(e) => handleEditBlock(block, e)}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/80 transition-colors"
                            title="Edit block"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleCopyContent(block.content)}
                            className="text-[9px] px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white/80 transition-colors ml-auto"
                            title="Copy content"
                          >
                            Copy
                          </button>
                        </div>

                        {/* History view */}
                        {history !== null && (
                          <div className="mb-2 pb-2 border-b border-white/10">
                            <div className="text-[9px] text-white/40 mb-1">Revision history ({history.length} versions)</div>
                            <div className="max-h-[150px] overflow-y-auto space-y-1">
                              {loadingHistory ? (
                                <div className="text-xs text-white/30">Loading...</div>
                              ) : history.length === 0 ? (
                                <div className="text-xs text-white/30">No history</div>
                              ) : (
                                history.map((h, idx) => (
                                  <div key={h.id} className="text-[9px] p-1 rounded bg-white/5">
                                    <div className="flex items-center gap-1">
                                      <span className="text-white/50">[{idx + 1}]</span>
                                      <span className="text-white/60">{h.updatedAt.slice(0, 10)}</span>
                                      <span className="text-white/40">by {h.updatedBy}</span>
                                      {h.id === block.id && <span className="text-emerald-400/70 ml-auto">(current)</span>}
                                    </div>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        )}

                        {/* Full content */}
                        <div className="max-h-[200px] overflow-y-auto">
                          <div className="text-[10px] text-white/50 mb-1">Content:</div>
                          <pre className="text-[10px] text-white/60 whitespace-pre-wrap font-sans leading-relaxed">
                            {block.content}
                          </pre>
                        </div>

                        {/* Footer metadata */}
                        <div className="mt-2 pt-1.5 border-t border-white/10">
                          <div className="flex items-center gap-2 text-[9px] text-white/35">
                            <span>Updated: {block.updatedAt.slice(0, 10)}</span>
                            <span>by {block.updatedBy}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
