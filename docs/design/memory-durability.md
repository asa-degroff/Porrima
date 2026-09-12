# Memory Durability: Session vs Durable Scoping

Status: Phase 1 implemented (2026-09-12); phases 2–4 pending. Date: 2026-09-12.

Related: [memory-system.md](../memory-system.md), [memory-blocks.md](../memory-blocks.md).

## Problem

Memory extraction saves indiscriminately by design, and hybrid retrieval + reranking
recovers relevance later. But a large share of extracted memories are **transient task
state** — current step, open branches, mid-experiment values, "next step is X", commit
hashes from the active workstream. They matter inside their origin thread (especially
after compaction) and are noise everywhere else.

Live-store evidence (2026-09-12): ~19.5k memories, 87% rated importance ≥ 6 (the scale
is compressed and non-discriminative), ~60% never selected by a retrieval pipeline, and
~250–390 memories/day written.

## Design Summary

- Add one orthogonal field to atomic memories: `durability: "durable" | "session"`.
  It is **not** a replacement for `importance`; importance stays about consequence,
  durability is about lifespan.
- "session" = only useful while the origin thread is active.
  "durable" = still useful outside it (other chats, months later).
- Write side stays indiscriminate: transient state is still captured, just labeled.
- Read side applies a tunable score multiplier to session memories **from other chats**,
  applied both pre-rerank (candidate pool entry) and post-rerank (final ranking), exactly
  like the existing cross-project multiplier. Same-chat session memories get no penalty.
- A per-thread **consolidation** step rides the existing delayed-extraction pass (the
  same 30-minute idle signal that already scales with usage) and writes 0–3 durable
  outcome memories linked to their session sources. It is incremental — only session
  memories no prior consolidation has reviewed — and may supersede its own earlier
  outputs when the outcome evolves.
- No deletion or TTL in v1. Demotion can wait for measured need.

Key invariant: retrieval must never be the only path that matters. Session memories stay
fully retrievable in their origin chat and are linked (not superseded) by consolidation.
Promotion to durable is deliberately deferred in v1 — consolidation carries durable value
forward in new memories instead of mutating session rows (see "Not in v1").

---

## Phase 1 — Field, extraction prompt, parser, observability

No retrieval behavior change. Goal: collect a few days of labels and verify the rubric
before touching ranking.

### 1.1 Types (`server/src/types.ts`)

```ts
export type MemoryDurability = "durable" | "session";

/** Canonical list of valid durability values. Keeps the extraction parser,
 *  runtime tools, and type definitions in sync. */
export const VALID_MEMORY_DURABILITIES: readonly MemoryDurability[] = ["durable", "session"];

/** Fallback when the extraction model omits or misspells the field. */
export const FALLBACK_MEMORY_DURABILITY: MemoryDurability = "durable";

export type MemorySourceType =
  | 'chat' | 'chat_delayed' | 'chat_immediate' | 'explicit' | 'synthesis' | 'consolidation';

export interface Memory {
  // ...existing fields...
  durability: MemoryDurability;
}
```

Mirror `durability` into `client/src/types.ts` (`Memory` interface).

### 1.2 DB migration + CRUD (`server/src/services/memory-storage.ts`)

Migration after the `subject` block (same PRAGMA-check pattern):

```ts
if (!cols.some((c) => c.name === "durability")) {
  db.exec(`ALTER TABLE memories ADD COLUMN durability TEXT NOT NULL DEFAULT 'durable'`);
  console.log("[memory] Added durability column for session-scoped memories");
}
```

- `addMemory` INSERT: add `durability`, value `memory.durability || 'durable'`.
- `saveMemoryStore` INSERT (legacy full-store rewrite): same.
- `updateMemory`: add clause

```ts
if (updates.durability !== undefined) {
  setClauses.push("durability = ?");
  values.push(updates.durability);
}
```

- **Mapper sweep** — every SELECT that hydrates a `Memory` adds `durability` to the
  column list, the row type, and the mapped object:
  - `loadMemoryStore`
  - `searchMemories` (metaRows)
  - `getMemoryById`
  - `getAllMemories`
  - `getMemoriesFromChat`
  - `searchMemoriesRaw`
  - `findSimilarMemoryCandidates`
  - `findDuplicates`
  - `getMemoriesByChatId`
  - `getDelayedMemoriesByChatId`

