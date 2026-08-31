/**
 * Shared timing constants for the activity indicators.
 *
 * The polyhedron decode animation (PolyhedronLogo) advances a JS phase
 * machine: a "spinning" transition (fixed duration + per-shape stagger),
 * a short pause, a "returning" transition, another pause, then a new
 * random target. Because the durations and staggers are constants, the
 * phase boundaries are deterministic — only the target orientations are
 * random — so one full pulse (spin out, settle back) is a stable period
 * that other indicators can sync to. The Beats indicator (five-square
 * tool-call activity strip) runs one 12-step beat per pulse.
 */

// Polyhedron decode phase machine (count-agnostic; stagger scales with count)
export const POLY_SPIN_MS = 600
export const POLY_SPIN_STAGGER_MS = 50
export const POLY_RETURN_MS = 700
export const POLY_RETURN_STAGGER_MS = 35
export const POLY_IDLE_MS = 500
export const POLY_SPIN_PAUSE_MS = 80
export const POLY_RETURN_PAUSE_MS = 120

/** The streaming-bubble instance — where tool rows (and therefore the
 *  Beats indicator) are co-located. */
export const POLY_DEFAULT_COUNT = 5
export const POLY_DEFAULT_SPEED = 1

/** Duration of one decode pulse (two phases: spinning + returning,
 *  including the inter-phase pauses) for a given count and speed.
 *  Default (count 5, speed 1) = 800 + 80 + 840 + 120 = 1840 ms. */
export function polyhedronPulseMs(count: number = POLY_DEFAULT_COUNT, speed: number = POLY_DEFAULT_SPEED): number {
  const spinEnd = POLY_SPIN_MS + (count - 1) * POLY_SPIN_STAGGER_MS
  const returnEnd = POLY_RETURN_MS + (count - 1) * POLY_RETURN_STAGGER_MS
  return (spinEnd + POLY_SPIN_PAUSE_MS + returnEnd + POLY_RETURN_PAUSE_MS) / speed
}

// Beats (five-square tool-call activity strip)
export const BEAT_STEPS_PER_BEAT = 12
export const BEAT_BEATS_PER_ROTATION = 5
/** Opacity of the "partial" fill state (full = 1, off = 0). */
export const BEAT_PARTIAL_OPACITY = 0.35
/** Opacity of the always-visible square outline. */
export const BEAT_OUTLINE_OPACITY = 0.45
/** Lightness of the fill, matching the activity-color swatch in
 *  Settings so the strip shows the user's configured hue verbatim. */
export const BEAT_FILL_LIGHTNESS = 55
/** Default beat cycle: one polyhedron pulse at the co-located instance.
 *  One beat = one pulse → the marker ticks once per polyhedron breath. */
export const BEAT_CYCLE_MS = polyhedronPulseMs()
