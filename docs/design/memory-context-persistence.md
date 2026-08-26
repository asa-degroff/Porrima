# Memory Context Persistence — Surviving the Process That Owns the Cache

**Status**: Design (v1.3 — verified against live code; §10 adds compaction re-roll fix)
**Author**: quje
**Date**: 2026-08-25 (revised 2026-08-26)

v1.1 changes: call-site inventory verified exhaustively (two sites the v1
inventory missed: `automation-runner.ts:214`, `agent-snapshots.ts:270`);
fourth write point added (`markMemoryDeltaInjected`); row-level global
invalidation added (a v1 correctness gap — post-restart global corpus
changes would silently land on zero chats); non-write-site decisions
recorded (snapshot restore, skip path, `getMemoryContextIds` ordering);
Phase 2 sub-case analysis and the dirty-state leak question added.

v1.2 changes: Phase 2 warm-queue timing check completed against live code
(commit 78edd8c).

v1.3 changes: Phase 1 verified LIVE in production (hydrate/persist/dirty
fall-through all present). KV-cache hit-rate forensics from llama-server
logs (08-26) established that the dominant remaining prefix invalidation is
**compaction-time Case 1 re-rolls**, not restarts — see §10 for the fix:
clobber guard + soft reset, with hysteresis re-roll deferred behind it.

## 1. Problem

Two incidents on 08-25 produced the identical symptom — a full cold prefill across a
chat's next turn — with opposite causality:

- **05:42:21** — the llama-server process died (glibc heap corruption, first ever).
  Server-side KV loss. Every chat's next turn owed a full prefill. Unavoidable.
- **02:30:32** — porrima restarted 79 seconds earlier (an Asa deploy, 02:29:13).
  Client-side prefix rewrite. The prefill was **avoidable** — the server still held
  99% of the usable state.

The 02:30:32 case, in full:

| Time | Event |
|---|---|
| 02:22:43 | Turn for chat 9df35ad4. `full retrieval: 1 memories frozen in system prompt`. Prompt A (hash 60c30f4c5337, system prompt 21,737 ch). Full prefill — owed (first turn after a 02:21 porrima restart). |
| 02:27:32 | Client disconnects. Slot 1 released, prompt A's state (73,399 tok) still in VRAM. No compaction (58.5% < 80%). |
| 02:29:13 | porrima restart (deploy bce0e5e). `contextState` Map dies with the process. |
| 02:30:32 | Next turn, same chat. `full retrieval: 2 memories frozen in system prompt`. Prompt B (hash 735649d13c5c, +986 ch in system prompt). |
| 02:30:32.508 | llama.cpp: `selected slot by LRU` — slot 1's 99%-similar state was **invisible to selection**. |
| 02:30:32.712 | Full cold prefill, 73,077 tokens. Slot 0's displaced state FIFO-evicts a 4,706 MiB pool entry to make room. |

The discriminating log line for forensics: a `[memory-context] full retrieval: N
memories frozen in system prompt` immediately preceding a cold prefill means the
*client* rewrote the prefix. No such line before a cold prefill means the *server*
lost state. From now on, "who owes the prefill" is a two-way question.

### Why the prefill happened: the LCP math

Slot reuse in b10164 gates on `sim = LCP(resident, new) / new > 0.50` (strict;
`server-context.cpp:1566/1568`; `--slot-prompt-similarity 0.50` in the running
config). The frozen-memories section sits **between** the stable prefix and the
conversation history (`systemPrompt = stablePrefix + frozenMemoriesSection`,
memory-context.ts:1027). The 1↔2 memory flip changed the section, so the LCP between
prompt A and prompt B stops at the section boundary — the stable prefix alone,
≈ 7,000 tokens of 73,077 ≈ **0.096**. Five times under the gate. The resident state
that a re-roll would have reused in ~4 tokens of prefill was walked past.

### The secondary cost: pool orphans

Under `--cache-idle-slots` + `--kv-unified`, every task launch saves all idle slots'
state to the 32 GiB RAM pool and clears them (`server-context.cpp:2398–2416`). Prompt
A's state entered the pool milliseconds after the 02:30:32 launch. It can never be
restored: pool entries are only eligible at `LCP ≥ 25%` of the entry's own length
(`server-task.cpp:1761`, `// don't trash large prompts`), and any future prompt for
this chat shares ≈ 9.5% with it. It is dead weight until FIFO eviction
(`server-task.cpp:1700`) — and in a 3-slot server, a few orphaned multi-GiB entries
crowd out restorable state for everyone. **Every restart-triggered flip manufactures
one.**

