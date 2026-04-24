# Architecture

## Chat Types

Four chat types: **agent** (memory-augmented), **quick** (standalone), **bluesky** (social media integration), and **system** (synthesis and reflection). The system chat is a singleton (id `"system"`) created on server startup; synthesis cycles append to it, and the user can view/interact with it through the sidebar like any other chat. Existing chats without a `type` field default to "quick".

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) orchestrates:
1. Memory context augmentation (agent chats only)
2. LLM streaming via pi-ai (`streamChat`)
3. Memory tool parsing and execution (agent chats only)
4. Deferred memory extraction after the agent loop completes (prevents concurrent LLM calls)
5. Mid-turn compaction with indexed archival when token usage > 85% during tool loops
6. Multi-cycle compaction loop (up to 5 cycles) for long-running tasks
7. Handoff messages for post-compaction continuity

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
- **OpenAI-Compatible** (`openai-compat-provider.ts`): Registers with pi-ai for OpenAI-format APIs (llama.cpp and vLLM)
  - SSE parser for OpenAI streaming format
  - Incremental tool call handling with argument accumulation
  - Support for `reasoning_content` field (thinking blocks via `--reasoning-format deepseek`)
  - `chat_template_kwargs: {"enable_thinking": true}` for Qwen models; `/think` directive prepended to system prompt for Gemma models
  - Vision model support with base64 image encoding (OpenAI content parts format)
  - Router mode model management: `ensureModelLoaded()` handles load/unload/reload; `waitForModelReady()` polls `/v1/models` status; `waitForModelUnloaded()` ensures clean transitions
  - Retry on transient fetch failures (3 attempts, 1s delay) for TCP connection hiccups between rapid tool iterations
  - Ollama VRAM cleanup before model loads — unloads Ollama models via `/api/ps` to prevent GPU memory contention
- **Model Discovery** (`models.ts`): `discoverAllModels()` queries enabled Ollama, llama.cpp, and vLLM servers, tags each model with `provider: "ollama"`, `provider: "llamacpp"`, or `provider: "vllm"`. HF-cached llama.cpp models (IDs with `/`) are filtered out. `createPiModelFromProvider()` routes to the correct pi-ai API provider. Vision detection uses `/props` modalities for loaded llama.cpp models and name heuristics for unloaded/OpenAI-compatible models.
- **Reasoning Detection**: `supportsReasoning()` checks model family (`qwen3*`, `gemma4*`) — enables `think: true` for Ollama, `chat_template_kwargs` for llama.cpp
- **Settings**: `llamacppEnabled`, `llamacppUrl`, `llamacppSharesGpu` control llama.cpp integration; `vllmEnabled`, `vllmUrl` control vLLM integration. `favoriteModels`, `showOnlyFavorites` filter model selectors.

## llama.cpp Infrastructure

- **Router mode** (`llama-server.service`): Serves models from `~/.local/share/llama-models/` with dynamic loading/unloading. Config: `--ctx-size 131072`, `--parallel 1`, `--n-gpu-layers auto`, `--reasoning-format deepseek`, `--sleep-idle-seconds 300`
- **Model directory structure**: Each model in a subdirectory with the GGUF + optional mmproj file for vision. Router auto-detects `mmproj*` files.
- **Auto-sync** (`sync-llama-models.sh` + `sync-llama-models.timer`): Every 5 min, scans `~/.cache/huggingface/` for new GGUF downloads, creates symlinked subdirectories, restarts llama-server if new models found. Excludes reranker/embedding models.
- **Reranker service** (`reranker.service`): Dedicated Qwen3-Reranker-0.6B instance on port 8082, CPU-only, for memory retrieval reranking.
- **Title generation**: Uses Ollama with `num_gpu: 0` and `keep_alive: "0s"` — forced to CPU to avoid VRAM contention with larger models.

## Memory Services

Memory services are in `server/src/services/memory-*.ts`. They share the pi-ai `streamChat` function for LLM calls (extraction, synthesis, tool execution all use it with different system prompts).

**Memory extraction** is deferred during active tool loops — queued and executed after the agent loop completes to prevent concurrent LLM calls from interfering with the active conversation (e.g., triggering model reloads on llama.cpp).

