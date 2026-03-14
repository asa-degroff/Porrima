# AGENTS.md

## Project

**qu.je Agent** — A local Ollama chat UI with persistent memory, project context, and agentic tool execution. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

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

## Tool System (Agent Chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

### Registry (`server/src/services/agent-tools.ts`)

- `getAgentTools()` returns all tools; `executeTool(toolCall, chatId, onEvent?)` dispatches by name.
- **Memory tools** (from `memory-tools.ts`): `save_memory`, `search_memory`, `forget_memory`
- **Filesystem tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `bash`
- **Sandbox tools**: `run_python`, `create_artifact`
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `~/.quje-agent/pending/{chatId}.json`, resumes on next user message)

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

- **Automatic extraction**: after each agent response, a background LLM call extracts facts (preferences, personal details, behaviors, instructions) and deduplicates them against existing memories using cosine similarity.
- **Context augmentation**: relevant memories are retrieved via semantic search and injected into the system prompt so the agent naturally references what it knows.
- **Agent tools**: the agent can explicitly save, search, and forget memories when asked.
- **Daily synthesis**: a scheduler merges near-duplicate memories, applies importance decay, and generates a daily summary log.
- **Pre-compaction flush**: when a conversation approaches the context window limit (>75% usage), all important facts are extracted and preserved before truncation.

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

### Image Generation

- Uses ComfyUI (local diffusion via `server/src/services/comfyui.ts`)
- Queue-based generation with progress tracking
- Stored in `~/.quje-agent/images/`
- UI: `ImageSandbox`, `ImageGallery`, `GeneratedImagePanel`

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
│   │   ├── memory.ts                # Memory CRUD + search + synthesis trigger
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
│       ├── project-storage.ts       # Project JSON persistence
│       ├── storage.ts               # Chat JSON persistence
│       ├── embeddings.ts            # Ollama embedding API wrapper
│       ├── memory-storage.ts        # Memory SQLite + sqlite-vec persistence + KNN search
│       ├── memory-extraction.ts     # Background fact extraction + pre-compaction flush
│       ├── memory-context.ts        # System prompt augmentation with memories
│       ├── memory-tools.ts          # Agent tool definitions, parsing, execution
│       ├── synthesis.ts             # Daily memory consolidation
│       ├── scheduler.ts             # Hourly synthesis check + startup catch-up
│       ├── compaction.ts            # Message compaction when near context limit
│       ├── tts.ts                   # Kokoro TTS integration
│       ├── comfyui.ts               # ComfyUI API client
│       ├── image-generation.ts      # Diffusion image generation
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
├── chats/              # One JSON file per chat
├── projects/           # One JSON file per project
├── artifacts/          # One folder per artifact (contains index.html + assets)
├── images/             # Generated images from ComfyUI
├── user-images/        # Uploaded user images (originals + thumbnails)
├── vision/             # Analyzed images
├── pending/            # Pending tool loop state (for ask_user)
├── settings.json       # User preferences
└── memory/
    ├── memories.db     # SQLite database (memories + vector embeddings via sqlite-vec)
    └── daily/          # Daily synthesis logs (YYYY-MM-DD.md)
```

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
| GET | `/api/memory/status` | Embedding model status + memory count |
| POST | `/api/memory/synthesis/run` | Manually trigger synthesis |
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
| POST | `/api/auth/register` | Register passkey |
| POST | `/api/auth/login` | Login with passkey |
| POST | `/api/auth/logout` | Logout |

## Key Patterns

- **Streaming**: SSE with event types `text_delta`, `thinking_delta`, `tool_status`, `artifact`, `ask_user`, `done`, `error`, `iteration`, `warning`, `compaction`, `title_update`, `message_complete`, `follow_up_start`
- **Types**: Shared interfaces in `server/src/types.ts` and `client/src/types.ts` (kept in sync manually)
- **Storage**: Chat/project persistence uses JSON files (`storage.ts`, `project-storage.ts`), memory persistence uses SQLite + sqlite-vec (`memory-storage.ts` → `~/.quje-agent/memory/memories.db`). Both use `~/.quje-agent/` as the base directory.
- **Context window**: Fetched per-model from Ollama `/api/show` (`model_info.*.context_length`). Per-chat override via `chat.contextWindow`; effective value is `chat.contextWindow ?? model.contextWindow`.
- **Embeddings**: Ollama `qwen3-embedding:0.6b` via `POST http://localhost:11434/api/embed`. Vectors are L2-normalized, so cosine similarity = dot product.
- **Memory scoring**: `cosine_sim * recency_decay * (importance / 10)` with a 30-day half-life on recency.
- **Memory dedup**: cosine > 0.85 between a new fact and existing memory triggers UPDATE instead of ADD. Uses sqlite-vec KNN MATCH for nearest-neighbor lookup.
- **Backward compat**: `getChat()` and `listChats()` default missing `type` to "quick".

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue; projects use emerald
- No external state management — React hooks + API calls
- Lazy loading for heavy components (ImageSandbox, MarkdownRenderer, RippleGridBackground)

## Important Notes

- The `memory.ts` routes must define `/status`, `/synthesis/*`, and `/search` **before** the `/:id` param routes to avoid Express matching those paths as IDs.
- `streamChat` from `agent.ts` is reused by extraction, synthesis, and tool execution — it's the single LLM call interface.
- The scheduler (`scheduler.ts`) runs a synthesis check on startup and then hourly via `setInterval`.
- When editing types, update both `server/src/types.ts` and `client/src/types.ts`.
- The server may run compiled `dist/index.js` (via `npm start` / systemd) rather than tsx dev mode — source changes require `npm run build` + restart to take effect.
- Blob URLs for artifacts are critical for Chrome animation performance — do not use cross-origin iframe src.
