import { memo } from "react";

interface ProgressRingProps {
  /** Filled fraction, 0–100. Values are clamped. */
  pct: number;
  /** Stroke color of the filled arc (CSS color, may carry its own alpha). */
  color: string;
  /** Track color. Defaults to the same hairline the horizontal bars use. */
  track?: string;
  /** Extra opacity applied to the filled arc only — the track stays put,
   *  mirroring how the bars fade their fill without fading the track. */
  opacity?: number;
  /** Outer diameter in px. */
  size?: number;
  strokeWidth?: number;
  className?: string;
  /**
   * No per-ring tooltip: the parent containers already carry the full
   * tooltip (label - tokens - eta - slot), and the bars have none either.
   */
}

/**
 * Compact radial progress indicator — the mobile instrument for the same
 * signals the horizontal bars show at md+. One threshold/color logic feeds
 * both, so they cannot drift; the ring is the glance layer, the exact
 * numbers live in the text beside it.
 */
export const ProgressRing = memo(function ProgressRing({
  pct,
  color,
  track = "rgba(255, 255, 255, 0.1)",
  opacity = 1,
  size = 18,
  strokeWidth = 2,
  className = "",
}: ProgressRingProps) {
  const clamped = Math.max(0, Math.min(100, pct));
  // One px of margin so the stroke and its round cap never clip the viewBox edge.
  const r = (size - strokeWidth) / 2 - 1;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - clamped / 100);
  return (
    <svg
      className={`shrink-0 ${className}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Progress ${Math.round(clamped)}%`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={track}
        strokeWidth={strokeWidth}
      />
      {/* Skip the arc entirely at 0% — a zero-length dash with a round cap
          still paints a dot in some renderers. */}
      {clamped > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ opacity, transition: "stroke-dashoffset 300ms ease, opacity 300ms ease" }}
        />
      )}
    </svg>
  );
});