**Synthesis** runs inside the persistent system chat (`server/src/services/system-chat.ts`) using the main model with full tool access. Synthesis is serialized against user chat via the `synthesisLock` mutex: the chat route awaits `getSynthesisLock()` before processing user messages, and the scheduler's enrichment/delayed-extraction passes skip while `isSynthesisActive()` is true. See [memory-system.md](memory-system.md) § Synthesis.

## Chat Storage

Chat storage uses SQLite (`server/src/services/chat-storage.ts`). The `app.db` database stores:
- **Chats** — metadata + JSON `messages` column (hybrid approach: normalized metadata, JSON for nested arrays)
- **Chat messages** — denormalized `chat_messages` table with FTS5 virtual table for full-text search
- **Context archives** — `context_archives` table with FTS5 for indexed compaction (cross-chat searchable). Archives are created two ways: (a) during compaction, when messages are rolled out of the active context, and (b) by `pre-synthesis-archive.ts` before each synthesis cycle, which writes archives (with LLM-generated one-line `indexEntry` descriptions) for recent unarchived agent chats so the synthesis agent has full-fidelity access via `read_archived_context`.
- **Projects, settings, pending states** — SQLite tables

**FTS5 search**: `chat_messages_fts` and `context_archives_fts` both support phrase match with fallback to term search. The `search_conversation` tool searches both current messages AND archived context, with archive results showing dereferenceable IDs.

## Compaction & Indexed Archival

Compaction replaces narrative LLM summaries with **indexed archives** (inspired by Memex and Letta):

1. **Pre-send compaction** (80% trigger → 50% target): Proactively truncates before LLM call. Decoupling the trigger from the target prevents a second compaction from firing immediately at end-of-turn in the same exchange.
2. **Post-response compaction** (50% target): Triggered after response if usage is high
3. **Mid-turn compaction** (85% threshold): Detects overflow during tool loops, breaks the agent loop, compacts, and resumes with a handoff message. Multi-cycle (up to 5 cycles) for very long tasks.
4. **Hard-cap safety pass** (95% char-estimate): Defensive net that runs after the pre-send path. If the pure char-based estimate alone exceeds 95% of the window (e.g., the usage anchor went stale because the system prompt grew), forces aggressive compaction via `truncateChatHistory(forceCompact=true)` targeting 50%.

When compaction runs, it follows a strict sequence: **archive** → **flush** → **reset** → **rebuild**:

1. **Archive & Index**: Messages grouped into logical blocks, stored in `context_archives` with FTS5. LLM generates one-line descriptions per block.
2. **Memory Flush** (`preCompactionFlush`, awaited): Extracts atomic memories from removed messages, processes block updates (importance ≥ 7), deduplicates against existing memories.
3. **Reset** (`resetMemoryContext`): Clears delta tracking state so the next prompt build does a full retrieval.
4. **Rebuild** (`buildSplitAugmentedPrompt`): Full retrieval includes freshly extracted memories, frozen into system prompt.

See [docs/compaction.md](compaction.md) for full details.

**Context estimation** returns the max of two paths: **Path A** anchors on the last in-context assistant's reported `usage.totalTokens` and adds char-estimates for anything added since; **Path B** is a pure char-based estimate of the full system prompt + in-context messages + tool schemas. Path A wins in steady state (it captures framing/tokenizer overhead char estimation misses). Path B wins when the anchor has gone stale — system prompt grew after a `resetMemoryContext` re-froze memories, AGENTS.md / persona / memory blocks expanded, or tool schemas changed. The hard-cap safety pass uses Path B alone, so a blown anchor can't mask an oversized real payload.

## GPU Coordination

VRAM management across Ollama, llama.cpp, and ComfyUI:

- **ComfyUI generation**: `waitForFreeVRAM()` checks `/system_stats` for free VRAM, unloads all LLM models (Ollama via `/api/ps` + llama.cpp via `/v1/models`) if insufficient, polls every 3s until 6GB free
- **llama.cpp model loading**: `ensureModelLoaded()` unloads Ollama models before loading to maximize GPU offloading
- **Idle unloading**: llama.cpp `--sleep-idle-seconds 300` auto-unloads after 5 min of inactivity
- **Tool result limits**: Dynamic truncation scaled to 15% of context window (min 8k chars)
