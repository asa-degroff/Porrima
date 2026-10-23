# Memory Context Persistence — Surviving the Process That Owns the Cache

**Status**: Phase 1 implemented (frozen-prefix persistence) plus the §10
compaction re-roll fix and the §11 project-context snapshot; Phase 2
(cache-warm stop-re-roll, §4.4) and Fix C (§10.5) outstanding.

## 1. Problem

Two incidents produced the identical symptom — a full cold prefill on a
chat's next turn — with opposite causality:

- The llama-server process died (glibc heap corruption). Server-side KV loss.
  Every chat's next turn owed a full prefill. Unavoidable.
- porrima restarted moments before a chat's next turn while llama-server kept
  serving. Client-side prefix rewrite. The prefill was **avoidable** — the
  server still held 99% of the usable state.

The restart case, in full: a turn ran with `full retrieval: 1 memories frozen
in system prompt` (prompt A) and paid a cold prefill it owed from an earlier
restart; the client disconnected and prompt A's ~73k-token slot state stayed
resident in VRAM; porrima restarted and the `contextState` Map died with the
process; the next turn, same chat, re-retrieved — `full retrieval: 2 memories
frozen` (prompt B, a different system prompt); llama.cpp reported `selected
slot by LRU` — prompt A's 99%-similar state was **invisible to selection**;
and a full cold prefill of ~73k tokens ran, the displaced state FIFO-evicting
a multi-GiB pool entry to make room.

The discriminating log line for forensics: a `[memory-context] full retrieval: N
memories frozen in system prompt` immediately preceding a cold prefill means the
*client* rewrote the prefix. No such line before a cold prefill means the *server*
lost state. "Who owes the prefill" is a two-way question.

### Why the prefill happened: the LCP math

Slot reuse in b10164 gates on `sim = LCP(resident, new) / new > 0.50` (strict;
`server-context.cpp:1566/1568`; `--slot-prompt-similarity 0.50` in the running
config). The frozen-memories section sits **between** the stable prefix and the
conversation history (`systemPrompt = stablePrefix + frozenMemoriesSection`,
memory-context.ts). The 1↔2 memory flip changed the section, so the LCP between
prompt A and prompt B stops at the section boundary — the stable prefix alone,
≈ 7,000 tokens of 73,077 ≈ **0.096**. Five times under the gate. The resident state
that a re-roll would have reused in ~4 tokens of prefill was walked past.

### The secondary cost: pool orphans

Under `--cache-idle-slots` + `--kv-unified`, every task launch saves all idle slots'
state to the 32 GiB RAM pool and clears them (`server-context.cpp:2398–2416`). Prompt
A's state entered the pool milliseconds after the re-roll launch. It can never be
restored: pool entries are only eligible at `LCP ≥ 25%` of the entry's own length
(`server-task.cpp:1761`, `// don't trash large prompts`), and any future prompt for
this chat shares ≈ 9.5% with it. It is dead weight until FIFO eviction
(`server-task.cpp:1700`) — and in a 3-slot server, a few orphaned multi-GiB entries
crowd out restorable state for everyone. **Every restart-triggered flip manufactures
one.**

### Root cause

`buildSplitAugmentedPrompt` (memory-context.ts) has three cases:

- **Case 1**: no in-memory state → full retrieval → reranker rolls fresh →
  whole set frozen into the system prompt.
- **Case 2**: state, not dirty → `stablePrefix + frozenMemoriesSection`,
  byte-identical.
- **Case 3**: state, dirty → re-retrieve, diff against
  `frozenIds ∪ deltaIds`, append **new** memories as a tail delta.

Case 1's precondition is documented as "first turn or post-compaction" but
**implemented as "no state in the Map."** Process death is indistinguishable from a
first turn. The frozen set is a pure function of (query, corpus) at roll time — the
corpus is durable (SQLite), the roll is not, and the reranker (Qwen3-Reranker-0.6B) is
non-deterministic on borderline scores. Same query, same candidate set, same
corpus, top set flipped — 1 memory frozen on one roll, 2 on the next.

