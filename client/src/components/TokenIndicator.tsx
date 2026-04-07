import type { MessageUsage } from "../types";
import { OctahedronLogo } from "./OctahedronLogo";

interface CompactionInfo {
  removedCount: number;
  remainingCount: number;
}

interface Props {
  usage: MessageUsage;
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
  contextWindow, 
  compacting, 
  compaction,
  hasCompactionSummary,
  onClick
}: Props) {
  // Determine if we have real usage data or are in a post-compaction state
  // Real usage comes from Ollama's prompt_eval_count on assistant messages
  const hasRealUsage = usage.totalTokens > 0;
  const isPostCompaction = !hasRealUsage && hasCompactionSummary;
  
  // Calculate percentage for the progress bar
  // In post-compaction state, show 0% since we're awaiting new data
  const pct = hasRealUsage
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
        {hasRealUsage ? (
          <>
            <span title="Context tokens (input)">&#8593;{formatNumber(usage.input)}</span>
            <span title="Generated tokens (output)">&#8595;{formatNumber(usage.output)}</span>
            <span className="text-white/20">&middot;</span>
            <span>{formatNumber(usage.totalTokens)} / {formatNumber(contextWindow)}</span>
          </>
        ) : isPostCompaction ? (
          <>
            <span className="text-white/30 italic">context reset</span>
            <span className="text-white/20">&middot;</span>
            <span>{formatNumber(contextWindow)} max</span>
          </>
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
            // Fade the bar when we don't have real usage data
            opacity: hasRealUsage ? 1 : 0.3,
          }}
        />
      </div>
      {compacting ? (
        <div className="flex items-center gap-2 text-purple-300/80 cursor-default" title="Summarizing older messages to free context space">
          <OctahedronLogo isActive={true} count={3} size={14} gap={2} speed={0.8} />
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
