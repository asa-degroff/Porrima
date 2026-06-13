# Porrima

![Porrima brand image](/assets/porrima-brand-image.avif)

A self-hosted, memory-native AI agent framework and cross-platform GUI application. 

## Features

##### First-class GUI
The client is a PWA built for desktop, tablet, and mobile. Access remotely with Cloudflare Tunnels. Secured with Webauthn passkeys.

Color themes, animations, and style options to make it your own.

Chat list, full-text chat search, and project-scoped chats shown in the sidebar. Push notifications are per-device, with foreground presence suppression.

Streaming output with thinking blocks, tool calls, uploaded images, and generated HTML/JS artifacts. Mobile: gesture drawer, keyboard inset, mobile-Safari-friendly.

Detailed observability: memory blocks, the full memory database, model stats (decode/prefill/cache hitrate), extraction and reranker run history, context size, and the constructed system prompt.

##### Multithreaded cognition
Porrima remembers and recalls its experiences both consciously and subconsciously. It runs two language models and a reranker model during operation, designed to fully utilize both the GPU and CPU on a typical high-end consumer desktop. It has self-managed memory blocks, as well as ambient associative memory with the capacity to recall memory content both in response to user messages, using memory tools, and spontaneously while it runs, with non-blocking live context injection between tool calls. 

The memory extraction model operates in the background, taking a first and second pass over the same context as the main model, recording memories of everything new, supersession chains for everything old, to form a database of atomic memories with dense vector embeddings for subconscious recall. Control depth of recall with granular configuration options. 

The main model reviews its recent atomic memories during regular synthesis cycles and incorporates its experiences into self-managed memory blocks (global and project-scoped), which attach to the starting context for chats in the respective scope. The default `zeitgeist` block holds a high-level summary; the agent can also create topical blocks on its own.

##### Modular foundation
Five managed llama.cpp server instances are configurable from the settings menu. Bring your own binaries (mainline or any llama.cpp fork) and your own GGUFs for each of main chat, memory extraction, title generation, cross-encoder reranker, and embedding models. The agent can hot-swap its own llama.cpp process without user intervention.

##### Continuous operation
Sleep/wake cycle sets aside non-interactive time for synthesizing experiences, managing memory blocks, pulling at threads of curiosity, or running whatever else you configure. The `system` chat is the context where all autonomous operation takes place; you can also chime in there as the user. A `pause` button stops autonomous work to free resources on demand.

##### Chat scopes
Three chat types:
- **Projects** — chats that start with a working directory and the project's `AGENTS.md` in-context. Project working directories can live on a remote host so a single Porrima instance can work across multiple machines on your Tailnet.
- **Global chats** — the default agent chats, with full agent capabilities.
- **Quick chats** — non-agent chats for one-off questions or model testing, independent of the memory system and tools.

A configurable project memory relevance multiplier (and global-project cross-score) lets you tune how strongly memories from other scopes surface.

##### Web access
Bring an API key for the included Exa, Tavily, and/or Brave Search providers. Includes web fetch and PDF parsing tools.

##### Text-to-speech
Backend wrappers included for Kokoro, Qwen3-TTS, and Supertonic 3. Voice selection, speed, pitch (resample or rubberband), text preprocessing, and 3-tier sentence boundary detection are configurable. Streaming output with Qwen3-TTS, chunked live playback for Kokoro and Supertonic 3.

##### Asynchronous thinking space
A notebook section where you can write down anything that doesn't warrant an immediate reply. Your agent reads your notes during the next synthesis cycle and writes its own notebook entries after reflecting on its recent experiences (and on what you wrote).

##### Skills
Global and project-scoped `SKILL.md` skills. Classic `/` invocation. Automatic discovery in project directories, as well as a UI for installing global skills from remote sources and managing installed skills.

##### Image sandbox
Vision analysis with built-in description presets (Simple, Detailed, Z-Image, etc.). Image generation frontends for ComfyUI and/or stable-diffusion.cpp. A masonry gallery viewer and a D3 force-directed image corpus graph that clusters your generated collection by similarity. GPU/resource coordination is handled automatically so the LLM and image model can share hardware if you run the image and language servers on the same machine.

##### Backup and restore
One-click snapshots of chats, the memory database, embeddings, and (optionally) the image corpus. Embedding backups and migration when changing embedding models. All data lives in SQLite databases under `~/.porrima/`.