The design is internally consistent *within a live process*: the frozen section is
byte-stable and new memories tail in as deltas. The bug is that the consistency
guarantee has a process-lifetime, while the thing it protects (the server's KV)
does not.

### Prior evidence the problem is known

`cache-warm.ts` already fights this with a local workaround — the comment says
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
| `stablePrefix` | derived — deterministic from durable inputs (blocks, persona, user doc, AGENTS.md, static hints) | ✓ rebuildable (caveats: AGENTS.md §11, memory blocks §11.6) |
| **Frozen set (ids + section text)** | **process Map** (`contextState`) | **✗ ← the bug** |
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
cold-prefills, which is exactly what a server-side cache-loss event does. The
cache is the asset; the process is disposable.

### F. Do nothing / budget it

Rejected. The user deploys porrima several times a day; each deploy re-pays a 73k-token
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

**Hydrate — Case 1 entry.** Between the `skipMemoryRetrieval`
early-return and the state read:

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
The `skipMemoryRetrieval` path (automation/system runs) **hydrates and
retains**: it serves `stablePrefix` plus the hydrated frozen section
byte-exact — these runs are follow-up messages whose chat's cached prefix must
survive — but never establishes or writes state, since a first-run freeze would
re-roll against a synthetic, non-conversational query.

**Persist — write points:**

1. Case 1, after `contextState.set` — the freeze.
2. Case 3, after delta update — new `deltaIds`, `dirty=0`.
3. `invalidateMemoriesCache` — `dirty=1` on the Map entry; **fall
   through to the row when the Map entry is absent** (post-restart, before
   first hydration). Without this, an extraction-driven invalidate that lands
   after a restart evaporates, and the later hydration restores a stale
   `dirty=0`.
4. `invalidateAllMemoriesCaches` — `dirty=1` on all Map entries **plus
   a bulk `UPDATE ... SET dirty=1` on all rows.** A Map-only mark is not
   enough: after a restart the Map is empty, so a global corpus change
   (synthesis, global extraction) would land on zero chats — and the full
   re-roll that used to "heal" that is exactly what persistence removes.
5. `markMemoryDeltaInjected` — passive recall (mid-turn and post-turn,
   passive-memory-recall.ts) mutates `state.deltaIds`. Without this
   point, a restart after an injection restores stale `delta_ids` and the next
   Case 3 re-injects memories already present in the history as delta rows.
6. **Delivery-receipt claim rule.** Case 3 itself claims nothing: `deltaIds`
   grows only in `commitMemoryDelta`, called after the save that makes the
   delta durable. An uncommitted delta leaves `dirty` set, so the next build
   re-retrieves and delivers it instead of treating it as injected.

All persist calls are wrapped in try/catch → `console.warn`: a bookkeeping
write must never kill a turn. `dirty` is semantically "corpus changed since
last retrieval for this chat" — a property of (chat, corpus), not of process
lifetime. Worst case after restore is one extra Case 3 delta at the tail —
prefix-safe.

**Reset — `resetMemoryContext`.** Also `DELETE` the row. Only chat
deletion (chat-deletion.ts) and cache-warm preparation (cache-warm.ts)
funnel through this function — one place to keep the durable state honest.
Compaction uses `softResetMemoryContext` (Fix B, §10.4); follow-up runs —
synthesis, wake, cross-chat, and automation runs — are messages in a
persistent chat and retain the frozen section; no hard reset happens on
those paths.

**Non-write sites (deliberate):**

- `resetAllMemoryContextCaches` (called from agent-snapshots.ts after a
  snapshot restore) — clears the Map only, **no row operations.** The
  rows live inside the memory DB file, so they time-travel with the corpus and
  arrive consistent with the restored state. Wiping them would force re-rolls
  across all chats — the exact cost this fix eliminates.
- `getMemoryContextIds` (read-only) — safe without hydration of its own:
  every turn path, including the `skipMemoryRetrieval` path, builds (and thus
  hydrates) before the passive-recall engine first runs. The dedup set
  therefore matches what the prompt actually carries: the hydrated frozen
  ids when a row exists, empty otherwise.

**`invalidateAllCaches` — behavior change.** Currently deletes
`contextState` → next turn re-rolls. Sole caller: project workspace change
(projects.ts). Change to clear only the *derived* caches
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
| Case 1 retrieval fails | No state established → no row → next turn retries. Unchanged. |
| Fresh chat, restart before first turn | No row → Case 1. Correct. |
| Frozen memory deleted/superseded while frozen | **No validation on hydrate.** Current Case 2 semantics already tolerate stale frozen content until compaction; changing that would be a separate behavior change with its own prefix cost. Log a warning when `frozen_ids` don't resolve against the corpus (observability only). |
| `skipMemoryRetrieval` (automation/system runs) | Hydrates the row when the Map is empty and retains the frozen section byte-exact in the prompt. Never establishes or writes state. |
| Chat deletion | `resetMemoryContext` already called (chat-deletion.ts) → row deleted. |
| Concurrent writers | N/A — single porrima process under systemd. If that ever changes, this table needs a write lock; noted, not solved. |
| System chat | Same table, `SYSTEM_CHAT_ID`. Synthesis/wake runs are follow-up messages: they retain the frozen section and never reset. |
| Automation run in a chat that has a row | No reset; the run hydrates the frozen section and delivers new memories as a delta, so the target's cached prefix survives. |
| Snapshot restore (agent-snapshots.ts) | `resetAllMemoryContextCaches` clears the Map only; rows time-travel with the memory DB file and are consistent with the restored corpus. No row wipe. |
| Restart after a passive-recall injection | `markMemoryDeltaInjected` persists `delta_ids` (write point 5) → no double injection on the next Case 3. |
| Global corpus change after restart, before any turn | `invalidateAllMemoriesCaches` bulk-updates rows (write point 4) → later hydration restores `dirty=true` → Case 3 delta, prefix-safe. |

### 4.4 Secondary change (Phase 2): cache-warm stops re-rolling

With persistence, the send path restores the *user's actual* frozen section, so
cache-warm's `resetMemoryContext` + fresh Case 1 is no longer needed for
alignment — and for established chats it is actively harmful (warms a
re-rolled prompt the user's next turn won't match). Dropping the reset makes the
warm bake `stablePrefix + restored frozen section` = the user's actual next-turn
prompt = a warm that can actually hit. One-line change.

**Warm-lease invariant.** Warm prefills are never dispatched concurrently with
a turn: `drainQueue` acquires the same turn lease real turns use for the whole
prefill (kind `cache-warm`, background priority, 60s heartbeat), and a
foreground turn preempts a running background warm via
`preemptBackgroundWarms()` — a send arriving mid-warm queues at the gate and
renders the explicit queued state instead of the warm's prefill progress.
`isCacheWarmOrLlamaRuntimeBusy` covers the reverse direction: the scheduler
yields to a busy warm. (Without the lease — gating the warm only by the
warm-queue mutex and `llm-activity.waitForIdle` — an interactive turn arriving
between the idle check and the prefill POST would overlap the warm. The
overlap is bounded and non-corrupting, since the warm bakes a byte-prefix of
whatever the concurrent turn builds, but the gate lease closes it outright;
lease plus preemption keeps user priority without the priority inversion a
bare yield-to-waiters deferral would introduce.)

**Sub-case analysis.** The change is dropping the `resetMemoryContext`
call only; the trailing `invalidateMemoriesCache` stays, which preserves the
"next real turn still retrieves for the new prompt" contract:

| State at warm | Warm builds | Real turn | Warm hit? |
|---|---|---|---|
| clean | Case 2 — user's actual prompt, no retrieval | dirty → Case 3, retrieves against the *new* message | ✓ |
| dirty | Case 3 — same system prompt (delta discarded by warm) | dirty again → Case 3 | ✓ |
| no state (fresh / post-compaction) | Case 1 roll, as today | Case 1 re-roll against new query | ~same as today |

**Dirty-state leak (closed by the claim model).** Warm on a *dirty* state runs
Case 3 against the old messages and its delta rows are never sent (warm bakes
only the system prompt). Under the delivery-receipt model (§4.2, write point 6)
this leaks nothing: Case 3 claims nothing, so the discarded delta stays
unclaimed — `dirty` stays set and the next real turn retrieves and delivers
it. (The pre-claim-model alternative — a read-only warm mode — was rejected: a
real code-path change to bound a leak that the claim model eliminates at the
root.) Warm's Case 3 retrieval does run `updateAccessMetadata`, inflating
access stats for memories the user never saw — minor, accepted.

Phase 2 has not landed; warm still always takes Case 1 via its reset (the
`resetMemoryContext` call in cache-warm.ts). The above is the safety net for
when Phase 2 lands, not a live behavior change.

## 5. What this does NOT fix (scope)

- **Block-edit prefills.** Editing a memory block changes `stablePrefix`
  legitimately → the prefill is owed, payer ≠ editor. That externality is the
  turn-engine's territory (activity-based timeout, false-success detection), not
  this one.
- **Server-side loss.** Crashes and evictions are unavoidable; server-side
  cache-loss events remain an open watch item regardless.
- **Compaction re-roll nondeterminism.** Deferred as "owed; see option C",
  then addressed in §10 (fix lives in a separate change).

## 6. Test plan

**Unit** (`memory-context-persistence.test.ts`):
1. Seed a row → hydrate → Case 2 returns the persisted section **byte-exact**
   (sha1 compare, not string-equal — the artifact is the hash), and no
   retrieval runs.
2. No row → Case 1 → row written with the frozen payload.
3. Dirty row + new memories → Case 3 → returns `memoriesMessage` +
   `newMemoryIds` unclaimed (`dirty` stays 1, `delta_ids` unchanged);
   `commitMemoryDelta(ids)` then grows `delta_ids` and clears `dirty`.
4. `invalidateMemoriesCache` with an empty Map → row-level `dirty=1` (write
   point 3 fall-through); `invalidateAllMemoriesCaches` → bulk row update.
5. `markMemoryDeltaInjected` → `delta_ids` upserted (write point 5).
6. `resetMemoryContext` → row gone; next build is Case 1.
7. `invalidateAllCaches` → derived caches cleared, **row and Map state
   intact**; next build is Case 2.
8. `skipMemoryRetrieval` → hydrates and retains the persisted section
   byte-exact — no retrieval, no state established or written; hydrate failure
   (DB throw) → warn + Case 1 fallback.
9. `commitMemoryDelta` no-ops on empty ids or missing live state — a failed
   retrieval must not be recorded clean.
10. `stableOnly` with live state → no retrieval, section byte-exact, `dirty`/
    `delta_ids` untouched; with no state → falls through to Case 1.

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

## 7. Rollout state

- **Phase 1** — table + migration in memory-storage.ts, hydrate/persist/reset
  in memory-context.ts, `invalidateAllCaches` behavior change, log lines:
  implemented, together with the §10 compaction re-roll fix (Fix A + B land as
  one change — Fix A alone rots once Fix B removes most Case 1 arrivals) and
  the §11 project-context snapshot.
- **Phase 2** — cache-warm reset removal (§4.4): outstanding; separate change.
- **Phase 3** — hysteresis on compaction re-rolls to reduce orphan production
  (Fix C, §10.5): deferred; only if pool occupancy forensics show orphans
  mattering.
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

## 10. Compaction re-roll fix

### 10.1 Why the scope item was reopened

After Phase 1, post-compaction re-rolls became the dominant avoidable prefix
invalidation, including the clobber-to-zero class. KV-cache hit-rate
reconstruction from llama-server INFO logs (per-request reuse = `release
n_tokens` − total `prompt processing` tokens) put hits at 94–100% everywhere
except bursts that correlate exactly with compaction cycles and frozen-set
flips — the worst events being a synthesis compaction rewrite, post-compaction
Case 1 re-rolls thinned below threshold, mid-turn overflow
compactions, and a re-roll that landed on **0 frozen** memories (the clobber
class). Every miss was followed by recovery to 94–99% on the next turn — the
damage is one large cold prefill per event, plus one manufactured pool orphan
each. Restart-triggered flips disappeared once Phase 1 landed, and §7's
verification confirmed hydration works (byte-exact, `LCP sim 0.995`). The
remaining `full retrieval:` lines between genuine first turns were all
**post-compaction**. So the §5 item "Compaction re-roll nondeterminism —
owed" is now the dominant avoidable cost and gets a design.

### 10.2 Root cause chain

1. Compaction calls `resetMemoryContext(chatId)` → deletes Map state **and**
   the durable row.
2. Next build = Case 1 full retrieval → nondeterministic rerank roll → new
   `frozen_section` string, new hash.
3. The retrieval pipeline applies the relevance threshold pre-freeze; a
   reranker variance dip (or topic-anchor dampening after topic drift) can
   return an empty or near-empty set, which then unconditionally overwrites a
   good row. Observed repeatedly overnight — a 5→4→0→3 flip series in one
   night.
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
canonical: once the row existed, Case 2 held it until
the next compaction. Skipping establishment means the next build retries full
retrieval with that turn's query, mirroring the existing retrieval-error path.

Structural note: post-Phase-1 hydration
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

Then switch the **post-compaction** `resetMemoryContext` call sites to it —
the class is: call sites that run inside or immediately after a compaction
flow where the conversation history is rewritten but the chat continues.
Keep hard `resetMemoryContext` (row delete + full re-roll) for exactly two
callers:

- **Chat deletion** (chat-deletion.ts) — nothing left to preserve.
- **Cache-warm preparation** (cache-warm.ts) — the warm owns the rebuilt
  prefix; Phase 2 (§4.4) proposes dropping this too.

Hard resets anywhere else are wrong under follow-up semantics: every
automation run, cross-chat wake, synthesis cycle, and wake cycle is a
message in a persistent chat whose cached prefix must survive. (An earlier
keep-list retained hard resets for "zeitgeist rewrites" — a mislabel for the
system-chat automation entry points in system-chat.ts — and for automation
starts; resetting there deleted the row and forced the following build to
re-roll the head of a warm prefix.) The `skipMemoryRetrieval` build hydrates and
retains the frozen section byte-exact instead. Workspace changes only clear
derived caches (`invalidateAllCaches`), never the frozen state.

Effect: post-compaction turns become Case 3 delta builds against compacted
history. Section string survives compaction byte-exact → prefix holds from
stablePrefix through the whole history tail → hits stay ≥94%, zero dice, zero
orphans.

Delta growth note: deltas previously reset at every compaction will now
accumulate across many cycles. The existing valve handles it —
`deltaIds.size > 20` logs high-water and the dirty build performs the hard
re-roll (Fix C). Expected cadence ≈ once/day/chat, which matches the budget
set aside for compaction re-rolls.

`softResetMemoryContext` also drops the per-chat `stablePrefixCache` entry
**unconditionally** — the drop is not tied to the project-context landing in
`applyProjectContextLanding`, so it applies even when no AGENTS.md snapshot
row exists. Mid-conversation block writes (agent-tool and UI) defer their
stable-prefix cost to compaction: no invalidation at write
time (the editing chat already carries the new content in its transcript),
and the post-compaction rebuild reads CURRENT block bytes exactly when the
in-context tool call gets cut. The rebuild is byte-identical when nothing
changed, so a clean compaction costs no head re-prefill. This closes the
hole where non-project chats (and project chats without a snapshot row)
served pre-edit block bytes indefinitely after compaction.

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
5. Regression: hard reset still deletes row (chat deletion, cache-warm prep).

Canary update (standing): `full retrieval: N memories frozen` legitimate only
at genuine first turns and delta-valve re-rolls; `full retrieval: 0 memories`
should be extinct.

## 11. The project-context snapshot (deferred AGENTS.md)

The §2 inventory marked `stablePrefix` as "✓ rebuildable" — deterministic from
durable inputs. That held only while nobody edits AGENTS.md between sessions.
A `git checkout` or an editor save while porrima is down makes the next
rebuild render a different system prompt, and a prefix change at ANY offset
re-prefills every token after it — i.e. the entire retained history. Resume
paid the full miss for content the conversation had never been built against,
while the in-process Map cache (which never re-validates against disk) had
been happily serving the OLD bytes. The inconsistency: deferral by accident
mid-session, forced application on restart.

Fix, in the same shape as the frozen-section persistence: durably mirror the
last-SERVED `## Project Context` section.

### 11.1 Schema

`chat_project_context_state (chat_id PK, source, content, content_hash,
updated_at)` in the memory DB (`memory-storage.ts`). The rendered SECTION
string is stored, not the file — byte-exact restore by construction, same
rationale as `frozen_section`. Deliberately a separate table:
`hydrateContextState` treats ANY `memory_context_state` row as established
memory context, so a prefix-build writing a row with an empty frozen section
would trap the chat in Case 2 and suppress the Case 1 freeze.

`source` records the workspace identity (resolved label/path) the snapshot was
rendered from. It separates "the user moved the workspace" (source differs →
apply fresh immediately; the move is a deliberate event and `projects.ts` also
calls `invalidateAllCaches`, which drops the row) from "the file content
moved" (source same, hash differs → defer).

### 11.2 Rules (buildStablePrefix, cache-miss path only)

| Disk vs snapshot | Behavior |
|---|---|
| No row / first build | Render fresh, persist row. |
| Hash match | Serve disk bytes (identical), re-persist (no-op write). |
| Hash mismatch, same source | Serve snapshot bytes; `pendingProjectUpdate=true` on the Map entry; `project context diverged` canary. |
| Hash mismatch, source differs | Workspace move: render fresh, overwrite row. |
| Workspace read throws | Serve snapshot (transient fs/ssh blips must not empty the section); no notice — disk state unknown, not known-changed. |
| Rendered section > 128KB | Apply fresh, DROP the row — don't stash a snapshot too big to defer with. |

`preview: true` builds (the `context-view` fallback) consult the Map and the
snapshot for honest display but write neither: a preview must not baseline a
snapshot for a chat that has never delivered, and must not seed the Map with
bytes a delivery build then serves without persisting.

### 11.3 Notice: the change is visible while deferred

The prefix is untouchable, so the notice rides the message tail with the
`[time:]` anchor — `buildTimeAnchor(messages, chatId)` appends
`buildProjectContextNotice(chatId)` while the Map entry is pending. It freezes
on the persisted row and replays byte-exact like the anchor itself. On the
main and edit paths the anchor is stamped BEFORE the prompt build (which is
what discovers the deferral), so the route re-stamps the notice onto this
turn's row after `buildSplitAugmentedPrompt` returns and re-saves — wire and
row stay identical. Without the notice the agent could work all session
against instructions it can't see it's missing.

### 11.4 Landing points

Deferred content applies where the prompt is reprocessed (or re-warmed)
anyway:

- `softResetMemoryContext` (every compaction path) → `applyProjectContextLanding`:
  drop row + Map entry, and drop the cached stable prefix entry
  unconditionally — mid-conversation block edits land here too. Runs before
  the no-state early-return, since a chat with no memory context still
  compacted.
- `resetMemoryContext` (chat deletion, cache-warm prep) → drop row + entry;
  the warm then pre-fills fresh bytes at zero additional cost.
- `invalidateAllCaches` (workspace move) → drop row.

Explicitly NOT landing points: `invalidateStablePrefixCache` /
`invalidateAllStablePrefixCaches` (Map-only clears; no production path calls
them). Those clear the Map without a compaction; a project chat whose
non-project sections rebuild byte-identical still keeps its prefix — wiping
the snapshot there would land an AGENTS.md edit on the chat's next turn for
a reason unrelated to compaction.

### 11.5 Scope notes

- Only the PROJECT SECTION defers its snapshot. AGENTS.md edits arrive with no
  event at all, which is why they get the deferral treatment. Block edits likewise
  defer: agent-tool and UI writes are not invalidated at write time;
  they land at each chat's next compaction (the soft reset re-reads the
  blocks). No path clears cached heads globally: a global clear rewrites
  every chat's head on its next build and stales the prefix digest of every
  parked KV snapshot (`kv-snapshot-parking.md` §5.4), so each cold return
  pays a full re-prefill before its re-park heals it.
- The agent's own AGENTS.md edits defer like any others; the per-turn notice
  says "read AGENTS.md / check git status", so a working agent sees the newer
  file immediately.
- Per-chat keying means each chat lands at ITS next compaction; two chats on
  one project can serve different versions concurrently. Correct by
  construction — each chat's KV cache was built against its own bytes.
