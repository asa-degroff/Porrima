import { memo } from 'react'
import type { CSSProperties } from 'react'
import { useActivityHue, useActivitySaturation } from '../hooks/useActivityStyle'
import {
  BEAT_BEATS_PER_ROTATION,
  BEAT_CYCLE_MS,
  BEAT_FILL_LIGHTNESS,
  BEAT_OUTLINE_OPACITY,
  BEAT_PARTIAL_OPACITY,
  BEAT_STEPS_PER_BEAT,
} from '../lib/activityTimings'

interface Props {
  /** Square edge in px. Default 6 — fits the ~24 px tool-row header. */
  size?: number
  /** Gap between squares in px. Default 2. */
  gap?: number
  /** One beat (the fill/drain cycle) in ms. Default = one polyhedron
   *  decode pulse at the co-located streaming-bubble instance
   *  (1840 ms), so the strip breathes with the agent indicator. */
  cycleMs?: number
  className?: string
}

/**
 * Five Beats — activity indicator for tool calls.
 *
 * Five squares, each an LED with three states: off, partial, full.
 * One beat: the partial fill sweeps left→right, holds, drains
 * left→right (12 steps). Exactly one square holds the full (opaque)
 * fill for its beat, then the marker advances one position to the
 * right — five beats complete one rotation. Pure opacity, no movement.
 *
 * Implementation: two stacked fill layers per square, both animating
 * opacity only (compositor-friendly, zero layout work). The wave layer
 * (`beat-wave`, one beat per cycle) is phase-shifted per square with a
 * negative delay of (i − 12) steps; the marker layer (`beat-marker`,
 * one rotation per cycle) is shifted by (i − 5) beats. The marker
 * layer sits on top, so a square that IS the marker stays fully opaque
 * even while the wave passes through it. Keyframes live in glass.css.
 *
 * Color comes from the user-configured activity style (same context as
 * the polyhedra), at the lightness the Settings swatch uses. Corner
 * shape inherits the global `corner-shape: squircle` rule. Under
 * prefers-reduced-motion the animation collapses to a static frame:
 * one full square + four partial.
 */
export const Beats = memo(function Beats({ size = 6, gap = 2, cycleMs = BEAT_CYCLE_MS, className = '' }: Props) {
  const hue = useActivityHue()
  const saturation = useActivitySaturation()

  const fill = `hsl(${hue}, ${saturation}%, ${BEAT_FILL_LIGHTNESS}%)`
  const style = {
    gap: `${gap}px`,
    '--beat-cycle': `${cycleMs}ms`,
    '--beat-partial': BEAT_PARTIAL_OPACITY,
  } as CSSProperties

  return (
    <span
      className={`beats inline-flex shrink-0 items-center ${className}`}
      style={style}
      aria-hidden="true"
    >
      {Array.from({ length: BEAT_BEATS_PER_ROTATION }, (_, i) => (
        <span
          key={i}
          className="beat-sq"
          style={{
            width: size,
            height: size,
            // 30 % of the square, scaled with the user's corner-radius
            // preference (--radius-scale, set on <html>).
            borderRadius: `calc(${(size * 0.3).toFixed(2)}px * var(--radius-scale, 1))`,
            borderColor: `hsl(${hue}, ${saturation}%, ${BEAT_FILL_LIGHTNESS}% / ${BEAT_OUTLINE_OPACITY})`,
          }}
        >
          <i
            className="beat-wave-layer"
            style={{
              background: fill,
              animationDelay: `calc(var(--beat-cycle) * ${i / BEAT_STEPS_PER_BEAT - 1})`,
            }}
          />
          <i
            className="beat-marker-layer"
            style={{
              background: fill,
              boxShadow: `0 0 ${Math.max(2, Math.round(size * 0.5))}px hsl(${hue}, ${saturation}%, ${BEAT_FILL_LIGHTNESS}% / 0.35)`,
              animationDelay: `calc(var(--beat-cycle) * ${i - BEAT_BEATS_PER_ROTATION})`,
            }}
          />
        </span>
      ))}
    </span>
  )
})
