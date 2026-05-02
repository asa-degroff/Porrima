import type { MessageUsage } from "../types";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape } from "../hooks/useActivityStyle";

interface CompactionInfo {
  removedCount: number;
  remainingCount: number;
}

interface Props {
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

export function TokenIndicator({
  usage,
  isEstimated,
  contextWindow,
  compacting,
  compaction,
  hasCompactionSummary,
  onClick
}: Props) {
  const activityShape = useActivityShape();
  // We have a usable count as long as totalTokens > 0 — whether it came from
  // the LLM's real usage or the server's post-compaction estimate. The
  // `isEstimated` flag just tells us to mark the number as provisional so the
  // user knows a confirmed count will follow.
  const hasUsageNumber = usage.totalTokens > 0;
  const isPostCompactionUnknown = !hasUsageNumber && hasCompactionSummary;

  const pct = hasUsageNumber
    ? Math.min((usage.totalTokens / contextWindow) * 100, 100)
    : 0;

  return (
    <div 
      className="flex items-center gap-2 text-xs text-white/40"
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
      title={onClick ? "Click to edit context window" : undefined}
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
                <span className="hidden md:inline" title="Context tokens (input)">&#8593;{formatNumber(usage.input)}</span>
                <span className="hidden md:inline" title="Generated tokens (output)">&#8595;{formatNumber(usage.output)}</span>
                <span className="hidden md:inline text-white/20">&middot;</span>
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
    </div>
  );
}
