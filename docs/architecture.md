# Architecture

## Chat Types

Three chat types: **agent** (memory-augmented), **quick** (standalone), and **bluesky** (social media integration). Existing chats without a `type` field default to "quick".

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) orchestrates:
1. Memory context augmentation (agent chats only)
2. LLM streaming via pi-ai (`streamChat`)
3. Memory tool parsing and execution (agent chats only)
4. Fire-and-forget memory extraction after responses
5. Pre-compaction flush when token usage > 75% of context window

## Projects

Projects provide persistent context for agent chats through AGENTS.md files:
- Created via UI or API, stored in `~/.quje-agent/projects/`
- Each project has a name, filesystem path, and optional AGENTS.md
- New chats in a project automatically inject AGENTS.md content into the system prompt
- Chats within projects are grouped under their project in the UI
- The agent uses `list_files`, `read_file`, etc. tools to explore the project structure
- UI features: color customization per project, pin/unpin, path validation with permissions checking, directory creation
- `project-storage.ts` provides filesystem utility for reading AGENTS.md from project directories

## LLM Provider Architecture

Multi-provider system supporting multiple inference backends through pi-ai's provider abstraction:

- **Ollama Native** (`ollama-native-provider.ts`): Registers with pi-ai for Ollama's native `/api/chat` format
- **OpenAI-Compatible** (`openai-compat-provider.ts`): Registers with pi-ai for OpenAI-format APIs (llama.cpp, etc.)
  - SSE parser for OpenAI streaming format
  - Incremental tool call handling with argument accumulation
  - Support for `reasoning_content` field (thinking blocks)
  - Vision model support with base64 image encoding
  - Router mode: per-process model loading cache with `ensureModelLoaded()` calling `/models/load`; tracks `lastLoadedModel` to avoid redundant loads; 30s unload / 120s load timeouts
- **Model Discovery** (`models.ts`): `discoverAllModels()` queries both Ollama and llama.cpp servers, tags each model with `provider: "ollama"` or `provider: "llamacpp"`. `createPiModelFromProvider()` routes to the correct pi-ai API provider.
- **Settings**: `llamacppEnabled`, `llamacppUrl`, `llamacppSharesGpu` control llama.cpp integration

## Memory Services

Memory services are in `server/src/services/memory-*.ts`. They share the pi-ai `streamChat` function for LLM calls (extraction, synthesis, tool execution all use it with different system prompts).

## Chat Storage

Chat storage migrated from JSON files to SQLite (`server/src/services/chat-storage.ts`). The `app.db` database stores:
- **Chats** — metadata + JSON `messages` column (hybrid approach: normalized metadata, JSON for nested arrays)
- **Chat messages** — denormalized `chat_messages` table with FTS5 virtual table for full-text search
- **Projects, settings, pending states** — migrated from JSON to SQLite tables

**FTS5 search**: `chat_messages_fts` uses `content` + `chat_id UNINDEXED` columns. Triggers auto-sync on insert/update/delete. `searchChatMessages()` supports phrase match fallback to term search, scoped to single chat or global. The `search_conversation` tool exposes this to the agent.