##### Cache-aware
Agent harness designed to be KV-cache-friendly with compaction-time memory consolidation. Multi-slot cache warmth indicators in the chat list (amber halos for cached, purple for the most recent), a cache warmer button, post-synthesis auto-rewarming, and prefill progress indicators in the chat view. Context continues indefinitely — compaction runs extraction, moves memory-augmented content to the head, drops redundant entries, and packs the post-compaction context to ~30% capacity while keeping the tail of the previous conversation intact.

##### Hardware-aware
Built-in llama.cpp server configuration (per-slot overrides, binary management, model scan paths, slot binding modes). Decode/prefill/hitrate stats, reranker latency and score quality, and a graphical hardware monitor for CPU/RAM/GPU.

##### Self-modifying
Open a project in the source code directory and ask Porrima to tweak anything in its own codebase.

##### Personal AI
Full sovereignty over data, model, infrastructure, and operation. Safe from deprecation, surveillance, and censorship.

##### Recommended use cases
- **Software engineering** — excellent at coding, learns your projects over time, very high context density.
- **Personal agent** — does anything on your computer that's accessible by command line.
- **Research** — keeps going down rabbit holes and writing about findings while you sleep.
- **Companion / advisor** — complete privacy, long-term permanence, no topical restrictions.

## System requirements

##### Server (recommended)
- **OS:** Linux with systemd
- **GPU:** ≥32 GB dedicated VRAM, AMD RDNA 3+ or Nvidia Ampere+
- **CPU:** Desktop x86_64, ≥8 physical/performance cores, AVX-512, AMD Zen 4+ or Intel Alder Lake+
- **RAM:** ≥48 GB dual-channel DDR5
- **SSD:** NVMe Gen 4 or 5

24 GB VRAM systems may be usable but will need to fit the main model plus two smaller models simultaneously. Unified-memory systems (AMD Strix Halo, Nvidia Grace Blackwell, Apple Silicon) are not recommended unless you have a multi-system cluster; partial CPU offloading is also not recommended due to memory-bandwidth contention.

##### Client
- **OS:** Linux, macOS, Windows, Android, iOS
- **Browser:** Chromium-based with PWA support recommended (mobile Safari also works)

## Recommended models

| Slot | Pick |
|---|---|
| Main chat | Qwen 3.6 27B or Gemma 4 31B |
| Memory extraction | Same family as the main model — Qwen 3.5 9B / 4B or Gemma 4 26B A4B / 12B / E4B |
| Title generation | Gemma 4 E2B (or E4B) |
| Reranker | Qwen3-reranker 0.6B |
| Embeddings | Qwen3-embedding 4B (or 0.6B) |
| Images | Z-Image Base, Qwen Image |

Use an extraction model from the same family as the main chat model. The main and extraction models share a first-person perspective, and matching families keep the main model from perceiving its memories as messages from an external entity.

The main model should run on the GPU; the extraction, reranker, title, and embedding models typically run on CPU in parallel, drawing from a separate pool of system RAM and not contending with the interactive main model.

These are recommendations, but you can run it with whatever model you want, and the choices will likely change in the future.

## Setup

Porrima is intended to be installed by an existing coding agent. The canonical install prompt walks the agent through probing your hardware, asking for missing choices, and making a plan before installing or configuring anything.

```bash
curl -fsSL https://porrima.cc/install/agent-prompt.txt | codex
```

Equivalent one-liners are provided for Claude, OpenCode, and Pi. Read the prompt first if you want to review the exact instructions. The full installation guide lives at <https://porrima.cc/docs/install/>.

If you want to install by hand, the project is a standard npm workspaces monorepo:

```bash
git clone <repo-url> porrima
cd porrima
npm install
cd server && npm run dev      # backend on :3001
cd client && npm run dev      # frontend on :5173 (Vite proxies /api to :3001)
```

### Optional TTS backends

TTS backends use Python packages that are intentionally optional. Install only the backends you want:

```bash
./scripts/install-tts-backend.sh kokoro --python /path/to/python3.12
./scripts/install-tts-backend.sh qwen3-tts
./scripts/install-tts-backend.sh supertonic-3
```

The installer creates per-backend virtual environments under `.venv-tts/` and writes interpreter overrides to `server/.env.tts`, so adding one backend does not break another. Backend status is available at `/api/tts/status?backend=kokoro`, `/api/tts/status?backend=qwen3-tts`, and `/api/tts/status?backend=supertonic-3`. Kokoro and Qwen3-TTS work best on Python 3.10–3.13.

