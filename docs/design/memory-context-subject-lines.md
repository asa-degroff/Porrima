# Memory Context Subject Lines

## Problem

Extracted memories surface as orphaned facts. When recalled, the agent sees, e.g.:

```
- Auto-save/restore merged in PRs #20819/#20822 [decision, 8/10, saved: 2026-06-15]
```

But has no sense of what conversation, debugging session, or architectural discussion produced it. The memory is true but untethered — the difference between knowing something and knowing *why it matters*.

This is especially acute for:
- **Implementation details** — "checkpoint restore uses nearest checkpoint on seq_rm failure" is true, but the agent has lost that it emerged from the DeltaNet TP asymmetry deep-dive.
- **Cross-topic retrieval** — when MMR surfaces memories from multiple extraction runs, there's no topical map to orient the agent.
- **Delayed extraction** — the broader vantage point of delayed extraction produces higher-level memories, but the framing of "what was this conversation about?" is lost.

The existing `source_chat_id` field tracks provenance at the database level but is never surfaced to the agent at injection time.

## Solution

Attach a short topic-framing "subject line" to each batch of extracted memories at extraction time, stored as metadata, and injected alongside the memory text at retrieval time.

The subject line answers: *"What conversation or discussion was I having when I learned this?"*

### Subject vs Memory Text

The extraction prompt already instructs: *"Each extracted memory should be a self-contained statement that would be meaningful without the original conversation."*

The subject does not duplicate this. They operate on different axes:

| Axis | Memory text | Subject line |
|---|---|---|
| Question | What should I know? | What scene produced this? |
| Content | The specific fact, decision, pattern | The broader conversational topic |
| Example | "Auto-save/restore merged in PRs #20819/#20822" | "KV cache slot persistence and llama.cpp upstream PRs" |
| Granularity | Specific detail | Topical framing |

### Extraction Types and Subject Scope

| Extraction type | Scope | Subject quality |
|---|---|---|
| **Mid-turn pulse** | 1–2 exchanges, raw signals | Narrow, concrete — "Signal token counter implementation" |
| **Immediate (post-turn)** | Full turn | Same narrowness, slightly synthesized |
| **Delayed** | Full conversation + prior memories | Broader — "Building extraction pulse system" |
| **Pre-compaction** | Full conversation before compaction | Similar to delayed, compaction-aware |

Each extraction run generates its own subject. Delayed/pre-compaction extraction does *not* reuse subjects from prior extraction runs — it operates from a different vantage point (holistic vs slice-by-slice), and its subject should reflect that scope. If a delayed extraction produces memories about the same narrow topic as a mid-turn pulse, the subject will naturally converge. If it finds broader patterns, the subject will be broader.

## Design

### Extraction Output Format Change

Current output:
```json
[
  {"text": "...", "category": "decision", "importance": 8},
  {"text": "...", "category": "context", "importance": 9}
]
```

New output:
```json
{
  "subject": "KV cache slot persistence and upstream PR tracking",
  "memories": [
    {"text": "...", "category": "decision", "importance": 8},
    {"text": "...", "category": "context", "importance": 9}
  ]
}
```

One subject per extraction call. For single-call extraction, that's one subject
for the whole run. For chunked extraction, each chunk produces its own subject
applied to that chunk's facts (see Chunked Extraction below).

### Prompt Instruction Addition

Added to **all four** extraction system prompts: `EXTRACTION_INSTRUCTIONS`,
`DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS`, `PRE_COMPACTION_INSTRUCTIONS`, and
the mid-turn pulse instructions:

```
Before the memories array, provide a "subject" field — a brief topic line
(5-15 words) describing the conversational context that produced these memories.
Use a noun phrase, not a full sentence. Examples:
  - "KV cache slot persistence and checkpoint restore debugging"
  - "Architectural decisions for the extraction pulse system"
  - "TTS streaming boundary detection and chunk race fixes"

The subject frames the scene, not the facts themselves. It should be specific
enough to distinguish from other conversations but broad enough to cover all
memories in this batch.
```

### Subject Quality Specification

The subject line's value depends entirely on quality. A vague subject ("coding
discussion") adds noise; a good one ("KV cache slot persistence debugging")
orients the agent. The extraction prompt must enforce quality on multiple axes.

**Specificity floor** — The subject must name the concrete topic or system
discussed, not the activity or relationship. Bad subjects fail this test:

