import { useState, useRef, useEffect, useCallback } from "react";
import { fetchMemoryBlocks } from "../api/client";
import type { MemoryBlock } from "../types";

interface Props {
  projectId?: string;
}

export function BlockIndicator({ projectId }: Props) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState<MemoryBlock[] | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleClick = useCallback(() => {
    const opening = !open;
    setOpen(opening);
    if (opening && !blocks) {
      setLoading(true);
      // Fetch global blocks + project blocks if applicable
      Promise.all([
        fetchMemoryBlocks("global"),
        projectId ? fetchMemoryBlocks("project", projectId) : Promise.resolve([]),
      ])
        .then(([global, project]) => setBlocks([...global, ...project]))
        .catch(() => setBlocks([]))
        .finally(() => setLoading(false));
    }
  }, [open, blocks, projectId]);

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
          <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
          <path d="M16 3H8l-2 4h12L16 3z" />
        </svg>
        {count != null && <span>{count}</span>}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 min-w-[240px] max-w-[320px] backdrop-blur-xl border rounded-xl shadow-2xl py-2 px-1"
          style={{
            backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
            borderColor: `rgba(var(--theme-primary-border))`,
          }}
        >
          <div className="px-2 pb-1.5 text-[10px] uppercase tracking-wider text-white/30 font-medium">
            Loaded Memory Blocks
          </div>

          {loading ? (
            <div className="px-2 py-3 text-xs text-white/30 text-center">Loading...</div>
          ) : !blocks || blocks.length === 0 ? (
            <div className="px-2 py-3 text-xs text-white/30 text-center">No blocks loaded</div>
          ) : (
            <div className="max-h-[300px] overflow-y-auto space-y-0.5">
              {blocks.map((block) => (
                <div
                  key={block.id}
                  className="px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-white/70 font-medium truncate flex-1">{block.name}</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${
                      block.scope === "global" ? "bg-blue-500/15 text-blue-300" : "bg-emerald-500/15 text-emerald-300"
                    }`}>
                      {block.scope}
                    </span>
                  </div>
                  <p className="text-[10px] text-white/35 truncate mt-0.5">{block.description}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
