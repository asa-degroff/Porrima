# Memory System — Remaining Concerns and Recommendations

**Document Status**: Draft  
**Created**: 2026-03-01  
**Based On**: Code review of memory system implementation (commit 5130228)

---

## Executive Summary

The memory system is **production-ready for personal use** at scales up to several thousand memories. The critical issues from the original code review (write locking, deduplication consistency, error handling) have all been resolved. The storage layer has been migrated from a single JSON file to **SQLite + sqlite-vec**, providing efficient per-row CRUD operations and SIMD-accelerated vector similarity search.

This document outlines **7 original concerns** — 2 have been resolved by the SQLite migration, and 5 remain. None are blockers, but they represent technical debt that may matter as the system scales or evolves. Concerns are organized by priority with concrete implementation recommendations.

---

## Priority Matrix

| Concern | Priority | Effort | Impact if Ignored |
|---------|----------|--------|-------------------|
| **Embedding model versioning** | 🔴 High | Low | Silent corruption if model changes |
| **Memory purge testing** | 🔴 High | Low | Potential data loss if bug exists |
| **Scaling (O(n²) synthesis)** | 🟡 Medium | Medium | Slow synthesis at 5,000+ memories |
| ~~**Scaling (O(n) search)**~~ | ✅ Resolved | — | Resolved by sqlite-vec migration |
| **Query construction strategy** | 🟡 Medium | Low | Occasional irrelevant memory recalls |
| **One-way importance decay** | 🟢 Low | Low | Memories may be underrated over time |
| **Daily log rotation** | 🟢 Low | Low | Disk space usage over years |

---

## Concern 1: Embedding Model Versioning

### 🔴 **Priority: High** | Effort: Low | Risk: Silent Data Corruption

### Problem

The embedding model (`qwen3-embedding:0.6b`) is hardcoded. If you change it in the future:
- Existing embeddings become incompatible with new ones (different vector spaces)
- Similarity calculations silently break
- No migration path exists

**Current state**:
```typescript
// embeddings.ts
const EMBEDDING_MODEL = "qwen3-embedding:0.6b"; // Hardcoded, never checked
```

The `MemoryStore` doesn't track which model was used to create embeddings:
```typescript
interface MemoryStore {
  memories: Memory[];
  lastSynthesis: string | null;
  // ❌ No embeddingModel field
}
```

### Consequences

If you run `ollama pull mxbai-embed-large` and update the constant:
1. All new memories use the new embedding space
2. All old memories use the old embedding space
3. Cosine similarity between old and new embeddings is meaningless
4. Recall quality degrades gradually as old memories become noise

### Recommendation

**Step 1: Add model tracking to MemoryStore**
```typescript
// types.ts
export interface MemoryStore {
  memories: Memory[];
  lastSynthesis: string | null;
  embeddingModel?: string;           // NEW: e.g., "qwen3-embedding:0.6b"
  embeddingModelVersion?: number;    // NEW: for same model, different versions
}
```

**Step 2: Backfill on load**
```typescript
// memory-storage.ts
export async function loadMemoryStore(): Promise<MemoryStore> {
  await ensureMemoryDir();
  try {
    const data = await readFile(MEMORY_FILE, "utf-8");
    const store = JSON.parse(data) as MemoryStore;
    
    // Backfill for stores created before versioning
    if (!store.embeddingModel) {
      store.embeddingModel = "qwen3-embedding:0.6b";
      await saveMemoryStore(store);
    }
    
    return store;
  } catch {
    return { memories: [], lastSynthesis: null, embeddingModel: "qwen3-embedding:0.6b" };
  }
}
```

**Step 3: Validate on startup**
```typescript
// embeddings.ts
export async function validateEmbeddingModel(): Promise<{ valid: boolean; needsMigration: boolean }> {
  const store = await loadMemoryStore();
  const currentModel = EMBEDDING_MODEL;
  
  if (!store.embeddingModel) {
    return { valid: true, needsMigration: false }; // Fresh install
  }
  
  if (store.embeddingModel !== currentModel) {
    return { valid: false, needsMigration: true };
  }
  
  return { valid: true, needsMigration: false };
}
```