| Bad | Why | Fix |
|---|---|---|
| "Coding discussion" | Names the activity, not the topic | "KV cache slot persistence debugging" |
| "This conversation" | No information | "TTS streaming boundary detection" |
| "User preferences" | Too broad — every chat has preferences | "User preference for SVG over canvas effects" |
| "Project update" | Generic label | "Porrima extraction pulse system design decisions" |
| "Debugging" | Activity, not topic | "DeltaNet TP asymmetry and checkpoint search failure" |

**Granularity ceiling** — The subject should not restate a specific memory's
content. If the subject matches one memory's text almost exactly, it's too
narrow — it's a label for one fact, not a frame for the batch. Good subjects
sit one level above the individual facts:

| Too narrow (restates a fact) | Right granularity |
|---|---|
| "Auto-save/restore merged in PRs #20819/#20822" | "KV cache slot persistence and upstream PR tracking" |
| "Checkpoint restore uses nearest checkpoint on seq_rm failure" | "DeltaNet checkpoint restore and TP asymmetry debugging" |

**Scope coverage** — The subject must be broad enough to plausibly cover all
memories in the batch. If the batch contains memories about both KV cache
persistence and TTS streaming, the subject needs to span both or be split
into separate batches. For mid-turn/immediate extraction (narrow windows),
this is rarely an issue. For delayed/pre-compaction (full conversations), the
subject should capture the dominant topic or use a compound phrase:
"Extraction pulse system design and KV cache slot debugging."

**Prompt enforcement** — The extraction instruction text includes a negative
guardrail to prevent generic subjects:

```
Don't use generic labels like "this conversation", "coding session",
"debugging", or "project update". Name the specific topic, system, or
component discussed. The subject should let a future reader distinguish
this extraction from another conversation about a different topic.
```

**Quality monitoring (post-deployment)** — Subject quality is the make-or-break
variable for this feature. Worth observing:
- Extraction logs: scan for subjects under 3 words (too short = vague) or over
  20 words (too long = restating facts)
- Injection sampling: spot-check whether subjects actually help orient the agent
  or add noise
- Prompt tuning: the extraction prompt is the lever; adjust examples and
  negative guardrails based on observed patterns

### Batch-Header Schema Strings

