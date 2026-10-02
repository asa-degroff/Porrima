# AGENTS.md

## Project

**Porrima** — A feature-rich agent framework and user interface with persistent memory, project context, and agentic tool execution. npm workspaces monorepo: `server/` (Express + TypeScript) and `client/` (React + Vite + Tailwind).

## Quick Reference

- **Server port**: 3001 — `cd server && npm run dev` (tsx watch mode)
- **Client port**: 5173 — `cd client && npm run dev` (Vite, proxies `/api` to server)
- **Build server**: `cd server && npm run build` (outputs to `server/dist/`)
- **Build client**: `cd client && npm run build` (outputs to `client/dist/`)
- **Type check**: `npx tsc --noEmit` from either `server/` or `client/`
- **Data dir**: `~/.porrima/` (chats, projects, settings, memories, artifacts)
- **Models dir**: `~/.local/share/llama-models/` (symlinked GGUFs for llama.cpp router)
- **systemd services**:
  - `porrima.service` — main server. **USER scope** (`~/.config/systemd/user/porrima.service`, drop-in override): manage with `systemctl --user`; system-scope `systemctl` reports "could not be found"
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

Native pi-ai tool calling with TypeBox schemas. Registry in `agent-tools.ts` with memory, filesystem, sandbox, browser, and web tools. The low-level loop lives in `agent-loop-runner.ts`; the HTTP chat route and headless automation runner provide their own callbacks for transport, persistence, compaction, and follow-up prompts. `ask_user` pauses the HTTP loop and persists state. Message reconstruction splits persisted messages back into the pi-ai multi-message format.

Tool surface is split across specialists: `browser-tools.ts` drives a user-attached Chrome over the DevTools Protocol (`chrome.ts`) with a consent handshake (`browser-session.ts`), `web-tools.ts` covers fetch/search, `workspace.ts` provides local and remote-SSH filesystem access, and `sandbox.ts` runs Python. `turn-gate.ts` serializes all turns on **one global slot** (not per chat) with foreground-over-background priority and stale-lease recovery.

## Memory System

See [docs/memory-system.md](docs/memory-system.md) for full details.

Two complementary memory systems: **atomic memories** (8 categories: preference, fact, behavior, instruction, context, decision, note, reflection) and **memory blocks** (structured, editable knowledge documents). Atomic memories are extracted automatically via LLM; blocks are agent-curated documents that organize knowledge by topic/project/domain.

Hybrid retrieval: vector search + FTS5 with RRF fusion, then cross-encoder reranking via Qwen3-Reranker-0.6B with chat-type-specific instructions. Memory blocks loaded by scope (global/project) with progressive disclosure — descriptions always in context, full content via `read_memory_block` tool. Extraction pipeline sees loaded blocks to prevent redundant extraction.

Indexed compaction archives full-fidelity messages in `context_archives` table with cross-chat FTS search. KV cache optimization uses delta-based memory injection — frozen memories in system prompt, new memories appended as delta messages to preserve longest-common-prefix caching. Key files: `memory-storage.ts`, `memory-block-scope.ts`, `memory-extraction.ts`, `memory-context.ts`, `memory-tools.ts`, `reranker.ts`, `system-chat.ts`, `automation-storage.ts`, `automation-scheduler.ts`, `automation-runner.ts`, `chat-turn-runner.ts`, `agent-loop-runner.ts`, `llm-stream.ts`.

## Automations

See [docs/automations.md](docs/automations.md) for full details.

Automations are configurable recurring system-chat tasks. Built-ins cover synthesis and wake cycles; custom tasks support interval or daily schedules, order, activation policy, editable prompt steps, run history, and optional push notifications. Startup calls `ensureAutomationDefaults()` once, then `automation-scheduler.ts` checks due tasks every 5 minutes. Prompt text stays in user-role trigger/follow-up messages so the stable system-chat prefix remains KV-cache friendly.

See also: [docs/memory-blocks.md](docs/memory-blocks.md) for the block system details.

## Artifacts & Images

See [docs/artifacts.md](docs/artifacts.md) for full details.