### Root cause

`buildSplitAugmentedPrompt` (memory-context.ts:970) has three cases:

- **Case 1** (L1021): no in-memory state → full retrieval → reranker rolls fresh →
  whole set frozen into the system prompt.
- **Case 2** (L1050): state, not dirty → `stablePrefix + frozenMemoriesSection`,
  byte-identical.
- **Case 3** (L1056): state, dirty → re-retrieve, diff against
  `frozenIds ∪ deltaIds`, append **new** memories as a tail delta.

Case 1's precondition is documented as "first turn or post-compaction" but
**implemented as "no state in the Map."** Process death is indistinguishable from a
first turn. The frozen set is a pure function of (query, corpus) at roll time — the
corpus is durable (SQLite), the roll is not, and the reranker (0.6B, 8082) is
non-deterministic on borderline scores. Same query, same 21→15 candidate set, same
corpus, top set flipped (08-25 02:22→02:30: 1 frozen → 2 frozen).

The design is internally consistent *within a live process*: the frozen section is
byte-stable and new memories tail in as deltas. The bug is that the consistency
guarantee has a process-lifetime, while the thing it protects (the server's KV)
does not.

### Prior evidence the problem is known

`cache-warm.ts:294` already fights this with a local workaround — the comment says
it verbatim: *"Freeze the current memory context into the system prompt now, so the
later send path reuses the same prompt instead of doing a fresh retrieval that shifts
the entire prefix and misses the warmed slot."* It calls `resetMemoryContext` + fresh
Case 1 to pre-bake a re-rolled prompt. That patch has a defect of its own: the warmed
prompt is the **re-roll**, not the user's previous prompt — so for an established
chat the warmed slot still misses the user's actual next turn. The workaround treats
the symptom and worsens the warm's hit rate; the fix below removes the need for it.

## 2. Durability inventory

| Artifact | Where | Survives porrima restart? |
|---|---|---|
| Memory corpus | SQLite `memories` (+ FTS, vectors) | ✓ |
| Memory blocks | SQLite `memory_blocks` | ✓ |
| Conversation history | SQLite `chat_messages` | ✓ |
| Base system prompt | SQLite `chats.systemPrompt` | ✓ |
| `stablePrefix` | derived — deterministic from durable inputs (base prompt, blocks, persona, user doc, AGENTS.md, static hints) | ✓ rebuildable |
| **Frozen set (ids + section text)** | **process Map** (memory-context.ts:134) | **✗ ← the bug** |
| `deltaIds` | process Map | ✗ (minor: dedup only) |
| `promptCache` / `stablePrefixCache` / `promptBreakdownCache` | process Maps | ✗ (derived, cheap) |

The only non-derivable, non-durable artifact is the frozen set. That is the fix
surface.

## 3. Options

### A. Persist the context state per chat — **recommended**

New table, write-through on state changes, hydrate on Case 1. Restore is
**byte-exact by construction**: we persist the section *string*, not the inputs, so
there is no rebuild, no re-query, no reranker in the path. Details in §4.

### B. Persist the last augmented system prompt; re-parse the section on restart

Rejected. Persisting a 21k-char prompt to string-surgery a ~20k substring out of it
is a weaker guarantee (parse fragility) for a larger blob. Subsumed by A, which
persists exactly the substring.

### C. Hysteresis on the frozen set (stability margin on rerank scores)

**Downgraded from "necessary" to "optional follow-up."** Re-examining the in-process
paths: Case 3 (the dirty path) never touches the system prompt — it appends a delta
row at the tail, and delta rows are new history, not prefix. Reranker flips in
Case 3 are therefore prefix-free. The only in-process path that re-rolls the frozen
set is compaction (reset → Case 1), and there the re-roll is *owed* — the whole
prefix is being rebuilt anyway. Hysteresis would only reduce **orphan production**
at compaction time (a re-roll that lands on a near-identical set still re-saves a
replaced pool entry). Worth doing someday; not the fix.

### D. Move the frozen section to the tail of the full prompt

Rejected. Changes the model's reading order (memories should apply to the whole
conversation, not be read after the user message) and violates the standing
constraint: no prompt reordering, vanilla cache semantics is ground truth.

### E. Restart llama-server alongside porrima

