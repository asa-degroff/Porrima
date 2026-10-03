# Architecture

## Chat Types

Two chat types: **agent** (memory-augmented) and **system** (synthesis, wake cycles, and automations). The built-in system chat is a singleton (id `"system"`) created on server startup; synthesis and wake cycles append to it, and the user can view/interact with it through the sidebar like any other chat. Custom automations can create additional `system` chats such as `automation:<id>`. Existing chats without a `type` field default to "agent".

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
- **Settings**: `llamacppEnabled`, `llamacppUrl` control llama.cpp integration. `favoriteModels`, `showOnlyFavorites` for model selector filtering.

## llama.cpp Infrastructure

Five dedicated llama.cpp server roles, each managed as a systemd user service with its own port, mode, and configuration:

| Role | Service Unit | Port | Default Mode | GPU |
| --- | --- | --- | --- | --- |
| Inference | `llama-server.service` | 32100 | router | yes (`--split-mode tensor`) |
| Extraction | `extraction-model.service` | 32101 | single | no |
| Reranker | `reranker.service` | 32102 | single | no |
| Embedding | `embedding-model.service` | 32103 | single | no |
| Title generation | `title-generation.service` | 32104 | single | no |

- **Symlink-based binary management** (`llama-path.ts`): All services reference `~/bin/llama-current` as their binary path. Updating the llama.cpp build is a single symlink swap (`ln -sfn`) followed by a service restart. `updateLlamaPath()` handles the swap, `systemctl daemon-reload`, service restart, health polling (8s timeout per service), and automatic rollback if any service fails to come up. Note the restart list is **four** units — `llama-server`, `reranker`, `extraction-model`, `title-generation`; `embedding-model.service` is not included, so a build swap leaves the embedding server on the previous binary.
- **Slot leases** (`llama-slot-leases.ts`): An optional allocator for llama.cpp router slots. `acquire()` finds a free slot, else evicts the least-recently-used inactive chat, and returns a lease of `{ slotId, maxInstances, evictedChatId }`. Capacity comes from `GET /props` → `max_instances` (cached 5 min). Pools are keyed by `(baseUrl, modelId, contextWindow)` but sharing is coordinated *across* pools on the same base URL. Bindings persist to `~/.porrima/llama-slot-bindings.json`, and "fossil" bindings are purged after 24h. **Off by default** — it only engages when `settings.llamacppSlotBindingMode === "enforced"` (or the `LLAMACPP_ID_SLOT` env var is set); otherwise `acquire()` returns `null` and llama.cpp picks slots itself.
- **Prompt-cache residency** (`llama-cache-residency.ts`): Tracks observed KV-cache state per chat as `warming | warm | stale` with a confidence of `confirmed-hit | partial-hit | filled-after-miss | unknown` (hit ratios above 0.9 / 0.5). `markLlamaCachePrefillComplete()` flips `warming` → `warm` at generation start. Records expire to `stale` after 12h and are deleted after a further 24h grace, with a global cap of 256 and a per-pool warm cap of 4 (overridable via `LLAMACPP_CACHE_RESIDENCY_LIMIT`, `_TTL_MS`, `_REMOVAL_GRACE_MS`). `checkLlamaServerRestart()` wipes every record for a base URL when the systemd PID changes, so a crash or model swap cannot leave phantom warmth. This feeds the sidebar warming spinners and the manual "warm cache" action.
- **Cache warming** (`cache-warm.ts`, `cache-warm-queue.ts`): Queues targeted prompt warms. After a successful synthesis cycle the queue reads capacity from llama.cpp capacity (`/props.max_instances`, falling back to the configured inference `parallel`) and builds a prioritized plan: synthetic new-agent-chat baseline first, system chat second, then recent agent chats. Execution warms lower-priority recent chats *first* and the baseline *last*, so llama.cpp's `--kv-unified` longest-prefix selection can reuse that baseline for new global chats.
- **Per-slot binary overrides** (`llama-launch-templates.ts`): Each slot can use a different binary via `settings.llamaServerBins[slotId]`. Custom binaries (e.g. an ik_llama fork with dynamic `.so` libraries) automatically get `LD_LIBRARY_PATH` injected pointing to their directory. Binary resolution order: override in settings → systemd drop-in → hardcoded default (`~/bin/llama-current/llama-server`).
- **Service configuration** (`llama-service-config.ts`): Per-slot defaults for mode, ctx size, parallelism, extra args, and environment. `mergeServiceConfig()` overlays user settings onto defaults. `renderServiceExecStart()` builds the full command line; `renderManagedDropIn()` writes a `zz-porrima-managed.conf` systemd drop-in override. `parseManagedServiceConfig()` reverse-parses a running service's ExecStart back into a config object.
- **Service supervisor** (`llama-supervisor.ts`): Queries systemd for live process state (PID, active state, fragment path, working directory), HTTP health (`/health`, `/v1/models`), and override status. Detects server restarts by PID change to invalidate KV cache residency tracking. Supports start/stop/restart actions and journal log retrieval.
- **Model directory structure**: Each model in a subdirectory under `~/.local/share/llama-models/` with the GGUF + optional mmproj file for vision. Router auto-detects `mmproj*` files.
- **Auto-sync** (`sync-llama-models.sh` + `sync-llama-models.timer`): Every 5 min, scans `~/.cache/huggingface/` for new GGUF downloads, creates symlinked subdirectories, restarts llama-server if new models found. Excludes reranker/embedding models.