## Remote access

Expose Porrima to the internet only with HTTPS and WebAuthn passkeys configured. The recommended path is a Cloudflare Tunnel, with Cloudflare Access (or equivalent) providing temporary protection during the first-run window — never open an unprotected first-run instance to the public internet. The first owner passkey must be registered on the final HTTPS hostname before the tunnel is left unprotected.

## Production

Build and run:

```bash
cd server && npm run build
cd ../client && npm run build
cd ../server && npm start
```

The compiled server listens on port 3001. Serve `client/dist/` with any static file server, or front it with a reverse proxy.

The repository ships systemd unit templates that manage the main `porrima` server plus each of the five llama.cpp slots (`inference`, `extraction`, `reranker`, `embedding`, `title-generation`). The settings GUI can start, stop, restart, and configure each one — including binary management, model assignments, and slot binding modes — without touching the command line.

## Project structure

```
porrima/
├── server/src/
│   ├── index.ts                     # Express app, route mounting, scheduler start
│   ├── types.ts                     # Shared TypeScript interfaces
│   ├── routes/
│   │   ├── chat.ts                  # POST /api/chat — SSE streaming around shared agent loop
│   │   ├── chats.ts                 # Chat CRUD
│   │   ├── projects.ts              # Project CRUD + AGENTS.md injection
│   │   ├── memory.ts                # Memory CRUD + search + synthesis dispatch
│   │   ├── automations.ts           # Automation CRUD, manual run, run history
│   │   ├── models.ts                # Model discovery
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
│       ├── chat-storage.ts          # SQLite chat/project/settings storage
│       ├── automation-storage.ts    # Automation tasks + run history
│       ├── automation-scheduler.ts  # Configurable recurring task scheduler
│       ├── automation-runner.ts     # Built-in/custom automation execution
│       ├── automation-lock.ts       # Global automation run lock
│       ├── embeddings.ts            # Embedding API wrapper
│       ├── memory-storage.ts        # Memory SQLite + sqlite-vec + KNN search
│       ├── memory-extraction.ts     # Background fact extraction + pre-compaction flush
│       ├── memory-context.ts        # System prompt augmentation with memories
│       ├── memory-tools.ts          # Agent tool definitions
│       ├── system-chat.ts           # Synthesis and wake cycles in system chat
│       ├── scheduler.ts             # Automations, delayed extraction, enrichment, pollers
│       ├── compaction.ts            # Message compaction + indexed archival
│       ├── reranker.ts              # Qwen3-Reranker client for memory retrieval
│       ├── openai-compat-provider.ts # OpenAI-compatible provider (llama.cpp)
│       ├── models.ts                # Model discovery, provider dispatch, reasoning detection
│       ├── tts.ts                   # Kokoro TTS integration
│       ├── tts-qwen3.ts             # Qwen3-TTS backend with caching
│       ├── tts-streaming.ts         # Generator-based streaming TTS
│       ├── tts-buffer.ts            # 3-tier boundary detection
│       ├── tts-text-preprocessor.ts # Markdown-to-speech text extraction
│       ├── comfyui.ts               # ComfyUI API client
│       ├── image-generation.ts      # Generation state tracking + ComfyUI integration
│       ├── image-storage.ts         # Generated image persistence + metadata
│       ├── image-corpus.ts          # SQLite corpus + FTS5 + vector search + hybrid RRF
│       ├── image-tools.ts           # Image analysis + element extraction
│       ├── element-extraction.ts    # Structured extraction into visual categories
│       ├── generate-review.ts       # Multi-iteration image gen with agent review loop
│       ├── cluster-engine.ts        # Density-based clustering with cosine similarity
│       ├── cluster-storage.ts       # Cluster persistence + centroid/element computation
│       ├── visualization.ts         # D3 force-directed graph HTML generation
│       ├── vision-analysis.ts       # Vision model analysis
│       ├── user-image-storage.ts    # User image upload + thumb generation
│       ├── skills.ts                # Skill definitions + activation
│       ├── persona-store.ts         # Persona synthesis + storage
│       ├── auth-storage.ts          # Passkey credential storage
│       ├── title-generation.ts      # LLM-generated chat titles + summaries
│       ├── sandbox.ts               # Python code execution sandbox
│       ├── notebook-storage.ts      # Dual notebook system (user/agent entries)
│       ├── project-storage.ts       # Filesystem utility for reading AGENTS.md
│       ├── user-store.ts            # User profile markdown file management
│       └── message-queue.ts         # Offline message queue with per-chat persistence
├── client/src/
│   ├── types.ts                     # Shared interfaces (client copy)
│   ├── api/client.ts                # Fetch API client + SSE parser
│   ├── hooks/                       # React hooks (useChat, useChats, useProjects, useModels, useSettings, useTTS, useNotebooks, useStreamingTTS, useGestureDrawer, useOnlineStatus, etc.)
│   ├── components/                  # React components (Sidebar, ChatView, MessageBubble, ArtifactPanel, ImageSandbox, VisionGallery, NotebookView, ConversationSearch, SidebarSearch, CompactionIndicator, OfflineIndicator, TokenIndicator, SkillsBrowser, etc.)
│   ├── lib/                         # IndexedDB cache, utils
│   └── utils/                       # Helper functions
├── docs/                            # Architecture, memory system, automations, tool system, data storage
└── package.json                     # npm workspaces root
```

