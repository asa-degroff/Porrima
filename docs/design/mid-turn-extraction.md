# Mid-Turn Extraction

**Status**: Design  
**Author**: quje  
**Date**: 2026-06-28

## Problem

The current extraction pipeline fires only when an agent turn completes. Long turns — multi-step software implementation, extended research loops — can produce thousands of tokens of tool calls, results, and reasoning before extraction runs. This creates two problems:

1. **Compaction bottleneck**: When the context limit is reached mid-turn, compaction must wait for a pre-compaction extraction pass to finish before it can proceed. This extraction sees the full accumulated context and must extract from scratch, adding latency to an already-pressure point.

2. **Signal delay**: Memories from early in a long turn don't become available for passive recall until the turn finishes. During an extended implementation loop, the agent cannot benefit from memories it generated 20 tool calls ago.

## Solution

Extract incrementally during agent turns, triggered by accumulated *signal tokens* rather than turn completion. Integrate with the existing immediate extraction session so the extraction model maintains KV cache continuity across all pulses within a turn.

### Key Principles

- **Signal over volume**: Trigger on post-formatting signal tokens, not raw completion tokens. A 20KB `read_file` result is not signal — it's truncated to 500 chars for extraction. The counter reflects what the extraction model will actually process.
- **Session continuity**: Mid-turn pulses and turn-completion extraction share the same immediate extraction session. The KV cache prefix (system prompt + accumulated history) carries across all calls within a turn.
- **Marker-based strategy shift**: The extraction model receives `[MID-TURN]` or `[TURN COMPLETE]` markers in the user prompt, telling it whether to extract concrete facts from a segment or synthesize patterns from the full exchange.
- **Pre-compaction bypass**: When mid-turn pulses have already covered the context about to be compacted, skip the pre-compaction extraction entirely. Only extract the delta gap if one exists.

## Architecture

### Token Counter

Accumulates *estimated extraction signal tokens* per agent turn, using the same truncation rules that `formatMessageContentForExtraction` applies:

| Content type | Token estimate |
|---|---|
| Text / thinking content | `length / 2` (full count) |
| Tool call (name + args) | ~150 tokens fixed (generous estimate for truncated args) |
| Bulk tool result (`read_file`, `web_fetch`, `bash`, `run_python`, `list_files`, `read_pdf`) | ~250 tokens (500 chars / 2, matching `EXTRACT_TOOL_RESULT_MAX`) |
| Non-bulk tool result | `min(length / 2, 500)` |

The counter resets after each extraction pulse. Threshold: **6000 signal tokens** (configurable). Short turns that never cross the threshold get only the turn-completion extraction.

### Session Flow

Within a single agent turn, the immediate extraction session accumulates:

```
Pulse 1 (signal threshold crossed):
  User prompt header: "[MID-TURN] Review the segment of ongoing agent activity..."
  User message: [original user message that triggered this turn]
  Agent response: [thinking + tool calls + results from turn start → pulse 1]

Pulse 2 (threshold crossed again):
  User prompt header: "[MID-TURN] Review the segment of ongoing agent activity..."
  User message: [same original user message]
  Agent response: [thinking + tool calls + results from pulse 1 → pulse 2]

Completion (turn ends):
  User prompt header: "[TURN COMPLETE] Review the complete conversation exchange..."
  User message: [original user message]
  Agent response: [full agent response including final text]
```

The system prompt (`EXTRACTION_AGENT_PREFIX` + block summaries + `EXTRACTION_INSTRUCTIONS`) is identical across all calls, preserving the LCP cache prefix. The session history accumulates, so pulse 2's LCP covers pulse 1's content, and completion's LCP covers everything.

### Prompt Markers

Two variants of the batch header in `buildImmediateBatchHeader`:

**Mid-turn pulse:**
```
Review the segment of ongoing agent activity below. The agent is still working — this is not a complete exchange. Extract concrete facts from tool actions, results, and reasoning. Focus on specific decisions, findings, and observable patterns. Do not attempt narrative synthesis.
```

**Turn completion:**
```
Review the complete conversation exchange below. The agent has finished its turn. Extract everything significant, including higher-level patterns that span the full exchange. [TURN COMPLETE]
```

Both markers go in the user prompt, not the system prompt, keeping the system prefix stable for KV cache.

### Pre-Compaction: no bypass

`preCompactionFlush` runs on **every** compaction — there is no bypass. The `lastExtractedMessageIndex` / `chat.extractionState` design was never implemented; no such field exists anywhere in the codebase.

What delivers the intended KV benefit instead is session continuity: the mid-turn pulses and the pre-compaction flush share **one extraction session**, so the flush continues from the pulses' cached prefix rather than re-evaluating cold. Only non-substantive rows are filtered before the call (compaction summaries, out-of-context rows, system rows, synthesis rows, automation prompts).

### Content Format

