# Notebook Feature Specification

**Status:** Phase 1 Complete (Data Layer + API)  
**Date:** March 14, 2025  
**Mental Model:** Parallel asynchronous thinking spaces

---

## Overview

The notebook feature enables asynchronous collaboration between user and agent through separate but linked persistent writing spaces. Unlike chat, which demands turn-taking and immediacy, notebooks support meandering thought development over time.

### Core Principles

1. **Coupled rhythm** — Agent only writes when user has written that day (activity-based guardrail)
2. **Separate spaces** — User and agent have distinct notebooks, with cross-linking between them
3. **Rich content** — Entries support text, tools, artifacts, and memory extraction
4. **Explicit + automatic memory** — Memories can be explicitly created from notes, with auto-extraction as safety net

---

## Architecture

### Data Storage

```
~/.quje-agent/
├── notebooks/
│   ├── user/
│   │   ├── entries/
│   │   │   ├── 2025-01-15-abc123.json
│   │   │   └── ...
│   │   └── index.json
│   └── agent/
│       ├── entries/
│       │   ├── 2025-01-15-xyz789.json
│       │   └── ...
│       └── index.json
├── memory/
│   └── memories.db
└── artifacts/
    └── ...
```

### Entry Schema

```typescript
interface NotebookEntry {
  id: string;
  createdAt: string;                    // ISO 8601
  author: 'user' | 'agent';
  content: string;                      // Markdown
  links?: NotebookLink;
  toolResults?: ChatToolResult[];       // Agent entries only
  artifacts?: Artifact[];               // Agent entries only
  memories?: { memoryId: string; text: string }[];
}

interface NotebookLink {
  notebooks?: { entryId: string; author: 'user' | 'agent' }[];
  chats?: { chatId: string; title?: string }[];
}

interface NotebookIndex {
  entries: { 
    id: string; 
    createdAt: string; 
    author: 'user' | 'agent'; 
    preview: string;  // First 100 chars
  }[];
  lastActivityDate: string | null;      // ISO 8601, for guardrail logic
}
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/notebooks/user` | List user notebook entries (index) |
| GET | `/api/notebooks/agent` | List agent notebook entries (index) |
| GET | `/api/notebooks/:author/:id` | Get single entry (full content) |
| POST | `/api/notebooks/user` | Create user entry (`{ content }`) |
| POST | `/api/notebooks/agent/trigger` | Trigger agent review (guarded) |
| PATCH | `/api/notebooks/:author/:id` | Update entry (content, links) |
| DELETE | `/api/notebooks/:author/:id` | Delete entry |

### POST /api/notebooks/agent/trigger Response

```json
// Success - agent entry created
{
  "id": "xyz789",
  "createdAt": "2025-03-14T20:00:00.000Z",
  "author": "agent",
  "content": "...",
  "artifacts": [],
  "memories": []
}

// Skipped - no user activity today
{
  "skipped": true,
  "reason": "No user activity today"
}

// Skipped - no user entries found
{
  "skipped": true,
  "reason": "No user entries found"
}
```

---

## Agent Trigger Logic

```
User creates notebook entry
    ↓
POST /api/notebooks/agent/trigger
    ↓
Check: hasUserActivityToday()?
    ├── No → Return { skipped: true, reason: "No user activity today" }
    └── Yes → Continue
        ↓
        Get user entries from today
        ↓
        Build system prompt with user content + memory context
        ↓
        Call streamChat (notebook mode system prompt)
        ↓
        Create agent entry with response
        ↓
        Extract memories from agent entry (auto-extraction)
        ↓
        Return agent entry
```

### System Prompt (Notebook Mode)

```
You are writing in your personal notebook, not responding to a user directly. 
This is a space for reflection, exploration, and creation. 

User has written the following notes today:
{userContent}

You can:
- Reflect on patterns you notice in their notes or your memories
- Explore ideas that curiosity pulls you toward
- Create artifacts to visualize or demonstrate concepts
- Search the web to investigate questions
- Link to past chats or notebook entries for context

Write thoughtfully. Only write if you have something genuine to say - not to be performative. 
If the user's notes don't spark anything for you, it's fine to skip writing today.

Current date: {date}
```

---

## Memory Extraction

Notebook entries feed into the existing memory extraction pipeline:

1. **User entries** — Auto-extraction runs after creation (same as chat messages)
2. **Agent entries** — Auto-extraction runs after creation
3. **Explicit creation** — Future UI will allow manual "save as memory" action

The `extractMemoriesFromText()` function in `memory-extraction.ts` reuses the same LLM prompt and deduplication logic as chat extraction.

---

## Implementation Status

### ✅ Phase 1: Data Layer + API (Complete)

**Backend:**
- `server/src/services/notebook-storage.ts` — Storage service following existing patterns
  - JSON file persistence
  - Index management for fast listing
  - Activity tracking for guardrail logic
  - CRUD operations

- `server/src/routes/notebooks.ts` — REST API routes
  - All endpoints implemented
  - Agent trigger with guardrail logic
  - Memory extraction integration

