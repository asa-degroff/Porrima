# Architecture

## Chat Types

Three chat types: **agent** (memory-augmented), **quick** (standalone), and **system** (synthesis, wake cycles, and automations). The built-in system chat is a singleton (id `"system"`) created on server startup; synthesis and wake cycles append to it, and the user can view/interact with it through the sidebar like any other chat. Custom automations can create additional `system` chats such as `automation:<id>`. Existing chats without a `type` field default to "quick".

The server is the integration hub. The chat route (`server/src/routes/chat.ts`) owns HTTP-specific behavior:
1. Memory context augmentation (agent chats only)
2. SSE emission and reconnectable live-stream state
3. Tool status and artifact/visual/image side effects
4. Deferred memory extraction after the agent loop completes (prevents concurrent LLM calls)
5. Mid-turn compaction with indexed archival when token usage > 85% during tool loops
6. Multi-cycle compaction loop (up to 5 cycles) for long-running tasks
7. Handoff messages for post-compaction continuity

The core pi-agent loop is shared through `server/src/services/agent-loop-runner.ts`. The chat route passes route-owned callbacks for steering messages, follow-up messages, SSE emission, persistence, and compaction. Headless system/automation turns use the same low-level runner through `chat-turn-runner.ts`.

## Projects

Projects provide persistent context for agent chats through AGENTS.md files:
- Created via UI or API, stored in `~/.porrima/projects/`
- Each project has a name, filesystem path, and optional AGENTS.md
- New chats in a project automatically inject AGENTS.md content into the system prompt
- Chats within projects are grouped under their project in the UI
- The agent uses `list_files`, `read_file`, etc. tools to explore the project structure
- UI features: color customization per project, pin/unpin, path validation with permissions checking, directory creation
- `project-storage.ts` provides filesystem utility for reading AGENTS.md from project directories

## LLM Provider Architecture

Multi-provider system supporting multiple inference backends through pi-ai's provider abstraction:

- **OpenAI-Compatible** (`openai-compat-provider.ts`): Registers with pi-ai for OpenAI-format APIs (llama.cpp)
  - SSE parser for OpenAI streaming format
  - Incremental tool call handling with argument accumulation
  - Support for `reasoning_content` field (thinking blocks via `--reasoning-format deepseek`)
  - `chat_template_kwargs: {"enable_thinking": true}` for Qwen models; `/think` directive prepended to system prompt for Gemma models
  - Vision model support with base64 image encoding (OpenAI content parts format)
  - Router mode model management: `ensureModelLoaded()` handles load/unload/reload; `waitForModelReady()` polls `/v1/models` status; `waitForModelUnloaded()` ensures clean transitions
  - Retry on transient fetch failures (3 attempts, 1s delay) for TCP connection hiccups between rapid tool iterations
- **Model Discovery** (`models.ts`): `discoverAllModels()` queries the llama.cpp server via `/v1/models`, tags each model with `provider: "llamacpp"`. HF-cached models (IDs with `/`) are filtered out. `createPiModelFromProvider()` creates openai-compat models. Vision detection uses `/props` modalities for loaded models, `--mmproj` args and name heuristics for unloaded.
- **Reasoning Detection**: `supportsReasoning()` checks model family (`qwen3*`, `gemma4*`) — enables `chat_template_kwargs` for llama.cpp
- **Settings**: `llamacppEnabled`, `llamacppUrl`, `llamacppSharesGpu` control llama.cpp integration. `favoriteModels`, `showOnlyFavorites` for model selector filtering.

## llama.cpp Infrastructure