No index needed yet. Consolidation candidate scans (phase 3) can add
`idx_memories_source_durability ON memories(source_chat_id, durability, created_at)`
if scans show up in profiling.

### 1.3 Extraction (`server/src/services/memory-extraction.ts`)

Shared rubric string (declared before `EXTRACTION_INSTRUCTIONS`), interpolated into all
five output schemas:

- `EXTRACTION_INSTRUCTIONS` (system prompt)
- `buildImmediateBatchHeader`
- `buildMidTurnBatchHeader`
- `PRE_COMPACTION_USER_HEADER`
- `DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS`

```ts
const DURABILITY_FIELD_GUIDE = `  - "durability": "durable" or "session".
    "session" = only useful while this thread is active — current step, open branches,
    mid-experiment values, next actions, pending decisions.
    "durable" = still useful outside this thread — settled decisions, architecture facts,
    preferences, instructions, lessons, project relationships.
    Ask: would this matter in an unrelated conversation a month from now?
    If not, mark it "session". Transient task state is still worth capturing — mark it,
    don't drop it.`;
```

Prompt contradiction to fix while here: `DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS`
item 5 "Unresolved threads — ongoing work, open questions, pending decisions" should note
these are session-scoped unless they encode a durable open question.

Parser:

```ts
export const DEFAULT_EXTRACTION_DURABILITY: MemoryDurability = "durable";

