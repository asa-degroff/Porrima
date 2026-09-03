/**
 * Unified context-pressure estimation and turn-guard decisions.
 *
 * Phase 1 of docs/design/turn-engine.md. One estimator replaces the three
 * dialects that had drifted (chat.ts inline anchor+exact+char; the headless
 * hook's anchor+chars/4; the char-only fallbacks), and one pure function
 * owns the iteration-cap decisions that existed
 * verbatim in both routes.
 *
 * The estimate is THREE numbers, not one — and the mapping to triggers is
 * the contract (doc §4.2):
 *
 *   | Decision          | Ratio | Number that drives it               |
 *   |-------------------|-------|-------------------------------------|
 *   | mid-turn normal   | 0.85  | refinedTokens                       |
 *   | mid-turn hard-cap | 0.95  | hardCapTokens                       |
 *   | end-of-turn       | 0.80  | max(rawUsageTotal, estimatedTokens) |
 *   | pre-send          | 0.85  | pre-send's own re-measurement (untouched) |
 *
 * The ratios stay call-site parameters, not estimator properties: this
 * module reports numbers (and pure guard decisions); the call site decides.
 * A phase that changes which number drives which trigger changes production
 * trigger behavior and must do so as a named delta, never as a side effect
 * of consolidation.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { Chat } from "../types.js";
import {
  COMPACTION_HARD_CAP_RATIO,
  COMPACTION_TRIGGER_RATIO,
  estimateContextBreakdown,
  estimateContextTokensWithExactToolResults,
  estimateHardCapTokens,
  type ContextEstimateBreakdown,
} from "./compaction.js";

export interface PressureEstimate {
  /** Conservative estimate (positive-delta-only). Drives END-OF-TURN, maxed
   *  with the last measured usage (`endOfTurnNeedsCompaction`). */
  estimatedTokens: number;
  /** Refined display estimate. Drives the mid-turn NORMAL trigger (0.85)
   *  and the client token indicator. */
  refinedTokens: number;
  /** Conservative upper bound. Drives the mid-turn HARD-CAP guard (0.95). */
  hardCapTokens: number;
  /** Raw usage.totalTokens of the last measured call (0 = no anchor). */
  rawUsageTotal: number;
  /** Which path produced the numbers: exact tokenization ran, a usage
   *  anchor (live or row-scanned) drove the estimate, or only the char
   *  estimate. Callers must treat "char_estimate" as conservative — it
   *  drives the hard-cap ratio (0.95), never the normal trigger (0.85/0.80).
   *  The documented invariant (doc §4.2 semantics, path 3). */
  selectedPath: "exact" | "usage_anchor" | "char_estimate";
  errors: string[];
  /** The anchor/char breakdown underneath — observation logging. */
  contextBreakdown: ContextEstimateBreakdown;
  // Exact-path provenance (zeros when the exact path did not run):
  exactToolResultCount: number;
  /** Positive-only exact-token delta applied to `estimatedTokens`. */
  exactDelta: number;
  /** Signed exact-token delta applied to `refinedTokens`. */
  signedExactDelta: number;
  exactElapsedMs: number;
  /** Pre-exact base numbers (observation logging). */
  approximateTokens: number;
  approximateDisplayTokens: number;
  approximateHardCapTokens: number;
}

export interface PressureEstimateParams {
  messages: Chat["messages"];
  systemPrompt: string;
  /** AgentTool[] in practice — the estimator only serializes it for the
   *  char estimate, so the parameter stays `unknown` like the breakdown. */
  tools: unknown;
  contextWindow: number;
  /** Tool results produced AFTER the last usage measurement (the next
   *  prompt's input). Only used when `lastUsageTotal` is set: the anchor
   *  path adds their text on top. The char path already counts them via
   *  the rows. */
  postUsageToolResults?: ToolResultMessage[];
  /** Measured totalTokens of the last completed call (usage anchor). When
   *  set, it overrides any anchor found by scanning `messages` — the rows
   *  lag the live context in headless turns, and the just-completed
   *  message is the truth. */
  lastUsageTotal?: number;
  /** llamacpp capability — enables the exact tool-result tokenization path
   *  when present. The existing self-gating applies (no HTTP below 70% of
   *  window / 16k-char results, max 12 candidates). Ignored when
   *  `lastUsageTotal` is set: the exact path scans its anchor from the
   *  rows, which would be stale relative to a live anchor. */
  exact?: { baseUrl: string; modelId: string; chatId: string; phase: string };
  /** Optional observation sink, called with the final estimate. The return
   *  value is the primary channel; this is for callers that prefer push. */
  onObservation?: (obs: PressureEstimate) => void;
}

