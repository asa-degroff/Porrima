import { useState, memo } from "react";

export interface CompactionData {
  removedCount: number;
  summary: string;
  messageIndex: number; // Index in messages array where summary was inserted
  timestamp: number;
}

export interface MidTurnCompactionData {
  removedCount?: number;
  cycle?: number;
  timestamp: number;
}

interface Props {
  compaction: CompactionData;
}

interface MidTurnProps {
  midTurn: MidTurnCompactionData;
}

/**
 * Renders a collapsible indicator showing where messages were compacted.
 * Replaces the summary message bubble with a more compact, expandable UI.
 */
export const CompactionIndicator = memo(function CompactionIndicator({ compaction }: Props) {
  const [expanded, setExpanded] = useState(false);

  const formattedDate = new Date(compaction.timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="my-3 flex justify-center">
      <div
        className="max-w-md w-full cursor-pointer transition-all duration-200"
        onClick={() => setExpanded(!expanded)}
        style={{
          backgroundColor: "rgba(255, 255, 255, 0.03)",
          border: "1px solid rgba(255, 255, 255, 0.08)",
          borderRadius: "12px",
        }}
      >
        {/* Collapsed Header */}
        <div className="px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            {/* Compact icon */}
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
              style={{
                backgroundColor: "rgba(147, 197, 253, 0.15)",
                border: "1px solid rgba(147, 197, 253, 0.3)",
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-blue-300"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white/70">
                {compaction.removedCount} message{compaction.removedCount !== 1 ? "s" : ""} compacted
              </div>
              <div className="text-xs text-white/40">{formattedDate}</div>
            </div>
          </div>
          {/* Expand/collapse chevron */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-white/30 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>

        {/* Expanded Summary Panel */}
        {expanded && (
          <div
            className="px-4 pb-3 pt-0 border-t"
            style={{
              borderColor: "rgba(255, 255, 255, 0.06)",
            }}
          >
            <div className="mt-3 text-xs text-white/50 leading-relaxed whitespace-pre-wrap">
              {compaction.summary}
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-white/30">
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
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>Previous conversation context preserved above</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Renders a collapsible indicator for mid-turn compaction events.
 * Shows a compact, non-intrusive divider with cycle info that can be
 * expanded to see the handoff summary.
 */
export const MidTurnCompactionIndicator = memo(function MidTurnCompactionIndicator({ midTurn }: MidTurnProps) {
  const [expanded, setExpanded] = useState(false);

  const formattedDate = new Date(midTurn.timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const removedCount = midTurn.removedCount ?? 0;
  const cycle = midTurn.cycle ?? 0;

  return (
    <div className="my-3 flex justify-center">
      <div
        className="max-w-md w-full cursor-pointer transition-all duration-200"
        onClick={() => setExpanded(!expanded)}
        style={{
          backgroundColor: "rgba(147, 197, 253, 0.04)",
          border: "1px solid rgba(147, 197, 253, 0.15)",
          borderRadius: "12px",
        }}
      >
        {/* Collapsed Header */}
        <div className="px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            {/* Compaction icon */}
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
              style={{
                backgroundColor: "rgba(147, 197, 253, 0.15)",
                border: "1px solid rgba(147, 197, 253, 0.3)",
              }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-blue-300"
              >
                <polyline points="16 16 12 11 16 6" />
                <line x1="8" y1="6" x2="3" y2="6" />
                <line x1="8" y1="12" x2="3" y2="12" />
                <line x1="8" y1="18" x2="3" y2="18" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-blue-200/70">
                Context compacted
                {cycle > 0 && <span className="text-blue-300/40 text-xs ml-1.5">#{cycle}</span>}
              </div>
              <div className="text-xs text-white/40">
                {removedCount > 0
                  ? `${removedCount} message${removedCount !== 1 ? "s" : ""} removed · ${formattedDate}`
                  : formattedDate}
              </div>
            </div>
          </div>
          {/* Expand/collapse chevron */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-white/30 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      </div>
    </div>
  );
});
