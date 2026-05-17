# qu.je Agent

A local chat UI and agent framework for Ollama and OpenAI-compatible local models. Agent chats learn about you over time through automatic fact extraction, semantic search, indexed compaction, memory blocks, and configurable system-chat automations. Quick chats work as standalone conversations with no memory.

## Features

**Chat types**
- **Agent chats** — Memory-augmented conversations. The agent remembers facts about you across sessions, has explicit memory tools (`save_memory`, `search_memory`, `forget_memory`), and automatically extracts important details from conversations in the background.
- **Quick chats** — Standalone one-off conversations with no memory behavior.
- **Bluesky chats** — Dedicated social-media conversations with Bluesky tools and notification context.
- **System chats** — Background synthesis, wake cycles, and custom automations with auditable message history.

**Memory system**
- Automatic extraction: after each agent response, a background LLM call extracts facts (preferences, personal details, behaviors, instructions) and deduplicates them against existing memories using cosine similarity.
- Context augmentation: relevant memories are retrieved via semantic search and injected into the system prompt so the agent naturally references what it knows.
- Agent tools: the agent can explicitly save, search, and forget memories when asked.
- Synthesis and wake cycles: built-in configurable automations run in the persistent system chat with full tool access, editable prompts, run history, and optional push notifications.
- Custom automations: schedule recurring system-chat tasks on interval or daily schedules.
- Pre-compaction flush: when a conversation approaches the context window limit (>75% usage), all important facts are extracted and preserved before truncation.

**Streaming & reasoning**
- Server-Sent Events for real-time token streaming
- Collapsible thinking blocks for reasoning-capable models (Qwen3+)
- Token usage indicator with context window progress bar

**Other**
- Per-chat model selector and system prompt editor
- Glassmorphism UI with Tailwind CSS v4
- Markdown rendering with GFM support
- SQLite-backed chat, settings, automation, memory, and corpus storage with FTS5 search and sqlite-vec where vector search is needed

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Ollama](https://ollama.ai/) running locally on port 11434
- A chat model pulled in Ollama (e.g. `ollama pull qwen3:8b`)
- The embedding model for memory: `ollama pull qwen3-embedding:0.6b`

## Setup

```bash
git clone <repo-url> quje-agent
cd quje-agent
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

## Project structure

```
quje-agent/
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

All data is stored in `~/.quje-agent/`:

```
~/.quje-agent/
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

MIT