- **Artifacts**: `create_artifact` tool writes HTML to `~/.porrima/artifacts/`. Blob URLs for iframe src (critical for Chrome animation performance).
- **Chat images**: Porrima ingests images but does not generate or analyze them. Attachments, tool-result figures, and artifact screenshots are stored under `~/.porrima/user-images/` and `~/.porrima/tool-result-images/`. Image generation, vision analysis, and the image corpus moved to a separate app.

## Integrations & Features

See [docs/integrations.md](docs/integrations.md) for full details.

- **Notebooks**: Dual user/agent notebook with linking and attachments. Synthesis integration. Agent entries are dual-represented as filesystem JSON (for UI) and memory blocks (for searchability).
- **TTS**: Kokoro, Qwen3-TTS, and Supertonic-3 backends. Generator-based streaming with 3-tier boundary detection, a Python worker pool, and per-backend retry.
- **User Images**: Upload, thumbnails, vision analysis. Stored in `~/.porrima/user-images/`.
- **Skills**: Pluggable definitions, per-chat activation, URL installation.
- **Persona**: Dynamic synthesis from memories, daily updates.
- **Auth**: Passkey-based (WebAuthn) with express-session.
- **Message Queueing**: Offline queue with per-chat persistence and retry.

## UI Patterns

See [docs/ui-patterns.md](docs/ui-patterns.md) for full details.

SSE streaming with thinking blocks, token usage indicator, compaction indicator. Mobile: gesture drawer, keyboard inset. Conversation search via FTS5. Tailwind v4 glassmorphism. Purple for agent, blue for quick, emerald for projects.

## Project Structure

Only landmark files are named; `*.test.ts` files are omitted throughout.