- **Router mode** (`llama-server.service`): Serves models from `~/.local/share/llama-models/` with dynamic loading/unloading. Config: `--ctx-size 131072`, `--parallel 1`, `--n-gpu-layers auto`, `--reasoning-format deepseek`, `--sleep-idle-seconds 172800`
- **Model directory structure**: Each model in a subdirectory with the GGUF + optional mmproj file for vision. Router auto-detects `mmproj*` files.
- **Auto-sync** (`sync-llama-models.sh` + `sync-llama-models.timer`): Every 5 min, scans `~/.cache/huggingface/` for new GGUF downloads, creates symlinked subdirectories, restarts llama-server if new models found. Excludes reranker/embedding models.
- **Reranker service** (`reranker.service`): Dedicated Qwen3-Reranker-0.6B instance on port 8082, CPU-only, for memory retrieval reranking.
- **Title generation**: Uses a dedicated CPU-only llama.cpp instance with `keep_alive: "0s"` to avoid VRAM contention with larger models.

## Memory Services

Memory services are in `server/src/services/memory-*.ts`. Simple one-shot LLM calls still use `streamChat()` from `agent.ts` (extraction, compaction indexing, archive descriptions). Tool-loop conversations use `runAgentLoop()` through the chat route or `runHeadlessChatTurn()`.

**Memory extraction** is deferred during active tool loops — queued and executed after the agent loop completes to prevent concurrent LLM calls from interfering with the active conversation (e.g., triggering model reloads on llama.cpp).

**Synthesis** runs inside the persistent system chat (`server/src/services/system-chat.ts`) using the main model with full tool access. Synthesis is now a built-in automation, so scheduler dispatch flows through `automation-scheduler.ts` / `automation-runner.ts`, while manual memory endpoints remain for direct dispatch. Synthesis is serialized against user chat via the `synthesisLock` mutex: the chat route awaits `getSynthesisLock()` before processing user messages, and the scheduler's enrichment/delayed-extraction passes skip while `isSynthesisActive()` is true. See [memory-system.md](memory-system.md) § Synthesis.

## Automations

Automations are stored in `automation_tasks` and `automation_runs` in `app.db`, exposed via `/api/automations`, and configured from Settings. Built-ins provide synthesis and wake cycle defaults; users can add custom recurring tasks with interval or daily schedules, ordered execution, editable prompt steps, activation policies, run history, and optional push notifications.

The automation scheduler checks every 5 minutes and starts at most one due task per tick. It skips while another automation, synthesis, wake cycle, or user chat is active. A global automation lock guards manual and scheduled runs, and failures use exponential backoff; custom tasks are disabled after repeated failures.

Custom automations append trigger/follow-up prompts as user-role messages in their system chat, build the stable prefix with `buildStablePrefix()`, run pre-send compaction before dispatch, and then execute through the shared headless chat turn runner. Keeping automation prompt text out of the system prompt preserves the longest-common-prefix KV cache for the stable system-chat prefix. See [automations.md](automations.md).

## Chat Storage

Chat storage uses SQLite (`server/src/services/chat-storage.ts`). The `app.db` database stores:
- **Chats** — metadata + JSON `messages` column retained as a compatibility snapshot for existing `Chat.messages` callers
- **Chat message rows** — full-fidelity per-message rows in `chat_message_rows`, keyed by `(chat_id, sequence)`. This is the authoritative source when populated and supports paged message-window reads for long-running chats.
- **Chat messages** — denormalized `chat_messages` table with FTS5 virtual table for full-text search
- **Context archives** — `context_archives` table with FTS5 for indexed compaction (cross-chat searchable). Archives are created two ways: (a) during compaction, when messages are rolled out of the active context, and (b) by `pre-synthesis-archive.ts` before each synthesis cycle, which writes archives (with LLM-generated one-line `indexEntry` descriptions) for recent unarchived agent chats so the synthesis agent has full-fidelity access via `read_archived_context`.
- **Automations** — `automation_tasks` stores built-in/custom task configuration; `automation_runs` stores status, summary/error, tool-call count, chat ID, and assistant message index for audit history.
- **Projects, settings, pending states** — SQLite tables

The chat API returns a recent message window by default when requested with `messageLimit`; older windows are loaded via `GET /api/chats/:id/messages?before=<sequence>&limit=<n>`. The client keeps absolute message indexes through `messageOffset`, so edit/retry and search jump behavior still refer to persisted sequence positions rather than the local array index.