**Step 4: Create migration tool**
```typescript
// scripts/migrate-embeddings.ts
import { embedBatch } from "./embeddings.js";
import { loadMemoryStore, saveMemoryStore } from "./memory-storage.js";

export async function migrateEmbeddings(newModel: string): Promise<void> {
  const store = await loadMemoryStore();
  
  console.log(`Migrating ${store.memories.length} memories to ${newModel}...`);
  
  // Batch migrate in chunks of 50
  const CHUNK_SIZE = 50;
  for (let i = 0; i < store.memories.length; i += CHUNK_SIZE) {
    const chunk = store.memories.slice(i, i + CHUNK_SIZE);
    const texts = chunk.map(m => m.text);
    
    const newEmbeddings = await embedBatch(texts); // Uses new model
    
    for (let j = 0; j < chunk.length; j++) {
      store.memories[i + j].embedding = newEmbeddings[j];
    }
    
    console.log(`Migrated ${Math.min(i + CHUNK_SIZE, store.memories.length)} / ${store.memories.length}`);
  }
  
  store.embeddingModel = newModel;
  await saveMemoryStore(store);
  console.log("Migration complete!");
}
```

**Step 5: Add startup warning**
```typescript
// index.ts (server startup)
import { validateEmbeddingModel } from "./services/embeddings.js";

const validation = await validateEmbeddingModel();
if (!validation.valid && validation.needsMigration) {
  console.warn("⚠️  Embedding model mismatch detected!");
  console.warn("   Run: npm run migrate-embeddings <new-model>");
  console.warn("   Until then, memory recall quality will be degraded.");
}
```

### Implementation Checklist

- [ ] Add `embeddingModel` field to `MemoryStore` interface
- [ ] Backfill existing stores on load
- [ ] Create migration script (`scripts/migrate-embeddings.ts`)
- [ ] Add startup validation and warning
- [ ] Document migration process in README
- [ ] Add `embeddingModelVersion` field if model has multiple versions

### Estimated Effort
**4-6 hours** (including testing)

---

## Concern 2: Memory Purge Testing

### 🔴 **Priority: High** | Effort: Low | Risk: Data Loss if Buggy

### Problem

The memory purge system is **new** (added after the original code review):

```typescript
// synthesis.ts
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
const staleIds = new Set<string>();

for (const memory of store.memories) {
  const msSinceAccess = now - new Date(memory.lastAccessed).getTime();
  if (msSinceAccess > SIX_MONTHS_MS && memory.importance <= 2) {
    staleIds.add(memory.id);
  }
}

if (staleIds.size > 0) {
  store.memories = store.memories.filter((m) => !staleIds.has(m.id));
  console.log(`[synthesis] Purged ${staleIds.size} stale memories...`);
}
```

**Risks**:
- No tests verify the purge logic
- Edge cases untested (leap years, timezone issues, importance boundary at 2)
- Once purged, memories are gone forever

### Recommendation

**Add integration tests**:

```typescript
// __tests__/synthesis.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { runDailySynthesis } from "../services/synthesis.js";
import { loadMemoryStore, addMemory } from "../services/memory-storage.js";
import type { Memory } from "../types.js";

describe("Memory Purge", () => {
  beforeEach(async () => {
    // Reset memory store before each test
    const { saveMemoryStore } = await import("../services/memory-storage.js");
    await saveMemoryStore({ memories: [], lastSynthesis: null });
  });

  it("purges memories older than 6 months with importance ≤2", async () => {
    const oldStale: Memory = {
      id: "1",
      text: "Old unimportant fact",
      category: "fact",
      importance: 2,
      embedding: [0.1, 0.2, 0.3],
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccessed: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      accessCount: 0,
      sourceChatId: "test",
    };

    const recentStale: Memory = {
      id: "2",
      text: "Recent unimportant fact",
      category: "fact",
      importance: 1,
      embedding: [0.2, 0.3, 0.4],
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessCount: 1,
      sourceChatId: "test",
    };

    const oldImportant: Memory = {
      id: "3",
      text: "Old important fact",
      category: "fact",
      importance: 8,
      embedding: [0.3, 0.4, 0.5],
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccessed: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      accessCount: 0,
      sourceChatId: "test",
    };

    await addMemory(oldStale);
    await addMemory(recentStale);
    await addMemory(oldImportant);

    await runDailySynthesis();

    const store = await loadMemoryStore();
    expect(store.memories).toHaveLength(2);
    expect(store.memories.map(m => m.id)).toContain("2"); // Recent stale kept
    expect(store.memories.map(m => m.id)).toContain("3"); // Old important kept
    expect(store.memories.map(m => m.id)).not.toContain("1"); // Old stale purged
  });

  it("does not purge memories with importance = 3 (boundary case)", async () => {
    const memory: Memory = {
      id: "boundary",
      text: "Boundary importance",
      category: "fact",
      importance: 3, // Just above threshold
      embedding: [0.1, 0.2, 0.3],
      createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      lastAccessed: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
      accessCount: 0,
      sourceChatId: "test",
    };

    await addMemory(memory);
    await runDailySynthesis();

    const store = await loadMemoryStore();
    expect(store.memories).toHaveLength(1);
    expect(store.memories[0].id).toBe("boundary");
  });

  it("handles empty memory store gracefully", async () => {
    await runDailySynthesis();
    const store = await loadMemoryStore();
    expect(store.memories).toHaveLength(0);
  });
});
```