The per-batch user-prompt headers (`buildImmediateBatchHeader`,
`buildMidTurnBatchHeader`) currently hardcode the per-memory schema as
`{"text": ..., "category": ..., "importance": ..., "sourceExchangeId": ...}`.
These strings must be updated to describe the `{subject, memories: [...]}`
wrapper, or the model receives conflicting signals (system prompt says "output
wrapper"; user prompt says "output flat array"). The schema string should read
something like:

```
Output: {"subject": "<topic line>", "memories": [{"text": string, "category": string, "importance": number, "sourceExchangeId": string}]}
```

### Chunked Extraction

Chunked extraction (`extractInChunks` in `memory-extraction.ts`) splits content
larger than the extraction server's context budget into multiple sequential LLM
calls. Each chunk is an independent call with its own response, so each chunk
produces its own subject. The subject is scoped to that chunk's content and
applied to all memories extracted from that chunk — not propagated across
chunks. Rationale: chunks cover different message windows, so a single run-level
subject would be too broad to be useful, and forcing chunk N to echo chunk 1's
subject would require carrying it forward, adding prompt plumbing for little
gain.

The `ExtractChunkedResult` type gains a parallel `subjects: string[]` array
(per-chunk subject, same length as `chunkCount`) so callers can pair each fact
with its originating chunk's subject. Since facts from different chunks are
saved together via `dedupAndSave`, the subject must be threaded from the chunk
result into `saveExtractedMemory` per-fact — easiest done by stamping subject
onto each `ExtractedFact` before passing facts into `dedupAndSave`.

### Project Name in Extraction Prompt

For project-scoped chats, the project name is prepended to the user content:

```
Project: Porrima

[rest of extraction content...]
```

This gives the extraction model grounding for broader context. The subject itself remains topic-focused, not project-focused.

### Storage Schema Change

New column on `memories` table:

```sql
ALTER TABLE memories ADD COLUMN subject TEXT NOT NULL DEFAULT '';
```

- Existing memories: empty string (no subject)
- New memories: populated at extraction time
- Backward compatible: nullable semantics via empty-string default

Type change (`types.ts`):
```typescript
export interface Memory {
  // ... existing fields ...
  subject: string;  // Topic framing from extraction context; '' for legacy/user-authored
}
```

Note: the interface field is `string` (not `string?`) to match the
`NOT NULL DEFAULT ''` column. Empty string is the "no subject" sentinel —
the injection formatter checks falsiness (`if (memory.subject)`) so legacy
memories and `save_memory`-authored memories with `subject: ''` are handled
the same as before. A nullable column + `subject?: string` would also work
but creates a three-state (undefined / '' / 'text') that's harder to reason
about. Prefer the two-state empty-or-set model.

The client copy of `MemorySummary` (`client/src/types.ts`) gains `subject:
string` too, so API responses from `getAllMemories`/`getMemoryById`/
`searchMemories` stay typed end-to-end even though the field isn't displayed
in the UI.

### Injection Format Change

In `formatRetrievedMemoryForContext`, when a subject is present:

```
(subject: KV cache slot persistence debugging)
- Auto-save/restore merged in PRs #20819/#20822 [decision, 8/10, saved: 2026-06-15]
```

When no subject (legacy memory or `save_memory` tool):
```
- Some existing memory without a subject [fact, 7/10, saved: 2025-12-01]
```

If multiple consecutive memories share the same subject, the subject line
is repeated per memory. MMR diversity scoring limits how many memories from
the same batch survive filtering, so repetition is bounded and cheap (~15 tokens).

### Parsing

`parseExtractionResponse` is the single point where extraction LLM output
becomes structured facts. Its signature changes to return subject alongside
facts, then every caller threads the subject through to `saveExtractedMemory`.

New return type:

```typescript
interface ParsedExtraction {
  subject: string;   // '' when the model omits it or output is a flat array
  facts: ExtractedFact[];
}
```

`parseExtractionResponse` handles both formats:

1. Try parsing as `{subject, memories}` object — extract `subject` and treat
   `memories` as the facts array
2. Fall back to flat `[]` array (legacy/hand-crafted memories) — `subject: ''`
3. If the wrapper is present but `memories` is missing/invalid, fall back to
   treating the whole object as a single-element facts array (defensive)

Because the return type changes, every caller updates. The blast radius is
intentional — it forces each extraction path to decide how subject flows to
storage:

| Caller | File:line (approx) | Subject handling |
|---|---|---|
| `extractInChunks` | memory-extraction.ts | Per-chunk: stamp subject onto each `ExtractedFact` before saving |
| Immediate batch | memory-extraction.ts | Stamp subject onto facts before `saveImmediateFacts` |
| Mid-turn pulse | memory-extraction.ts | Stamp subject onto facts before `dedupAndSave` |
| Pre-compaction flush | memory-extraction.ts | Stamp subject onto facts before `dedupAndSave` |
| Delayed extraction | memory-extraction.ts | Stamp subject onto facts before `saveExtractedMemory` |

The `ExtractedFact` interface gains an optional `subject?: string` field so the
stamp-and-forward pattern works without changing `dedupAndSave`'s signature —
`saveExtractedMemory` reads `fact.subject` and writes it to the `Memory`.

### Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Extraction     │     │  Storage         │     │  Injection      │
│  Prompt         │     │  (memories db)   │     │  (system prompt)│
│                 │     │                  │     │                 │
│ Output:         │     │ Column:          │     │ Display:        │
│ {               │────▶│ subject TEXT     │────▶│ (subject: ...)  │
│   subject: "...",│     │                  │     │ - memory text...│
│   memories: [...]│     │ Existing: ''     │     │                 │
│ }               │     │ New: populated   │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Implementation Touchpoints

### Server-side

| File | Change |
|---|---|
| `types.ts` | Add `subject: string` to `Memory` interface (two-state: `''` or text) |
| `client/src/types.ts` | Add `subject: string` to `MemorySummary` for end-to-end typing |
| `memory-storage.ts` | Add `subject` column migration; include `subject` in `addMemory` INSERT + value list, `updateMemory` set-clauses, `searchMemories`/`getMemoryById`/`getAllMemories`/`getMemoriesByChatId`/`getMemoriesFromChat`/`getDelayedMemoriesByChatId`/`searchMemoriesRaw`/`findSimilarMemoryCandidates`/`findDuplicates` SELECT + result mapping; `loadMemoryStore`/`saveMemoryStore` for synthesis roundtrip |
| `memory-extraction.ts` | Update `EXTRACTION_INSTRUCTIONS`, `DELAYED_EXTRACTION_SYSTEM_INSTRUCTIONS`, `PRE_COMPACTION_INSTRUCTIONS`, and mid-turn pulse instructions to request subject; update `buildImmediateBatchHeader` + `buildMidTurnBatchHeader` schema strings to describe `{subject, memories}` wrapper; change `parseExtractionResponse` return type to `ParsedExtraction`; add `subject?: string` to `ExtractedFact`; thread subject through `extractInChunks` → `ExtractChunkedResult.subjects[]` → every caller (immediate, mid-turn, pre-compaction, delayed); stamp `fact.subject` before `saveExtractedMemory`/`dedupAndSave`; pass project name to extraction prompt for project-scoped chats |
| `memory-context.ts` | Update `formatRetrievedMemoryForContext` to prepend `(subject: ...)` line when `memory.subject` is non-empty |

### `search_memory` tool results

`memory-tools.ts` has its own result formatter (lines ~204-215) that does not
use `formatRetrievedMemoryForContext`. For consistency with the injected
context, that formatter should also prepend the subject line when present —
otherwise the agent's passive/recalled context shows subjects but its explicit
tool searches do not, an asymmetry that could confuse retrieval decisions.

### `updateMemory` patch path

`memory-storage.ts:612` builds its SET clause field-by-field with explicit
`if (updates.X !== undefined)` checks. Add an `if (updates.subject !==
undefined)` clause so the generic update path can write subject (even though
extraction is the primary writer, `updateMemory` is the shared patch surface
and will silently drop subject without this).

### Synthesis reflections

`system-chat.ts:160` instructs the agent to call
`save_memory(category="reflection", importance=7-9)` during synthesis Phase 3.
These go through `dedupAndSave` with `sourceType: 'explicit'` and will have
`subject: ''`. This is a known gap — synthesis reflections would benefit from
framing (e.g. "Synthesis reflections, 2026-06-30") but the `save_memory` tool
has no subject parameter by design (user-authored memories are explicit).
Accepted for v1; revisit if synthesis reflections surface as confusing in
practice.

### No changes needed

- `memory-tools.ts` `save_memory` tool definition — user-authored memories are explicit, no subject parameter
- `memory-extraction-observability.ts` — subject is metadata, not observability
- Client/UI components — subject is injected server-side into the LLM prompt, not displayed to the user (though it flows through API responses typed as `string`)
- Embedding/search — subject is NOT embedded into the memory text (would corrupt vector search); it's pure display context
- `fts_memories` — indexes `text` only; subject stays out of the FTS index for the same reason

## Open Questions

1. **Subject dedup at injection** — Currently accepting per-memory subject repetition. If this proves wasteful in practice, grouping by subject is the next step (requires collecting all results before formatting). Note: with per-chunk subjects, adjacent injected memories from different chunks will have different subjects, so grouping would only collapse subjects from the same chunk.

2. **Subject quality monitoring** — The extraction model may produce vague subjects ("coding discussion") or subjects that restate the memory text. Worth observing after deployment; the extraction prompt is the lever.

3. **Reranker input** — Currently the reranker sees only `memory.text`. Including the subject in the reranker document could improve relevance scoring by giving the reranker topical context. This would be a separate change (reranker documents come from `memory.text` in `memory-context.ts`).

4. **Passive recall injection** — Mid-turn passive recall injects memories. Should it include subjects? Likely yes — same `formatRetrievedMemoryForContext` function handles both paths, so this is automatic once the formatter is updated.

5. **Cross-chunk subject coherence** — Per-chunk subjects could diverge across a single delayed extraction run (chunk 1: "Debugging the parser", chunk 2: "Refactoring the test suite"). The agent sees subjects from all chunks at injection time. This is the intended behavior — chunks cover different content — but worth watching whether the agent finds it disorienting. Grouping at injection (open question #1) would compound this if subjects vary, so the two questions interact.

## Risks

- **Token overhead** — Subject lines add ~8-15 tokens per memory. With 10-15 injected memories, that's ~100-200 tokens. Acceptable for the value gained.
- **Model compliance** — The extraction model (Qwen 3.5 4B/9B) needs to reliably produce the wrapper format. The parser already handles JSON robustness; the wrapper adds one nesting level.
- **Backward compatibility** — Existing memories have no subject. The injection formatter must handle the empty case gracefully (no subject line prepended).
