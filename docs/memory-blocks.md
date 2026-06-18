# Memory Blocks

Memory blocks are structured, editable knowledge documents that complement the atomic memory system. While atomic memories capture individual facts extracted from conversations, blocks organize related knowledge into coherent, agent-curated documents — inspired by [Letta's Context Constitution](https://github.com/letta-ai/context-constitution).

## Problem Solved

The atomic memory extraction pipeline sees each conversation exchange independently, without awareness of what's already stored. This causes redundant extraction of well-known facts ("the project uses Tailwind") that pollute the memory store. Blocks solve this by:

1. **Consolidating repeated knowledge** — instead of 10 memories about the tech stack, one block paragraph covers it
2. **Preventing redundant extraction** — the extraction LLM sees loaded blocks and skips facts already covered
3. **Providing stable context** — blocks are always loaded by scope, not dependent on query relevance matching

## Block Structure

```typescript
interface MemoryBlock {
  id: string;              // blk-{uuid}
  name: string;            // "Tech Stack", "User Preferences"
  description: string;     // One-line summary for retrieval and indexing
  content: string;         // Full block content (max 4000 chars)
  scope: "global" | "project";
  projectId?: string;      // For project-scoped blocks
  createdAt: string;
  updatedAt: string;
  updatedBy: "agent" | "user";
  tokenEstimate: number;   // Approximate tokens (~content.length / 4)
  supersededBy?: string;   // Links to newer version
  supersedes?: string;     // Links to older version
}
```

## Storage

- **Table**: `memory_blocks` in `app.db`
- **FTS5**: `memory_blocks_fts` virtual table indexes content, name, and description for full-text search
- **Auto-sync triggers**: FTS kept in sync via INSERT/UPDATE/DELETE triggers
- **Character limit**: 4000 chars per block (~1000 tokens). Exceeding the limit during an update creates a new superseding block.

## Scoping

**Global blocks** (always loaded):
- Applied to every chat regardless of project
- Examples: user preferences, agent personality notes, communication style

**Project blocks** (loaded when `projectId` matches):
- Scoped to a specific project
- Examples: architecture decisions, tech stack, coding conventions
- Still searchable cross-project via FTS and `search_memory`

## Context Injection

In `buildStablePrefix` / `buildMemoryAugmentedPrompt`, blocks and project context are injected in this order:

```
1. Base system prompt
2. ## Your Persona (loaded from persona-store)
3. ## About the User (loaded from user-store)
4. ## Memory Blocks (global blocks, full content, fixed ~3000-token budget)
5. ## Available Memory Blocks (remaining global blocks — one-line descriptions)
   - [blk:id] Name — description
   Use read_memory_block(id) to load full content when relevant.
6. ## Continuity Context (Zeitgeist)
7. ## Project Context (project chats only: working directory + AGENTS.md)
8. ## Project Memory Blocks (project blocks, using the remaining project-chat block budget)
9. ## Available Project Memory Blocks (remaining current-project blocks — one-line descriptions)
10. ## Relevant Memories (atomic memories from reranker pipeline)
```

**Progressive disclosure**: Global and project blocks load full content automatically. Other blocks appear as one-line descriptions (name + description) — the agent loads full content on demand via `read_memory_block`.

**Token budget**: Global loaded blocks use a fixed ~3000-token budget so the no-project prefix is byte-identical to the start of project-chat prefixes. Project chats keep a ~5000-token total loaded-block budget by assigning the remaining budget to project blocks. The block index (one-liners) is lightweight.

**Stable prefix caching**: The system prompt prefix (base prompt + persona + user doc + global blocks + zeitgeist + optional project context/blocks) is cached per-chat in `stablePrefixCache`. This keeps the prefix byte-for-byte identical across turns, maximizing llama.cpp KV cache reuse. Global sections come before project-only sections so a no-project baseline warm can be reused by project chats through the global prefix. Only the dynamic memories section changes between turns.

## Agent Tools

| Tool | Description |
|------|-------------|
| `create_memory_block` | Create a new named block with content, scope, optional projectId |
| `update_memory_block` | Edit a block's content or description. Auto-supersedes if over 4000 chars |
| `read_memory_block` | Load full content of a block by ID |
| `list_memory_blocks` | Browse blocks by scope, project, or name/description query |
| `get_block_history` | Walk the supersession chain to see how a block evolved |
| `search_memory` | Extended to also return block excerpts alongside atomic memory results |

## Supersession

When a block exceeds the 4000 character limit during an update, a new block is created that supersedes the old one — using the same supersession system as atomic memories:

- Old block gets `supersededBy` pointing to the new block
- New block gets `supersedes` pointing to the old block
- Old blocks remain accessible via `get_block_history` or direct ID lookup
- Only current (non-superseded) blocks appear in listings and context injection

## Extraction Integration

The extraction system prompt includes loaded block content (first 300 chars each):

```
## Existing Knowledge Blocks
The following memory blocks already contain relevant context:
- Tech Stack: TypeScript, React, Vite, Tailwind v4, Express, SQLite...
- Architecture: npm workspaces monorepo, pi-ai tool calling...

Only extract information that is:
1. NOT already covered by the above blocks
2. Specific enough to be useful as a standalone fact
3. Worth remembering beyond what blocks already capture
```

This directly prevents redundant extraction of facts already in blocks.

## User Interface

**Settings Modal**: "Memory Blocks" section in the Memory area:
- Browse/filter blocks by scope (All / Global / Project)
- View block content with token count and update metadata
- Inline editing with save/cancel
- Delete with confirmation

**Chat Header**: `BlockIndicator` component shows:
- Icon + count of loaded blocks (global + project)
- Click to expand dropdown with block names, scopes, descriptions
- Expandable blocks with full content, copy, history viewer

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory/blocks` | List blocks (optional `?scope=` and `?projectId=` filters) |
| `POST` | `/api/memory/blocks` | Create block |
| `GET` | `/api/memory/blocks/:id` | Get single block |
| `PATCH` | `/api/memory/blocks/:id` | Update block (sets `updatedBy: "user"`) |
| `DELETE` | `/api/memory/blocks/:id` | Delete block |
| `GET` | `/api/memory/blocks/:id/history` | Supersession chain |

## Relationship to Other Systems

| System | Role | Relationship |
|--------|------|-------------|
| **Atomic memories** | Individual facts, preferences, decisions | Complementary — blocks organize related memories; search returns both |
| **Context archives** | Full-fidelity conversation artifacts | Separate concern — archives preserve exact tool outputs; blocks curate knowledge |
| **Persona** | Agent identity document | Could migrate to a global block (currently separate file-based storage) |
| **User document** | User profile | Could migrate to a global block (currently separate file-based storage) |
| **Daily synthesis** | Memory consolidation | Future: synthesis could consolidate atomic memories into blocks |

## Key Files

| File | Role |
|------|------|
| `server/src/services/memory-storage.ts` | Block table schema, CRUD functions, FTS search, supersession |
| `server/src/services/memory-tools.ts` | Agent tool definitions and executors |
| `server/src/services/memory-context.ts` | Context injection, scope loading, stable prefix caching |
| `server/src/services/memory-extraction.ts` | Extraction prompt augmentation with block content |
| `server/src/routes/memory.ts` | REST API endpoints for block CRUD |
| `client/src/components/SettingsModal.tsx` | Browser/editor UI in settings |
| `client/src/components/BlockIndicator.tsx` | Chat header indicator component |
