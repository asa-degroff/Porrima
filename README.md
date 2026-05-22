# Porrima

Memory-native AI agent system. Runs on your own hardware, learns and evolves over time, and offers endless customization.

### Features
##### First-class GUI
Install anywhere, do anything. The client app is a PWA built for desktop, tablet, and mobile. Access remotely with Cloudflare Tunnels. Secured with Webauthn passkeys. 

Color themes, animations, and style options to make it your own.

Chat list, chat search, and projects shown in the sidebar.

Push notification support so you can be notified when your agent has a new message for you.

Displays rich streaming output with thinking, tool calls, uploaded images, and generated HTML+JS artifacts. 

Detailed observability and debugging information: view and manage memory blocks, memory database, model stats, extraction and retrieval runs, context size, and constructed system prompt.

##### Multithreaded cognition
Porrima remembers and recalls its experiences both consciously and subconsciously. It runs two language models and a reranker model during operation, designed to fully utilize both the GPU and CPU on a typical high-end consumer desktop. It has self-managed memory blocks, as well as ambient associative memory with the capacity to recall memory content both in response to user messages, using memory tools, and spontaneously while it runs, with non-blocking live context injection between tool calls. 

The memory extraction model operates in the background, taking a first and second pass over the same context as the main model, recording memories of everything new, supersession chains for everything old, to form a database of atomic memories with dense vector embeddings for subconscious recall. Control depth of recall with granular configuration options. 

The agent's main model reviews its recent atomic memories during regular synthesis cycles, and incorporates its experiences into self-managed memory blocks which exist globally and for project scopes, attached to the starting context for chats in the respective scope.

##### Modular foundation
Five managed Llama.cpp server instances can be configured from the settings menu. Bring your own binaries, including mainline or any LLama.cpp forks of your choosing. Bring your own GGUFs for each of the main chat, memory extraction, title generation, cross-encoder reranker, and embedding models, remaining flexible for present and future. 

##### Continuous operation
Porrima has a sleep/wake cycle and will spend the non-interactive time synthesizing its experiences, managing its memory blocks, pulling at threads of curiosity, or whatever else you configure. The 'system chat' is the context where all fully autonomous operation takes place, and you can also chime in afterwards as the user if you want. 

##### Chat scopes
Offers global chats and project-scoped chats. Projects include AGENTS.md support and a working directory, optionally on a remote host. Includes a configurable project memory relevance multiplier so you can adjust how much or how little the agent remembers from projects outside its current context. 

Also offers non-agent quick chats for one-off questions or model testing, which exist independently of the memory system or tools. 

##### Web access
Bring an API key for the included Exa, Tavily, and/or Brave Search providers. 

Includes web fetch and PDF parsing tools.

##### Text-to-speech
Porrima can read its responses out loud with backend wrappers included for Kokoro, Qwen3-TTS, and Supertonic 3. Voice selection, speed, and pitch post-processing are configurable. Supports streaming output with Qwen3-TTS, and chunked playback for reading in-progress responses with Kokoro and Supertonic 3. 

##### Asynchronous thinking space
Features a notebook section where you can write down anything on your mind that doesn't elicit an immediate response. Your agent will read your notes later, and then write notebook entries of its own after reflecting on its recent experiences, as well as things that you wrote. 

##### Skills
Supports global and project-scoped skills. Offers skill invocation with the classic '/' command. Features automatic skills discovery in project directories, and a UI for installing global skills from remote sources and managing installed skills. 

##### Image Sandbox
Offers an image analysis interface for vision tasks, frontend for ComfyUI server and/or stable-diffusion.cpp, a gallery viewer, and an image corpus graph for seeing your generated image collection.

##### Cache-aware
Agent harness designed to be LCP cache-friendly. Features cache warmth indicators with multi-slot awareness in the chat list, a cache warmer button, and post-synthesis auto-rewarming. 

##### Hardware-aware
Balance the processing and memory load with built-in llama.cpp server configuration, view inference speed stats, reranking latency stats, and keep an eye on your system resources with the graphical hardware monitor. 

##### Self-modifying
Ask Porrima to tweak anything in its own codebase if you want to tinker. 

##### Personal AI
Full sovereignty over data, model, infrastructure, and operation. Safe from deprecation, surveillance, and censorship. 

##### Recommended use cases
- Software engineering: Porrima is excellent at coding, learns your projects over time, and has a memory system that affords very high context-density.
- Personal agent: Porrima can do anything on your computer that's accessible by command line. 
- Research: keeps going down rabbit holes and writing about findings while you sleep.
- Therapist, companion, or advisor: complete privacy, long-term permanence, no topical restrictions.

##### Naming information
38 light-years from Earth, Porrima is a binary star that can be seen in our night sky in the constellation Virgo. The star system takes its name from the Ancient Roman goddess of the future. 

