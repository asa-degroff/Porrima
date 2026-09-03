/**
 * End-of-turn compaction — decision + execution.
 *
 * Phase 2 of docs/design/turn-engine.md (§4.4). One function owns what the
 * routes had drifted on: the decision (endOfTurnNeedsCompaction), the
 * execution ordering (pulse settle → pre-compaction flush → truncate →
 * save), and the logging — including the negative path, whose observability
 * (added in the Aug 23 compaction rework, after the 14-day 0-fire gap) is
 * now structural rather than per-route diligence.
 *
 * What stays with the caller:
 *   - the gate (route-specific stop conditions: mid-turn exhaustion,
 *     ask_user, waiting-for-input),
 *   - the estimator call (the caller holds the model capability and passes
 *     the refined estimate in),
 *   - the post-truncation aftermath (onCompacted — prompt rebuild, skill
 *     re-injection, stale-usage clear, SSE event; the callback's closure
 *     owns route-local state, including the systemPrompt reassignment the
 *     rest of the turn reads).
 *
 * Adoption status: chat.ts (HTTP) — phase 2a, behavior-identical move.
 * system-chat (synthesis/wake) and automation-runner come as named deltas
 * (D2 trigger 0.85→0.80, D3 automation check, D4 headless flush), each
 * separately reviewable.
 */

import type { Chat, ChatMessage } from "../types.js";
import {
  END_OF_TURN_COMPACTION_TRIGGER_RATIO,
  endOfTurnNeedsCompaction,
  truncateChatHistory,
} from "./compaction.js";
import { saveChat } from "./chat-storage.js";

export interface EndOfTurnCompactionOptions {
  chat: Chat;
  contextWindow: number;
  /** Raw token usage for the final turn (state.finalUsage?.totalTokens ?? 0). */
  lastUsage: number;
  /** stopReason === "length" — forces the decision and force-compact. */
  hitContextLimit?: boolean;
  /**
   * Refined estimate from the caller's estimator (estimateContextPressure
   * when the llamacpp capability is present, char estimate otherwise). The
   * caller passes it in — this module does not own model capability.
   */
  estimatedTokens: number;
  /**
   * Default END_OF_TURN_COMPACTION_TRIGGER_RATIO (0.80). Named deltas pass
   * their own (D2: headless 0.85→0.80; D3: automation 0.80 vs 0.85 pending
   * D1). The value also renders in the negative-path log, so the log and
   * the decision cannot drift apart.
   */
  triggerRatio?: number;
  /** SSE: compacting event — passed through to truncateChatHistory. */
  emitCompacting?: () => void;
  /** SSE: keepalive ping emitter — passed through to truncateChatHistory. */
  emitKeepalive?: () => void;
  /** Wrap the execution in a keepalive loop (chat.ts: withSSEKeepalive). */
  keepaliveWrap?: (body: () => Promise<void>) => Promise<void>;
  /** Settle in-flight mid-turn pulses before the flush (chat.ts: awaitMidTurnPulse). */
  settleInFlight?: () => Promise<void>;
  /** Pre-compaction flush — invoked with the removed set BEFORE archive/index generation. */
  preFlush?: (removed: ChatMessage[]) => Promise<void>;
  /**
   * Route-specific aftermath — runs only when truncation happened, after
   * saveChat. chat.ts: prefill indicator, memory-context rebuild, skill
   * re-injection, stale-usage clear, SSE compaction event.
   */
  onCompacted?: (r: { removedCount: number; removedSplitCount?: number; remainingCount: number }) => Promise<void> | void;
  /** System prompt for truncateChatHistory's overhead budgeting. */
  systemPrompt?: string;
  /** Tool schemas for truncateChatHistory's overhead budgeting. */
  tools?: unknown;
  /** Log prefix. Default "[compaction]". */
  logPrefix?: string;
}

export interface EndOfTurnCompactionResult {
  /** The decision fired (hitContextLimit or ratio above the trigger). */
  triggered: boolean;
  /** The truncation was persisted (saveChat succeeded). */
  truncated: boolean;
  drivingTokens: number;
  ratio: number;
}

export async function runEndOfTurnCompaction(
  opts: EndOfTurnCompactionOptions,
): Promise<EndOfTurnCompactionResult> {
  const { chat, contextWindow, lastUsage, estimatedTokens, logPrefix = "[compaction]" } = opts;
  const triggerRatio = opts.triggerRatio ?? END_OF_TURN_COMPACTION_TRIGGER_RATIO;
  const hitContextLimit = opts.hitContextLimit ?? false;

  // Either signal can drive the trigger (conservative max, never min),
  // against the earlier end-of-turn threshold (0.80 vs pre-send's 0.85) —
  // see endOfTurnNeedsCompaction. Pre-send remains the backstop for
  // anything end-of-turn can't see.
  const decision = endOfTurnNeedsCompaction({
    lastUsage,
    estimatedTokens,
    contextWindow,
    hitContextLimit,
    triggerRatio,
  });
  const drivingTokens = decision.drivingTokens;
  const usageRatio = decision.ratio;
  const needsCompaction = decision.needsCompaction;

  if (!needsCompaction) {
    // The negative path is logged unconditionally — a check that only
    // speaks when it fires is unobservable (the 14-day 0-fire gap).
    console.log(
      `${logPrefix} End-of-turn check: no compaction (chat=${chat.id}, driving=${drivingTokens}/${contextWindow} ` +
        `(${(usageRatio * 100).toFixed(1)}%, trigger=${triggerRatio * 100}%) ` +
        `[usage=${lastUsage}, estimated=${estimatedTokens}]`,
    );
    return { triggered: false, truncated: false, drivingTokens, ratio: usageRatio };
  }

  console.log(
    `${logPrefix} End-of-turn compaction triggered: driving=${drivingTokens}/${contextWindow} ` +
      `(${(usageRatio * 100).toFixed(0)}%) [usage=${lastUsage}, estimated=${estimatedTokens}]`,
  );

  let truncated = false;
  try {
    const body = async () => {
      // Settle any in-flight mid-turn pulse before the flush so its
      // cursor is final and it isn't racing the extraction server.
      await opts.settleInFlight?.();
      const compaction = await truncateChatHistory(
        chat,
        contextWindow,
        hitContextLimit || (lastUsage === 0 && needsCompaction),
        opts.emitCompacting,
        opts.emitKeepalive,
        lastUsage,
        opts.systemPrompt,
        opts.tools,
        opts.preFlush,
      );
      if (compaction.truncated) {
        await saveChat(chat, { allowTruncation: true });
        truncated = true;
        await opts.onCompacted?.({
          removedCount: compaction.removedCount,
          removedSplitCount: compaction.removedSplitCount,
          remainingCount: chat.messages.filter((m) => !m._outOfContext).length,
        });
      }
    };
    // Wrap in keepalive loop (when provided) so the client's inactivity
    // timeout doesn't fire during slow extraction/embed/rerank steps.
    if (opts.keepaliveWrap) {
      await opts.keepaliveWrap(body);
    } else {
      await body();
    }
  } catch (err) {
    console.error(`${logPrefix} End-of-turn compaction failed:`, err);
  }

  return { triggered: true, truncated, drivingTokens, ratio: usageRatio };
}