/**
 * The unified context-pressure estimate.
 *
 * Semantics (all already implemented somewhere; this is consolidation —
 * doc §4.2):
 *
 * 1. **Anchor available + exact capability**: delegates to
 *    `estimateContextTokensWithExactToolResults` on the row-scanned
 *    anchor/char base (chat.ts production path; self-gating applies).
 * 2. **Live anchor, no exact**: `lastUsageTotal + ceil(postUsageChars / 4)`
 *    — the headless hook's current arithmetic, promoted to the shared path.
 * 3. **Scanned anchor, no exact**: the breakdown's own dual path
 *    (conservative = max(anchor, char), display = anchor, hard cap bounded
 *    relative to the anchor).
 * 4. **No anchor**: the char estimate — conservative; callers drive the
 *    hard-cap ratio with it, never the normal trigger.
 */
export async function estimateContextPressure(params: PressureEstimateParams): Promise<PressureEstimate> {
  const {
    messages,
    systemPrompt,
    tools,
    contextWindow,
    lastUsageTotal,
    postUsageToolResults,
    exact,
    onObservation,
  } = params;

  // The anchor/char breakdown as seen in the rows: base for every path and
  // the observation-logging provenance.
  const breakdown = estimateContextBreakdown(messages, systemPrompt, tools);

  const liveAnchor = lastUsageTotal && lastUsageTotal > 0 ? lastUsageTotal : 0;
  const zeros = {
    exactToolResultCount: 0,
    exactDelta: 0,
    signedExactDelta: 0,
    exactElapsedMs: 0,
  };

  let estimate: PressureEstimate;

  if (exact && liveAnchor === 0) {
    // Path 1: exact tool-result tokenization on top of the row-scanned
    // anchor/char base. Delegates entirely to the existing self-gating
    // function — same numbers, one call site instead of an inline copy.
    const e = await estimateContextTokensWithExactToolResults(messages, systemPrompt, tools, {
      baseUrl: exact.baseUrl,
      modelId: exact.modelId,
      chatId: exact.chatId,
      phase: exact.phase,
      contextWindow,
    });
    estimate = {
      estimatedTokens: e.estimatedTokens,
      refinedTokens: e.refinedTokens,
      hardCapTokens: e.hardCapTokens,
      rawUsageTotal: e.contextBreakdown.lastUsageTotal ?? 0,
      selectedPath:
        e.exactToolResultCount > 0
          ? "exact"
          : e.contextBreakdown.selectedPath === "usage_anchor"
            ? "usage_anchor"
            : "char_estimate",
      errors: e.errors,
      contextBreakdown: e.contextBreakdown,
      exactToolResultCount: e.exactToolResultCount,
      exactDelta: e.exactDelta,
      signedExactDelta: e.signedExactDelta,
      exactElapsedMs: e.exactElapsedMs,
      approximateTokens: e.approximateTokens,
      approximateDisplayTokens: e.approximateDisplayTokens,
      approximateHardCapTokens: e.approximateHardCapTokens,
    };
  } else if (liveAnchor > 0) {
    // Path 2: a live usage anchor that is not (yet) in the rows, plus this
    // turn's tool results, which the anchor does not cover. The legacy
    // headless arithmetic, promoted to the shared path: usage +
    // ceil(postUsageChars / 4). Text only — images are excluded, same as
    // the legacy hook's counting.
    let postUsageChars = 0;
    for (const tr of postUsageToolResults ?? []) {
      for (const block of tr.content) {
        if (block.type === "text" && block.text) postUsageChars += block.text.length;
      }
    }
    const anchorEstimate = liveAnchor + Math.ceil(postUsageChars / 4);
    // Conservative = the max of the live anchor arithmetic and whatever the
    // rows say (a persisted segment boundary may already have grown them).
    const conservative = Math.max(breakdown.estimatedTokens, anchorEstimate);
    estimate = {
      estimatedTokens: conservative,
      refinedTokens: anchorEstimate,
      hardCapTokens: estimateHardCapTokens(conservative, anchorEstimate, true),
      rawUsageTotal: liveAnchor,
      selectedPath: "usage_anchor",
      errors: [],
      contextBreakdown: breakdown,
      ...zeros,
      approximateTokens: breakdown.estimatedTokens,
      approximateDisplayTokens: breakdown.displayTokens,
      approximateHardCapTokens: estimateHardCapTokens(
        breakdown.estimatedTokens,
        breakdown.displayTokens,
        breakdown.displayPath === "usage_anchor",
      ),
    };
  } else if (breakdown.selectedPath === "usage_anchor") {
    // Path 3: the rows carry a post-compaction usage anchor but there is no
    // exact capability (and no live anchor to prefer). The breakdown's own
    // dual path: conservative = max(anchor, char), display = anchor, hard
    // cap bounded relative to the anchor — the same math the exact function
    // uses for its pre-exact base.
    const conservative = breakdown.estimatedTokens;
    const display = breakdown.displayTokens;
    const hardCap = estimateHardCapTokens(conservative, display, true);
    estimate = {
      estimatedTokens: conservative,
      refinedTokens: display,
      hardCapTokens: hardCap,
      rawUsageTotal: breakdown.lastUsageTotal ?? 0,
      selectedPath: "usage_anchor",
      errors: [],
      contextBreakdown: breakdown,
      ...zeros,
      approximateTokens: conservative,
      approximateDisplayTokens: display,
      approximateHardCapTokens: hardCap,
    };
  } else {
    // Path 4: no anchor anywhere — the pure char estimate. Conservative by
    // definition: it drives the hard-cap ratio, never the normal trigger.
    const chars = breakdown.estimatedTokens; // == pathB (no anchor)
    estimate = {
      estimatedTokens: chars,
      refinedTokens: chars,
      hardCapTokens: chars,
      rawUsageTotal: 0,
      selectedPath: "char_estimate",
      errors: [],
      contextBreakdown: breakdown,
      ...zeros,
      approximateTokens: chars,
      approximateDisplayTokens: chars,
      approximateHardCapTokens: chars,
    };
  }

  onObservation?.(estimate);
  return estimate;
}

