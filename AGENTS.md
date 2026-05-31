# AGENTS.md

## Project

**Porrima** — A feature-rich agent framework and user interface with persistent memory, project context, image generation, and agentic tool execution. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick Reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.porrima/` (chats, projects, settings, memories, artifacts)
- **Models dir**: `~/.local/share/llama-models/` (symlinked GGUFs for llama.cpp router)
- **systemd services**:
  - `porrima.service` — main server (auto-starts on boot)
  - `llama-server.service` — llama.cpp router (port 32100, GPU inference)
  - `extraction-model.service` — memory extraction server (port 32101, CPU-only)
  - `reranker.service` — Qwen3-Reranker-0.6B (port 32102, CPU-only, memory retrieval)
  - `embedding-model.service` — embedding server (port 32103, CPU-only)
  - `title-generation.service` — title/recap server (port 32104, CPU-only)
  - `sync-llama-models.timer` — auto-syncs HuggingFace GGUF downloads every 5 min

## Architecture

See [docs/architecture.md](docs/architecture.md) for full details.

Three chat types: **agent** (memory-augmented), **quick** (standalone), and **system** (synthesis, wake cycles, and automations). The chat route (`server/src/routes/chat.ts`) owns memory augmentation, SSE/persistence, compaction, and extraction around the shared agent loop in `agent-loop-runner.ts`. Chat storage is SQLite with FTS5 full-text search. LLM system uses OpenAI-compatible (llama.cpp) backend for all inference.

## Tool System

See [docs/tool-system.md](docs/tool-system.md) for full details.

Native pi-ai tool calling with TypeBox schemas. Registry in `agent-tools.ts` with memory, filesystem, and sandbox tools. The low-level loop lives in `agent-loop-runner.ts`; the HTTP chat route and headless automation runner provide their own callbacks for transport, persistence, compaction, and follow-up prompts. `ask_user` pauses the HTTP loop and persists state. Message reconstruction splits persisted messages back into the pi-ai multi-message format.

## Memory System

See [docs/memory-system.md](docs/memory-system.md) for full details.

Two complementary memory systems: **atomic memories** (8 categories: preference, fact, behavior, instruction, context, decision, note, reflection) and **memory blocks** (structured, editable knowledge documents). Atomic memories are extracted automatically via LLM; blocks are agent-curated documents that organize knowledge by topic/project/domain.

Hybrid retrieval: vector search + FTS5 with RRF fusion, then cross-encoder reranking via Qwen3-Reranker-0.6B with chat-type-specific instructions. Memory blocks loaded by scope (global/project) with progressive disclosure — descriptions always in context, full content via `read_memory_block` tool. Extraction pipeline sees loaded blocks to prevent redundant extraction.

Indexed compaction archives full-fidelity messages in `context_archives` table with cross-chat FTS search. KV cache optimization uses delta-based memory injection — frozen memories in system prompt, new memories appended as delta messages to preserve longest-common-prefix caching. Key files: `memory-storage.ts`, `memory-extraction.ts`, `memory-context.ts`, `memory-tools.ts`, `reranker.ts`, `system-chat.ts`, `automation-storage.ts`, `automation-scheduler.ts`, `automation-runner.ts`, `chat-turn-runner.ts`, `agent-loop-runner.ts`, `llm-stream.ts`.

## Automations

See [docs/automations.md](docs/automations.md) for full details.

Automations are configurable recurring system-chat tasks. Built-ins cover synthesis and wake cycles; custom tasks support interval or daily schedules, order, activation policy, editable prompt steps, run history, and optional push notifications. Startup calls `ensureAutomationDefaults()` once, then `automation-scheduler.ts` checks due tasks every 5 minutes. Prompt text stays in user-role trigger/follow-up messages so the stable system-chat prefix remains KV-cache friendly.

See also: [docs/memory-blocks.md](docs/memory-blocks.md) for the block system details.

## Artifacts & Image Systems

See [docs/artifacts-and-images.md](docs/artifacts-and-images.md) for full details.

- **Artifacts**: `create_artifact` tool writes HTML to `~/.porrima/artifacts/`. Blob URLs for iframe src (critical for Chrome animation performance).
- **Image Corpus**: SQLite + sqlite-vec + FTS5. Hybrid search via RRF. Density-based clustering (0.85 threshold).
- **Corpus/Clustering**: SQLite corpus storage, enrichment, FTS/vector search, density-based clustering, and D3 visualization.
- **Image Generation**: ComfyUI integration with GPU/resource coordination for agent/tool-initiated image work.
- **Vision**: Pluggable analysis presets with conversation support.

## Integrations & Features

See [docs/integrations.md](docs/integrations.md) for full details.

- **Notebooks**: Dual user/agent notebook with linking and attachments. Synthesis integration. Agent entries are dual-represented as filesystem JSON (for UI) and memory blocks (for searchability).
- **TTS**: Kokoro + Qwen3-TTS backends. Generator-based streaming with 3-tier boundary detection.
- **User Images**: Upload, thumbnails, vision analysis. Stored in `~/.porrima/user-images/`.
- **Skills**: Pluggable definitions, per-chat activation, URL installation.
- **Persona**: Dynamic synthesis from memories, daily updates.
- **Auth**: Passkey-based (WebAuthn) with express-session.
- **Message Queueing**: Offline queue with per-chat persistence and retry.

## UI Patterns

See [docs/ui-patterns.md](docs/ui-patterns.md) for full details.

SSE streaming with thinking blocks, token usage indicator, compaction indicator. Mobile: gesture drawer, keyboard inset, haptic feedback. Conversation search via FTS5. Tailwind v4 glassmorphism. Purple for agent, blue for quick, emerald for projects.

## Project Structure

```
porrima/
├── server/src/
│   ├── index.ts                     # Express app, route mounting, scheduler start
│   ├── types.ts                     # Shared TypeScript interfaces
│   ├── routes/
│   │   ├── chat.ts                  # POST /api/chat — SSE streaming + tool loop
│   │   ├── chats.ts                 # Chat CRUD
│   │   ├── projects.ts              # Project CRUD + AGENTS.md injection
│   │   ├── memory.ts                # Memory CRUD + search + synthesis + conversation search
│   │   ├── automations.ts           # Automation CRUD + manual run + run history
│   │   ├── models.ts                # Model discovery (llama.cpp)
│   │   ├── settings.ts              # User preferences
│   │   ├── tts.ts                   # TTS settings + voice info
│   │   ├── vision.ts                # Vision analysis endpoints
│   │   ├── images.ts                # ComfyUI image generation
│   │   ├── user-images.ts           # User image upload + serving
│   │   ├── artifacts.ts             # Artifact serving
│   │   ├── skills.ts                # Skill definitions
│   │   ├── persona.ts               # Persona endpoints
│   │   ├── auth.ts                  # Passkey auth
│   │   ├── corpus.ts                # Corpus clusters, directions, creative engine
│   │   ├── image-corpus.ts          # Corpus entry CRUD + search + enrichment
│   │   ├── notebooks.ts             # Notebook entry CRUD (user/agent)
│   │   ├── ui-state.ts              # UI state persistence
│   │   ├── user.ts                  # User profile document
│   │   └── visuals.ts               # Visual artifact serving
│   └── services/
│       ├── agent.ts                 # One-shot LLM calls + message reconstruction
│       ├── agent-loop-runner.ts     # Shared pi-agent loop driver
│       ├── chat-turn-runner.ts      # Headless system/automation turn adapter
│       ├── llm-stream.ts            # Safe stream wrapper + activity tracking
│       ├── agent-tools.ts           # Tool registry + execution
│       ├── chat-storage.ts          # SQLite storage for chats/projects/settings + FTS5
│       ├── automation-storage.ts    # Automation task/run persistence
│       ├── automation-scheduler.ts  # Configurable recurring task scheduler
│       ├── automation-runner.ts     # Built-in/custom automation execution
│       ├── automation-lock.ts       # Global automation run lock
│       ├── embeddings.ts            # Embedding API wrapper (llama.cpp /v1/embeddings)
│       ├── memory-storage.ts        # Memory + block SQLite + sqlite-vec persistence + KNN search
│       ├── memory-extraction.ts     # Immediate + delayed extraction + supersession tracking
│       ├── memory-context.ts        # System prompt augmentation with memories + blocks + stable prefix caching
│       ├── memory-tools.ts          # Agent tool definitions: memories, blocks, archives, conversation search
│       ├── system-chat.ts           # Synthesis and wake cycles in persistent system chat
│       ├── scheduler.ts             # Automations, delayed extraction, enrichment, pollers
│       ├── compaction.ts            # Message compaction + indexed archival
│       ├── reranker.ts              # Qwen3-Reranker client for memory retrieval
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
│       ├── visualization.ts         # D3 force-directed graph HTML generation
│       ├── vision-analysis.ts       # Vision model analysis
│       ├── user-image-storage.ts    # User image upload + thumb generation
│       ├── skills.ts                # Skill definitions + activation
│       ├── persona-store.ts         # Persona synthesis + storage
│       ├── auth-storage.ts          # Passkey credential storage
│       ├── title-generation.ts      # LLM-generated chat titles
│       ├── sandbox.ts               # Python code execution sandbox
│       ├── notebook-storage.ts      # Dual notebook system (user/agent entries)
│       ├── project-storage.ts       # Filesystem utility for reading AGENTS.md
│       ├── user-store.ts            # User profile markdown file management
│       └── message-queue.ts         # Offline message queue with per-chat persistence
├── client/src/
│   ├── types.ts                     # Shared interfaces (client copy)
│   ├── api/client.ts                # Fetch API client + SSE parser
│   ├── hooks/                       # React hooks (useChat, useChats, useProjects, useModels, useSettings, useTTS, useNotebooks, useStreamingTTS, useGestureDrawer, useHaptics, useOnlineStatus, etc.)
│   ├── components/                  # React components (Sidebar, ChatView, MessageBubble, ArtifactPanel, ImageSandbox, VisionGallery, NotebookView, ConversationSearch, SidebarSearch, CompactionIndicator, OfflineIndicator, TokenIndicator, SkillsBrowser, etc.)
│   ├── styles/                      # Tailwind styles
│   ├── lib/                         # IndexedDB cache, utils
│   └── utils/                       # Helper functions
├── docs/                            # Detailed documentation (see links in sections above)
└── package.json                     # npm workspaces root
```

## Further Documentation

- [API Reference](docs/api-reference.md) — Full endpoint table
- [Automations](docs/automations.md) — Configurable recurring system-chat tasks
- [Data Storage](docs/data-storage.md) — Directory layout and SQLite schemas
- [Key Patterns](docs/key-patterns.md) — Cross-cutting patterns and important notes
- [Memory Blocks](docs/memory-blocks.md) — Structured knowledge document system
- [Setup & Deployment](docs/setup.md) — Prerequisites, development, production, systemd