Mid-turn pulses don't have a clean assistant response — they have a stream of messages from the agent loop. Content is assembled from agent-role messages in the window since the last pulse:

1. Thinking/reasoning blocks (full text)
2. Tool calls (name + truncated args via `formatToolArgumentsForExtraction`)
3. Tool results (truncated via `formatToolResultForExtraction`)

This uses the existing `formatMessageContentForExtraction` pipeline, ensuring consistent formatting and truncation.

The user message included in each pulse is the original user message that triggered the turn (for context — what was the agent asked to do). This is the same across all pulses within a turn.

### Integration Point

The trigger lives in `routes/chat.ts` (`maybeDispatchMidTurnPulse`), **not** in `agent-loop-runner.ts`.

The signal window is **cursor-derived** rather than a token counter: the trigger tracks offsets into `fullText` / `thinkingText` / `allToolCalls` / `allToolResults`. After a tool result is appended:
1. Advance the cursors past the new content
2. Estimate signal tokens for the newly-uncovered span
3. If that span meets the token threshold **or** estimated context usage crosses `DEFAULT_MID_TURN_EXTRACTION_CONTEXT_RATIO` (0.65) → trigger a pulse
4. The pressure branch also requires a +0.05 step latch that re-arms only after the ratio falls back out of the zone. Without it, one tool round-trip trivially exceeds the token floor and the 0.65–0.85 band would fire at nearly every iteration boundary — each costing a 4B CPU extraction call plus a session dialogue pair that prunes and re-prefills at the 8-pair cap

Because the window is cursor-derived, a failed or timed-out pulse simply rolls its cursors back and the next pulse retries the same content.

The extraction call is synchronous (runs through `withExtractionMutex`) but bounded by a timeout. If the mutex doesn't release in time, the pulse is skipped — the next pulse or turn completion will cover the content.

### Extraction Model Mutex

Mid-turn pulses go through `withExtractionMutex` like immediate extraction. Under normal conditions the extraction model (CPU, Qwen 3.5 9B) is fast. Under heavy load (compaction flush + delayed extraction competing), the mutex may block.

Timeout behavior: if extraction doesn't complete within the gate, the pulse is skipped and the agent loop continues. The content is not lost — it's covered by the next pulse or turn completion.

### Same-Turn Retrieval Guard

Memories extracted by mid-turn pulses are tagged with the current `turnId` (or message index range). Passive recall filters out memories where `turnId === currentTurnId`, preventing the agent from retrieving its own freshly-extracted memories while still working on the same turn. Once the turn completes and a new turn starts, those memories become available.

## Tradeoffs

| Concern | Resolution |
|---|---|
| Agent loop latency | Extraction is CPU-bound (separate model). Mutex adds 2-5s under normal load. 15s timeout prevents indefinite blocking. |
| KV cache invalidation | System prompt is stable. Session history accumulates within a turn. Cache carries across all pulses. New turn = new session (existing behavior). |
| Duplicate memories | Session history gives the extraction model context of what it already extracted. Vector dedup at save time catches remaining overlap. Supersession handling for delayed extraction. |
| Pre-compaction quality loss | Mid-turn pulses use the general extraction prompt, not the task-state-focused pre-compaction prompt. Accepted: the flush always runs and shares the pulses' extraction session, so it continues from their cached prefix. |
| Token counting accuracy | Signal estimate mirrors truncation rules but doesn't run the full formatter. Good enough for thresholding — exact token count isn't required. |

## Configuration

- `extractionMidTurnThreshold`: Signal tokens before a mid-turn pulse fires. Default: 6000.
- `extractionMidTurnTimeoutMs`: Max time to wait for the extraction mutex. **Default: 120000 (2 min)**; range 15000–900000. The upper bound must stay in sync with the client Settings modal cap.

Both configurable via Settings, persisted to settings.

## Files Affected

| File | Change |
|---|---|
| `server/src/services/memory-extraction.ts` | Signal token estimator, mid-turn pulse formatting, session marker support, pre-compaction flush |
| `server/src/routes/chat.ts` | `maybeDispatchMidTurnPulse` — trigger, pressure latch, cursor bookkeeping and rollback |
| `server/src/services/extraction-settings.ts` | Threshold, timeout, context-ratio, and min-signal-token defaults and clamps |
| `server/src/services/passive-memory-recall.ts` | Same-turn retrieval guard (drops memories tagged with the current `turnId`) |
| `server/src/types.ts` | Settings fields |

## Open Questions

- Should the extraction model see the user message repeated in every pulse, or only in the first pulse (to save tokens)? Current design repeats it for context, but it adds redundant prefill. The KV cache handles this if the user message is identical across pulses within a turn — but only if it appears at the same position in the dialogue, which it won't (it's in a new user-role message each time). Alternative: include it only in the first pulse and rely on session history for context in subsequent pulses.
- Should mid-turn extraction be opt-in or default? Default-on feels right for the compaction bypass benefit, but adds extraction cost to all turns.
