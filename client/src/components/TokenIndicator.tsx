import type { MessageUsage } from "../types";

interface CompactionInfo {
  removedCount: number;
  remainingCount: number;
}

interface Props {
  usage: MessageUsage;
  contextWindow: number;
  compaction?: CompactionInfo | null;
}

function formatNumber(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

export function TokenIndicator({ usage, contextWindow, compaction }: Props) {
  // Always show the indicator - even with 0 tokens, show the context window
  // This prevents the "blank" appearance when usage data is missing
  const pct = usage.totalTokens > 0 
    ? Math.min((usage.totalTokens / contextWindow) * 100, 100)
    : 0;

  return (
    <div className="flex items-center gap-2 text-xs text-white/40">
      <div className="flex items-center gap-1.5">
        <span title="Context tokens (input)">&#8593;{formatNumber(usage.input)}</span>
        <span title="Generated tokens (output)">&#8595;{formatNumber(usage.output)}</span>
        <span className="text-white/20">&middot;</span>
        <span>
          {usage.totalTokens > 0 
            ? `${formatNumber(usage.totalTokens)} / ${formatNumber(contextWindow)}`
            : `${formatNumber(contextWindow)} max`}
        </span>
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
          }}
        />
      </div>
      {compaction && (
        <span
          className="text-purple-300/60 cursor-default"
          title={`${compaction.removedCount} messages compacted, ${compaction.remainingCount} remaining`}
        >
          compacted
        </span>
      )}
    </div>
  );
}