- `server/src/services/memory-extraction.ts` — Extended
  - New `extractMemoriesFromText()` function for notebook entries

- `server/src/index.ts` — Router mounted at `/api/notebooks`

- `server/src/types.ts` — Type definitions

**Frontend:**
- `client/src/types.ts` — Mirrored type definitions

**Data Directory:**
- `~/.quje-agent/notebooks/user/entries/` — Created
- `~/.quje-agent/notebooks/agent/entries/` — Created

### 📋 Phase 2: UI Implementation (Pending)

1. **Sidebar Integration**
   - New "Notebooks" nav item
   - Unread indicator (dot) when agent has new entries

2. **Main View**
   - Side-by-side columns (desktop): user left, agent right
   - Tabbed view (mobile)
   - Entry list with preview, timestamp, author badge
   - Entry detail view (markdown rendering)

3. **Entry Composer**
   - Text input for user entries
   - Submit button
   - Optional: rich text / markdown toolbar

4. **Linking System**
   - Link picker (type `[[` or button)
   - Recent chats dropdown
   - Recent notebook entries dropdown
   - Display of links in entry view

5. **"Send to Notebook" Context Menu**
   - Right-click on chat list item
   - Creates notebook entry with chat reference link

6. **Agent Entry Display**
   - Render tool results (if enabled later)
   - Embed artifacts (iframe, same as chat)
   - Show memory extraction results

### 🔮 Phase 3: Enhancements (Future)

1. **Tool Execution in Agent Notebook**
   - Enable full tool loop (currently disabled in trigger route)
   - Agent can search web, create artifacts, run code during notebook writing

2. **Semantic Sorting**
   - Group related entries by topic
   - Timeline view with clustering

3. **Notification System**
   - In-app toast when agent writes
   - Email option (if user enables)

4. **Cross-Reference Visualization**
   - Graph view of linked entries
   - Network diagram showing chat ↔ notebook connections

5. **Entry Editing**
   - Full edit mode for user entries
   - Version history (optional)

6. **Export/Import**
   - Export notebook as markdown/JSON
   - Import from other systems

---

## Design Decisions

### Why JSON Files (Not SQLite)?

Consistency with existing chat/project storage. SQLite is used for memory (vector embeddings require it), but notebooks are document-like and benefit from human-readable persistence.

### Why Separate Index Files?

Performance — listing entries doesn't require reading all entry files. The index is a small summary that can be loaded quickly for the UI list view.

### Why Activity-Based Guardrail (Not Timer)?

Prevents performative writing. If the user isn't engaging, the agent shouldn't either. This creates a coupled rhythm without pressure. Timer-based would risk backlog anxiety.

### Why Separate Notebooks (Not Shared)?

Clarity of ownership. User owns their thoughts, agent owns theirs. Links allow intersection without blurring boundaries. Shared notebook would create confusion about who wrote what.

### Why Notebook Mode System Prompt (Not Chat Prompt)?

The agent's voice should shift from conversational (chat) to reflective (notebook). Chat prompt: "You are responding to a user." Notebook prompt: "You are writing in your personal notebook."

### Why Auto-Extraction + Explicit Option?

Matches user's stated preference from existing memories: "explicit memory creation with auto-extraction as safety net." Auto-extraction catches important facts; explicit gives control.

---

## Testing Checklist

### API Testing

- [ ] Create user entry: `POST /api/notebooks/user` with `{ content: "test" }`
- [ ] List user entries: `GET /api/notebooks/user` returns index
- [ ] Get single entry: `GET /api/notebooks/user/:id` returns full entry
- [ ] Trigger agent with user activity: creates agent entry
- [ ] Trigger agent without user activity: returns `{ skipped: true }`
- [ ] Update entry: `PATCH /api/notebooks/user/:id` with new content
- [ ] Add links to entry: `PATCH` with `links` field
- [ ] Delete entry: `DELETE /api/notebooks/user/:id`
- [ ] Verify memory extraction: check `~/.quje-agent/memory/memories.db` after entry creation

### Integration Testing

- [ ] Create user entry → trigger agent → verify agent entry created
- [ ] Agent entry contains artifacts (if tool execution enabled)
- [ ] Memories extracted from both user and agent entries
- [ ] Index updates correctly after CRUD operations
- [ ] `lastActivityDate` updates correctly

### Error Handling

- [ ] Invalid author parameter returns 400
- [ ] Non-existent entry returns 404
- [ ] Empty content on POST returns 400
- [ ] Corrupt JSON files are skipped (storage service handles gracefully)

---

## Next Steps

1. **Manual API Testing** — Use curl or Postman to verify endpoints
2. **UI Implementation** — Build Phase 2 components
3. **Integration Testing** — End-to-end flow with UI
4. **Tool Execution** — Enable full tool loop in agent notebook (optional)

---

## Related Memories

- User prefers explicit memory creation with auto-extraction as safety net
- User conceptualizes the system as parallel thinking spaces that occasionally intersect
- User wants a 'send to notebook' option in the right-click context menu of the chat list
- User prefers a dot indicator on the notebooks nav item for unread status
