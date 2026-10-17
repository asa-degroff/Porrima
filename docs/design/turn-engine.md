# Turn Engine — Unifying the Context-Pressure Path

**Status**: Design + implementation record. **§3 is a frozen snapshot of the
pre-refactor state (Aug 23), not the current file layout.** Deltas D1–D6 are in
force; **D7 is parked by design**; Phase 4 stays deferred per §4.7 — see the
table in §5.
**pi 1.0 note**: Wherever this doc says `shouldStopAfterTurn`, the live pi-agent-core
hook is `finishTurn` (see [pi-1.0-migration.md](pi-1.0-migration.md) §5.3).

## 1. Problem

The logic that keeps a turn alive inside its context window exists in **two full
implementations and a partial third**, and they have drifted.

| Site | Pre-send | Mid-turn trigger | Mid-turn cycle | End-of-turn |
|---|---|---|---|---|
| `chat.ts` `handleChatStream` (HTTP) | ✓ refined est. | usage anchor + **exact** tool-result tokenization, dual 0.85/0.95 | 5 cycles, flush, prompt rebuild, memory handoff | ✓ `endOfTurnNeedsCompaction`, refined est., 0.80 |
| `system-chat.ts` synthesis / wake | ✓ | via runner hook: usage anchor + `chars/4`, or char est. at 0.95 only | 3 cycles, **no flush**, no prompt rebuild | ✓ own inline copy, **char est. only**, 0.85 |
| `automation-runner.ts` | ✓ (estimate L254 → `truncateBeforeSend` L240) | same runner hook as system-chat | same | ✗ **none** — next-run pre-send is the only backstop |
| `chat-turn-runner.ts` (shared headless runner) | — | `shouldStopAfterTurn` hook (L568) | `for(;;)` + `activeContext` swap (L693–883) | — (contract left to callers, undocumented) |

The cost is not line count. It is that **every compaction fix must be reasoned
about in 2–3 dialects, and the dialects have already drifted in ways that
produced incidents**:

- **7-minute pre-send wait.** End-of-turn read raw `finalUsage`
  (84.8% of window); the refined estimate said 85.3%. End-of-turn stayed quiet,
  the compaction instead fired at pre-send — while the user was already waiting on the
  round-trip. Pure estimator asymmetry between the two routes.
- **14-day forensics.** Main-route end-of-turn fired **0×**;
  pre-send fired 10× (7 of them system-chat cycle starts). System-chat
  end-of-turn fired 3×, twice of them with the window already **>100%**. The
  main-route
  check was structurally blind (ran before the continuation loops, on a
  pre-continuation snapshot) — a placement divergence from system-chat's
  post-turn check. Since fixed — but the fix lived in one route only.
- **The fix cycle behind §3's snapshot (8 fixes).** Fixes spanned `compaction.ts`,
  `chat.ts`, `system-chat.ts`, and a new `context-high-water.ts`. The refined
  end-of-turn estimate (fix 6) reached `chat.ts` but **not** the headless
  paths. The high-water floor (fix 4) was explicitly threaded through
  `chat-turn-runner` because headless turns would otherwise never feed it —
  i.e. the fix had to *know* the runner's internals to reach them.
- **Known open gap.** Headless compaction paths omit the
  pre-compaction extraction flush — the one place where skipping the flush has
  identity-level stakes (memories extracted from removed context are lost).
- **Frozen-prefix staleness.** After a headless mid-turn compaction, the
  runner reuses the same `systemPrompt` variable for the rest of the turn —
  the frozen memory prefix still describes the pre-compaction world. The HTTP
  route rebuilds it (`softResetMemoryContext` + `buildSplitAugmentedPrompt` +
  skill re-injection) on every compaction.

The pattern: the two runners agree on *shape* (flag → cycle →
`truncateChatHistory` → `_isMidTurnCompaction` handoff row → rebuild → resume)
and diverge on *parameters and aftermath* (cycle caps, handoff content,
estimator, flush, prompt rebuild, trigger ratios). Shape-agreement with
parameter-drift is the worst combination: it reads as "same code, different
config" in review, then behaves as two different systems in production.

## 2. Goals

1. **One estimator.** A single context-pressure function every route calls;
   the exact tool-result path is a capability, not a dialect.
2. **One end-of-turn execution.** Decision + keepalive + flush + truncate +
   caller-specific rebuild/emit, one implementation; every headless caller
   (synthesis, wake, **automations**) gets it.
3. **One mid-turn cycle skeleton.** Cycle accounting, handoff persistence, and
   resume-context rebuild live once; per-route resume event handling stays put.