function normalizeExtractionDurability(value: unknown): MemoryDurability {
  return value === "session" || value === "durable" ? value : DEFAULT_EXTRACTION_DURABILITY;
}
```

- `ExtractedFact` gains `durability: MemoryDurability`.
- `mapFactItems` maps `durability: normalizeExtractionDurability(f.durability)`.
- `saveExtractedMemory` passes `durability: fact.durability` into `addMemory`.

Dedup merge (both `dedupAndSave` and the delayed loop update branch):

```ts
function mergeDurability(existing: MemoryDurability, incoming: MemoryDurability): MemoryDurability {
  return existing === "durable" || incoming === "durable" ? "durable" : "session";
}
```

Call `updateMemory` only when the value changes.

Observability (`memory-extraction-observability.ts`): `ExtractionParsedFact` gains
`durability?: string`; every `facts.map(...)` run-complete site includes it (immediate
~line 3184, mid-turn/pre-compaction ~4417, delayed ~4843). Optionally add per-run
durable/session counters to `getExtractionMetrics()`.

### 1.4 Other creation sites

- `server/src/routes/memory.ts`:
  - `POST /`: accept `durability`, validate against `VALID_MEMORY_DURABILITIES`,
    default `"durable"`.
  - `PATCH /:id`: text-supersede path copies `existing.durability`; in-place update
    accepts `durability`.
- `server/src/services/memory-tools.ts`:
  - `save_memory`: optional `durability` parameter (`StringEnum(["durable","session"])`),
    default `"durable"`; include in the constructed fact.
  - `search_memory`: pass `chatId` to ranking options (phase 2) and render a
    `session-scoped` tag.
- Synthesis `save_memory` calls default to durable automatically.

### 1.5 Tests + docs for phase 1

- `memory-extraction.test.ts`: parses `durability`, invalid value falls back to durable,
  missing value defaults durable, dedup promotes session→durable.
- `memory-storage.test.ts`: migration idempotency, round-trip write/read, update clause.
- Fixture sweep: all `Memory` literals in tests gain `durability` (grep `importance:` in
  `server/src/__tests__/` and `server/src/services/*.test.ts`).
- Add a durability chip to `MemoryDebugPanel` parsed-facts rows so labels can be eyeballed
  live.
- Update `docs/memory-system.md` categories/extraction sections.

**Ship gate:** run a few days with no ranking change. Check the durable/session split
(expected roughly 60–80% durable), spot-check mislabels, tune the rubric if one class
swallows the other.

---

## Phase 2 — Retrieval policy

### 2.1 Scope helper (`server/src/services/memory-retrieval-scope.ts`)

```ts
import type { MemoryDurability } from "../types.js";

export const SESSION_SCOPE_SCORE_MULTIPLIER_DEFAULT = 0.3;

export function normalizeSessionScopeScoreMultiplier(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return SESSION_SCOPE_SCORE_MULTIPLIER_DEFAULT;
  }
  return Math.max(0, Math.min(1, value));
}

export function isCrossChatSessionMemory(
  memory: { durability?: MemoryDurability; sourceChatId?: string },
  chatId: string | undefined,
): boolean {
  if (memory.durability !== "session") return false;
  if (chatId !== undefined && memory.sourceChatId === chatId) return false;
  return true;
}

export function applySessionScopeScoreMultiplier<
  T extends { memory: { durability?: MemoryDurability; sourceChatId?: string }; score: number }
>(candidates: T[], chatId: string | undefined, multiplier: number): number {
  const normalized = normalizeSessionScopeScoreMultiplier(multiplier);
  let count = 0;
  for (const candidate of candidates) {
    if (!isCrossChatSessionMemory(candidate.memory, chatId)) continue;
    candidate.score *= normalized;
    count++;
  }
  return count;
}
```

Note: `chatId === undefined` penalizes session memories that have a `sourceChatId`
(unscoped searches). Callers that know the chat always pass it.

### 2.2 `searchMemories` (`memory-storage.ts`)

```ts
export interface MemorySearchRankingOptions {
  projectId?: string;
  crossProjectScoreMultiplier?: number;
  globalProjectScoreMultiplier?: number;
  /** Current chat id — session memories from other chats are dampened. */
  chatId?: string;
  /** Score multiplier for cross-chat session memories. Undefined = no adjustment. */
  sessionScopeScoreMultiplier?: number;
}
```

Apply after the existing project multipliers, before the `sortByAdjustedScore(...).slice(topK)`:

```ts
if (rankingOptions?.sessionScopeScoreMultiplier !== undefined) {
  applySessionScopeScoreMultiplier(
    scored,
    rankingOptions.chatId,
    rankingOptions.sessionScopeScoreMultiplier,
  );
}
```

This makes pool entry scope-aware. The post-rerank application (below) handles final
ranking, mirroring how cross-project is applied twice today.

### 2.3 Settings plumbing

- `types.ts` `Settings`: `sessionScopeScoreMultiplier?: number` with comment; default 0.3.
- `chat-storage.ts` `DEFAULT_SETTINGS`: `sessionScopeScoreMultiplier: 0.3`.
- Read-time normalization only (same as cross-project): callers use
  `normalizeSessionScopeScoreMultiplier`. `PUT /api/settings` passes through.
- Client: `client/src/types.ts` + `useSettings.ts` default; optional slider in
  `SettingsModal.tsx` next to the cross-project slider (can land in phase 5).

### 2.4 Call sites

`memory-context.ts` (`retrieveMemories`) and `passive-memory-recall.ts` (`runRecall`):

1. Read the multiplier once via a local `getConfiguredSessionScopeScoreMultiplier()`
   (mirror of the existing cross-project helper in each file).
2. Pass `{ chatId, sessionScopeScoreMultiplier }` into `searchMemories` alongside the
   existing project options.
3. After rerank scores are mapped, apply `applySessionScopeScoreMultiplier(...)` with the
   same arguments, next to the existing project multiplier application.
4. Log: `[memory-retrieval] session-scope: dampened N cross-chat session memories (×0.3)`
   (and `[passive-memory]` equivalent).

`formatRetrievedMemoryForContext`: append `, session-scoped` to the bracket so the model
knows the memory may be thread-local. Same tag in the `search_memory` tool output.

`search_memory` tool (`memory-tools.ts`): pass `chatId` + configured multiplier. Explicit
agent searches keep the same policy — the tag plus deliberate query text is enough.

### 2.5 Tests

- `memory-retrieval-scope.test.ts`: same-chat no-op, cross-chat dampened, undefined chat,
  durable no-op, invalid/default multiplier normalization.
- `memory-storage.test.ts`: `searchMemories` pool ordering with a chatId.
- `memory-context-*` / `passive-memory-recall.test.ts`: ranking integration; verify
  same-chat post-compaction session memories are not dampened.
- `memory-tools.test.ts`: save param, search tag.

**Ship gate:** retrieval logs show cross-chat session memories still reachable when
genuinely relevant but rank below durable peers; same-chat continuity unchanged.

---

## Phase 3 — Thread consolidation

New module `server/src/services/memory-consolidation.ts`, invoked from the scheduler at
the end of each chat's delayed-extraction pass.

### 3.1 Trigger

Consolidation rides the existing delayed-extraction pass rather than using its own idle
timer. The 30-minute inactivity signal is activity-adaptive: it marks natural session
boundaries, so busy days produce several consolidations and quiet days produce one. The
12-hour framing assumed consolidation must wait for task completion, but that is not
required here — session memories stay intact and consolidated outputs are supersedable,
so an early consolidation is correctable rather than damaging. The definition shifts from
"summarize the finished task" to "distill what this session window added in durable form."

- Scheduler sequencing (`scheduler.ts`): after `extractDelayedMemories(chatId, model)`
  resolves for a chat — including the no-new-content early return — call
  `consolidateChatThread(chatId, model)`. Consolidation must run after save + comparison
  so the pass's freshest facts are part of the input.
- Skip when there are no unlinked session memories (the ledger query in 3.2 returns
  empty), when the chat was deleted, or when the delayed pass was skipped for system
  pause / synthesis / active-chat reasons (existing gates apply).
- The existing `delayedExtractionsInProgress` set already serializes per-chat delayed
  work; consolidation runs inside that window. Extraction LLM calls remain serialized by
  `withExtractionMutex`.
- `delayedExtractionEnabled === false` naturally disables consolidation too — same pass.

### 3.2 Input: ledger, not a watermark

The join table doubles as the "already reviewed" ledger, so no timestamp watermark is
needed. Input selection:

```sql
SELECT m.id, m.text, m.subject, m.category, m.importance, m.created_at
FROM memories m
WHERE m.source_chat_id = ?
  AND m.durability = 'session'
  AND m.superseded_by IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM memory_consolidation_sources s WHERE s.source_id = m.id
  )