Rejected. Converts an avoidable, per-chat cost into a universal one — every chat
cold-prefills, which is exactly what the 05:42 heap crash did. The cache is the
asset; the process is disposable.

### F. Do nothing / budget it

Rejected. Asa deploys porrima several times a day; each deploy re-pays a 73k-token
prefill (≈ 2–3 min GPU on a 3-slot server, serialized behind the turn gate) for
**every active chat**, plus manufactures multi-GiB pool orphans. The cost scales
with the number of live chats and the deploy cadence. Measured, not theoretical.

## 4. Recommended design (Option A)

### 4.1 Schema

Owned by `memory-storage.ts` (same DB, same `CREATE TABLE IF NOT EXISTS` +
PRAGMA-table_info migration idiom as the `memories` table):

```sql
CREATE TABLE IF NOT EXISTS memory_context_state (
  chat_id        TEXT PRIMARY KEY,
  frozen_section TEXT NOT NULL,            -- the exact section string
  section_hash   TEXT NOT NULL,            -- sha1(frozen_section), forensics
  frozen_ids     TEXT NOT NULL DEFAULT '[]',  -- JSON array
  delta_ids      TEXT NOT NULL DEFAULT '[]',  -- JSON array
  dirty          INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);
```

~20 KB per active chat. One row per chat. No indexes needed beyond the PK.

Helpers exported from memory-storage.ts: `getMemoryContextState(chatId)`,
`upsertMemoryContextState(chatId, state)`, `deleteMemoryContextState(chatId)`.

### 4.2 Service changes (memory-context.ts, ~60–80 lines)

**Hydrate — Case 1 entry (L1021).** Between the `skipMemoryRetrieval`
early-return (L1016) and the state read (L1018):

```
if (chatId && !contextState.has(chatId)) {
  row = getMemoryContextState(chatId)
  if (row) {
    contextState.set(chatId, { frozenIds, deltaIds, frozenMemoriesSection: row.frozen_section, dirty: row.dirty })
    log(`[memory-context] chat=${chatId} restored frozen set: ${n} frozen + ${m} delta, section ${len} ch (hash ${row.section_hash})`)
  }
}
// Case 2/3 logic now runs on the restored state
```

The `restored frozen set` log line is the forensic canary that replaces
`full retrieval` as the post-restart signature. A DB read failure warns and
falls through to a Case 1 re-roll (bookkeeping must never break a build).
The `skipMemoryRetrieval` path must **not** hydrate: it returns bare
`stablePrefix` with no frozen section, so hydrated state would wrongly
suppress passive-recall injections for memories that are not in the prompt.

**Persist — five write points:**

1. Case 1, after `contextState.set` (L1030) — the freeze.
2. Case 3, after delta update (L1066–1069) — new `deltaIds`, `dirty=0`.
3. `invalidateMemoriesCache` (L140) — `dirty=1` on the Map entry; **fall
   through to the row when the Map entry is absent** (post-restart, before
   first hydration). Without this, an extraction-driven invalidate that lands
   after a restart evaporates, and the later hydration restores a stale
   `dirty=0`.
4. `invalidateAllMemoriesCaches` (L151) — `dirty=1` on all Map entries **plus
   a bulk `UPDATE ... SET dirty=1` on all rows.** This is the v1 gap: after a
   restart the Map is empty, so a global corpus change (synthesis, global
   extraction) would land on zero chats — and v1's behavior only "healed" that
   via the full re-roll this fix removes.
5. `markMemoryDeltaInjected` (L179) — passive recall (mid-turn and post-turn,
   passive-memory-recall.ts:449/600) mutates `state.deltaIds`. Without this
   point, a restart after an injection restores stale `delta_ids` and the next
   Case 3 re-injects memories already present in the history as delta rows.

All persist calls are wrapped in try/catch → `console.warn`: a bookkeeping
write must never kill a turn. `dirty` is semantically "corpus changed since
last retrieval for this chat" — a property of (chat, corpus), not of process
lifetime. Worst case after restore is one extra Case 3 delta at the tail —
prefix-safe.