4. **Every behavioral delta is explicit, named, and verified** — no silent
   "unification" that changes trigger timing or handoff semantics.
5. **The fixes above stay pinned.** Phase 0 pins current behavior as named
   regression tests *before* any code moves.

### Non-goals

- Merging `chat.ts` and `chat-turn-runner.ts` into one parameterized runner.
  The transport differences (SSE reconnect/grace, `ask_user` pause, TTS,
  queued follow-ups, crash-recovery pending states) are genuinely
  HTTP-shaped; one function with ~40 transport flags would be worse than two.
- Client changes. Phases 1–3 preserve the wire format exactly (same SSE
  events, same row shapes, same `_rowSequence` stamping).
- The mid-turn *extraction pulse* — HTTP-only, and it stays. (It does consume
  the unified estimator's context-ratio output going forward.)
- `TurnState` unification (accumulator + boundary cursors) — see §4.7,
  deferred.

## 3. Current state (Aug 23, post-fixes)

Layer map as it stands:

```
pi-agent-core loop
  └─ agent-loop-runner.ts (119 lines) — config factory, runAgentLoop, stopAgentLoop
       ├─ chat.ts handleChatStream (HTTP, ~4k lines)
       │    4× runAgentLoop: main / incomplete-tool continuation /
       │    stranded recovery / mid-turn resume
       │    inline: estimator+observation, guards, pulse, compaction
       └─ chat-turn-runner.ts runHeadlessChatTurn (980 lines)
            1× runAgentLoop in for(;;); compaction-resume = activeContext swap
            shouldStopAfterTurn hook, getFollowUpMessages, emitter interface
             ├─ system-chat.ts — synthesis/wake orchestration, own pre-send +
             │  end-of-turn checks (L870/1151, L1240/1400)
             └─ automation-runner.ts — pre-send only (L240)
```

Shared pieces that already work and should not be touched:
`compaction.ts` (truncation core, `endOfTurnNeedsCompaction` decision at L46,
ratios at L23–32), `estimateContextTokensWithExactToolResults` (L432, already
self-gating: exact tokenization only for ≥70%-of-window contexts or ≥16k-char
results, max 12 candidates), the `shouldStopAfterTurn` config hook, the
passive-recall controller, `context-high-water.ts`.

## 4. Design

### 4.1 Target shape

Three modules, no runner merge:

```
context-pressure.ts (NEW)
  estimateContextPressure()   — the unified estimator (§4.2)
  evaluateTurnGuards()        — dedup + iteration caps, pure (§4.3)

turn-compaction.ts (NEW)
  runEndOfTurnCompaction()    — decision + execution, hooks for aftermath (§4.4)
  runMidTurnCompactionCycles()— cycle skeleton (§4.5)
  persistMidTurnHandoff()     — the _isMidTurnCompaction row, one shape

compaction.ts (unchanged surface)
  truncateChatHistory, truncateBeforeSend, endOfTurnNeedsCompaction, ratios
```

`chat.ts` keeps: SSE emission, `ask_user`, TTS, queued follow-ups, pending
states, recap/title/push, pre-send, the extraction pulse, and its four
`runAgentLoop` call sites. `chat-turn-runner.ts` keeps: the emitter interface,
`getFollowUpMessages`, timeout, and the two-path final persist. The runner
stays transport-pure; the end-of-turn contract moves from "undocumented" to a
named requirement in its JSDoc, enforced by adoption at all three current
call sites (§4.4).

### 4.2 Estimator — `estimateContextPressure()`

One function replaces the three dialects (chat.ts inline anchor+exact+char;
headless hook anchor+chars/4; system-chat char-only).

**The estimate is three numbers, not one — and the mapping to triggers is the
contract.** Today `chat.ts` reads three distinct fields of the exact estimate
for three distinct decisions (chat.ts:2620, 2621, 3446): the refined/display
number drives the mid-turn *normal* trigger, the conservative upper bound
drives the mid-turn *hard-cap* guard, and the positive-delta-only conservative
number (maxed with usage) drives *end-of-turn*. Collapsing those into "one
primary number drives triggers" would silently change which estimate feeds
which trigger — the exact drift this refactor exists to kill. The interface
below mirrors `ExactContextTokenEstimate` field-for-field so the mapping is 1:1
with the live code, and the trigger mapping is pinned in the table after the
semantics.

```ts
interface PressureEstimate {
  /** Conservative estimate (positive-delta-only). Drives END-OF-TURN, maxed
   *  with lastUsage. (compaction.ts `estimatedTokens` / `approximateTokens`.) */
  estimatedTokens: number;
  /** Refined display estimate. Drives mid-turn NORMAL trigger (0.85) and the
   *  client token indicator. (compaction.ts `refinedTokens` /
   *  `approximateDisplayTokens`.) */
  refinedTokens: number;
  /** Conservative upper bound. Drives mid-turn HARD-CAP guard (0.95).
   *  (compaction.ts `hardCapTokens` / `approximateHardCapTokens`.) */
  hardCapTokens: number;
  /** Raw usage.totalTokens of the last call, if any (0 = no anchor). */
  rawUsageTotal: number;
  selectedPath: "exact" | "usage_anchor" | "char_estimate";
  errors: string[];
  contextBreakdown?: ContextBreakdown;   // existing shape, for observation logging
}

interface PressureEstimateParams {
  messages: ChatMessage[];
  systemPrompt: string;
  tools: AgentTool[];
  contextWindow: number;
  /** Tool results produced AFTER the last usage measurement (next prompt's
   *  input). The anchor path adds these on top; the char path already
   *  includes them via the rows. */
  postUsageToolResults?: ToolResultBlock[];
  /** Measured totalTokens of the last completed call (usage anchor). */
  lastUsageTotal?: number;
  /** llamacpp capability — enables the exact path when present. */
  exact?: { baseUrl: string; modelId: string; chatId: string; phase: string };
  /** Optional observation sink (chat.ts keeps recording to its existing
   *  store; headless passes nothing). */
  onObservation?: (obs: PressureObservation) => void;
}
```

Semantics (all already implemented somewhere; this is consolidation):

1. **Anchor available + exact capability**: `estimateContextTokensWithExactToolResults`
   on top of `lastUsageTotal` + `postUsageToolResults`. Existing self-gating
   applies (no HTTP below 70% / 16k-char threshold).
2. **Anchor available, no exact**: `lastUsageTotal + ceil(postUsageChars / 4)`
   (the headless hook's current arithmetic — promoted to the shared path).
3. **No anchor**: `estimateContextTokens` (rows + prompt + tools, the char
   estimate) — and callers must treat path 3 as conservative: it drives the
   **hard-cap** ratio (0.95), never the normal trigger (0.85/0.80). This rule
   is already headless behavior; it becomes the documented invariant.

**Trigger mapping (pinned).** The estimator reports three numbers; each
trigger reads exactly one (or one maxed with usage). This table is the
contract — a phase that changes a row changes production trigger behavior and
must do so as a named delta, never as a side effect of consolidation:

| Decision | Ratio | Number that drives it |
|---|---|---|
| mid-turn normal | 0.85 | `refinedTokens` |
| mid-turn hard-cap | 0.95 | `hardCapTokens` |
| end-of-turn | 0.80 | `max(rawUsageTotal, estimatedTokens)` |
| pre-send | 0.85 | pre-send's own refined re-measurement (untouched by this design) |

The ratios stay **call-site parameters**, not estimator properties — the
estimator reports numbers, the call site decides. D1's flip aligns headless to
this same mapping: today's headless arithmetic (anchor + chars/4 for the 0.85,
char estimate for the 0.95) maps onto `refinedTokens`/`hardCapTokens`
respectively, so the flip changes *which measurement* feeds the trigger, not
*which number drives which trigger*.

**Shadow mode (phase 1 ship condition).** After headless adoption, the hook
logs *both* the legacy arithmetic and the unified result
(`[context-pressure] shadow legacy=X unified=Y delta=Z path=P`) and acts on
the legacy value. The flip has explicit pass/fail criteria — a quiet week must
not pass by default:

- **Sample floor**: ≥15 headless turns with a non-zero usage anchor (synthesis
  + wake + automations combined) AND ≥5 calendar days, whichever comes last.
  Below that, the window extends — no decision on thin data.
- **Pass**: zero turns where the trigger outcome differs between legacy and
  unified (one crosses a ratio boundary the other doesn't, at 0.85 or 0.95),
  AND no systematic directional bias (unified > legacy on >80% of turns with
  median delta > 2% of window).
- **Fail**: either condition. A consistent bias means the estimator's *model*
  is wrong for that workload, not noisier — investigate before any flip
  (see §8, Risk 2).

**Verdict:** D1 flipped after the shadow log showed zero divergence — no
trigger-outcome differences, no directional bias; `midTurnPressureDecision`
owns the mapping and shadow mode is retired.
The one corner the shadow data could not observe (no-usage iteration →
path 3/char) is pinned in the `comparePressureShadow` fixtures and guarded by an
explicit loud log in `chat-turn-runner.ts`.

This is the same "trust the artifact over memory" discipline as the
high-water fix: we don't guess which estimate is closer, we watch them
disagree.

### 4.3 Guards — `evaluateTurnGuards()`

The iteration caps exist verbatim in both routes as `turn_end` inline code.
Extract as pure functions:

```ts
interface GuardResult { stop?: { reason: "iteration_limit"; scope: "total" | "segment"; warning: string }; }

evaluateTurnGuards({
  iterations, maxIterations,
  perSegmentIterations?, maxIterationsPerSegment?,
}): GuardResult
```

**No duplicate-tool-call dedup guard.** An earlier design carried one — a
streak ≥ 3 of identical JSON tool-call signatures aborting the loop — and it
was explicitly rejected: it produced false alarms on legitimate repeated calls
(consecutive `bash` invocations). Do not re-add it as a "guard"; identical
calls are legal behavior.

Both routes' `turn_end` handlers call this and emit their own warnings
(SSE `event: warning` vs `emitter.emitWarning`) — the *decision* is shared,
the *expression* stays per-transport. The headless `shouldStopAfterTurn` hook
delegates its guard portion here (its context-overflow portion delegates to
§4.2). `chat.ts` keeps its inline estimator + pulse dispatch where it is:
both are coupled to the SSE `iteration` payload and the pending-state
observation record, and moving them into the config hook would only add
indirection without removing coupling.

**Stays inline (named, so nobody folds it in later):** the implicit-overflow
heuristic (chat.ts:2598–2612 — stream error with no usage data, prior usage
already above the trigger or iterations > 3 → treat as `hitContextLimit`,
emit the `context_length` SSE warning) is signal *classification*, not a guard
decision: it consumes the live-stream state and the SSE warning channel. It
stays in `chat.ts`'s `turn_end` handler. `evaluateTurnGuards` takes
`hitContextLimit` as an input and never computes it.

### 4.4 End-of-turn — `runEndOfTurnCompaction()`

The decision (`endOfTurnNeedsCompaction`, compaction.ts L46) is already shared.
What isn't is everything around it — chat.ts has ~120 lines of inline
execution (keepalive wrap, pulse settle, truncate, save, memory-context
rebuild, skill re-injection, stale-usage clear, compaction event);
system-chat has a leaner inline copy (char estimate, no rebuild, no flush);
automations have nothing.

```ts
interface EndOfTurnOptions {
  chat: Chat;
  contextWindow: number;
  lastUsage: number;
  hitContextLimit?: boolean;
  /** Refined estimate via estimateContextPressure (call site passes its
   *  systemPrompt/tools/model capability). Falls back to char estimate if
   *  the call site has no llamacpp capability. */
  estimatedTokens: number;
  triggerRatio?: number;   // default END_OF_TURN_COMPACTION_TRIGGER_RATIO (0.80)
  onCompacting?: () => void;          // SSE: compacting event
  keepalive?: () => void;             // SSE: ping loop wrapper (chat.ts only)
  preFlush?: (chat) => Promise<void>; // preCompactionFlushHook — every caller
                                       // including headless (delta D4)
  onCompacted?: (r: { removedCount: number; remainingCount: number })
               => Promise<void> | void; // prompt rebuild, skill re-injection,
                                        // stale-usage clear, event emission
}

runEndOfTurnCompaction(opts): Promise<{ triggered: boolean; truncated: boolean; drivingTokens: number; ratio: number }>
```

Internally: `endOfTurnNeedsCompaction` → (if needed) optional keepalive wrap →
`awaitMidTurnPulse` (chat.ts passes a settler; headless none) →
`truncateChatHistory(chat, cw, force, emit*, preFlush)` → `saveChat(chat,
{allowTruncation: true})` → `onCompacted` → **always** log the negative path
(what made the 0-fire gap visible — this becomes structural,
not per-route diligence).

Adoption:

| Caller | Change |
|---|---|
| `chat.ts` | Inline block (L3413–3545) replaced by the call. No behavior change. |
| `system-chat.ts` synthesis (L1151) | Char-only estimate → refined via `estimateContextPressure`; 0.85 → **0.80** (delta D2); gains flush (D4); gains negative-path logging. |
| `system-chat.ts` wake (L1400) | Same as synthesis. |
| `automation-runner.ts` | **New** check after `runHeadlessChatTurn` (delta D3). |

One operational note on D3: the new check runs inside `runAutomationTask`,
i.e. **under the turn-gate lease** (the global GPU-bound turn serialization).
Compacting while holding the lease is the *correct* behavior — the compacted
context is exactly what the next run's pre-send will measure against, and
releasing the lease between the decision and the truncate would let another
GPU-bound turn interleave and invalidate the measurement. If anyone later
"optimizes" the check out of the leased region, pre-send reverts to measuring
a stale pre-compaction context — the drift this doc exists to prevent.

**Pre-compaction flush (D4, in force).** The flush is the shared
`preCompactionFlushHook` in `memory-extraction.ts`, wired at **every** headless
compaction site — synthesis/wake/automation pre-send and end-of-turn, plus
headless mid-turn in `chat-turn-runner.ts`. The scoping axis is the *type of chat
being compacted*, not the transport: in-chat reminders and cross-chat wakes run
through the headless runner on the *target's agent chat* (`automation-runner.ts`
passes `chatType: liveChat.type`) — those chats carry a live, KV-warm extraction
session, so the flush there continues a warm prefix and closes a genuine memory
hole. On the system chat itself, `isSubstantiveForPreCompactionExtraction`
self-scopes the flush near-zero (synthesis rows tagged, automation boilerplate
filtered) — except user rows typed into the system chat and assistant-side
automation findings, which ARE substantive. Two constraints the original sketch
predated, both handled: the flush runs while **holding the global turn-gate
lease** (§8 Risk 4 — the watch item is foreground gate wait), and headless turns
stream with HTTP frame parity, so `SynthesisEmitter.emitCompacting()` emits the
same `compacting` SSE frame the HTTP route uses (resync mirrors the state until
the next real event).

The 0.85→0.80 move for synthesis/wake is deliberate and defensible: the rationale
for 0.80 is "this check runs while nobody is waiting for a response that
could have been compacted cheaper now" — true for autonomous work whose next
cycle is minutes-to-hours away. The >100% system-chat end-of-turn fires in §1 are
the argument from the other side: char-only estimates were *under*-reading
headless context, and the refined estimate + earlier trigger both move in the
safe direction. Automations keep **0.85** — their cadence puts the pre-send
backstop close behind, so the earlier trigger buys little (the §9 Q1 rule settled
it from gate data); D3 changes their *placement*, not their threshold: a run that
finishes over the trigger compacts at the end of that run instead of making the
next run wait in pre-send. Pre-send stays 0.85 as backstop everywhere.

### 4.5 Mid-turn — `runMidTurnCompactionCycles()` + `persistMidTurnHandoff()`

The skeleton both routes already share, with the divergences made explicit
as parameters:

```ts
interface MidTurnCycleOptions {
  chat: Chat;
  systemPrompt: string;            // in/out: onCompacted may return the rebuilt one
  tools: AgentTool[];
  contextWindow: () => number;
  maxCycles: number;               // chat.ts 5, headless 3 → both 5 (delta D5)
  buildHandoff: (removedCount: number, cycle: number) => string;
  preFlush?: (chat) => Promise<void>;
  onCompacted?: (r: CompactionResult, cycle: number) => Promise<{ systemPrompt?: string } | void>;
  buildResumeContext: (systemPrompt: string) => Promise<AgentContext>;
  shouldContinue: () => boolean;   // ask_user / waitingForInput / deleted gates
  settleInFlight?: () => Promise<void>;  // chat.ts: awaitMidTurnPulse
}

runMidTurnCompactionCycles(opts): Promise<{ cycles: number; systemPrompt: string; aborted: boolean }>
```

The shared part owns: the cycle counter and `needsMidTurnCompaction` clearing,
`truncateChatHistory` + `saveChat({allowTruncation: true})`, the handoff row
(`persistMidTurnHandoff` — one function writes the `_isSystemMessage /
_isMidTurnCompaction / _compactionRemovedCount / _compactionCycle` row so the
two routes can't drift on the KV-critical shape), resume-context rebuild, and
the abort-on-failure semantics.

The part that **stays per-route**: the resumed `runAgentLoop` call and its
`onEvent` handler. This is where the routes genuinely differ (SSE segments,
tool_status, TTS flush, pending-state saves vs emitter calls), and forcing it
through a callback interface would create a second SSE protocol in disguise.
Each route calls `runMidTurnCompactionCycles` inside its own `while` loop and
resumes with its own handler; the skeleton returns after each compaction and
the route decides whether to resume. Honest assessment: this phase shares less
than it looks like — the win is that handoff shape, cycle accounting, and the
flush/rebuild hooks can no longer drift, not that lines move en masse.

**Deliberate non-extraction (final shape).** The loop skeleton itself
(`runMidTurnCompactionCycles`) is **not** extracted — that is the Phase-3 scope
decision (§6), recorded here so the interface sketch above reads as the rationale
for what IS shared (the row writer, the flush/rebuild hooks, the cap value), not
as an open to-do. With handoff shape and the cap unified, the remaining loop
duplication is transport mechanics (SSE reconnect/`ask_user`/crash state vs
headless persist modes and `getFollowUpMessages`), not compaction semantics —
merging the loop would recreate the Phase-4 `TurnState` risk profile (§4.7) with
no correctness payoff.

**Handoff shape vs content (delta D6).** Two things were being conflated; only
one needs to be unified. The KV-critical part is the *row
shape* — `_isSystemMessage / _isMidTurnCompaction / _compactionRemovedCount /
_compactionCycle` — and `persistMidTurnHandoff` unifies that: the writer lives in
`turn-compaction.ts`, both routes call it, and they cannot drift on what the
resumed KV prefix sees.
The *content policy* (which progress text and which tool calls go into the
handoff message body) is a genuine per-route choice and **is not unified**:
`buildHandoff` stays a first-class per-route callback. Head framing carries
the turn's plan/goal; tail framing carries its latest state. Both are
defensible — head's plan framing is real continuity value, and tail's recency
is what "continue from where you left off" points at — and the design does
not force an answer. In force: HTTP (head 5000
chars + all tool calls + 10 fresh memories), headless
(tail 5000 + last 15 calls). Any future content change is gated on a proper A/B —
several representative long turns (≥3, spanning short-loop and
long-tool-chain profiles), not one. Unifying content on tail framing was
considered and rejected — it trades plan-continuity for recency under a thin
gate.

### 4.6 What stays where (the no-change list)

- `chat.ts`: SSE emitter, `ask_user` pause/resume, TTS queue, queued
  follow-ups, pending-state crash recovery, recap/title/push, pre-send
  compaction, the extraction pulse, the four `runAgentLoop` call sites,
  `_rowSequence` stamping.
- `chat-turn-runner.ts`: emitter interface, `getFollowUpMessages` (the
  synthesis phase mechanism), timeout, `persistIntermediateAssistantMessages`
  vs aggregate final path, `promptDebugChatId` threading (fix 4). Its JSDoc
  gains: *"Callers must run `runEndOfTurnCompaction` after the turn returns;
  mid-turn protection is provided by `shouldStopAfterTurn` + the caller's
  cycle loop."*
- `system-chat.ts`: phase orchestration, sleep/wake gating, cycle locks.
- `agent-loop-runner.ts`: untouched.

### 4.7 Phase 4 (deferred, optional): `TurnState`

Both routes maintain an accumulator + boundary-cursor machine (chat.ts's nine
`committed*` counters + `resetAccumulators`; headless's
`lastPersistedAssistantBoundary` object). Headless's is the cleaner model.
Unifying them is a real maintainability win but it touches the live SSE path,
crash-recovery pending states, and the `_rowSequence` re-anchoring contract —
the highest-risk surface in the file for the least correctness payoff.
Decision: **do not start before phases 1–3 have shipped and settled**, and
only if state drift causes another incident.

## 5. Intentional behavioral deltas

Each is a named change with a verification gate. None are silent.

| # | Delta | Route | Risk | Gate |
|---|---|---|---|---|
| D1 | Headless mid-turn trigger acts on the unified estimator | headless | trigger timing shifts | shadow week (§4.2) → flip: `midTurnPressureDecision` owns the trigger mapping; shadow mode is retired |
| D2 | Headless end-of-turn: refined estimate + 0.80 trigger | synthesis, wake | compacts earlier | forensics >100% cases as regression tests; watch end-of-turn fire rate for 1 week. Synthesis + wake run on `runEndOfTurnCompaction` with the usage anchor; the negative-path log covers headless |
| D3 | Automations gain an end-of-turn check | automations | new behavior, none before | automations execute end-of-turn at **0.85** (`COMPACTION_TRIGGER_RATIO`), decided by the §9 Q1 rule from log-only gate data; no `logOnly` flag exists anymore |
| D4 | Headless compaction runs `preCompactionFlush` | headless | closes the identity-level gap (memories from removed context); adds extraction latency to headless compaction | the shared `preCompactionFlushHook` in `memory-extraction.ts`, wired at every headless compaction site — synthesis/wake/automation pre-send + end-of-turn, and headless mid-turn in `chat-turn-runner.ts` (§4.4) |
| D5 | Mid-turn max cycles 3 → 5, both routes | headless | longer synthesis phases run longer | both routes cap at 5 — gate data showed a tail that reached the old cap. Cap-hit warns in headless too (HTTP-exhaustion-log style, with the end-of-turn next-line-of-defense framing) so the next cap question is answerable from logs; bounded cost of ≤2 extra compact+flush cycles under the global lease on tail runs |
| D6 | Mid-turn handoff **shape** unified (one row writer); **content** stays per-route (HTTP: head+all-tools+memories, headless: tail+last-15) | both | none — content unchanged | `persistMidTurnHandoff()` in `turn-compaction.ts` owns the row shape and its save; `chat.ts` and `chat-turn-runner.ts` both call it. Row bytes identical on both routes; placement semantics preserved (headless pushes at the tail, HTTP splices at its captured index). The row writer takes finished text, so per-route `buildHandoff` content policy is untouched and any content change rides the ≥3-long-turn A/B gate. The full loop merger (`runMidTurnCompactionCycles`) is deliberately not extracted — §4.5 / §6 Phase 3 |
| D7 | (opt-in) Headless mid-turn compaction may rebuild the system prompt | headless, via `onCompacted` | changes synthesis KV/prefix behavior; frozen-prefix semantics shift | **PARKED by design** — keeping it unshipped is itself the decision: the value is bounded (see below). The risk framing is stale in the safer direction: the retained-frozen-prefix + Case-3-delta model IS the system-chat invariant across cycles (the rebuild rides "like any other follow-up message"), and the automation runner already delivers rebuild deltas through the hidden-row + `commitMemoryDelta` pattern. A D7 rebuild would therefore be a soft reset + delta on the existing contract, not a prefix-semantics change — cheap to add IF a long single phase ever shows mid-run staleness; D4's flush makes memories extracted from mid-turn compaction sit undelivered until the next run's build, which is the concrete scenario to watch for |

D7's value is deliberately bounded: each synthesis or wake run rebuilds before
its phases (a retrieval-skipped rebuild that retains the chat's existing frozen
section) at system-chat.ts:1050, 1398,
so frozen-prefix staleness only bites *within* a single long run that
compacts mid-turn. Staying unshipped stays correct; the hook exists for the day
a long single phase shows it matters.

## 6. Migration plan

Each phase ships independently, keeps the wire format, and lands behind the
existing test suite. Order is by payoff-to-risk.

**Phase 0 — pin current behavior as named regression tests**
(`server/src/__tests__/compaction-forensics.test.ts`). Convert the
14-day forensics into named tests *before* code moves: the 84.8/85.3
dead-band case (table row for `endOfTurnNeedsCompaction`), the end-of-turn
negative-path log assertion, the pre-send fire cases, the >100% system-chat
cases, the scaleFactor clamp and degenerate-defang tests (already in
`compaction-safety.test.ts`). No production code changes.

**Phase 1 — Estimator.** `context-pressure.ts` with
`estimateContextPressure` + `evaluateTurnGuards`. `chat.ts` adopts (its inline
anchor/exact/char plumbing collapses to the call; observation recording stays
via `onObservation`; the SSE iteration payload fields map 1:1 from the return
type). Headless `shouldStopAfterTurn` adopts in **shadow mode** (§4.2).
Guards extracted; both routes' dedup/cap blocks delegate. Exit criteria:
suite green, one week of clean shadow logs, then the D1 flip
(the verdict that gated this phase is recorded once, in §4.2).

**Phase 2 — End-of-turn.** `runEndOfTurnCompaction` in `turn-compaction.ts`.
`chat.ts` adopts (no behavior change — the block moves). System-chat
synthesis/wake adopt (D2, D4). Automation adopts log-only (D3), flips after a
week. Exit criteria: the three forensics regression tests pass against the
new code path; negative-path logs appear from all four call sites.

**Phase 3 — Mid-turn.** `persistMidTurnHandoff` + the shared cap
(D5 → 5 in both routes). Both routes adopt; D7 stays parked (§5). D6
ships as shape-only unification — row writer shared, content policy per-route
and unchanged. The full `runMidTurnCompactionCycles` loop merger is
intentionally **out of scope** — rationale in §4.5; what Phase 3 shares are
the two things the design named as deltas: the row and the cap.
Exit criteria: handoff row bytes identical on *both* routes
(shared shape + each route's existing content), the row produced by exactly
one function so shape drift is structurally impossible, and cycle logs
unchanged in shape (the `<prefix> mid-turn compaction cycle N` forms already
match across routes).

**Phase 4 — TurnState.** Deferred per §4.7.

## 7. Testing

- **Estimator**: fixture-driven unit tests — recorded (messages, usage, tool
  results) triples asserting `selectedPath`, the self-gating (no exact HTTP
  below threshold), anchor+postUsage arithmetic, char fallback, and error
  degradation. The 84.8/85.3 case and the >100% cases are table rows.
- **Guards**: table-driven (streak boundaries, cap boundaries, per-segment
  cap).
- **End-of-turn execution**: fake `truncateChatHistory` + fake hooks; assert
  decision routing, keepalive wrap invocation, flush ordering (flush before
  truncate, pulse settled before flush), negative-path logging, and that
  `onCompacted` runs only on truncation.
- **Mid-turn skeleton**: fake truncate + fake resume-context builder; assert
  cycle accounting, flag clearing, handoff row shape (byte-identical to the
  current HTTP shape), abort-on-failure, `maxCycles` exhaustion returning
  `aborted: true`.
- **Shadow logs**: a test that the legacy and unified paths both compute and
  log during shadow mode.
- Existing suite green at every phase; `tsc --noEmit` clean;
  dist build before each porrima.service restart (the usual discipline).

## 8. Risks

1. **Fresh fixes regressing.** Recently-landed fixes are the ones most likely to be
   regressed by consolidation, and these are load-bearing (MTP live, long
   turns in production). Mitigation: Phase 0 pinning is not
   optional; every phase's exit criteria include the named regression tests.
2. **Shadow mode hiding a real divergence.** If unified and legacy disagree
   systematically in one direction for headless, the estimator model is wrong
   for that workload, not just noisier. Mitigation: the shadow week has an
   explicit review step — a consistent bias gets investigated, not averaged
   away.
3. **chat.ts coupling.** The inline estimator block feeds the SSE iteration
   payload, the pending-state observation record, and the pulse's
   contextRatio. The facade must return everything those consumers need
   (`refinedTokens`, breakdown fields) or chat.ts keeps a thin adapter.
   Mitigation: Phase 1 starts with a byte-level diff of the SSE payload
   before/after on a recorded turn.
4. **D4 latency.** Headless compaction now waits for the extraction flush.
   Synthesis is the long-turn workhorse; a slow extraction server extends
   compaction stalls. Mitigation: the flush already has its timeout. The
   flush runs while holding the **global turn-gate lease**, so
   the watch item is foreground gate wait, not just background cycle
   duration — and headless turns stream with HTTP frame parity, so
   attached viewers experience the stall directly; the emitter's
   `compacting` frame is part of D4. **Monitor** gate
   wait + cycle durations; the substantive filter keeps
   system-chat sites near-zero, so the load to expect is where headless
   runs compact *agent* chats (reminders/wakes).
5. **Scope creep toward runner merger.** The shape of this design invites
   "while you're in there…" pressure to merge transports. Non-goal, in
   writing, for the life of this doc.

## 9. Open questions

1. Should automations' end-of-turn check use 0.80 or keep 0.85? Current
   leaning: 0.80, same "nobody is waiting" rationale — but automation cadence
   (some are hourly) makes the pre-send backstop much closer than for
   synthesis, which argues for 0.85. The D3 log-only week settles it with
   data instead of opinion; the decision rule is defined up front so the week
   can't end in "looks fine": each logged turn records drivingTokens/window
   and whether it would have compacted at 0.80, at 0.85, or neither.
   **Sample floor**: ≥10 automation turns (extend the window if fewer).
   **Choose 0.80** if <10% of turns fall in the (0.80, 0.85] band AND no turn
   exceeds 0.90 (headroom exists; the earlier check just does the same work
   cheaper). **Choose 0.85** if ≥10% sit in the band — at hourly cadence the
   pre-send backstop is close enough that the extra compactions buy little.
   **Resolved: 0.85, and the check executes.** The gate week cleared the sample
   floor, put ≥10% of turns in the (0.80, 0.85] band, and included fires above
   0.90 → the rule chooses 0.85; the 0.80 branch was disqualified by the >0.90
   fires regardless. Note the >0.90 cases — overflows that would otherwise sit
   computed-not-executed until the next run's pre-send — fire at 0.85 too;
   executing is what moves them from *next run's wait* to *this run's quiet
   tail*, which was the point of the check. Call site
   passes `triggerRatio: COMPACTION_TRIGGER_RATIO`; synthesis/wake keep the
   0.80 default (D2).
2. Where does the memory section of the headless mid-turn handoff come from,
   if system-chat ever wants one? `getMemoriesFromChat` is HTTP-route-shaped;
   system-chat's memory model is the frozen prefix. Leaning: leave it out for
   system-chat (the prefix already carries stable memories; the handoff
   carries turn progress), and `buildHandoff` stays the seam if that changes.
   **Resolved: left out.** The shared writer takes finished
   text, so the seam is intact by construction — the content decision stays
   per-route and any change rides the D6 ≥3-long-turn A/B gate. D4 changes
   the calculus slightly: mid-turn flush memories now wait for the next
   run's build rather than riding the handoff — the concrete trigger for
   revisiting is that gap biting in a long phase, which is also D7's watch
   scenario.