```
porrima/
├── server/src/
│   ├── index.ts                     # Express app, route mounting, middleware, scheduler start
│   ├── types.ts                     # Shared TypeScript interfaces
│   ├── paths.ts                     # ~/.porrima root + legacy ~/.quje-agent rename migrations
│   ├── middleware/
│   │   ├── auth.ts                  # requireAuth gate for /api/*
│   │   └── compression.ts           # JSON response compression (SSE excluded)
│   ├── routes/
│   │   ├── chat.ts                  # POST /api/chat — SSE streaming, edit, enqueue, stop, reconnect
│   │   ├── chats.ts                 # Chat CRUD + paged message window + context breakdown
│   │   ├── projects.ts              # Project CRUD + AGENTS.md injection
│   │   ├── memory.ts                # Memories, blocks, graph, lineage, synthesis, cache-warm
│   │   ├── automations.ts           # Automation CRUD + manual run + run history
│   │   ├── system.ts                # System pause/resume control
│   │   ├── system-stats.ts          # CPU/GPU telemetry + history buffer settings
│   │   ├── models.ts                # Model discovery + health probes
│   │   ├── model-stats.ts           # Per-model token/latency samples
│   │   ├── reranker-stats.ts        # Reranker usage and latency samples
│   │   ├── llama-servers.ts         # Managed llama.cpp unit supervision + config
│   │   ├── settings.ts              # User preferences, SSH connections, header image, storage diagnostics
│   │   ├── snapshots.ts             # Agent database snapshot create/restore
│   │   ├── embedding-migration.ts   # Embedding backup/migrate/restore (SSE progress)
│   │   ├── extraction-prompt.ts     # Editable extraction prompt + version history
│   │   ├── tts.ts                   # TTS settings, voices, generation, cached audio
│   │   ├── user-images.ts           # Attachment serving + removal
│   │   ├── tool-result-images.ts    # Images emitted as tool results
│   │   ├── artifacts.ts             # Versioned artifact serving (+ /visuals aliases)
│   │   ├── visuals.ts               # Visual artifact serving
│   │   ├── skills.ts                # Skill definitions + install
│   │   ├── persona.ts               # Persona + version history
│   │   ├── auth.ts                  # Passkey auth
│   │   ├── push.ts                  # VAPID push subscriptions + presence
│   │   ├── notebooks.ts             # Notebook entry CRUD (user/agent) + search + bulk
│   │   ├── ui-state.ts              # UI state persistence
│   │   ├── user.ts                  # User profile document
│   │   └── app.ts                   # Build version + GitHub update check
│   ├── services/
│   │   ├── agent.ts                 # One-shot LLM calls + message reconstruction
│   │   ├── agent-loop-runner.ts     # Shared pi-agent loop driver
│   │   ├── chat-turn-runner.ts      # Headless system/automation turn adapter
│   │   ├── turn-gate.ts             # Global single-slot turn lease (FIFO, priority classes)
│   │   ├── turn-compaction.ts       # Per-turn compaction orchestration
│   │   ├── llm-stream.ts            # Safe stream wrapper + activity tracking
│   │   ├── llm-provider.ts          # Provider dispatch boundary
│   │   ├── live-streams.ts          # Reconnectable SSE stream registry
│   │   ├── synthesis-stream.ts      # Headless LiveStream wrapper for synthesis SSE
│   │   ├── context-breakdown.ts     # Per-section token attribution
│   │   ├── context-high-water.ts    # Running context high-water mark
│   │   ├── context-pressure.ts      # Context pressure signals
│   │   ├── cross-chat.ts            # Cross-chat posting/messaging
│   │   ├── current-message.ts       # Current-message resolution for turns
│   │   ├── pi-message-utils.ts      # pi-ai message helpers
│   │   ├── tool-result-ordering.ts  # Canonical tool-result ordering
│   │   ├── agent-tools.ts           # Tool registry + execution
│   │   ├── browser-tools.ts         # Browser tool definitions
│   │   ├── browser-session.ts       # Remote-debugging Chrome session
│   │   ├── chrome.ts                # Chrome DevTools Protocol client
│   │   ├── web-tools.ts             # Web fetch/search tools
│   │   ├── sandbox.ts               # Python execution helper (NOT a security sandbox)
│   │   ├── workspace.ts             # Workspace paths + remote SSH filesystem
│   │   ├── memory-storage.ts        # Memory + block SQLite + sqlite-vec + FTS5 persistence
│   │   ├── memory-block-scope.ts    # Scope/project resolution invariants for memory blocks
│   │   ├── memory-retrieval-scope.ts# Retrieval scope resolution for memories
│   │   ├── memory-extraction.ts     # Immediate + delayed extraction + supersession tracking
│   │   ├── memory-graph.ts          # Memory similarity graph edges + traversal
│   │   ├── memory-context.ts        # System prompt augmentation + stable prefix caching
│   │   ├── memory-tools.ts          # Agent tool definitions: memories, blocks, archives, search
│   │   ├── passive-memory-recall.ts # Mid-turn passive recall controller
│   │   ├── retrieval-settings.ts    # Settings-driven retrieval budgets
│   │   ├── extraction-settings.ts   # Extraction tuning settings
│   │   ├── extraction-prompt-store.ts # Editable extraction prompt + version history
│   │   ├── memory-extraction-observability.ts # Live extraction run tracking
│   │   ├── pre-synthesis-archive.ts # Archives recent chats before synthesis
│   │   ├── embeddings.ts            # Embedding API wrapper (llama.cpp /v1/embeddings)
│   │   ├── reranker.ts              # Qwen3-Reranker client for memory retrieval
│   │   ├── reranker-stats.ts        # Reranker sampling (porrima.db)
│   │   ├── cache-warm.ts            # llama.cpp prompt-cache warming
│   │   ├── cache-warm-queue.ts      # Warm queue with position tracking
│   │   ├── llama-cache-residency.ts # Observed prompt-cache residency
│   │   ├── system-chat.ts           # Synthesis and wake cycles in persistent system chat
│   │   ├── sleep-cycle.ts           # Inactivity/sleep-cycle state machine
│   │   ├── system-pause.ts          # Global background-work pause
│   │   ├── user-activity.ts         # Foreground activity stamping
│   │   ├── zeitgeist.ts             # Zeitgeist block accessors (content + archive hint)
│   │   ├── automation-storage.ts    # Automation task/run persistence
│   │   ├── automation-scheduler.ts  # Configurable recurring task scheduler
│   │   ├── automation-runner.ts     # Built-in/custom automation execution
│   │   ├── automation-lock.ts       # Global automation run lock
│   │   ├── automation-prompt-selection.ts # Prompt step cycle selection
│   │   ├── scheduler.ts             # Automations, delayed extraction, enrichment, pollers
│   │   ├── compaction.ts            # Message compaction + indexed archival
│   │   ├── chat-storage.ts          # app.db: chats, message rows, archives, projects, settings
│   │   ├── chat-deletion.ts         # Chat deletion + cascade
│   │   ├── message-queue.ts         # Offline message queue with per-chat persistence
│   │   ├── agent-snapshots.ts       # Database snapshot create/restore
│   │   ├── storage-diagnostics.ts   # Per-database size and row counts
│   │   ├── embedding-migration.ts   # Embedding dimension migration
│   │   ├── inline-image-payload-migration.ts # Inline image payload externalization
│   │   ├── tool-result-image-payload-migration.ts # Tool-result image externalization
│   │   ├── openai-compat-provider.ts # OpenAI-compatible API provider (llama.cpp)
│   │   ├── models.ts                # Model discovery, provider dispatch, reasoning detection
│   │   ├── model-stats.ts           # Model sampling (porrima.db)
│   │   ├── model-progress.ts        # Model load progress reporting
│   │   ├── llama-supervisor.ts      # systemd unit state, health, logs, actions
│   │   ├── llama-service-config.ts  # Per-slot config merge + drop-in rendering
│   │   ├── llama-launch-templates.ts# Per-slot binary overrides + ExecStart building
│   │   ├── llama-ports.ts           # Canonical slot id → port map
│   │   ├── llama-path.ts            # ~/bin/llama-current symlink management
│   │   ├── llama-models-disk.ts     # GGUF discovery on disk
│   │   ├── llama-model-aliases.ts   # Model id aliasing
│   │   ├── llama-overrides.ts       # Model override application
│   │   ├── llama-router-client.ts   # llama.cpp router client
│   │   ├── llama-slot-leases.ts     # Slot lease allocation
│   │   ├── llama-prompt-debug.ts    # Prompt debugging helpers
│   │   ├── tts.ts                   # Kokoro TTS integration
│   │   ├── tts-qwen3.ts             # Qwen3-TTS backend
│   │   ├── tts-supertonic.ts        # Supertonic-3 TTS backend
│   │   ├── tts-python.ts            # Python TTS process management
│   │   ├── tts-worker-pool.ts       # TTS worker pool
│   │   ├── tts-streaming.ts         # Generator-based streaming TTS
│   │   ├── tts-buffer.ts            # 3-tier boundary detection for streaming chunks
│   │   ├── tts-chunking.ts          # TTS text chunking
│   │   ├── tts-retry.ts             # TTS retry policy
│   │   ├── tts-text-preprocessor.ts # Markdown-to-speech text extraction
│   │   ├── artifact-guidance.ts     # Artifact authoring guidance injected into prompts
│   │   ├── artifact-preview.ts      # Artifact preview generation
│   │   ├── tool-result-image-storage.ts # Persist images emitted as tool results
│   │   ├── user-image-storage.ts    # Attachment persistence + thumb generation
│   │   ├── header-image-storage.ts  # Chat header image storage
│   │   ├── skills.ts                # Skill definitions + activation
│   │   ├── persona-store.ts         # Persona synthesis + storage + history
│   │   ├── notebook-storage.ts      # Dual notebook system (user/agent entries)
│   │   ├── auth-storage.ts          # Passkey credential storage
│   │   ├── session-cookie-config.ts # Session cookie configuration
│   │   ├── app-version.ts           # Build version metadata
│   │   ├── title-generation.ts      # LLM-generated chat titles
│   │   ├── project-storage.ts       # Filesystem utility for reading AGENTS.md
│   │   ├── user-store.ts            # User profile markdown file management
│   │   ├── push-storage.ts          # Push subscription persistence
│   │   ├── push-dispatch.ts         # Push notification delivery
│   │   ├── system-stats.ts          # CPU/GPU telemetry sampling
│   │   ├── token-count.ts           # Token counting helpers
│   │   ├── token-estimate-observability.ts # Token estimate tracking
│   │   ├── time-marker.ts           # Time anchors injected into turns
│   │   ├── time-format.ts           # Time formatting helpers
│   │   ├── logger.ts                # Server logging
│   ├── scripts/                    # CLI migrations (not HTTP): analyze-token-estimates, migrate-inline-image-payloads, migrate-tool-result-image-payloads
│   └── utils/                       # message-window, mime, path helpers
├── client/src/
│   ├── App.tsx                      # Root app shell, routing, theme/legacy-key migration
│   ├── sw.ts                        # Service worker (PWA, offline cache, push)
│   ├── types.ts                     # Shared interfaces (client copy)
│   ├── api/                         # Fetch API clients: client.ts, auth, tts, user, persona, push, extraction-prompt
│   ├── hooks/                       # React hooks (useChat, useChats, useProjects, useModels, useSettings, useTTS, useNotebooks, useStreamingTTS, useGestureDrawer, useOnlineStatus, useAuth, usePushNotifications, useCacheResidency, etc.)
│   ├── components/                  # React components (Sidebar, ChatView, MessageBubble, ArtifactPanel, NotebookView, MemoryGraphView, MemoryDebugPanel, PinnedPanel, ReminderCard, ThemePicker, SystemPromptEditor, ModelStatsModal, SystemStatsBar, SetupModal, SidebarSearch, CompactionIndicator, OfflineIndicator, TokenIndicator, SkillsBrowser, etc.)
│   │   └── ui/                      # Primitives (MarkdownRenderer, Dropdown, ContextMenu, ToggleSwitch, SpeakerButton, DiffView, etc.)
│   ├── contexts/                    # PinnedItemContext
│   ├── styles/                      # Tailwind styles
│   ├── lib/                         # IndexedDB cache, device id, activity timings, steering placeholders, legacy-key migration
│   └── utils/                       # Helpers (custom-theme, llamaPorts, imageCache, greeting, artifactErrorForwarder)
├── docs/                            # Detailed documentation (see links in sections above)
│   └── design/                      # Design docs: turn-engine, memory-durability, memory-context-persistence, mid-turn-extraction, p0b-storage-concurrency
└── package.json                     # npm workspaces root
```