## Memory Services

Memory services are in `server/src/services/memory-*.ts`. Simple one-shot LLM calls still use `streamChat()` from `agent.ts` (extraction, compaction indexing, archive descriptions). Tool-loop conversations use `runAgentLoop()` through the chat route or `runHeadlessChatTurn()`.

**Memory extraction** is deferred during active tool loops — queued and executed after the agent loop completes to prevent concurrent LLM calls from interfering with the active conversation (e.g., triggering model reloads on llama.cpp).

**Synthesis** runs inside the persistent system chat (`server/src/services/system-chat.ts`) using the main model with full tool access. Synthesis is now a built-in automation, so scheduler dispatch flows through `automation-scheduler.ts` / `automation-runner.ts`, while manual memory endpoints remain for direct dispatch. Synthesis is serialized against user chat via the `synthesisLock` mutex: the chat route awaits `getSynthesisLock()` before processing user messages, and the scheduler's enrichment/delayed-extraction passes skip while `isSynthesisActive()` is true. See [memory-system.md](memory-system.md) § Synthesis.

## Observability

Three sampling subsystems feed a debug UI and each writes to its own store.

- **System telemetry** (`system-stats.ts`): Polls every 2s into a 60s circular buffer, sampling per-GPU AMD/NVIDIA/Intel metrics keyed by **PCI address** (so a device keeps its identity across reorderings), with a PCI-codename → LLVM-gfx table for AMD and NVIDIA/CDNA. `PATCH /api/system-stats` mutates exactly two things — `bufferSeconds` and `hiddenGpus` — and does so in process-local module state, **not** in settings, so both are lost on restart. (The `systemStatsEnabled` / `systemStatsBufferSeconds` / `systemStatsHiddenGpus` fields in `types.ts` are declared but never read; polling starts unconditionally.)
- **Model stats** (`model-stats.ts`): Per-request rows of token counts and timings, retaining 50 runs per model. `resolveCanonicalCachedTokens()` resolves the reported-vs-delta divergence between llama.cpp's `prompt_tokens` and the local prompt-eval counters, guarded by a one-warning-per-model canary so a persistent divergence is visible without spamming. This is the same data behind the prompt-cache observability in the Model Stats modal.
- **Reranker stats** (`reranker-stats.ts`): Per-call reranking samples (model used, latency, document count, top-N, score distribution, plus `chatType` and `source` for attribution), retaining 100 runs.

Both stats services open `~/.porrima/porrima.db` **directly** rather than through a shared `getDb()` handle, keeping observability writes out of the main `app.db` transaction path.

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