ORDER BY m.created_at ASC
LIMIT ?
```

- Oldest-first FIFO drain when over the cap (~80), matching the delayed-extraction window
  behavior: the remainder waits for a future pass.
- Prompt also receives the chat's prior live consolidated memories
  (`source_type = 'consolidation'`, `superseded_by IS NULL`) with IDs, so the model can
  supersede a stale earlier outcome instead of restating it.
- Optional grounding: the most recent in-context compaction summary, capped (~2000
  chars), so outcomes can reference task framing the session memories may omit. Include
  only when present and small.
- Prompt asks for 0–3 **event-anchored** durable memories: outcome reached, decision and
  rationale settled, durable project fact, lesson. It must not restate session state, not
  write a thread diary, and not repeat prior consolidated content.
- Output:

```json
{
  "memories": [
    {
      "text": "...",
      "category": "decision",
      "importance": 7,
      "supersedesMemoryId": "prior consolidation id (optional)"
    }
  ]
}
```

All outputs are durable by construction; there is no promotion list in v1.

- Standalone compact call on the extraction model. It works from session memories rather
  than the conversation, so it neither needs nor benefits from the extraction KV session;
  keep it off that chain. Reuse the parse/repair plumbing for robustness.

### 3.3 Save and linkage

New table in `memory-storage.ts`:

```sql
CREATE TABLE IF NOT EXISTS memory_consolidation_sources (
  consolidated_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (consolidated_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_consolidation_sources_source
  ON memory_consolidation_sources(source_id);
```

- Save outputs via `dedupAndSave(..., { sourceType: "consolidation" })`. Because
  `dedupAndSave`'s `supersedeMemoryId` applies only to single-fact saves, save outputs one
  at a time with their per-output supersede target; embeddings are still batch-computed.
- **Never supersede session sources.** Superseding would hide exactly the local detail the
  origin thread needs post-compaction. Only prior consolidated memories may be superseded
  by a newer consolidation.
- After a successful run, insert link rows for every source in the reviewed window — even
  when the model output nothing — so an empty review still marks those memories as
  considered. Insert links in a transaction; if the run failed, insert nothing so the
  window retries next pass.
- If a consolidated memory lands as a near-duplicate of an existing durable memory, normal
  dedup semantics apply (bump metadata); prior consolidations are in the prompt so the
  model should supersede rather than duplicate, and the existing supersession chain
  remains the safety net.

### 3.4 Settings and observability

- New setting: `consolidationEnabled` (default true). No idle setting — timing is owned by
  the delayed pass. Output cap is a module constant (`CONSOLIDATION_MAX_MEMORIES = 3`)
  until there is a reason to expose it.
- `ExtractionTrigger` union gains `"consolidation"`; debug panel labels it.
- Tests: ledger selection excludes linked/superseded sources; FIFO cap + drain; links
  written on empty output; links skipped on failure; supersede of a prior consolidation;
  no-op without unlinked session memories; scheduler sequences consolidation after
  extraction.

---

## Phase 4 — Synthesis integration

`system-chat.ts` new-memories section:

- Split `newMemories` into durable and session.
- Durable keeps the existing explicit/auto tiers and full rendering.
- Session collapses to one "active threads" section: grouped by source chat + subject,
  rendered as short count/latest lines instead of full text.
- `renderTier` lines gain a durability marker for durable items only (session items are
  self-evidently in their own section).

This makes the existing 50-per-tier caps operate on signal instead of a compressed
importance scale, and stops synthesis narrative from being built on transient state.
No schema change: `loadMemoryStore` already returns the field after phase 1.

---

## Phase 5 — UI and docs (optional, parallel)

- `SettingsModal.tsx`: session-scope multiplier slider near cross-project.
- `MemoryDebugPanel.tsx`: durability filter/badge (the phase-1 chip is the precursor).
- `MemoryGraphView.tsx`: optional color/opacity distinction.
- `docs/memory-system.md`: durability section; extraction + retrieval pipeline updates.
- `client/src/types.ts`: `Memory.durability` + settings field.

---

## Test matrix (consolidated)

| Area | File | Cases |
|---|---|---|
| DB migration/CRUD | `memory-storage.test.ts` | add column idempotent; round-trip; update; legacy default |
| Parser | `memory-extraction.test.ts` | valid/invalid/missing durability; dedup promotion |
| Scope helper | `memory-retrieval-scope.test.ts` | same/cross/undefined chat; defaults |
| Main retrieval | `memory-context-*` | pool + post-rerank dampening; same-chat immunity |
| Passive recall | `passive-memory-recall.test.ts` | dampening; threshold interaction |
| Tools | `memory-tools.test.ts` | save param; search tag; chatId passed |
| Routes | route tests | POST/PATCH durability defaults/validation |
| Consolidation | new `memory-consolidation.test.ts` | ledger selection; FIFO cap/drain; empty-output links; failure retry; prior-output supersession; guards |

## Rollout Gates

1. Phase 1 merges with **no ranking change**. Observe durability distribution 3–5 days;
   tune rubric if needed.
2. Phase 2 merges with default ×0.3. Tune from `[memory-retrieval]` logs and spot-check
   that same-chat post-compaction continuity is intact.
3. Phase 3 after labels are trustworthy.
4. Phase 4 after phase 2/3 data exists.

## Not in v1

- Deletion/TTL/archival of session memories.
- Same-chat session boost (no penalty is enough to start).
- Access-count-based promotion (needs retrieval-by-chat tracking first).
- Consolidation-driven promotion of session memories. v1 carries durable value forward
  into new consolidated memories; it does not mutate session rows. Promotion can layer on
  later (access-based or consolidation-based) once retrieval is measured.
- Backfill reclassification of the existing 19.5k memories. Forward-only labeling with
  `durable` default is the safe default; a one-time batch classifier can be added later if
  old noise proves disruptive.

## Open Decisions

1. Field naming: `durability: durable | session` (recommended) vs `temporal_scope:
   long_term | session`.
2. Cross-chat multiplier default: 0.3 (matches cross-project) vs softer 0.5.
3. Consolidation output cap: max 3 durable memories per delayed pass (recommended),
   default-on with the delayed pass — needs a call.
4. `save_memory` exposing `durability` to the agent (recommended yes) vs always durable.
5. Whether consolidation is default-on at launch or behind a setting default-off for the
   first week.
