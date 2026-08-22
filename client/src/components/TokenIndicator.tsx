import { useState, useRef, useEffect, useCallback } from "react";
import type { MessageUsage, ContextBreakdown, ContextBreakdownGroup } from "../types";
import { fetchContextBreakdown } from "../api/client";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape } from "../hooks/useActivityStyle";

interface CompactionInfo {
  removedCount: number;
  remainingCount: number;
}

interface Props {
  chatId?: string;
  usage: MessageUsage;
  /** True when `usage` is a post-compaction estimate rather than a real LLM-reported count. */
  isEstimated?: boolean;
  contextWindow: number;
  compacting?: boolean;
  compaction?: CompactionInfo | null;
  hasCompactionSummary?: boolean;
  onClick?: () => void;
}

function formatNumber(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

const GROUP_COLORS: Record<ContextBreakdownGroup, { bar: string; text: string; dot: string }> = {
  system:       { bar: "rgb(167 139 250)", text: "text-violet-300",  dot: "bg-violet-400" },
  memory:       { bar: "rgb(52 211 153)",  text: "text-emerald-300", dot: "bg-emerald-400" },
  tools:        { bar: "rgb(251 191 36)",  text: "text-amber-300",   dot: "bg-amber-400" },
  conversation: { bar: "rgb(96 165 250)",  text: "text-blue-300",    dot: "bg-blue-400" },
  output:       { bar: "rgb(244 114 182)", text: "text-pink-300",    dot: "bg-pink-400" },
};

const GROUP_ORDER: ContextBreakdownGroup[] = ["system", "memory", "tools", "conversation", "output"];

// Module-level cache keyed by chatId so repeated hover/open doesn't refetch.
const breakdownCache = new Map<string, { data: ContextBreakdown; timestamp: number }>();
const CACHE_TTL_MS = 15_000;

function BreakdownPopover({ breakdown, loading, contextWindow }: {
  breakdown: ContextBreakdown | null;
  loading: boolean;
  contextWindow: number;
}) {
  return (
    <div
      className="absolute right-0 top-full mt-1.5 z-40 w-72 app-solid-popover border rounded-xl shadow-2xl py-2 px-1 animate-dropdown-enter"
      style={{
        backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
        borderColor: `rgba(var(--theme-primary-border))`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-2 pb-1.5 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-white/30 font-medium">Context breakdown</span>
        {breakdown && (
          <span className="text-[10px] text-white/30">
            {formatNumber(breakdown.totalTokens)} / {formatNumber(contextWindow)}
          </span>
        )}
      </div>

      {loading && !breakdown ? (
        <div className="px-2 py-4 text-xs text-white/30 text-center">Loading...</div>
      ) : !breakdown ? (
        <div className="px-2 py-4 text-xs text-white/30 text-center">No data available</div>
      ) : (
        <div className="px-2 space-y-2">
          {/* Stacked bar of group shares relative to the context window */}
          <div className="flex h-2 w-full rounded-full overflow-hidden bg-white/10">
            {GROUP_ORDER.map((key) => {
              const g = breakdown.groups.find((x) => x.key === key);
              if (!g || g.tokens <= 0) return null;
              const pct = (g.tokens / contextWindow) * 100;
              return (
                <div
                  key={key}
                  className="shrink-0"
                  style={{ width: `${pct}%`, backgroundColor: GROUP_COLORS[key].bar }}
                  title={`${g.label}: ${formatNumber(g.tokens)}`}
                />
              );
            })}
          </div>

          {/* Group totals */}
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {GROUP_ORDER.map((key) => {
              const g = breakdown.groups.find((x) => x.key === key);
              if (!g || g.tokens <= 0) return null;
              return (
                <div key={key} className="flex items-center gap-1.5 text-[11px]">
                  <span className={`w-2 h-2 rounded-full ${GROUP_COLORS[key].dot}`} />
                  <span className="text-white/50">{g.label}</span>
                  <span className="text-white/70 font-medium tabular-nums">{formatNumber(g.tokens)}</span>
                </div>
              );
            })}
          </div>

          {/* Per-section rows, grouped */}
          <div className="border-t border-white/10 pt-1.5 max-h-56 overflow-y-auto space-y-1.5">
            {GROUP_ORDER.map((key) => {
              const rows = breakdown.rows.filter((r) => r.group === key);
              if (rows.length === 0) return null;
              const group = breakdown.groups.find((x) => x.key === key);
              return (
                <div key={key}>
                  <div className={`text-[9px] uppercase tracking-wider ${GROUP_COLORS[key].text} opacity-80 mb-0.5`}>
                    {group?.label ?? key}
                  </div>
                  {rows.map((r) => (
                    <div key={r.key} className="flex items-center justify-between text-[11px] leading-5">
                      <span className="text-white/45">{r.label}</span>
                      <span className="text-white/70 tabular-nums">
                        {formatNumber(r.tokens)}
                        <span className="text-white/25 ml-1">
                          {contextWindow > 0 ? `${((r.tokens / contextWindow) * 100).toFixed(1)}%` : ""}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Footnotes on data quality */}
          {(breakdown.estimated || !breakdown.promptCached) && (
            <div className="border-t border-white/10 pt-1.5 text-[9px] text-white/30 leading-relaxed">
              {!breakdown.promptCached
                ? "System prompt cache is cold — system sections are approximate until the next message."
                : breakdown.estimated
                  ? "No model usage yet — figures are estimates until the first response."
                  : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TokenIndicator({
  chatId,
  usage,
  isEstimated,
  contextWindow,
  compacting,
  compaction,
  hasCompactionSummary,
  onClick
}: Props) {
  const activityShape = useActivityShape();
  const [visible, setVisible] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [breakdown, setBreakdown] = useState<ContextBreakdown | null>(null);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<number | null>(null);

  // We have a usable count as long as totalTokens > 0 — whether it came from
  // the LLM's real usage or the server's post-compaction estimate. The
  // `isEstimated` flag just tells us to mark the number as provisional so the
  // user knows a confirmed count will follow.
  const hasUsageNumber = usage.totalTokens > 0;
  const isPostCompactionUnknown = !hasUsageNumber && hasCompactionSummary;

  const pct = hasUsageNumber
    ? Math.min((usage.totalTokens / contextWindow) * 100, 100)
    : 0;

  // The breakdown detail is only offered when there's no dedicated onClick
  // (the empty-chat context-window editor) and we know which chat to query.
  const breakdownEnabled = !!chatId && !onClick;

  // Reset popover state when switching chats so stale data doesn't leak across.
  useEffect(() => {
    setVisible(false);
    setPinned(false);
    setBreakdown(null);
    setLoading(false);
  }, [chatId]);

  const loadBreakdown = useCallback(async (id: string) => {
    const cached = breakdownCache.get(id);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      setBreakdown(cached.data);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchContextBreakdown(id);
      breakdownCache.set(id, { data, timestamp: Date.now() });
      setBreakdown(data);
    } catch {
      setBreakdown(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const openPopover = useCallback(() => {
    setVisible(true);
    if (chatId) loadBreakdown(chatId);
  }, [chatId, loadBreakdown]);

  const handleMouseEnter = useCallback(() => {
    if (!breakdownEnabled) return;
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      if (!pinned) openPopover();
    }, 250);
  }, [breakdownEnabled, pinned, openPopover]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (!pinned) setVisible(false);
  }, [pinned]);

  const handleClick = useCallback(() => {
    if (!breakdownEnabled) {
      onClick?.();
      return;
    }
    if (pinned) {
      setPinned(false);
      setVisible(false);
    } else {
      setPinned(true);
      openPopover();
    }
  }, [breakdownEnabled, pinned, onClick, openPopover]);

  // Close a pinned popover on outside click.
  useEffect(() => {
    if (!pinned) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPinned(false);
        setVisible(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pinned]);

  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative flex items-center gap-2 text-xs text-white/40"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ cursor: (onClick || breakdownEnabled) ? 'pointer' : 'default' }}
      title={onClick ? "Click to edit context window" : breakdownEnabled ? "Context usage — hover or click for breakdown" : undefined}
    >
      <div className="flex items-center gap-1.5">
        {hasUsageNumber ? (
          <>
            {isEstimated ? (
              <span
                className="italic"
                title="Estimated post-compaction context — will update after the next response"
              >~{formatNumber(usage.totalTokens)} / {formatNumber(contextWindow)}</span>
            ) : (
              <>
                <span>{formatNumber(usage.totalTokens)} / {formatNumber(contextWindow)}</span>
              </>
            )}
          </>
        ) : isPostCompactionUnknown ? (
          <span>{formatNumber(contextWindow)} max</span>
        ) : (
          <span>{formatNumber(contextWindow)} max</span>
        )}
      </div>
      <div className="w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${pct}%`,
            background:
              pct > 80
                ? "rgb(248 113 113 / 0.6)"
                : pct > 50
                  ? "rgb(251 191 36 / 0.5)"
                  : "rgb(96 165 250 / 0.4)",
            // Fade the bar when we're showing a provisional or missing count.
            opacity: hasUsageNumber ? (isEstimated ? 0.6 : 1) : 0.3,
          }}
        />
      </div>
      {compacting ? (
        <div className="flex items-center gap-2 text-purple-300/80 cursor-default" title="Summarizing older messages to free context space">
          <PolyhedronLogo isActive={true} count={3} size={14} gap={2} speed={0.8} shape={activityShape} />
          <span className="animate-pulse">compacting...</span>
        </div>
      ) : compaction ? (
        <span
          className="text-purple-300/60 cursor-default"
          title={`${compaction.removedCount} messages compacted, ${compaction.remainingCount} remaining`}
        >
          compacted
        </span>
      ) : hasCompactionSummary ? (
        <span
          className="text-purple-300/40 cursor-default"
          title="Context was compacted - new counts will appear after next response"
        >
          compacted
        </span>
      ) : null}

      {breakdownEnabled && visible && (
        <BreakdownPopover breakdown={breakdown} loading={loading} contextWindow={contextWindow} />
      )}
    </div>
  );
}