## Further Documentation

Architecture and subsystems:

- [API Reference](docs/api-reference.md) — Full endpoint table (220 endpoints)
- [Architecture](docs/architecture.md) — Chat types, provider layer, storage, compaction
- [Chat Message Architecture](docs/chat-message-architecture.md) — Row canonicalization and replay fidelity
- [Compaction](docs/compaction.md) — Indexed archival and the five compaction paths
- [Tool System](docs/tool-system.md) — Full tool inventory, gating, workspace/browser adapters
- [Memory System](docs/memory-system.md) — Extraction, retrieval pipeline, graph, supersession
- [Memory Blocks](docs/memory-blocks.md) — Structured knowledge document system
- [Automations](docs/automations.md) — Configurable recurring system-chat tasks
- [Cross-Chat Messaging](docs/cross-chat-messaging.md) — Delivering messages between chats
- [Artifacts](docs/artifacts.md) — Versioned artifacts and visuals
- [UI Patterns](docs/ui-patterns.md) — Streaming, theming, effects, client state
- [Key Patterns](docs/key-patterns.md) — Cross-cutting invariants and important notes
- [Data Storage](docs/data-storage.md) — Directory layout and all SQLite schemas
- [Integrations](docs/integrations.md) — Notebooks, TTS, skills, push, PWA, SSH
- [Zeitgeist](docs/zeitgeist.md) — Background knowledge consolidation
- [Automation Scope](server/src/docs/automation-scope.md) — Automation scoping rules (in-tree, not in `docs/`)

Design documents (`docs/design/`) — rationale and history for shipped subsystems:

- [Turn Engine](docs/design/turn-engine.md)
- [Memory Durability](docs/design/memory-durability.md)
- [Memory Context Persistence](docs/design/memory-context-persistence.md)
- [Memory Context Subject Lines](docs/design/memory-context-subject-lines.md)
- [Mid-Turn Extraction](docs/design/mid-turn-extraction.md)
- [P0B Storage Concurrency](docs/design/p0b-storage-concurrency.md)
- [Image Sandbox Extraction](docs/design/image-sandbox-extraction.md)

Release and onboarding:

- [Implementation Overview](docs/implementation-overview.md) — Cross-cutting notes and known caveats
- [Onboarding & Installation](docs/onboarding-installation.md) — Install profiles and host probes
- [Release Notes 0.4.0](docs/release-notes-0.4.0.md)
- [Setup & Deployment](docs/setup.md) — Prerequisites, development, production, systemd