Tool-loop persistence is canonicalized to match the live pi-ai transcript: each assistant `toolUse` stop is saved as its own assistant row with only that iteration's `toolCalls`/`toolResults`, grouped with `_toolLoopId` and marked `_toolLoopFragment`. The final assistant text is a later row in the same group. This preserves llama.cpp longest-common-prefix KV cache matching on follow-up turns because replay no longer collapses an interleaved live loop into one byte-different assistant row. See [chat-message-architecture.md](chat-message-architecture.md).

Memory augmentation has two cache-preserving paths. Normal turn-start retrieval freezes memories into the stable system prompt or appends new memories as a delta before the next user message. Passive mid-turn recall runs during agent/tool loops: fast hybrid search and MMR accumulate candidates, the slower reranker filters a small batch, and selected memories are persisted as hidden system rows while live-injected as synthetic user-role context at the same transcript boundary replay will reconstruct later. This lets long autonomous turns recall relevant memory without changing the stable system prompt or creating byte-different replay.

**FTS5 search**: `chat_messages_fts` and `context_archives_fts` both support phrase match with fallback to term search. The `search_conversation` tool searches both current messages AND archived context, with archive results showing dereferenceable IDs.

## Compaction & Indexed Archival

Compaction replaces narrative LLM summaries with **indexed archives** (inspired by Memex and Letta):

1. **Pre-send compaction** (85% trigger → 30% target): Proactively truncates before LLM call. Decoupling the trigger from the target prevents a second compaction from firing immediately at end-of-turn in the same exchange.
2. **Post-response compaction** (85% trigger → 30% target): Triggered after response if usage is high
3. **Mid-turn compaction** (85% threshold): Detects overflow during tool loops, breaks the agent loop, compacts, and resumes with a handoff message. Multi-cycle (up to 5 cycles) for very long tasks.
4. **Hard-cap safety pass** (95% char-estimate): Defensive net that runs after the pre-send path. If the pure char-based estimate alone exceeds 95% of the window (e.g., the usage anchor went stale because the system prompt grew), forces aggressive compaction via `truncateChatHistory(forceCompact=true)` targeting 30%.

When compaction runs, it follows a strict sequence: **archive** → **flush** → **reset** → **rebuild**:

1. **Archive & Index**: Messages grouped into logical blocks, stored in `context_archives` with FTS5. LLM generates one-line descriptions per block.
2. **Memory Flush** (`preCompactionFlush`, awaited): Extracts atomic memories from removed messages, processes block updates (importance ≥ 7), deduplicates against existing memories.
3. **Reset** (`resetMemoryContext`): Clears delta tracking state so the next prompt build does a full retrieval.
4. **Rebuild** (`buildSplitAugmentedPrompt`): Full retrieval includes freshly extracted memories, frozen into system prompt.

See [docs/compaction.md](compaction.md) for full details.

**Context estimation** returns the max of two paths: **Path A** anchors on the last in-context assistant's reported `usage.totalTokens` and adds char-estimates for anything added since; **Path B** is a pure char-based estimate of the full system prompt + in-context messages + tool schemas. Path A wins in steady state (it captures framing/tokenizer overhead char estimation misses). Path B wins when the anchor has gone stale — system prompt grew after a `resetMemoryContext` re-froze memories, AGENTS.md / persona / memory blocks expanded, or tool schemas changed. The hard-cap safety pass uses Path B alone, so a blown anchor can't mask an oversized real payload.

## GPU Coordination

VRAM management:

- **llama.cpp model loading**: `ensureModelLoaded()` handles load/unload/reload cycles for model swaps
- **Idle unloading**: llama.cpp `--sleep-idle-seconds 172800` permits long-idle unloading without clearing the prompt cache between ordinary follow-up messages
- **Tool result limits**: Dynamic truncation scaled to 15% of context window (min 8k chars)
