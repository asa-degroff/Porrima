# AGENTS.md

## Project

**qu.je Agent** — An feature-rich agent framework and user interface with persistent memory, project context, image generation, and agentic tool execution. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick Reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.quje-agent/` (chats, projects, settings, memories, artifacts)
- **systemd service**: `quje-agent.service` (user service, auto-starts on boot)

## Architecture

### Chat Types

Two chat types: **agent** (memory-augmented) and **quick** (standalone). Existing chats without a `type` field default to "quick".

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) orchestrates:
1. Memory context augmentation (agent chats only)
2. LLM streaming via pi-ai (`streamChat`)
3. Memory tool parsing and execution (agent chats only)
4. Fire-and-forget memory extraction after responses
5. Pre-compaction flush when token usage > 75% of context window

### Projects

Projects provide persistent context for agent chats through AGENTS.md files:
- Created via UI or API, stored in `~/.quje-agent/projects/`
- Each project has a name, filesystem path, and optional AGENTS.md
- New chats in a project automatically inject AGENTS.md content into the system prompt
- Chats within projects are grouped under their project in the UI
- The agent uses `list_files`, `read_file`, etc. tools to explore the project structure

### Memory Services

Memory services are in `server/src/services/memory-*.ts`. They share the pi-ai `streamChat` function for LLM calls (extraction, synthesis, tool execution all use it with different system prompts).

### Chat Storage

Chat storage migrated from JSON files to SQLite (`server/src/services/chat-storage.ts`). The `app.db` database stores:
- **Chats** — metadata + JSON `messages` column (hybrid approach: normalized metadata, JSON for nested arrays)
- **Chat messages** — denormalized `chat_messages` table with FTS5 virtual table for full-text search
- **Projects, settings, pending states** — migrated from JSON to SQLite tables

**FTS5 search**: `chat_messages_fts` uses `content` + `chat_id UNINDEXED` columns. Triggers auto-sync on insert/update/delete. `searchChatMessages()` supports phrase match fallback to term search, scoped to single chat or global. The `search_conversation` tool exposes this to the agent.

## Tool System (Agent Chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

### Registry (`server/src/services/agent-tools.ts`)

- `getAgentTools()` returns all tools; `executeTool(toolCall, chatId, onEvent?)` dispatches by name.
- **Memory tools** (from `memory-tools.ts`): `save_memory`, `search_memory`, `forget_memory`
- **Conversation search**: `search_conversation` — FTS5 search on chat history, scoped to single chat or global
- **Filesystem tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
- **Sandbox tools**: `run_python`, `create_artifact`
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `pending_states` table in SQLite, resumes on next user message)

### Tool Loop (`server/src/routes/chat.ts`)

- `while (iterations < 20)`: calls `streamChat()`, checks `stopReason`. If `"toolUse"`, executes each tool call, appends `ToolResultMessage` to `piMessages`, and loops. Otherwise breaks.
- Three accumulators (`allToolCalls`, `allToolResults`, `allArtifacts`) collect across all iterations and are saved on the final `ChatMessage`.
- `ask_user` is intercepted before `executeTool` — sends SSE `ask_user` event and breaks the loop.
- SSE events during loop: `text_delta`, `thinking_delta`, `tool_status` (running/done/error), `artifact`, `ask_user`.

### Message Reconstruction (`server/src/services/agent.ts`, `chatMessagesToPiMessages()`)

- A single persisted `ChatMessage` (with `toolCalls` + `toolResults` + `content`) is reconstructed as multiple pi-ai messages: `AssistantMessage(stopReason:"toolUse")` → `ToolResultMessage[]` → `AssistantMessage(stopReason:"stop")` with the final text.
- This split is critical — collapsing tool calls and final text into one message confuses the model into avoiding tool use on replay.

## Feature Systems

### Memory System

**Categories** (8 types):
- `preference` — user likes, dislikes, stylistic choices
- `fact` — concrete information about the user or their world
- `behavior` — observed patterns in how the user works or communicates
- `instruction` — explicit directives from the user
- `context` — project-level information: architecture, tech choices, ongoing work
- `decision` — choices made and why, tradeoffs considered
- `note` — general observations, curiosities, personal details
- `reflection` — synthesis-only: higher-order insights, cross-session patterns, agent self-reflection

**Project scoping**: memories have an optional `projectId` field for project-scoped context. The DB auto-migrates the `project_id` column.

**Source tracking**: memories track `sourceType` ('chat_immediate', 'chat_delayed', 'synthesis', 'supersession') and `sourceId` for lineage. Supersession links (`superseded_by`, `supersedes`) track when memories are updated/contradicted.

- **Immediate extraction**: after each agent response, a background LLM call extracts memories (1-3 sentences each with context and rationale) and deduplicates them against existing memories using cosine similarity (>0.85 triggers UPDATE). Runs fire-and-forget via `memory-extraction.ts`.
- **Delayed extraction**: time-based trigger (configurable threshold, default 30 min) runs on inactive chats. Extracts the full conversation context, injects previously-extracted memories for density, and focuses on new patterns/decisions. Tracks `lastDelayedExtractionAt` and `lastDelayedExtractionMessageIndex` per chat. Uses `updateChatExtractionState()` to avoid touching `lastModified` (preserves chat ordering).
- **Context augmentation**: relevant memories are retrieved via RRF (Reciprocal Rank Fusion) combining vector search + FTS5 full-text search, then injected into the system prompt so the agent naturally references what it knows.
- **Agent tools**: the agent can explicitly save, search, and forget memories when asked.
- **Daily synthesis** (`synthesis.ts`): only runs when agent chats occurred that day (inactive days skipped). Groups today's chats by project, loads AGENTS.md for each active project. Loads today's notebook entries (user + agent, excluding prior synthesis entries). Uses `defaultModelId` from settings (not first Ollama model); captures `thinking_delta` as fallback for qwen3 reasoning mode. Generates reflections (1-5 per day, saved as `reflection` memories with importance 7-9). Writes an agent notebook entry with the synthesis summary. Includes persona pattern analysis (suggestions logged, not auto-applied). System prompt uses first-person for agent actions, third-person for user.
- **Pre-compaction flush**: when a conversation approaches the context window limit (>75% usage), all important facts are extracted and preserved before truncation.
- **Creative cycle integration**: After daily synthesis, scheduler runs `runCorpusCreativeCycle()` — rebuilds clusters, generates creative directions via LLM, saves top directions as `context` memories, then executes top directions as autonomous image generations.

### Artifact System

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

### Image Corpus & Clustering

**Corpus Storage** (`server/src/services/image-corpus.ts`):
- Migrated from JSON to SQLite (`~/.quje-agent/image-corpus/corpus.db`) with sqlite-vec for vector search
- Stores all images: generated (ComfyUI), analyzed (vision), uploaded (user)
- **Schema**: `corpus_entries` table with JSON `elements` column (themes, settings, characters, concepts, styles, mood)
- **Vector search**: `vec_corpus` virtual table with 1024-dim prompt embeddings, cosine distance
- **FTS5**: `fts_corpus` on prompt + description with auto-sync triggers
- **Hybrid search**: `searchCorpusHybrid()` combines FTS5 + vector similarity via RRF (Reciprocal Rank Fusion)
- **Novelty scoring**: `computeNovelty(embedding)` returns 1.0 - maxSimilarity against corpus

**Clustering** (`server/src/services/cluster-engine.ts`, `cluster-storage.ts`):
- Density-based clustering using pairwise cosine similarity matrix
- Threshold: 0.85 similarity (configurable); images above threshold grouped together
- **Cluster properties**: centroid (average embedding), dominantElements (top 5 themes/settings/etc.), variance, size
- **Singletons**: unclustered images become single-member clusters
- **Persistence**: clusters saved to `~/.quje-agent/clusters/clusters.json`
- **UI**: CorpusView with force-directed graph visualization (D3), cluster detail panels

### Creative Engine

**Direction Generation** (`server/src/services/creative-engine.ts`):
- Analyzes corpus to propose novel creative directions for autonomous generation
- **5 direction types**:
  - `gap-fill` — fills underrepresented themes (e.g., "first cyberpunk image")
  - `remix` — cross-pollinates distant clusters (similarity < 0.7)
  - `deepen` — adds intricate details to large clusters (>5 members)
  - `contrast` — opposes dominant corpus patterns (e.g., dark → luminous)
  - `explore` — variations within a cluster theme
- **LLM integration**: Uses qwen3.5:9b with Z_IMAGE_INSTRUCTIONS prompt for detailed image descriptions
- **Image context**: Loads representative cluster member thumbnails (up to 3) as vision input to LLM
- **Novelty scoring**: `scoreNovelty(embedding, corpus)` computes 1.0 - avgTop5Similarity; default threshold 0.15
- **Degenerate output detection**: Validates LLM output for token repetition, n-gram loops, malformed markdown

**Direction Cache** (`server/src/services/direction-cache.ts`):
- 24-hour TTL with invalidation on corpus size change (>10%) or cluster count change
- Persists to `~/.quje-agent/directions/cache.json`
- In-memory cache + disk fallback for fast access

**Job Queue** (`server/src/services/job-queue.ts`):
- Async direction generation to avoid blocking UI requests
- Job statuses: `pending` → `running` → `complete` | `failed`
- Processes pending jobs sequentially with 1s delay between jobs
- Auto-unloads Ollama model after LLM work to free VRAM

### Image Generation

**ComfyUI Integration** (`server/src/services/comfyui.ts`, `image-generation.ts`):
- Queue-based generation with progress tracking via SSE
- Generation state tracked in-memory with clientId for SSE subscriptions
- Links ComfyUI promptId to internal generationId for progress correlation
- Stored in `~/.quje-agent/images/{uuid}/` with metadata JSON

**Autonomous Generation** (`server/src/services/autonomous-generation.ts`):
- Executes creative directions automatically during synthesis cycle
- **Dimension analysis**: Detects portrait/landscape/square from prompt keywords (person, landscape, vehicle, etc.)
- **GPU coordination**: Unloads Ollama model (keep_alive: "0s") before ComfyUI execution to avoid VRAM contention
- **Config**: CFG scale, steps, model override via `creativeDirections` settings
- Tracks `generatedBy: 'agent'` and `directionId` on GeneratedImage metadata

**UI**: `ImageSandbox`, `ImageGallery`, `GeneratedImagePanel`, `CorpusView`

### Vision Analysis

- Image description and analysis with pluggable presets
- Conversation about analyzed images
- Stored in `~/.quje-agent/vision/`
- UI: `VisionGallery`, `VisionChat`, `VisionControls`

### TTS (Text-to-Speech)

- Kokoro TTS integration (ported from GreenGale codebase)
- Voice selection, speed, pitch controls
- Auto-read toggle for assistant messages
- Playback state in control bar

### User Images

- Upload and attach images to chats
- Vision model analysis
- Thumbnails and full-resolution serving
- Stored in `~/.quje-agent/user-images/`

### Skills

- Pluggable skill definitions
- Activated per chat
- UI: `SkillSelector`

### Persona

- Dynamic persona synthesis from memories
- Daily persona updates
- Persona-aware responses

### Authentication

- Passkey-based auth (WebAuthn)
- Session management via express-session
- Protected `/api/*` routes
- Login page for initial setup

### Message Queueing

- Offline message queueing
- Retry on reconnect
- Queue state persistence

## Streaming & Reasoning

- Server-Sent Events for real-time token streaming
- Collapsible thinking blocks for reasoning-capable models (Qwen3+)
- Token usage indicator with context window progress bar

## Other

- Per-chat model selector and system prompt editor
- Glassmorphism UI with Tailwind CSS v4
- Markdown rendering with GFM support
- SQLite + sqlite-vec for memory storage with SIMD-accelerated vector search; JSON files for chat persistence

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Ollama](https://ollama.ai/) running locally on port 11434
- A chat model pulled in Ollama (e.g. `ollama pull qwen3:8b`)
- The embedding model for memory: `ollama pull qwen3-embedding:0.6b`
- **Creative Engine**: `ollama pull qwen3.5:9b` (recommended for direction generation with vision context)
- (Optional) ComfyUI for image generation
- (Optional) Kokoro TTS voices

## Setup

```bash
git clone <repo-url> quje-agent
cd quje-agent
npm install
```

## Development

Run the server and client in separate terminals:

```bash
# Terminal 1 — backend (port 3001)
cd server
npm run dev

# Terminal 2 — frontend (port 5173)
cd client
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` requests to the backend.

## Production

Build and run:

```bash
cd server && npm run build
cd ../client && npm run build
cd ../server && npm start
```

The compiled server serves on port 3001. Serve the client build (`client/dist/`) with any static file server, or set up a reverse proxy.

### systemd Service

To run the server on boot, create `~/.config/systemd/user/quje-agent.service`:

```ini
[Unit]
Description=qu.je Agent Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/quje-agent/server
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now quje-agent
loginctl enable-linger $USER   # start without login
```

## Project Structure

```
quje-agent/
├── server/src/
│   ├── index.ts                     # Express app, route mounting, scheduler start
│   ├── types.ts                     # Shared TypeScript interfaces
│   ├── routes/
│   │   ├── chat.ts                  # POST /api/chat — SSE streaming + tool loop
│   │   ├── chats.ts                 # Chat CRUD
│   │   ├── projects.ts              # Project CRUD + AGENTS.md injection
│   │   ├── memory.ts                # Memory CRUD + search + synthesis + conversation search
│   │   ├── models.ts                # Ollama model discovery
│   │   ├── settings.ts              # User preferences
│   │   ├── tts.ts                   # TTS settings + voice info
│   │   ├── vision.ts                # Vision analysis endpoints
│   │   ├── images.ts                # ComfyUI image generation
│   │   ├── user-images.ts           # User image upload + serving
│   │   ├── artifacts.ts             # Artifact serving
│   │   ├── skills.ts                # Skill definitions
│   │   ├── persona.ts               # Persona endpoints
│   │   └── auth.ts                  # Passkey auth
│   └── services/
│       ├── agent.ts                 # pi-ai streaming wrapper
│       ├── agent-tools.ts           # Tool registry + execution
│       ├── chat-storage.ts          # SQLite storage for chats/projects/settings + FTS5
│       ├── embeddings.ts            # Ollama embedding API wrapper
│       ├── memory-storage.ts        # Memory SQLite + sqlite-vec persistence + KNN search
│       ├── memory-extraction.ts     # Immediate + delayed extraction + supersession tracking
│       ├── memory-context.ts        # System prompt augmentation with memories
│       ├── memory-tools.ts          # Agent tool definitions, parsing, execution
│       ├── synthesis.ts             # Daily memory consolidation
│       ├── scheduler.ts             # Synthesis check + delayed extraction + creative cycle
│       ├── compaction.ts            # Message compaction when near context limit
│       ├── tts.ts                   # Kokoro TTS integration
│       ├── comfyui.ts               # ComfyUI API client
│       ├── image-generation.ts      # Generation state tracking + ComfyUI integration
│       ├── image-storage.ts         # Generated image persistence + metadata
│       ├── image-corpus.ts          # SQLite corpus + FTS5 + vector search + hybrid RRF
│       ├── image-tools.ts           # Image analysis + element extraction
│       ├── cluster-engine.ts        # Density-based clustering with cosine similarity
│       ├── cluster-storage.ts       # Cluster persistence + centroid/element computation
│       ├── creative-engine.ts       # Direction generation (remix/gap-fill/deepen/contrast)
│       ├── direction-cache.ts       # 24h direction cache with corpus invalidation
│       ├── job-queue.ts             # Async direction generation job queue
│       ├── autonomous-generation.ts # Execute creative directions with GPU coordination
│       ├── visualization.ts         # D3 force-directed graph HTML generation
│       ├── vision-analysis.ts       # Vision model analysis
│       ├── user-image-storage.ts    # User image upload + thumb generation
│       ├── artifact-storage.ts      # Artifact HTML file management
│       ├── skills.ts                # Skill definitions + activation
│       ├── persona-store.ts         # Persona synthesis + storage
│       ├── auth-storage.ts          # Passkey credential storage
│       ├── title-generation.ts      # LLM-generated chat titles
│       ├── sandbox.ts               # Python code execution sandbox
│       └── models.ts                # Ollama model config + reasoning detection
├── client/src/
│   ├── types.ts                     # Shared interfaces (client copy)
│   ├── api/client.ts                # Fetch API client + SSE parser
│   ├── hooks/                       # React hooks (useChat, useChats, useProjects, useModels, useSettings, useTTS, etc.)
│   ├── components/                  # React components (Sidebar, ChatView, MessageBubble, ArtifactPanel, ImageSandbox, VisionGallery, etc.)
│   ├── styles/                      # Tailwind styles
│   ├── lib/                         # IndexedDB cache, utils
│   └── utils/                       # Helper functions
└── package.json                     # npm workspaces root
```

## Data Storage

All data is stored in `~/.quje-agent/`:

```
~/.quje-agent/
├── app.db              # SQLite database (chats, projects, settings, pending states, chat_messages FTS5)
├── chats/              # Legacy JSON files (migrated to app.db on startup)
├── projects/           # Legacy JSON files (migrated to app.db on startup)
├── artifacts/          # One folder per artifact (contains index.html + assets)
├── images/             # Generated images from ComfyUI ({uuid}/image.jxl + metadata.json)
├── user-images/        # Uploaded user images (originals + thumbnails)
├── vision/             # Analyzed images
├── pending/            # Legacy JSON files (migrated to app.db on startup)
├── settings.json       # Legacy JSON file (migrated to app.db on startup)
├── clusters/           # Cluster data (clusters.json with centroids, dominant elements)
├── directions/         # Creative direction cache (cache.json)
├── image-corpus/       # Image corpus SQLite database
│   ├── corpus.db       # SQLite: corpus_entries + vec_corpus (sqlite-vec) + fts_corpus (FTS5)
│   └── corpus.json.bak # Legacy JSON (migrated on first startup)
└── memory/
    ├── memories.db     # SQLite database (memories + vector embeddings via sqlite-vec)
    └── daily/          # Daily synthesis logs (YYYY-MM-DD.md)
```

**SQLite schemas:**
- `chats` — chat metadata with JSON `messages` column, delayed extraction tracking (`lastDelayedExtractionAt`, `lastDelayedExtractionMessageIndex`)
- `chat_messages` — denormalized message table for FTS5 (chat_id, message_index, role, content, timestamp)
- `chat_messages_fts` — FTS5 virtual table with automatic triggers for full-text search
- `projects` — project metadata
- `settings` — key-value settings (single 'settings' key)
- `pending_states` — ask_user tool loop state for resume after server restart
- `corpus_entries` — image corpus metadata (type, imagePath, prompt, description, elements JSON, chat/project/direction IDs)
- `vec_corpus` — sqlite-vec virtual table (id, embedding float[1024] with cosine distance)
- `fts_corpus` — FTS5 virtual table (id, prompt, description) with auto-sync triggers

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List available Ollama models |
| GET | `/api/chats` | List all chats |
| POST | `/api/chats` | Create chat (`{ modelId, type: "agent"\|"quick", projectId? }`) |
| PATCH | `/api/chats/:id` | Update chat metadata |
| DELETE | `/api/chats/:id` | Delete a chat |
| GET | `/api/chats/:id` | Get single chat with messages |
| POST | `/api/chat` | Send message (SSE stream) |
| POST | `/api/chat/enqueue` | Queue message for later delivery |
| POST | `/api/chat/edit` | Edit and resend a message |
| GET | `/api/memory` | List memories (without embeddings) |
| POST | `/api/memory` | Create memory |
| POST | `/api/memory/search` | Semantic search (`{ query, topK? }`) |
| GET | `/api/memory/status` | Embedding model status + memory count + extraction metrics |
| GET | `/api/memory/synthesis/status` | Last synthesis timestamp + memory count |
| POST | `/api/memory/synthesis/run` | Manually trigger synthesis |
| POST | `/api/memory/conversations/search` | Conversation search (`{ query, chatId?, limit? }`) — FTS5 on chat history |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project (`{ name, path }`) |
| PATCH | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project (orphans chats) |
| GET | `/api/projects/:id/agents-md` | Get project's AGENTS.md content |
| GET | `/api/tts` | Get TTS settings |
| PUT | `/api/tts` | Update TTS settings |
| GET | `/api/tts/voices` | List available voices |
| GET | `/api/vision` | List analyzed images |
| POST | `/api/vision/analyze` | Analyze an image |
| POST | `/api/vision/save` | Save analyzed image |
| POST | `/api/vision/images/:id/chat` | Chat about analyzed image |
| GET | `/api/images` | List generated images |
| POST | `/api/images/generate` | Generate image via ComfyUI |
| DELETE | `/api/images/:id` | Delete generated image |
| GET | `/api/images/status` | ComfyUI status |
| GET | `/api/user-images` | List uploaded images |
| POST | `/api/user-images` | Upload image |
| DELETE | `/api/user-images/:id` | Delete uploaded image |
| GET | `/api/artifacts/:id` | Serve artifact HTML |
| GET | `/api/artifacts/:id/*` | Serve artifact assets |
| GET | `/api/skills` | List available skills |
| GET | `/api/persona` | Get current persona |
| GET | `/api/corpus/clusters` | Get all clusters |
| GET | `/api/corpus/clusters/:id` | Get single cluster with members |
| POST | `/api/corpus/rebuild-clusters` | Rebuild clusters from current corpus |
| GET | `/api/corpus/visualization` | Get D3 force-directed graph HTML |
| GET | `/api/corpus/stats` | Get corpus statistics (auth required) |
| GET | `/api/corpus/stats-public` | Get corpus statistics (public) |
| GET | `/api/corpus/directions` | Get creative directions (with caching) |
| POST | `/api/corpus/directions/generate` | Queue direction generation job |
| GET | `/api/corpus/directions/job/:id` | Get job status |
| GET | `/api/corpus/gaps` | Analyze underrepresented themes |
| POST | `/api/corpus/remix` | Generate remix from specific clusters |
| POST | `/api/corpus/execute` | Execute creative direction (generate image) |
| GET | `/api/corpus/cache` | Get cache metadata (debugging) |
| POST | `/api/corpus/cache/clear` | Clear direction cache |
| POST | `/api/auth/register` | Register passkey |
| POST | `/api/auth/login` | Login with passkey |
| POST | `/api/auth/logout` | Logout |

## Key Patterns

- **Streaming**: SSE with event types `text_delta`, `thinking_delta`, `tool_status`, `artifact`, `ask_user`, `done`, `error`, `iteration`, `warning`, `compaction`, `title_update`, `message_complete`, `follow_up_start`
- **Types**: Shared interfaces in `server/src/types.ts` and `client/src/types.ts` (kept in sync manually)
- **Storage**: SQLite for chats/projects/settings/pending (`chat-storage.ts` → `~/.quje-agent/app.db`), SQLite + sqlite-vec for memories (`memory-storage.ts` → `~/.quje-agent/memory/memories.db`), SQLite + sqlite-vec for image corpus (`image-corpus.ts` → `~/.quje-agent/image-corpus/corpus.db`), notebooks via `notebook-storage.ts` → `~/.quje-agent/notebooks/`. All use `~/.quje-agent/` as the base directory.
- **Context window**: Fetched per-model from Ollama `/api/show` (`model_info.*.context_length`). Per-chat override via `chat.contextWindow`; effective value is `chat.contextWindow ?? model.contextWindow`.
- **Embeddings**: Ollama `qwen3-embedding:0.6b` via `POST http://localhost:11434/api/embed` (supports 32k context). Vectors are L2-normalized, so cosine similarity = dot product.
- **Memory scoring**: `rrf_score * recency_decay * (importance / 10)` with RRF combining vector search and FTS5 full-text search rankings; 30-day half-life on recency.
- **Memory dedup**: cosine > 0.85 between a new fact and existing memory triggers UPDATE instead of ADD. Uses sqlite-vec KNN MATCH for nearest-neighbor lookup.
- **Supersession tracking**: memories can be linked via `superseded_by` / `supersedes` columns when contradicted or updated. Confidence threshold (default 0.75) determines automatic linking; manual override via API.
- **Delayed extraction**: time-based trigger (configurable, default 30 min) extracts memories from inactive chats. Uses `updateChatExtractionState()` to avoid modifying `lastModified` (preserves chat ordering).
- **Project scoping**: memories have optional `projectId`; synthesis groups chats and memories by project, loading each project's AGENTS.md for context.
- **GPU coordination**: Ollama LLM and ComfyUI cannot run concurrently on single GPU. Scheduler unloads Ollama model (`keep_alive: "0s"`) with 3s pause before ComfyUI execution. Direction generation jobs also unload after LLM work.
- **Creative direction caching**: 24h TTL, invalidates on corpus size change (>10%) or cluster count change. Prevents redundant LLM calls on page refresh.
- **Job queue**: Async direction generation avoids blocking UI; jobs processed sequentially with 1s delay between runs.
- **Novelty scoring**: `1.0 - avgTop5Similarity` against corpus embeddings; default threshold 0.15 (more permissive than original 0.6).
- **Clustering**: Density-based with 0.85 cosine similarity threshold; O(n²) pairwise matrix acceptable for n<500 images.
- **Backward compat**: `getChat()` and `listChats()` default missing `type` to "quick". Memory DB auto-migrates `project_id` column. Chat/project/settings JSON files auto-migrate to SQLite on startup. Corpus JSON auto-migrates to SQLite on first startup.

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue; projects use emerald
- No external state management — React hooks + API calls
- Lazy loading for heavy components (ImageSandbox, MarkdownRenderer, RippleGridBackground)

## Important Notes

- The `memory.ts` routes must define `/status`, `/synthesis/*`, and `/search` **before** the `/:id` param routes to avoid Express matching those paths as IDs.
- `streamChat` from `agent.ts` is reused by extraction, synthesis, and tool execution — it's the single LLM call interface.
- The scheduler (`scheduler.ts`) runs a synthesis check on startup and then every 15 minutes via `setInterval`. Delayed extraction checks run every 5 minutes.
- **Creative cycle**: After successful synthesis, scheduler runs `runCorpusCreativeCycle()` — rebuilds clusters, generates directions, saves as memories, executes top directions. GPU coordination unloads Ollama before ComfyUI.
- **Direction cache**: Cached in `~/.quje-agent/directions/cache.json` with 24h TTL. Invalidates on corpus size change (>10%) or cluster count change. API returns cached results immediately while queuing background refresh.
- **Job queue**: Direction generation jobs are queued and processed sequentially to avoid GPU contention. Client polls `/api/corpus/directions/job/:id` for completion.
- **Cluster persistence**: Clusters saved to JSON (`~/.quje-agent/clusters/clusters.json`), not SQLite. Rebuilt on demand via `/api/corpus/rebuild-clusters`.
- **Corpus migration**: On first startup, `corpus.json` auto-migrates to `corpus.db` with FTS5 + sqlite-vec indexes. Original renamed to `corpus.json.bak`.
- When editing types, update both `server/src/types.ts` and `client/src/types.ts`.
- The server may run compiled `dist/index.js` (via `npm start` / systemd) rather than tsx dev mode — source changes require `npm run build` + restart to take effect.
- Blob URLs for artifacts are critical for Chrome animation performance — do not use cross-origin iframe src.
