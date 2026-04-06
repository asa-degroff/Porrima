# AGENTS.md

## Project

**qu.je Agent** — A feature-rich agent framework and user interface with persistent memory, project context, image generation, social media integration, and agentic tool execution. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick Reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.quje-agent/` (chats, projects, settings, memories, artifacts)
- **Models dir**: `~/.local/share/llama-models/` (symlinked GGUFs for llama.cpp router)
- **systemd services**:
  - `quje-agent.service` — main server (auto-starts on boot)
  - `llama-server.service` — llama.cpp router (port 8080, GPU inference)
  - `reranker.service` — Qwen3-Reranker-0.6B (port 8082, CPU-only, memory retrieval)
  - `sync-llama-models.timer` — auto-syncs HuggingFace GGUF downloads every 5 min

## Architecture

See [docs/architecture.md](docs/architecture.md) for full details.

Three chat types: **agent** (memory-augmented), **quick** (standalone), **bluesky** (social). The chat route (`server/src/routes/chat.ts`) orchestrates memory augmentation, LLM streaming via pi-ai, tool execution, and memory extraction. Chat storage is SQLite with FTS5 full-text search. Multi-provider LLM system supports Ollama native and OpenAI-compatible (llama.cpp) backends.

## Tool System

See [docs/tool-system.md](docs/tool-system.md) for full details.

Native pi-ai tool calling with TypeBox schemas. Registry in `agent-tools.ts` with memory, filesystem, sandbox, and Bluesky tools. Tool loop (max 20 iterations) in `chat.ts`. `ask_user` pauses the loop and persists state. Message reconstruction splits persisted messages back into the pi-ai multi-message format.

## Memory System

See [docs/memory-system.md](docs/memory-system.md) for full details.

8 memory categories (preference, fact, behavior, instruction, context, decision, note, reflection). Immediate + delayed extraction via LLM. Hybrid retrieval: vector search + FTS5 with RRF fusion, then cross-encoder reranking via Qwen3-Reranker-0.6B with chat-type-specific instructions. Cosine >0.85 dedup. Daily synthesis generates reflections and notebook entries. Pre-compaction flush preserves facts before context truncation. Indexed compaction archives full-fidelity messages in `context_archives` table with cross-chat FTS search. Key files: `memory-storage.ts`, `memory-extraction.ts`, `memory-context.ts`, `reranker.ts`, `synthesis.ts`.

## Artifacts & Image Systems

See [docs/artifacts-and-images.md](docs/artifacts-and-images.md) for full details.

- **Artifacts**: `create_artifact` tool writes HTML to `~/.quje-agent/artifacts/`. Blob URLs for iframe src (critical for Chrome animation performance).
- **Image Corpus**: SQLite + sqlite-vec + FTS5. Hybrid search via RRF. Density-based clustering (0.85 threshold).
- **Creative Engine**: 5 direction types (gap-fill, remix, deepen, contrast, explore). 24h direction cache. Async job queue.
- **Image Generation**: ComfyUI integration with autonomous generation during synthesis. GPU coordination via `waitForFreeVRAM` — checks ComfyUI's `/system_stats` VRAM, unloads all LLM models (Ollama + llama.cpp) if needed.
- **Vision**: Pluggable analysis presets with conversation support.

## Integrations & Features

See [docs/integrations.md](docs/integrations.md) for full details.

- **Notebooks**: Dual user/agent notebook with linking and attachments. Synthesis integration.
- **Bluesky**: AT Protocol with encrypted sessions, notification polling, auto-respond, thread splitting.
- **TTS**: Kokoro + Qwen3-TTS backends. Generator-based streaming with 3-tier boundary detection.
- **User Images**: Upload, thumbnails, vision analysis. Stored in `~/.quje-agent/user-images/`.
- **Skills**: Pluggable definitions, per-chat activation, URL installation.
- **Persona**: Dynamic synthesis from memories, daily updates.
- **Auth**: Passkey-based (WebAuthn) with express-session.
- **Message Queueing**: Offline queue with per-chat persistence and retry.

## UI Patterns

See [docs/ui-patterns.md](docs/ui-patterns.md) for full details.

SSE streaming with thinking blocks, token usage indicator, compaction indicator. Mobile: gesture drawer, keyboard inset, haptic feedback. Conversation search via FTS5. Tailwind v4 glassmorphism. Purple for agent, blue for quick, sky for bluesky, emerald for projects.

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
│   │   ├── models.ts                # Model discovery (Ollama + llama.cpp)
│   │   ├── settings.ts              # User preferences
│   │   ├── tts.ts                   # TTS settings + voice info
│   │   ├── vision.ts                # Vision analysis endpoints
│   │   ├── images.ts                # ComfyUI image generation
│   │   ├── user-images.ts           # User image upload + serving
│   │   ├── artifacts.ts             # Artifact serving
│   │   ├── skills.ts                # Skill definitions
│   │   ├── persona.ts               # Persona endpoints
│   │   ├── auth.ts                  # Passkey auth
│   │   ├── bluesky.ts               # Bluesky login/logout
│   │   ├── corpus.ts                # Corpus clusters, directions, creative engine
│   │   ├── image-corpus.ts          # Corpus entry CRUD + search + enrichment
│   │   ├── notebooks.ts             # Notebook entry CRUD (user/agent)
│   │   ├── ui-state.ts              # UI state persistence
│   │   ├── user.ts                  # User profile document
│   │   └── visuals.ts               # Visual artifact serving
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
│       ├── compaction.ts            # Message compaction + indexed archival
│       ├── reranker.ts              # Qwen3-Reranker client for memory retrieval
│       ├── ollama-native-provider.ts # Ollama native API provider for pi-ai
│       ├── openai-compat-provider.ts # OpenAI-compatible API provider (llama.cpp)
│       ├── models.ts                # Model discovery, provider dispatch, reasoning detection
│       ├── tts.ts                   # Kokoro TTS integration
│       ├── tts-qwen3.ts             # Qwen3-TTS backend with caching
│       ├── tts-streaming.ts         # Generator-based streaming TTS
│       ├── tts-buffer.ts            # 3-tier boundary detection for streaming chunks
│       ├── tts-text-preprocessor.ts # Markdown-to-speech text extraction
│       ├── comfyui.ts               # ComfyUI API client
│       ├── image-generation.ts      # Generation state tracking + ComfyUI integration
│       ├── image-storage.ts         # Generated image persistence + metadata
│       ├── image-corpus.ts          # SQLite corpus + FTS5 + vector search + hybrid RRF
│       ├── image-tools.ts           # Image analysis + element extraction
│       ├── element-extraction.ts    # Structured extraction into 10 visual categories
│       ├── generate-review.ts       # Multi-iteration image gen with agent review loop
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
│       ├── bluesky-agent.ts         # AT Protocol agent with session encryption
│       ├── bluesky-poller.ts        # Notification polling with auto-respond
│       ├── bluesky-tools.ts         # Agent tool definitions for Bluesky
│       ├── notebook-storage.ts      # Dual notebook system (user/agent entries)
│       ├── project-storage.ts       # Filesystem utility for reading AGENTS.md
│       ├── user-store.ts            # User profile markdown file management
│       └── message-queue.ts         # Offline message queue with per-chat persistence
├── client/src/
│   ├── types.ts                     # Shared interfaces (client copy)
│   ├── api/client.ts                # Fetch API client + SSE parser
│   ├── hooks/                       # React hooks (useChat, useChats, useProjects, useModels, useSettings, useTTS, useBluesky, useNotebooks, useStreamingTTS, useGestureDrawer, useHaptics, useOnlineStatus, etc.)
│   ├── components/                  # React components (Sidebar, ChatView, MessageBubble, ArtifactPanel, ImageSandbox, VisionGallery, BlueskySection, NotebookView, ConversationSearch, SidebarSearch, CompactionIndicator, OfflineIndicator, TokenIndicator, SkillsBrowser, etc.)
│   ├── styles/                      # Tailwind styles
│   ├── lib/                         # IndexedDB cache, utils
│   └── utils/                       # Helper functions
├── docs/                            # Detailed documentation (see links in sections above)
└── package.json                     # npm workspaces root
```

## Further Documentation

- [API Reference](docs/api-reference.md) — Full endpoint table
- [Data Storage](docs/data-storage.md) — Directory layout and SQLite schemas
- [Key Patterns](docs/key-patterns.md) — Cross-cutting patterns and important notes
- [Setup & Deployment](docs/setup.md) — Prerequisites, development, production, systemd