### Implementation Checklist

- [ ] Create `__tests__/synthesis.test.ts`
- [ ] Test purge threshold (6 months, importance ≤2)
- [ ] Test boundary cases (importance = 2 vs 3)
- [ ] Test timezone edge cases
- [ ] Test empty store handling
- [ ] Add test for importance decay interaction

### Estimated Effort
**2-3 hours**

---

## Concern 3: Scaling — O(n²) Synthesis

### 🟡 **Priority: Medium** | Effort: Medium | Risk: Slow Synthesis at Scale

### Problem

The pairwise comparison in synthesis scales quadratically:

```typescript
// synthesis.ts
for (let i = 0; i < store.memories.length; i++) {
  for (let j = i + 1; j < store.memories.length; j++) {
    const sim = cosineSimilarity(
      store.memories[i].embedding,
      store.memories[j].embedding
    );
    // ...
  }
}
```

**Note**: While the storage layer has been migrated to SQLite + sqlite-vec, the synthesis step still uses `loadMemoryStore()` to load all memories into JS and performs pairwise comparisons in JavaScript. This is acceptable because synthesis runs once per day, but the O(n²) complexity remains.

**Performance characteristics**:

| Memories | Comparisons | Estimated Time |
|----------|-------------|----------------|
| 100      | 4,950       | < 1 second     |
| 500      | 124,750     | ~2 seconds     |
| 1,000    | 499,500     | ~8 seconds     |
| 5,000    | 12.5 million | ~3 minutes   |
| 10,000   | 50 million  | ~12 minutes    |

At 5,000+ memories, synthesis becomes noticeably slow.

### Recommendation

**Short-term (now)**:
1. Add performance logging to track synthesis duration
2. Document the scaling characteristics
3. Consider increasing synthesis interval for large memory counts

**Long-term (when needed)**:

**Option A: Use sqlite-vec for near-duplicate detection**

Since the storage layer already uses sqlite-vec, synthesis could query for each memory's nearest neighbors instead of doing pairwise comparisons:

```typescript
// For each memory, find its nearest neighbor via sqlite-vec
for (const memory of memories) {
  const match = await findDuplicates(memory.embedding, 0.90);
  if (match && match.memory.id !== memory.id) {
    // Merge the pair
  }
}
```

This reduces O(n²) to O(n) KNN queries, each running in C with SIMD.

**Option B: Locality-Sensitive Hashing (LSH)**

Hash embeddings into buckets; only compare within buckets. Reduces comparisons to O(k²) per bucket where k << n.

### Implementation Checklist

- [ ] Add synthesis duration logging
- [ ] Set up performance benchmarks
- [ ] Refactor synthesis to use sqlite-vec `findDuplicates()` per memory
- [ ] Benchmark: sqlite-vec KNN vs JS pairwise at various memory counts

### Estimated Effort
- Short-term: **1-2 hours** (logging, docs)
- Long-term: **4-8 hours** (refactor synthesis to use sqlite-vec)

---

## ~~Concern 4: Scaling — O(n) Search~~ ✅ RESOLVED

### Resolution

Search has been migrated from JS-level iteration to **sqlite-vec KNN MATCH queries** running in C with SIMD acceleration. While the algorithmic complexity is still O(n) (brute-force scan), the constant factor is orders of magnitude lower than the previous implementation:

- **Before**: Load entire JSON file → parse → iterate all memories in JS → compute dot products → sort → slice
- **After**: `SELECT id, distance FROM vec_memories WHERE embedding MATCH ? ORDER BY distance LIMIT ?` → native C SIMD computation → JOIN metadata → JS re-ranking on small candidate set

Additionally, individual CRUD operations no longer require loading/serializing the entire memory store, eliminating the I/O bottleneck that previously made every operation scale with total memory count.

The two-phase search (KNN oversample 3x, then JS re-rank with recency/importance) ensures that the composite scoring formula still works correctly while leveraging native vector search performance.