1. **Pre-send compaction** (three triggers → 30% target): Proactively truncates before the LLM call. Decoupling the trigger from the target prevents a second compaction from firing immediately at end-of-turn in the same exchange. The three triggers are the normal 0.85 check against the usage-anchored `refinedTokens`, an anchor-bounded hard-cap estimate above **0.95**, and a pure char estimate above **1.15** of the window (the char band is looser than the hard cap because char estimation is the less trustworthy estimator).
2. **Post-response compaction** (**0.80** trigger → 30% target): Triggered after the response if usage is high. It fires *earlier* than pre-send's 0.85 because it runs while the user is reading rather than waiting.
3. **Mid-turn compaction** (85% threshold, 95% hard cap): Detects overflow during tool loops, breaks the agent loop, compacts, and resumes with a handoff message. Up to 5 cycles on the HTTP path, **3** on the headless path.
4. **Hard-cap safety pass**: a defensive net inside the pre-send path. If `hardCapTokens` (the anchor-bounded upper bound, *not* the char estimate alone) exceeds 0.95, **or** the pure char estimate `pathBTokens` exceeds 1.15, it forces `truncateChatHistory(forceCompact=true)` targeting 30% — so a blown anchor can't mask an oversized real payload.

The primitive itself does: **collect removed → await `onBeforeArchive` (the memory flush) → archive & index → mark `_outOfContext` / clear stale `usage` → splice the summary**. The flush runs *before* index generation on purpose, so it continues the extraction session's cached prompt rather than having it evicted. Index descriptions are written in `sync` mode (end-of-turn, mid-turn, `/compact`) or `deferred` mode (pre-send, where a mechanical description is written immediately and an LLM enrichment runs in the background) so the user's turn is never blocked on the CPU model.

The memory-context reset and prompt rebuild are **caller-owned aftermath**, not part of the primitive:

1. **Soft reset** (`softResetMemoryContext`): clears `deltaIds`, marks dirty. `frozenIds` and the frozen memories section are retained **byte-exact** — the next build is a Case 3 delta, not a Case 1 freeze. A hard `resetMemoryContext` is no longer used after compaction; it survives only for chat deletion, automation start, zeitgeist rewrite, and cache-warm preparation. (Re-rolling the frozen set at compaction was pure nondeterminism — a 5 → 4 → 0 → 3 sequence was observed in one night — which broke the prefix at the section boundary and orphaned the KV pool each time.)
2. **Rebuild** (`buildSplitAugmentedPrompt`): re-retrieves, so memories just extracted by the flush are eligible.

One consequence of the stale-`usage` strip is easy to miss: immediately after any compaction the estimator has **no** usage anchor, so `selectedPath` falls back to `char_estimate` and only the 0.95 hard cap is live until the next provider call reports usage.

The memory flush is **HTTP-only**: the chat route passes `preCompactionFlush` as the `onBeforeArchive` hook, while headless paths (synthesis, wake, automation, headless mid-turn) pass `undefined` and skip it. See [docs/compaction.md](compaction.md) for the full path matrix and the delta-delivery model.

**Context estimation** returns the max of two paths: **Path A** anchors on the last in-context assistant's reported `usage.totalTokens` and adds char-estimates for anything added since; **Path B** is a pure char-based estimate of the full system prompt + in-context messages + tool schemas. Path A wins in steady state (it captures framing/tokenizer overhead char estimation misses). Path B wins when the anchor has gone stale — the system prompt grew, AGENTS.md / persona / memory blocks expanded, tool schemas changed, or (most commonly right after a compaction) the anchor was stripped entirely.

## Turn Gate (`turn-gate.ts`)

There is **one global turn slot**, not one per chat. A module-global state holds a single `active` lease plus a FIFO `waiters` queue, deliberately stashed on `globalThis` so it survives dev-mode module reloads.

