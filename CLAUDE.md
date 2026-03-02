# CLAUDE.md

## Project

qu.je Agent — a local Ollama chat UI with a persistent memory system. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.quje-agent/` (chats, settings, memories)
- **systemd service**: `quje-agent.service` (user service, auto-starts on boot)

## Architecture

Two chat types: **agent** (memory-augmented) and **quick** (standalone). Existing chats without a `type` field default to "quick".

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) orchestrates:
1. Memory context augmentation (agent chats only)
2. LLM streaming via pi-ai (`streamChat`)
3. Memory tool parsing and execution (agent chats only)
4. Fire-and-forget memory extraction after responses
5. Pre-compaction flush when token usage > 75% of context window

Memory services are in `server/src/services/memory-*.ts`. They share the pi-ai `streamChat` function for LLM calls (extraction, synthesis, tool execution all use it with different system prompts).

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
- **Storage**: Chat persistence uses JSON files (`storage.ts`), memory persistence uses SQLite + sqlite-vec (`memory-storage.ts` → `~/.quje-agent/memory/memories.db`). Both use `~/.quje-agent/` as the base directory.
- **Context window**: Fetched per-model from Ollama `/api/show` (`model_info.*.context_length`). Per-chat override via `chat.contextWindow`; effective value is `chat.contextWindow ?? model.contextWindow`.
- **Embeddings**: Ollama `qwen3-embedding:0.6b` via `POST http://localhost:11434/api/embed`. Vectors are L2-normalized, so cosine similarity = dot product.
- **Memory scoring**: `cosine_sim * recency_decay * (importance / 10)` with a 30-day half-life on recency.
- **Memory dedup**: cosine > 0.85 between a new fact and existing memory triggers UPDATE instead of ADD. Uses sqlite-vec KNN MATCH for nearest-neighbor lookup.
- **Backward compat**: `getChat()` and `listChats()` default missing `type` to "quick".

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue
- No external state management — React hooks + API calls

## Important notes

- The `memory.ts` routes must define `/status`, `/synthesis/*`, and `/search` **before** the `/:id` param routes to avoid Express matching those paths as IDs.
- `streamChat` from `agent.ts` is reused by extraction, synthesis, and tool execution — it's the single LLM call interface.
- The scheduler (`scheduler.ts`) runs a synthesis check on startup and then hourly via `setInterval`.
- When editing types, update both `server/src/types.ts` and `client/src/types.ts`.
- The server may run compiled `dist/index.js` (via `npm start` / systemd) rather than tsx dev mode — source changes require `npm run build` + restart to take effect.