---

## Concern 5: Query Construction Strategy

### 🟡 **Priority: Medium** | Effort: Low | Risk: Occasional Irrelevant Recalls

### Problem

Context augmentation uses the last 3 user messages:

```typescript
// memory-context.ts
const userMessages = recentMessages
  .filter((m) => m.role === "user")
  .slice(-3)
  .map((m) => m.content)
  .join("\n");
```

**Issue**: In conversations with topic switches, old messages pull in irrelevant memories.

**Example**:
```
User: "I prefer TypeScript"          → Recalls TS preferences
User: "How do I cook pasta?"         → Still recalls TS (last 3 messages)
User: "What's the weather?"          → May still recall TS if conversation short
```

### Recommendation

**Option A: Single-message query (simplest)**

```typescript
const userMessages = recentMessages
  .filter((m) => m.role === "user")
  .slice(-1)  // Changed from -3
  .map((m) => m.content)
  .join("\n");
```

**Option B: Topic-aware multi-query**

```typescript
// Embed each user message individually
const userMessageEmbeddings = await embedBatch(
  recentMessages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content)
);

// Retrieve memories for each
const allResults = [];
for (const embedding of userMessageEmbeddings) {
  const results = await searchMemories(embedding, 3);
  allResults.push(...results);
}

// Deduplicate by memory ID
const seen = new Set<string>();
const deduped = allResults.filter(r => {
  if (seen.has(r.memory.id)) return false;
  seen.add(r.memory.id);
  return true;
});

// Take top 5 overall
return deduped.sort((a, b) => b.score - a.score).slice(0, 5);
```

**Option C: Hybrid (recommended)**

Use single message for query, but include conversation context in the system prompt:

```typescript
// Query: most recent message only
const queryText = recentMessages
  .filter((m) => m.role === "user")
  .slice(-1)
  .map((m) => m.content)
  .join("\n");

// Context: recent conversation appended to system prompt
const conversationContext = recentMessages
  .slice(-5)
  .map((m) => `${m.role}: ${m.content}`)
  .join("\n");

const augmentedPrompt = `${baseSystemPrompt}

## Recent Conversation Context
${conversationContext}

## What You Remember About This User
${memoriesBlock}
`;
```

### Implementation Checklist

- [ ] A/B test single-message vs 3-message queries
- [ ] Measure recall relevance (manual review or user feedback)
- [ ] Implement hybrid approach if multi-query is too expensive
- [ ] Document findings in memory-system.md

### Estimated Effort
**2-4 hours** (including testing)

---

## Concern 6: One-Way Importance Decay

### 🟢 **Priority: Low** | Effort: Low | Risk: Memories Underrated Over Time

### Problem

Importance only decreases during synthesis:

```typescript
// synthesis.ts
if (daysSinceAccess > 30 && memory.importance > 1) {
  memory.importance = Math.max(1, memory.importance - 1);
}
```

**Issue**: A memory that becomes relevant again (e.g., user asks about a dormant topic) cannot regain importance.

**Example**:
```
Memory: "User worked on Rust project" (importance: 8, created 2024-01)
→ Not accessed for 4 months
→ Importance decays to 7, then 6, then 5...
→ User returns to Rust project in 2024-06
→ Memory recalled but has low importance now
→ No mechanism to boost it back up
```

### Recommendation

**Boost importance on high-relevance recall**:

```typescript
// memory-context.ts
// After retrieving relevant memories
const now = new Date().toISOString();
for (const r of relevant) {
  // Update access metadata
  updateMemory(r.memory.id, {
    lastAccessed: now,
    accessCount: r.memory.accessCount + 1,
    // NEW: Boost importance if highly relevant
    importance: r.score > 0.7 
      ? Math.min(10, r.memory.importance + 0.5) 
      : r.memory.importance,
  }).catch(() => {});
}
```

**Alternative**: Weighted decay based on access pattern

```typescript
// synthesis.ts
const daysSinceAccess = ...;
const accessFrequency = memory.accessCount / daysSinceCreation;

if (daysSinceAccess > 30 && memory.importance > 1) {
  // Slow decay for frequently accessed memories
  const decayRate = accessFrequency > 0.1 ? 0.5 : 1.0;
  memory.importance = Math.max(1, memory.importance - decayRate);
}
```

### Implementation Checklist