**Reset — `resetMemoryContext` (L161).** Also `DELETE` the row. Compaction,
cache-warm, system-chat zeitgeist rewrites, chat deletion, and automation
starts all funnel through this function (chat.ts ×6, cache-warm.ts:294,
system-chat.ts ×2, chat-deletion.ts:24, automation-runner.ts:214) — one place
to keep the durable state honest. The automation-runner reset is by design:
its trigger message is synthetic, so the next *real* turn's re-roll is owed,
exactly like compaction (and identical to today's in-memory semantics).

**Non-write sites (deliberate, v1.1):**

- `resetAllMemoryContextCaches` (L213, called from agent-snapshots.ts:270
  after a snapshot restore) — clears the Map only, **no row operations.** The
  rows live inside the memory DB file, so they time-travel with the corpus and
  arrive consistent with the restored state. Wiping them would force re-rolls
  across all chats — the exact cost this fix eliminates.
- `getMemoryContextIds` (L171, read-only) — safe without hydration of its own:
  every turn path builds (and thus hydrates) before the passive-recall engine
  first runs. On the `skipMemoryRetrieval` path an empty dedup set is
  *correct*, since the prompt contains no frozen section.

**`invalidateAllCaches` (L197) — behavior change.** Currently deletes
`contextState` → next turn re-rolls. Sole caller: project workspace change
(projects.ts:143). Change to clear only the *derived* caches
(`stablePrefixCache`, `promptCache`, `promptBreakdownCache`) and keep the frozen
state. Rationale: a workspace change rewrites AGENTS.md → `stablePrefix` changes →
the prefill is owed anyway; re-rolling the frozen set on top adds an orphan and a
second source of churn for zero benefit. (The section embeds `blockHint`/
`zeitgeistHint` — both derived from durable/static inputs, so the persisted string
stays valid.)

### 4.3 Edge cases

| Case | Behavior |
|---|---|
| First deploy, no rows | Case 1 as today; row written. One-time re-roll per active chat on its next turn after deploy — the cost this doc eliminates *going forward*, unavoidable for existing chats. Deploy at a quiet time. |
| Case 1 retrieval fails | No state established → no row → next turn retries. Unchanged (L1040). |
| Fresh chat, restart before first turn | No row → Case 1. Correct. |
| Frozen memory deleted/superseded while frozen | **No validation on hydrate.** Current Case 2 semantics already tolerate stale frozen content until compaction; changing that would be a separate behavior change with its own prefix cost. Log a warning when `frozen_ids` don't resolve against the corpus (observability only). |
| `skipMemoryRetrieval` (automation starts) | No state touched, no row written. Unchanged (L1011). |
| Chat deletion | `resetMemoryContext` already called (chat-deletion.ts:24) → row deleted. |
| Concurrent writers | N/A — single porrima process under systemd. If that ever changes, this table needs a write lock; noted, not solved. |
| System chat | Same table, `SYSTEM_CHAT_ID`. Zeitgeist rewrites reset → re-roll owed (stablePrefix changes anyway). |
| Automation run in a chat that has a row | `resetMemoryContext` deletes the row by design; next real turn re-rolls (owed — synthetic trigger, same as today's in-memory semantics). |
| Snapshot restore (agent-snapshots.ts:270) | `resetAllMemoryContextCaches` clears the Map only; rows time-travel with the memory DB file and are consistent with the restored corpus. No row wipe. |
| Restart after a passive-recall injection | `markMemoryDeltaInjected` persists `delta_ids` (write point 5) → no double injection on the next Case 3. |
| Global corpus change after restart, before any turn | `invalidateAllMemoriesCaches` bulk-updates rows (write point 4) → later hydration restores `dirty=true` → Case 3 delta, prefix-safe. |

### 4.4 Secondary change (Phase 2): cache-warm stops re-rolling

With persistence, the send path restores the *user's actual* frozen section, so
cache-warm's `resetMemoryContext` + fresh Case 1 (cache-warm.ts:294) is no longer
needed for alignment — and for established chats it is actively harmful (warms a
re-rolled prompt the user's next turn won't match). Dropping the reset makes the
warm bake `stablePrefix + restored frozen section` = the user's actual next-turn
prompt = a warm that can actually hit. One-line change; the warm-queue timing
check against the send path was completed 08-25:

**Timing check (verified 08-25 against live code):** the send path
(send/resume/repair/edit in chat.ts) acquires the turn gate; warm does not — it
is gated only by the warm-queue mutex, `llm-activity.waitForIdle`, and deferral
while synthesis/wake/automation is active. `isCacheWarmOrLlamaRuntimeBusy`
covers the reverse direction: the scheduler yields to a busy warm. Residual
window: an interactive turn arriving after the idle check and before the
prefill POST runs concurrently with the warm. Bounded, not corrupting: a Case 2
build is row-read-only and the frozen section is invariant under Case 3, so the
warm bakes `stablePrefix + frozen section` — a byte-prefix of the concurrent
turn's Case 3 prompt (worst case a warm miss; best case the turn rides the
warmed prefix) — and the dirty mark (line 309) preserves the "next turn
retrieves for the new message" contract either way. Decision at PR time:
accept (matches the dirty-leak lean), or add a yield-to-waiters deferral in
`drainQueue` — check `turnGateStatus(job.chatId)`, defer with 30s backoff as
for automations — ~5 lines, closes the window without priority inversion.

**Sub-case analysis (v1.1).** The change is dropping the `resetMemoryContext`
call only; the trailing `invalidateMemoriesCache` stays, which preserves the
"next real turn still retrieves for the new prompt" contract:

| State at warm | Warm builds | Real turn | Warm hit? |
|---|---|---|---|
| clean | Case 2 — user's actual prompt, no retrieval | dirty → Case 3, retrieves against the *new* message | ✓ |
| dirty | Case 3 — same system prompt (delta discarded by warm) | dirty again → Case 3 | ✓ |
| no state (fresh / post-compaction) | Case 1 roll, as today | Case 1 re-roll against new query | ~same as today |

**Open question at implementation time:** warm on a *dirty* state runs Case 3
against the old messages and consumes the results into `deltaIds` — but the
delta rows are never sent (warm bakes only the system prompt). Those memories
are then "marked injected" without being in context. The leak is bounded
(top-8 of the old query, topically recent) and the lean is accept-it; the
alternative is a read-only warm mode, which is a real code-path change. Also
check: warm's Case 3 retrieval runs `updateAccessMetadata`, inflating access
stats for memories the user never saw — minor, same class.

## 5. What this does NOT fix (scope)

- **Block-edit prefills.** Editing a memory block changes `stablePrefix`
  legitimately → the prefill is owed, payer ≠ editor. That externality is the
  turn-engine's territory (activity-based timeout, false-success detection), not
  this one.
- **Server-side loss.** Crashes and evictions are unavoidable; the 05:42 heap
  corruption remains an open watch item regardless.
- **Compaction re-roll nondeterminism.** Was deferred as "owed; see option C" —
  reopened and addressed in v1.3, see §10 (fix lives in a separate change).

## 6. Test plan

**Unit** (`memory-context-persistence.test.ts`):
1. Seed a row → hydrate → Case 2 returns the persisted section **byte-exact**
   (sha1 compare, not string-equal — the artifact is the hash), and no
   retrieval runs.
2. No row → Case 1 → row written with the frozen payload.
3. Dirty row + new memories → Case 3 → row updated: `delta_ids` grown,
   `dirty=0`.
4. `invalidateMemoriesCache` with an empty Map → row-level `dirty=1` (write
   point 3 fall-through); `invalidateAllMemoriesCaches` → bulk row update.
5. `markMemoryDeltaInjected` → `delta_ids` upserted (write point 5).
6. `resetMemoryContext` → row gone; next build is Case 1.
7. `invalidateAllCaches` → derived caches cleared, **row and Map state
   intact**; next build is Case 2.
8. `skipMemoryRetrieval` → no hydration (row not read); hydrate failure
   (DB throw) → warn + Case 1 fallback.

Storage-level (real SQLite, tmpdir home): upsert/get/delete round-trip,
`section_hash` = sha1(section), `INSERT OR REPLACE` single-row invariant,
`setMemoryContextDirty` is a no-op (no row created) for unknown chats,
`setAllMemoryContextDirty` flips all rows.

**Integration (the real test, manual):**
1. Open a 50k+-token chat, let it run warm (two+ turns).
2. `systemctl --user restart porrima`.
3. Next turn: assert — (a) `restored frozen set` log line, (b) porrima prompt hash
   identical to pre-restart, (c) llama.cpp `cached_tokens` ≈ full prompt length
   (not ~7k), (d) no `making room` eviction line at turn start (no orphan made).
4. Regression: trigger compaction → next turn re-rolls (row absent by design).
5. Regression: delete a chat → row gone.

**Standing canary:** after deploy, `full retrieval: N memories frozen` should appear
only on genuine first turns and post-compaction turns. Any mid-conversation
occurrence is the fix failing — the line is the tripwire.

## 7. Rollout

- **Phase 1 (one PR):** table + migration in memory-storage.ts, hydrate/persist/
  reset in memory-context.ts, `invalidateAllCaches` behavior change, log lines,
  unit tests. ~100 lines total.
- **Phase 2 (separate, small):** cache-warm reset removal, after timing check.
- **Phase 3 (optional, deferred):** hysteresis on compaction re-rolls to reduce
  orphan production — only if pool occupancy forensics show orphans mattering.
- **Verification order:** system chat first (its turns are self-observable: the
  verifying turn's own `cached_tokens` is the measurement), then a user chat.

## 8. Cost / benefit

| | |
|---|---|
| Cost | ~100 lines, 1 table (~20 KB/chat), <1 ms SQLite per dirty turn, one-time re-roll per active chat at deploy |
| Benefit per deploy | Saves every active chat a 73k-token prefill (≈ 2–3 min GPU, serialized behind the turn gate) + stops manufacturing multi-GiB pool orphans that crowd out restorable state in a 3-slot, 32 GiB pool |
| Scales with | number of active chats × deploy cadence — both trending up |

## 9. The general shape

A stateless-looking restart is never stateless when the state lives in two processes
with different lifetimes. The frozen set exists to protect a cache that outlives it;
the shorter-lived process's "fresh start" is the longer-lived process's
mid-conversation amnesia. The fix pattern: **persist the artifact the longer-lived
side depends on — the exact string, not the inputs that produced it — so restore is
deterministic by construction and the non-deterministic step (the rerank) is
performed exactly once, at the moment it is owed.**

The same seam will appear anywhere future features park derived prompt content in
process memory: the turn-engine's shadow estimator state, cache-warm's baked
prompts, anything that says "recompute is cheap" while the thing being protected
lives on the other side of a process boundary. When you see it, this doc is the
template.

## 10. Compaction re-roll fix (v1.3 — closes §5's third scope item)

### 10.1 Forensics that motivated reopening the scope item

KV-cache hit-rate reconstruction from llama-server INFO logs (08-26, GPU 27B
server): per-request reuse = `release n_tokens` − total `prompt processing`
tokens. Hits were 94–100% everywhere except bursts that correlate exactly with
compaction cycles and frozen-set flips. The worst offenders:

| Time | Hit | Event |
|---|---|---|
| 06:35 | 7% | synthesis compaction cycle 2 rewrote history |
| 13:46 | 2% | post-compaction Case 1 re-roll (`11 filtered` by threshold) |
| 14:24 / 14:41 | 48% / 53% | agent-chat mid-turn overflow → compaction |
| 16:15 | 4% | post-compaction re-roll landed on **0 frozen** (clobber class) |

Every miss was followed by recovery to 94–99% on the next turn — the damage is
one large cold prefill per event, plus one manufactured pool orphan each.

Meanwhile Phase 1 shipped (9fa10f4) and restart-triggered flips disappeared
from the logs; §7's verification confirmed hydration works (byte-exact,
`LCP sim 0.995`). The remaining `full retrieval:` lines between genuine first
turns were all **post-compaction**. So the §5 item "Compaction re-roll
nondeterminism — owed" is now the dominant avoidable cost and gets a design.

### 10.2 Root cause chain

1. Compaction calls `resetMemoryContext(chatId)` → deletes Map state **and**
   the durable row.
2. Next build = Case 1 full retrieval → nondeterministic rerank roll → new
   `frozen_section` string, new hash.
3. The retrieval pipeline applies the relevance threshold pre-freeze; a
   reranker variance dip (or topic-anchor dampening after topic drift) can
   return an empty or near-empty set, which then unconditionally overwrites a
   good row. Observed twice overnight (00:13:23, 03:47:49) and again at
   16:15 — the hysteresis series 5→4→0→3 in one night.
4. Each flip breaks LCP at the section boundary (~0.096 sim per §1 math),
   walks past a warm slot, and manufactures an orphan entry in the pool.

The freeze is *owed* at compaction (prefix rebuilt anyway), but rolling fresh
dice each time is not — and silently degrading to an empty set never is.

### 10.3 Fix A — clobber guard (~10 lines)

At the Case 1 freeze site (memory-context.ts, after `retrieveMemories`): if
`memories.length === 0`, skip establishment entirely — set no state, persist
no row, log

```
[memory-context] chat=X full retrieval returned 0 — not freezing, will retry next build
```

Rationale: an empty retrieval is evidence of query/anchor failure, not corpus
emptiness. Freezing zero memories was exactly how an empty section became
canonical (00:13:23, 03:47:49): once the row existed, Case 2 held it until
the next compaction. Skipping establishment means the next build retries full
retrieval with that turn's query, mirroring the existing retrieval-error path.

Structural note (v1.3 revision while implementing): post-Phase-1 hydration
promotes any surviving row to state **before** Case 1 runs, so a Case 1
arrival structurally has no prior section to retain — "retain previous" is
unreachable there. The effective protection against the clobber class is this
guard (never writes a fresh empty canonical set) plus Fix B (rows survive
compaction at all). Reaching Case 1 alongside a live row can only mean the
row read failed (already warned); the guard keeps even that path free of
empty writes. The existing catch-block on retrieval failure already behaves
correctly and stays.

### 10.4 Fix B — soft reset at compaction (~30 lines)

New export in memory-context.ts:

```ts
export function softResetMemoryContext(chatId: string): void
```

- Clear `deltaIds` only; keep `frozenIds` + `frozenMemoriesSection`.
- Set `dirty = true`; persist to the row.
- If no Map entry exists, hydrate from the row first so a soft reset never
  resurrects state from nothing (no-op when no row exists).

Then switch the **post-compaction** `resetMemoryContext` call sites to it.
Site inventory requires per-call verification, but the class is: call sites
that run inside or immediately after a compaction flow where the conversation
history is rewritten but the chat continues. Keep hard `resetMemoryContext`
(row delete + full re-roll) for:

- **Chat deletion** (chat-deletion.ts:24) — nothing left to preserve.
- **Zeitgeist rewrites** (system-chat.ts ×2) — `stablePrefix` changes anyway;
  re-roll is subsumed by the owed rewrite cost.
- **Automation starts** (automation-runner.ts:214) — synthetic trigger message;
  next real turn's roll uses a real conversational query and is owed (doc §4.2).
- Project workspace change path (if reachable) — stablePrefix rebuild owed.

Effect: post-compaction turns become Case 3 delta builds against compacted
history. Section string survives compaction byte-exact → prefix holds from
stablePrefix through the whole history tail → hits stay ≥94%, zero dice, zero
orphans.

Delta growth note: deltas previously reset at every compaction will now
accumulate across many cycles. The existing valve handles it —
`deltaIds.size > 20` logs high-water and the dirty build performs the hard
re-roll (Fix C). Expected cadence ≈ once/day/chat, which matches the budget
set aside for compaction re-rolls.

### 10.5 Fix C — hysteresis re-roll at the delta-overflow valve (deferred)

When the valve fires, instead of a pure Case 1 roll, perform a re-roll whose
membership votes are asymmetric:

- Previously-frozen ids appearing among retrieved candidates are **exempt
  from the threshold filter** — sub-threshold score is not evidence against
  membership (borderline rerank variance); they leave only via supersession/
  deletion validation or absence from candidates entirely.
- Ids absent from candidates are dropped (slow decay).
- Merged set == previous set → reuse previous section string byte-exact
  (zero-churn fast path).

Requires threading `{ exemptIds?: Set<string> }` through `retrieveMemories`
to its threshold-filter site(s). Deferred until Fix A+B hit rates are
observed for ~a day: if soft-reset alone keeps mid-conversation
`full retrieval:` occurrences at the valve cadence, C can be minimal or
unnecessary.

### 10.6 Tests (extends §6)

Unit additions:
1. Non-empty durable row; Case 1 retrieval returns `[]` → section retained
   byte-exact (hash compare), warn logged, row unchanged.
2. Empty-set guard does not fire when retrieval succeeds non-empty.
3. `softResetMemoryContext`: keeps frozenIds/section, clears deltaIds,
   dirty=1 persisted; no-op when no row; no resurrection when neither Map
   nor row exists.
4. Post-compaction build after soft reset → Case 3 delta line (no
   `full retrieval:`).
5. Regression: hard reset still deletes row (deletion/automation/zeitgeist).

Canary update (standing): `full retrieval: N memories frozen` legitimate only
at genuine first turns and delta-valve re-rolls; `full retrieval: 0 memories`
should be extinct.

### 10.7 Rollout

Single PR: Fix A + B together (A alone rots once B removes most Case 1
arrivals; both are small). Phase 2 (cache-warm stop-re-roll) stays separate
per §7 sequencing.