// ---------------------------------------------------------------------------
// Turn guards
// ---------------------------------------------------------------------------

export interface TurnGuardInput {
  iterations: number;
  maxIterations: number;
  /** Iterations since the last assistant-segment boundary (headless). */
  perSegmentIterations?: number;
  maxIterationsPerSegment?: number;
}

export interface GuardResult {
  stop?: {
    reason: "iteration_limit";
    /** Which cap fired — the route logs from this instead of re-deriving
     *  the condition (precedence: total is checked first, so "segment"
     *  here means the total cap did not fire). */
    scope: "total" | "segment";
    /** Canonical warning text — shared by both routes; the *expression*
     *  (SSE `event: warning` vs `emitter.emitWarning`) stays per-transport. */
    warning: string;
  };
}

/**
 * Turn-end guard decisions: the iteration caps.
 *
 * Pure — no I/O, no aborts, no emission. Both routes call this and express
 * the decision in their own transport (doc §4.3). Precedence: the total
 * iteration cap, then the per-segment cap.
 */
export function evaluateTurnGuards(input: TurnGuardInput): GuardResult {
  const {
    iterations,
    maxIterations,
    perSegmentIterations,
    maxIterationsPerSegment,
  } = input;

  if (iterations >= maxIterations) {
    return {
      stop: {
        reason: "iteration_limit",
        scope: "total",
        warning: `Stopped — reached ${maxIterations} iteration limit`,
      },
    };
  }

  if (
    maxIterationsPerSegment &&
    perSegmentIterations !== undefined &&
    perSegmentIterations >= maxIterationsPerSegment
  ) {
    return {
      stop: {
        reason: "iteration_limit",
        scope: "segment",
        warning: `Stopped — reached ${maxIterationsPerSegment} iteration limit for this phase`,
      },
    };
  }

  return {};
}

