# CLAUDE.md

## Project

qu.je Agent — A local Ollama chat UI with persistent memory, project context, and agentic tool execution. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.quje-agent/` (chats, projects, settings, memories, artifacts, images)
- **systemd service**: `quje-agent.service` (user service, auto-starts on boot)

## Architecture

Two chat types: **agent** (memory-augmented) and **quick** (standalone). Existing chats without a `type` field default to "quick".

**Projects** provide persistent context for agent chats:
- Projects stored in `~/.quje-agent/projects/` with name, path, and optional AGENTS.md
- New chats in a project inject AGENTS.md content into the system prompt
- Chats within projects are grouped under their project in the UI
- Agent uses filesystem tools to explore project structure

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) orchestrates:
1. Memory context augmentation (agent chats only)
2. LLM streaming via pi-ai (`streamChat`)
3. Memory tool parsing and execution (agent chats only)
4. Fire-and-forget memory extraction after responses
5. Pre-compaction flush when token usage > 75% of context window

Memory services are in `server/src/services/memory-*.ts`. They share the pi-ai `streamChat` function for LLM calls (extraction, synthesis, tool execution all use it with different system prompts).

## Memory system

### Categories

`MemoryCategory` (in both `server/src/types.ts` and `client/src/types.ts`):
- `preference` — user likes, dislikes, stylistic choices
- `fact` — concrete information about the user, their role, or their environment
- `behavior` — recurring patterns in how the user works or communicates
- `instruction` — explicit directives about how the agent should behave
- `context` — project-level information: architecture, tech choices, ongoing work, constraints
- `decision` — a choice that was made and why, tradeoffs considered
- `note` — general observations, curiosities, personal details that don't fit other categories
- `reflection` — synthesis-only: higher-order insights, cross-session patterns, agent self-reflection

### Schema

Memories are stored in SQLite (`~/.quje-agent/memory/memories.db`) with three tables:
- `memories` — metadata: id, text, category, importance (1-10), timestamps, access_count, source_chat_id, **project_id** (optional, for project-scoped memories)
- `vec_memories` — 1024-dim embeddings (sqlite-vec, cosine distance)
- `fts_memories` — FTS5 full-text index (auto-synced via triggers)

### Extraction (`memory-extraction.ts`)

Two extraction paths run during chat:
1. **Per-exchange extraction** — fire-and-forget after each assistant response. Extracts 1-3 sentence memories with context and rationale (not just atomic facts). Accepts optional `projectId` to tag memories with their source project.
2. **Pre-compaction flush** — when messages are about to be removed due to context limits, extracts task state and technical context from the removed messages before they're lost.

Both use `dedupAndSave()` which checks cosine similarity > 0.85 against existing memories: updates if duplicate, inserts if new.

### Synthesis (`synthesis.ts`)

Daily synthesis runs via the scheduler (hourly check, 24h interval). **Only runs when agent chats occurred that day** — inactive days are skipped entirely.

**Flow:**
1. **Consolidate** — merge near-duplicate memories (cosine > 0.90)
2. **Decay/purge** — decrease importance for memories unused >30 days; purge if unused >6 months with importance ≤2
3. **Load today's activity** — group agent chats by project, load AGENTS.md for each active project, load notebook entries (user + agent, excluding prior synthesis entries)
4. **Generate daily summary** — LLM call with chat digest + notebook entries + stored memories. Prompt instructs first-person voice for agent actions, third-person for user actions. Uses `defaultModelId` from settings (falls back to first available Ollama model). Captures both `text_delta` and `thinking_delta` (qwen3 reasoning fallback). Writes to `~/.quje-agent/memory/daily/{YYYY-MM-DD}.md`
5. **Generate reflections** — separate LLM call producing 1-5 `reflection` memories (importance 7-9). Prompt encourages agent self-awareness and cross-project pattern recognition. Saved via `dedupAndSave` with `sourceChatId: "synthesis"`. Tagged with projectId if all activity was in a single project
6. **Persona pattern analysis** — clusters high-importance frequently-accessed memories, generates persona update suggestions (logged, not auto-applied)
7. **Write notebook entry** — creates an agent notebook entry with the synthesis summary, dedup-guarded (one per day)

**Model selection** (`getSynthesisModelId()`): reads `defaultModelId` from settings, verifies availability in Ollama, falls back to first discovered model.

### Memory augmentation (`memory-context.ts`)

For agent chats, the system prompt is augmented with:
1. Persona content (`~/.quje-agent/persona.md`)
2. Top 5 memories matching the last 3 user messages (hybrid RRF search: vector + FTS5, filtered by score > 0.0003)

### Memory tools (agent-callable)

- `save_memory` — explicit memory save (all categories except `reflection`)
- `search_memory` — semantic search, returns top 5 with scores
- `forget_memory` — delete by ID or search query
- `update_persona` — modify persona document sections

## Tool system (agent chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

**Registry** (`server/src/services/agent-tools.ts`):
- `getAgentTools()` returns all tools; `executeTool(toolCall, chatId, onEvent?)` dispatches by name.
- **Memory tools** (from `memory-tools.ts`): `save_memory`, `search_memory`, `forget_memory`
- **Filesystem tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
- **Sandbox tools**: `run_python`, `create_artifact`
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `~/.quje-agent/pending/{chatId}.json`, resumes on next user message)

**Tool loop** (`server/src/routes/chat.ts`):
- `while (iterations < 20)`: calls `streamChat()`, checks `stopReason`. If `"toolUse"`, executes each tool call, appends `ToolResultMessage` to `piMessages`, and loops. Otherwise breaks.
- Three accumulators (`allToolCalls`, `allToolResults`, `allArtifacts`) collect across all iterations and are saved on the final `ChatMessage`.
- `ask_user` is intercepted before `executeTool` — sends SSE `ask_user` event and breaks the loop.
- SSE events during loop: `text_delta`, `thinking_delta`, `tool_status` (running/done/error), `artifact`, `ask_user`.

**Message reconstruction** (`server/src/services/agent.ts`, `chatMessagesToPiMessages()`):
- A single persisted `ChatMessage` (with `toolCalls` + `toolResults` + `content`) is reconstructed as multiple pi-ai messages: `AssistantMessage(stopReason:"toolUse")` → `ToolResultMessage[]` → `AssistantMessage(stopReason:"stop")` with the final text.
- This split is critical — collapsing tool calls and final text into one message confuses the model into avoiding tool use on replay.

## Artifact system

**Creation**: The `create_artifact` tool receives `{ title, html }`. `sandbox.ts` writes the HTML to `~/.quje-agent/artifacts/{uuid}/index.html` and returns URL `/api/artifacts/{uuid}`.

**Serving** (`server/src/routes/artifacts.ts`):
- `GET /api/artifacts/:id` — serves `index.html` with `Content-Type: text/html`
- `GET /api/artifacts/:id/*subpath` — serves sub-files (CSS, JS, images) with path-traversal protection

**Persistence**: `ChatMessage.artifacts?: Artifact[]` stores `{ id, title, url }` for each artifact created during the message's tool loop. Artifacts survive server restarts because both the HTML files on disk and the URL references in chat JSON are stable.

**Client rendering** (`client/src/components/ArtifactPanel.tsx`):
- Fetches artifact HTML via `fetch(artifact.url)`, creates a `Blob` URL, and uses it as the iframe `src`.
- **Blob URLs are same-origin**, which avoids Chrome's `requestAnimationFrame` throttling on cross-origin iframes. Do NOT use `sandbox` attribute or direct `/api/artifacts/` URLs as iframe src — animations will freeze.
- "Code" tab shows the fetched source; "Open" link opens the raw `/api/artifacts/{id}` URL in a new tab.
- In `MessageBubble.tsx`, artifacts render via `(artifacts || message.artifacts)?.map(...)` — live streaming prop takes precedence, falls back to persisted `message.artifacts`.

## Key patterns

- **Streaming**: SSE with event types `text_delta`, `thinking_delta`, `tool_status`, `artifact`, `ask_user`, `done`, `error`
- **Types**: Shared interfaces in `server/src/types.ts` and `client/src/types.ts` (kept in sync manually)
- **Storage**: Chat persistence uses JSON files (`storage.ts`), memory persistence uses SQLite + sqlite-vec (`memory-storage.ts` → `~/.quje-agent/memory/memories.db`), notebooks use JSON files (`notebook-storage.ts` → `~/.quje-agent/notebooks/`). All use `~/.quje-agent/` as the base directory.
- **Context window**: Fetched per-model from Ollama `/api/show` (`model_info.*.context_length`). Per-chat override via `chat.contextWindow`; effective value is `chat.contextWindow ?? model.contextWindow`.
- **Embeddings**: Ollama `qwen3-embedding:0.6b` via `POST http://localhost:11434/api/embed`. Vectors are L2-normalized, so cosine similarity = dot product. Supports 32k context.
- **Memory scoring**: `rrf_score * recency_decay * (importance / 10)` with a 30-day half-life on recency. RRF combines vector and FTS5 rankings.
- **Memory dedup**: cosine > 0.85 between a new fact and existing memory triggers UPDATE instead of ADD. Uses sqlite-vec KNN MATCH for nearest-neighbor lookup.
- **Project scoping**: Memories have an optional `projectId` field. Chats in a project can tag their extracted memories with the project ID. Synthesis groups chats by project and loads AGENTS.md for context.
- **Backward compat**: `getChat()` and `listChats()` default missing `type` to "quick". Memory DB auto-migrates `project_id` column if missing.

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue; projects use emerald
- No external state management — React hooks + API calls
- Lazy loading for heavy components (ImageSandbox, MarkdownRenderer, RippleGridBackground)

## Important notes

- The `memory.ts` routes must define `/status`, `/synthesis/*`, and `/search` **before** the `/:id` param routes to avoid Express matching those paths as IDs.
- `streamChat` from `agent.ts` is reused by extraction, synthesis, and tool execution — it's the single LLM call interface.
- The scheduler (`scheduler.ts`) runs a synthesis check on startup and then hourly via `setInterval`. Synthesis only runs if agent chats occurred that day — inactive days are skipped.
- Synthesis uses `defaultModelId` from settings, not the first Ollama model. It captures `thinking_delta` as fallback for qwen3 reasoning mode where text output may be empty.
- The `reflection` memory category is reserved for synthesis — extraction prompts and the `save_memory` tool do not include it.
- When editing types, update both `server/src/types.ts` and `client/src/types.ts`.
- The server may run compiled `dist/index.js` (via `npm start` / systemd) rather than tsx dev mode — source changes require `npm run build` + restart to take effect.
- Blob URLs for artifacts are critical for Chrome animation performance — do not use cross-origin iframe src.
