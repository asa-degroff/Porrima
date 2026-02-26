import type { MessageUsage } from "../types";

interface Props {
  usage: MessageUsage;
  contextWindow: number;
}

function formatNumber(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

export function TokenIndicator({ usage, contextWindow }: Props) {
  if (usage.totalTokens === 0) return null;

  const pct = Math.min((usage.totalTokens / contextWindow) * 100, 100);

  return (
    <div className="flex items-center gap-2 text-xs text-white/40">
      <div className="flex items-center gap-1.5">
        <span title="Input tokens">&#8593;{formatNumber(usage.input)}</span>
        <span title="Output tokens">&#8595;{formatNumber(usage.output)}</span>
        <span className="text-white/20">·</span>
        <span>
          {formatNumber(usage.totalTokens)} / {formatNumber(contextWindow)}
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
    </div>
  );
}
