# qu.je Agent

A local chat UI for Ollama models with a persistent memory system. Agent chats learn about you over time through automatic fact extraction, semantic search, and daily memory consolidation. Quick chats work as standalone conversations with no memory.

## Features

**Two chat modes**
- **Agent chats** — Memory-augmented conversations. The agent remembers facts about you across sessions, has explicit memory tools (`save_memory`, `search_memory`, `forget_memory`), and automatically extracts important details from conversations in the background.
- **Quick chats** — Standalone one-off conversations with no memory behavior.

**Memory system**
- Automatic extraction: after each agent response, a background LLM call extracts facts (preferences, personal details, behaviors, instructions) and deduplicates them against existing memories using cosine similarity.
- Context augmentation: relevant memories are retrieved via semantic search and injected into the system prompt so the agent naturally references what it knows.
- Agent tools: the agent can explicitly save, search, and forget memories when asked.
- Daily synthesis: a scheduler merges near-duplicate memories, applies importance decay, and generates a daily summary log.
- Pre-compaction flush: when a conversation approaches the context window limit (>75% usage), all important facts are extracted and preserved before truncation.

**Streaming & reasoning**
- Server-Sent Events for real-time token streaming
- Collapsible thinking blocks for reasoning-capable models (Qwen3+)
- Token usage indicator with context window progress bar

**Other**
- Per-chat model selector and system prompt editor
- Glassmorphism UI with Tailwind CSS v4
- Markdown rendering with GFM support
- SQLite + sqlite-vec for memory storage with SIMD-accelerated vector search; JSON files for chat persistence

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
│   │   ├── chat.ts                  # POST /api/chat — SSE streaming + tool loop
│   │   ├── chats.ts                 # Chat CRUD
│   │   ├── memory.ts                # Memory CRUD + search + synthesis trigger
│   │   ├── models.ts                # Ollama model discovery
│   │   └── settings.ts              # User preferences
│   └── services/
│       ├── agent.ts                 # pi-ai streaming wrapper
│       ├── models.ts                # Ollama model config + reasoning detection
│       ├── storage.ts               # Chat JSON persistence (~/.quje-agent/chats/)
│       ├── embeddings.ts            # Ollama embedding API wrapper
│       ├── memory-storage.ts        # Memory SQLite + sqlite-vec persistence + KNN search
│       ├── memory-extraction.ts     # Background fact extraction + pre-compaction flush
│       ├── memory-context.ts        # System prompt augmentation with memories
│       ├── memory-tools.ts          # Agent tool definitions, parsing, execution
│       ├── synthesis.ts             # Daily memory consolidation
│       └── scheduler.ts             # Hourly synthesis check + startup catch-up
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
├── chats/              # One JSON file per chat
├── settings.json       # User preferences
└── memory/
    ├── memories.db     # SQLite database (memories + vector embeddings via sqlite-vec)
    └── daily/          # Daily synthesis logs (YYYY-MM-DD.md)
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

## License

MIT
