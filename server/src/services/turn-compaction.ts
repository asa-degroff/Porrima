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
 * Adoption status:
 *   - chat.ts (HTTP) — phase 2a, behavior-identical move.
 *   - system-chat (synthesis/wake) — D2, done 09-03: the char-only 0.85
 *     under-read replaced by the conservative max at 0.80; negative-path
 *     logging now covers the headless workhorse.
 *   - automation-runner — D3: check added 09-03 behind the log-only gate,
 *     flipped to EXECUTE 10-12 at its own triggerRatio (0.85). The gate
 *     week applied §9's pre-defined rule: 25 turns, 5 (20%) inside
 *     (0.80, 0.85] — over the 10% "choose 0.85" bar — so automations keep
 *     the pre-send's ratio, executed while nobody waits instead of at the
 *     next run's start. The logOnly flag was removed with the flip, per
 *     its own contract.
 *   - D4 (headless pre-compaction flush) landed 10-12: every headless site
 *     passes the shared preCompactionFlushHook (memory-extraction.ts), and
 *     SynthesisEmitter.emitCompacting() frames the stall for streamed runs.
 */

import type { Chat, ChatMessage } from "../types.js";
import type { PressurePath } from "./context-pressure.js";
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
   * Which estimator path produced estimatedTokens (PressureEstimate.
   * selectedPath). Rendered in the log lines when present so a future
   * incident is self-explaining — the 09-09 trigger looked like a
   * usage-anchor fire until the journal showed the char path drove it.
   */
  selectedPath?: PressurePath;
  /**
   * Default END_OF_TURN_COMPACTION_TRIGGER_RATIO (0.80). Named deltas pass
   * their own (D2: headless 0.85→0.80; D3: automation executes at
   * COMPACTION_TRIGGER_RATIO, 0.85, per its §9 gate-week verdict). The
   * value also renders in the negative-path log, so the log and the
   * decision cannot drift apart.
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
  /**
   * Turn cancellation signal. When aborted before the decision is executed
   * (user pressed stop), the check reports no trigger and the truncation +
   * pre-archive memory flush are skipped. The signal is also threaded into
   * truncateChatHistory so a stop landing mid-compaction bails at the next
   * safe checkpoint.
   */
  signal?: AbortSignal;
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
  // Rendered only when the caller identified the estimator path (the
  // estimateContextPressure callers); bare char-estimate callers omit it.
  const pathSuffix = opts.selectedPath ? `, path=${opts.selectedPath}` : "";

  // A stopped turn must not compact: the user abandoned it, and the flush it
  // runs would keep the extraction servers busy after the stop.
  if (opts.signal?.aborted) {
    console.log(`${logPrefix} End-of-turn compaction skipped (turn stopped): chat=${chat.id}`);
    return { triggered: false, truncated: false, drivingTokens: 0, ratio: 0 };
  }

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
      `${logPrefix} End-of-turn check: no compaction ` +
        `(chat=${chat.id}, driving=${drivingTokens}/${contextWindow} ` +
        `(${(usageRatio * 100).toFixed(1)}%, trigger=${triggerRatio * 100}%) ` +
        `[usage=${lastUsage}, estimated=${estimatedTokens}${pathSuffix}]`,
    );
    return { triggered: false, truncated: false, drivingTokens, ratio: usageRatio };
  }

  console.log(
    `${logPrefix} End-of-turn compaction triggered: driving=${drivingTokens}/${contextWindow} ` +
      `(${(usageRatio * 100).toFixed(0)}%) [usage=${lastUsage}, estimated=${estimatedTokens}${pathSuffix}]`,
  );

  let truncated = false;
  try {
    const body = async () => {
      // Settle any in-flight mid-turn pulse before the flush so its
      // cursor is final and it isn't racing the extraction server.
      if (opts.signal?.aborted) return;
      await opts.settleInFlight?.();
      if (opts.signal?.aborted) return;
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
        opts.signal,
      );
      if (compaction.truncated) {
        await saveChat(chat);
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

/**
 * Mid-turn handoff row writer — turn-engine D6, the shape-only unification.
 *
 * Both routes append the same hidden user row at the tail and persist it,
 * so future replays reconstruct the exact token sequence the resumed
 * continuation saw (and KV prefix matching keeps working on the next
 * turn). ONE writer now owns the row shape: content policy stays per-route
 * — the caller passes the finished handoff body (HTTP: progress summary +
 * delivered memory delta + top-10 memories; headless: the minimal
 * continuation text from buildMidTurnHandoffText). Any future content
 * change stays gated on the D6 A/B rule; any shape change happens here,
 * never in the routes.
 *
 * The caller orders this AFTER truncate (rows marked out-of-context) and
 * before resuming the loop; the save is what the memory-delta delivery
 * receipt (HTTP: commitMemoryDelta) is sequenced against.
 *
 * `at` preserves each route's historical placement semantics byte-exact
 * (D6 is shape-only): the HTTP route splices at the index captured before
 * its hydration await (so a concurrent append cannot strand the handoff
 * behind it mid-turn), while headless appends at the tail (push). Omitting
 * `at` pushes.
 */
export async function persistMidTurnHandoff(
  chat: Chat,
  handoffText: string,
  meta: { removedCount?: number; cycle: number },
  at?: number,
): Promise<void> {
  const row: ChatMessage = {
    role: "user",
    content: handoffText,
    timestamp: Date.now(),
    _isSystemMessage: true,
    _isMidTurnCompaction: true,
    _compactionRemovedCount: meta.removedCount,
    _compactionCycle: meta.cycle,
  };
  if (at !== undefined) {
    chat.messages.splice(at, 0, row);
  } else {
    chat.messages.push(row);
  }
  await saveChat(chat);
}