You can, of course, assign your agent any name and persona you want.


## Setup

```bash
git clone <repo-url> porrima
cd porrima
npm install
```

## Optional TTS Backends

TTS backends use Python packages that are intentionally optional. Install only the backends you want:

```bash
./scripts/install-tts-backend.sh kokoro --python /path/to/python3.12
./scripts/install-tts-backend.sh qwen3-tts
./scripts/install-tts-backend.sh supertonic-3
```

The installer creates per-backend virtual environments under `.venv-tts/` and writes interpreter overrides to `server/.env.tts`. This keeps Kokoro, Qwen3-TTS, and Supertonic dependencies isolated so adding one backend does not break another. Backend status is available at `/api/tts/status?backend=kokoro`, `/api/tts/status?backend=qwen3-tts`, and `/api/tts/status?backend=supertonic-3`.

Kokoro and Qwen3-TTS should use Python 3.10-3.13. Python 3.14 can force native dependencies such as spaCy or torch to build from source instead of installing prebuilt wheels.

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

### systemd service

To run the server on boot, create `~/.config/systemd/user/porrima.service`:

```ini
[Unit]
Description=Porrima Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/path/to/porrima/server
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
systemctl --user enable --now porrima
loginctl enable-linger $USER   # start without login
```

## Project structure

```
porrima/
├── server/src/
│   ├── index.ts                     # Express app, route mounting, scheduler start
│   ├── types.ts                     # Shared TypeScript interfaces
│   ├── routes/
│   │   ├── chat.ts                  # POST /api/chat — SSE streaming around shared agent loop
│   │   ├── chats.ts                 # Chat CRUD
│   │   ├── memory.ts                # Memory CRUD + search + synthesis dispatch
│   │   ├── automations.ts           # Automation CRUD, manual run, run history
│   │   ├── models.ts                # Model discovery
│   │   └── settings.ts              # User preferences
│   └── services/
│       ├── agent-loop-runner.ts     # Shared pi-agent loop driver
│       ├── chat-turn-runner.ts      # Headless system/automation turn adapter
│       ├── llm-stream.ts            # Safe stream wrapper + activity tracking
│       ├── agent.ts                 # One-shot LLM calls + message reconstruction
│       ├── models.ts                # Provider dispatch + reasoning detection
│       ├── chat-storage.ts          # SQLite chat/project/settings storage
│       ├── automation-storage.ts    # Automation tasks + run history
│       ├── automation-scheduler.ts  # Configurable recurring task scheduler
│       ├── automation-runner.ts     # Built-in/custom automation execution
│       ├── system-chat.ts           # Synthesis and wake cycles in system chat
│       ├── embeddings.ts            # Ollama embedding API wrapper
│       ├── memory-storage.ts        # Memory SQLite + sqlite-vec persistence + KNN search
│       ├── memory-extraction.ts     # Background fact extraction + pre-compaction flush
│       ├── memory-context.ts        # System prompt augmentation with memories
│       ├── memory-tools.ts          # Agent tool definitions, parsing, execution
│       └── scheduler.ts             # Automation startup, delayed extraction, enrichment, pollers
├── client/src/
│   ├── types.ts                     # Shared interfaces (client copy)
│   ├── api/client.ts                # Fetch API client + SSE parser
│   ├── hooks/                       # React hooks (useChat, useChats, useModels, useSettings)
│   └── components/                  # React components (Sidebar, ChatView, MessageBubble, etc.)
└── package.json                     # npm workspaces root
```

## Data storage

All data is stored in `~/.porrima/`:

```
~/.porrima/
├── app.db              # SQLite database for chats, settings, automations, search projections
├── chats/              # Legacy chat JSON files migrated to app.db
├── settings.json       # Legacy settings JSON migrated to app.db
└── memory/
    ├── memories.db     # SQLite database (memories + vector embeddings via sqlite-vec)
    └── daily/          # Legacy synthesis logs; current synthesis lives in system chat/notebooks
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List available Ollama models |
| GET | `/api/chats` | List all chats |
| POST | `/api/chats` | Create chat (`{ modelId, type: "agent"\|"quick" }`) |
| POST | `/api/chat` | Send message (SSE stream) |
| GET | `/api/memory` | List memories (without embeddings) |
| POST | `/api/memory` | Create memory |
| POST | `/api/memory/search` | Semantic search (`{ query, topK? }`) |
| GET | `/api/memory/status` | Embedding model status + memory count |
| POST | `/api/memory/synthesis/run` | Manually trigger synthesis |
| GET | `/api/automations` | List configurable built-in/custom automations |
| POST | `/api/automations` | Create a custom automation |
| POST | `/api/automations/:id/run` | Manually run an automation |
| GET | `/api/automations/:id/runs` | View automation run history |

## License

Apache 2.0