- [ ] Implement importance boost on high-relevance recall
- [ ] Tune threshold (0.7) and boost amount (0.5) via testing
- [ ] Document decay/boost mechanics in memory-system.md
- [ ] Consider weighted decay for frequently accessed memories

### Estimated Effort
**1-2 hours**

---

## Concern 7: Daily Log Rotation

### 🟢 **Priority: Low** | Effort: Low | Risk: Disk Space Over Years

### Problem

Daily synthesis logs accumulate indefinitely:

```
~/.quje-agent/memory/daily/
├── 2024-01-01.md
├── 2024-01-02.md
├── ...
└── 2026-03-01.md  # Continues forever
```

**At ~500 bytes per log**:
- 1 year: 182 KB
- 5 years: 912 KB
- 10 years: 1.8 MB

Not a significant concern for most users, but could grow large for heavy users over many years.

### Recommendation

**Simple rotation**: Archive/compress logs older than N days

```typescript
// synthesis.ts - after saving daily log
const { gzip } = await import('zlib');
const { readdir, unlink, writeFile } = await import('fs/promises');

// Archive logs older than 30 days
const ARCHIVE_AGE_DAYS = 30;
const dailyDir = join(MEMORY_DIR, "daily");
const files = await readdir(dailyDir);

for (const file of files) {
  if (!file.endsWith('.md')) continue;
  
  const filePath = join(dailyDir, file);
  const stats = await stat(filePath);
  const ageDays = (Date.now() - stats.mtimeMs) / (24 * 60 * 60 * 1000);
  
  if (ageDays > ARCHIVE_AGE_DAYS) {
    const content = await readFile(filePath);
    const compressed = gzip(content);
    await writeFile(`${filePath}.gz`, compressed);
    await unlink(filePath);
    console.log(`[synthesis] Archived ${file}`);
  }
}
```

**Alternative**: Add manual archive command

```bash
npm run archive-logs -- --older-than=90
```

### Implementation Checklist

- [ ] Decide on archive threshold (30, 60, or 90 days)
- [ ] Implement automatic compression
- [ ] Or create manual archive command
- [ ] Document archive format for future readability

### Estimated Effort
**1-2 hours**

---

## Summary of Recommendations

### Immediate (1-2 weeks)

1. **Embedding model versioning** — Critical for future flexibility
2. **Memory purge tests** — Prevent potential data loss

### Short-term (1-2 months)

3. **Synthesis scaling instrumentation** — Add logging/benchmarks, consider refactoring to use sqlite-vec
4. **Query construction A/B test** — Improve recall quality
5. **Importance boost** — Better long-term memory management

### Long-term (6+ months, or when scale requires)

6. **Daily log rotation** — If disk space becomes a concern

### ✅ Already Resolved

- ~~**O(n) search scaling**~~ — Resolved by sqlite-vec KNN MATCH queries
- ~~**JSON file I/O bottleneck**~~ — Resolved by SQLite migration with per-row CRUD

---

## Appendix: Implementation Priority Matrix

```
Impact
  │
  │  ┌─────────────────────┐
  │  │  Embedding Version  │ ← Do this FIRST
  │  │  Purge Testing      │
  │  └─────────────────────┘
  │
  │  ┌─────────────────────┐
  │  │  Scaling (O(n²))    │ ← When you hit 5k+ memories
  │  │  Query Strategy     │
  │  └─────────────────────┘
  │
  │  ┌─────────────────────┐
  │  │  Importance Boost   │
  │  │  Log Rotation       │ ← Nice-to-have
  │  └─────────────────────┘
  │                              ✅ Resolved: O(n) search, JSON I/O bottleneck
  └───────────────────────────→ Effort
```

---

## Closing Notes

The memory system is in **excellent shape**. These concerns represent thoughtful engineering for future scale and maintainability, not critical bugs or design flaws. The system will serve well for personal use at scales up to several thousand memories without any of these improvements.

**When to prioritize**:
- Embedding versioning: Before switching embedding models
- Purge testing: Before relying on purge for space management
- Synthesis scaling: When synthesis takes >30 seconds (refactor to use sqlite-vec per-memory KNN)
- Query strategy: If you notice irrelevant recalls during topic switches
- Importance boost: If old memories seem undervalued in long-running chats
- Log rotation: When the `daily/` directory exceeds ~10 MB

**Note**: The SQLite + sqlite-vec migration (completed) resolved the O(n) search scaling concern and the JSON file I/O bottleneck. Search now runs KNN MATCH queries in native C with SIMD acceleration, and individual CRUD operations no longer require loading the entire memory store.