- **Lease kinds**: `chat`, `system`, `cache-warm`. Kinds are informational; capacity is one slot.
- **Priority**: waiters carry a foreground/background class, and a foreground waiter is spliced ahead of queued background cache warms.
- **Abortable waits**: `acquireTurn()` wires the wait to the live stream's abort signal, so a client disconnect releases a queued turn.
- **Heartbeat and stale-lease recovery**: healthy turns touch the lease every loop iteration, every LLM stream event, and during compaction keepalives. A lease silent for `TURN_GATE_STALE_LEASE_MS` (15 min) is considered dead and is stolen by the next acquire, with a 60s reaper sweep as a backstop. `isTurnGateBusy()` deliberately *ignores* stale leases.
- **Five acquire sites, and the lease is not held for the whole turn**: `acquireTurnGate` is called for send, resume, `/edit`, follow-up re-acquire, and artifact repair. Before end-of-turn compaction the lease is **released early** when a separate extraction model is configured (that work is CPU-only), then re-acquired for a queued follow-up.

This is the outer serialization point: automation runs acquire the turn lease *before* the automation lock, which is why a manual automation run queues behind an in-flight user turn rather than failing.

## Live Streams & Reconnect (`live-streams.ts`)

The SSE registry that makes a turn reconnectable. Buffer replay has been **retired entirely** (the old up-to-10 MB per-turn buffer and its `?replay` parameter are gone) — reconnection is snapshot-based, not replay-based.

- **Resync snapshot contract**: each stream owner installs a `buildResync` hook that returns the current state to splice into a reconnecting client. Three owners: the chat route's queue state, its turn tail, and the headless `SynthesisEmitter`. This is why `/api/chat/reconnect/:chatId` works for the system chat too.
- **Pending turn intents**: registered synchronously at request entry, so `POST /api/chat/stop` can abort a turn that is still doing pre-stream work (prompt construction, memory retrieval, pre-send compaction) and has no live stream yet.
- **Ownership guards**: `endLiveStreamIfCurrent` / `closeLiveSSEIfCurrent` exist because a superseded turn's late teardown would otherwise close the *newer* turn's stream.
- **Retention**: ended streams are kept for `LIVE_END_RETENTION_MS` (60s).
- `GET /api/chat/status/:chatId` is the liveness probe and optionally folds a message window into the same response (`?includeWindow=1`, and only when a stream is actually live) — that is what makes "is it still going, and what did I miss" a single round trip on refresh.

`synthesis-stream.ts` (`SynthesisEmitter`) is a deliberate re-implementation of the chat route's wire format frame-for-frame, which is the other half of why system-chat reconnect works. It installs a headless `LiveStream` with a 10s keepalive comment so the client's 95s inactivity timer doesn't fire during model loads; splices a tool result immediately after its matching `tool_call` segment so visuals produced during the run stay after the pair; refuses zero-token usage so a thinking-only iteration doesn't blank the TokenIndicator; and reads pending text *without flushing* it when building a resync payload so segment boundaries survive the reconnect.

## Context Accounting: Three Systems

Three modules with confusingly similar names do three different jobs. They are not interchangeable.

| Module | Job | Feeds |
| --- | --- | --- |
| `context-pressure.ts` | The **trigger estimator**. Returns `estimatedTokens` / `refinedTokens` / `hardCapTokens` + `selectedPath`, plus `evaluateTurnGuards()` (iteration caps) and `midTurnPressureDecision()`. | Compaction and turn-guard decisions |
| `context-high-water.ts` | A **denominator floor**, not an estimator. `recordContextObservation()` is fed at stream end and `getContextWindowFloor()` floors the *discovered* window, keyed by `(chatId, modelId, baseUrl)`. Survives compaction, resets on model swap. Exists because model discovery under-reports `--ctx`, which otherwise pushes every ratio above 1.0. | `getEffectiveContextWindow()` |
| `context-breakdown.ts` | A **display-only attribution view**. Called solely from `GET /api/chats/:id/context-breakdown`, and it rescales input-side rows so they sum exactly to the LLM-reported input. | The TokenIndicator breakdown popover |

`context-breakdown` is a read-out, not a decision input. Do not wire it into a trigger.

## GPU Coordination

VRAM management:

- **llama.cpp model loading**: `ensureModelLoaded()` handles load/unload/reload cycles for model swaps
- **Idle unloading**: llama.cpp `--sleep-idle-seconds 172800` permits long-idle unloading without clearing the prompt cache between ordinary follow-up messages
- **Tool result limits**: Dynamic truncation scaled to 15% of context window (min 8k chars)