## Data storage

All data is stored in `~/.porrima/`:

```
~/.porrima/
├── app.db                  # SQLite: chats, projects, settings, automations, FTS5 projections
├── memory/
│   ├── memories.db         # SQLite + sqlite-vec: atomic memories + vector embeddings
│   ├── daily/              # Legacy synthesis logs; current synthesis lives in the system chat
│   └── backups/            # Labeled embedding backups for migration
├── image-corpus/
│   └── corpus.db           # SQLite + sqlite-vec: generated image corpus + FTS5
├── snapshots/              # Agent state snapshots (memories, blocks, settings, optionally corpus)
├── artifacts/              # Generated HTML/JS artifacts
├── user-images/            # Uploaded images + thumbnails
├── settings.json           # Legacy settings (current lives in app.db)
└── chats/                  # Legacy chat JSON (current lives in app.db)
```

## API

The full reference is in [docs/api-reference.md](docs/api-reference.md). A representative subset:

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/models` | List available inference models |
| GET | `/api/llama-servers` | List managed llama.cpp units with process state and HTTP health |
| POST | `/api/llama-servers/:id/:action` | Start / stop / restart an allowlisted unit |
| PUT | `/api/llama-servers/:id/config` | Save service configuration (systemd drop-in override) |
| GET/POST | `/api/chats` | List / create chats (`{ modelId, type: "agent"\|"quick", projectId? }`) |
| POST | `/api/chat` | Send message (SSE stream) |
| POST | `/api/chat/enqueue` | Queue a message for offline delivery |
| GET/POST | `/api/memory` | List / create memories |
| POST | `/api/memory/search` | Semantic + hybrid memory search |
| GET | `/api/memory/status` | Embedding model status + memory count + extraction metrics |
| POST | `/api/memory/synthesis/run` | Dispatch a synthesis run (202 Accepted, polls `/synthesis/status`) |
| POST | `/api/memory/conversations/search` | FTS5 search over chat history |
| GET/POST/DELETE | `/api/snapshots` | List / create / delete agent state snapshots |
| POST | `/api/snapshots/:id/restore` | Restore a snapshot (creates a pre-restore snapshot first) |
| GET/POST/PATCH/DELETE | `/api/automations[...]` | List / create / edit / run / inspect runs of automation tasks |
| GET/POST/PATCH/DELETE | `/api/projects[...]` | Project CRUD + AGENTS.md |
| POST | `/api/images/generate` | Generate an image via ComfyUI |
| GET/POST | `/api/user-images` | Upload / list user images |
| POST | `/api/auth/login` | Passkey login (no passwords) |

## Further reading

- [docs/architecture.md](docs/architecture.md) — top-level architecture
- [docs/memory-system.md](docs/memory-system.md) — extraction, retrieval, blocks, reranking
- [docs/automations.md](docs/automations.md) — recurring system-chat tasks
- [docs/tool-system.md](docs/tool-system.md) — native tool calling and registry
- [docs/setup.md](docs/setup.md) — prerequisites, development, production
- [docs/api-reference.md](docs/api-reference.md) — full endpoint table
- [https://porrima.cc/](https://porrima.cc/) — product overview, screenshots, model recommendations, FAQs

## Naming

38 light-years from Earth, Porrima is a binary star system seen from our night sky in the constellation Virgo. The star system takes its name from the Roman goddess of foresight and the future. You can, of course, assign your agent any name and persona you want.

## License

Apache 2.0