// ---------------------------------------------------------------------------
// Shadow mode (headless ship condition)
// ---------------------------------------------------------------------------

export interface PressureShadowComparison {
  legacyEstimate: number;
  legacyFires: boolean;
  unifiedEstimate: number;
  unifiedFires: boolean;
  /** unifiedEstimate - legacyEstimate. */
  delta: number;
  path: PressureEstimate["selectedPath"];
  /** Which side(s) crossed their trigger ratio. First-class data — the log
   *  line embeds it so the flip's pass criterion is evaluable from logs
   *  alone, but callers should read this field, not parse the string. */
  fire: "both" | "legacy" | "unified" | "none";
  /** `[context-pressure] shadow legacy=X unified=Y delta=Z path=P fire=F`
   *  — F ∈ {none, legacy, unified, both}. The fire outcomes are part of the
   *  line because the flip's pass criterion (zero trigger-outcome
   *  divergence) must be evaluable from the logs alone. */
  logLine: string;
}

/**
 * Shadow-mode comparison (doc §4.2 ship condition). The headless hook keeps
 * acting on the legacy arithmetic while the unified estimate is computed
 * and logged side-by-side. The flip to the unified trigger is gated on:
 *
 * - sample floor — ≥15 headless turns with a non-zero usage anchor AND ≥5
 *   calendar days, whichever comes last;
 * - pass — zero turns where the trigger outcome differs between legacy and
 *   unified (one crosses a ratio boundary the other doesn't, at 0.85 or
 *   0.95), AND no systematic directional bias (unified > legacy on >80% of
 *   turns with median delta > 2% of window);
 * - fail — either condition. A consistent bias means the estimator's model
 *   is wrong for that workload, not noisier — investigate before any flip.
 *
 * Pinned unified trigger selection (the §4.2 trigger table): an anchor
 * (live or row-scanned) feeds the NORMAL trigger (0.85) via
 * `refinedTokens`; a pure char estimate feeds only the HARD CAP (0.95) via
 * `hardCapTokens` — the documented invariant.
 */
export function comparePressureShadow(params: {
  legacyEstimate: number;
  /** The ratio the legacy arithmetic is checked against (0.85 with a usage
   *  anchor, 0.95 for the char fallback — the legacy's own choice). */
  legacyTriggerRatio: number;
  pressure: PressureEstimate;
  contextWindow: number;
}): PressureShadowComparison {
  const { legacyEstimate, legacyTriggerRatio, pressure, contextWindow } = params;

  const legacyFires = contextWindow > 0 && legacyEstimate / contextWindow > legacyTriggerRatio;

  const unifiedEstimate =
    pressure.selectedPath === "char_estimate" ? pressure.hardCapTokens : pressure.refinedTokens;
  const unifiedTriggerRatio =
    pressure.selectedPath === "char_estimate" ? COMPACTION_HARD_CAP_RATIO : COMPACTION_TRIGGER_RATIO;
  const unifiedFires = contextWindow > 0 && unifiedEstimate / contextWindow > unifiedTriggerRatio;

  const delta = unifiedEstimate - legacyEstimate;
  const fire: PressureShadowComparison["fire"] =
    legacyFires && unifiedFires ? "both" : legacyFires ? "legacy" : unifiedFires ? "unified" : "none";
  const logLine =
    `[context-pressure] shadow legacy=${legacyEstimate} unified=${unifiedEstimate} ` +
    `delta=${delta} path=${pressure.selectedPath} fire=${fire}`;

  return { legacyEstimate, legacyFires, unifiedEstimate, unifiedFires, delta, path: pressure.selectedPath, fire, logLine };
}
