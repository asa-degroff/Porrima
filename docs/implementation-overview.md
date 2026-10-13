# Porrima Implementation Overview

## Core Architecture
npm workspaces monorepo. `server/`: Express + TS (3001). `client/`: React + Vite + Tailwind v4 (5173).
Services: llama.cpp chat router (32100, GPU), extraction (32101, CPU), reranker (32102, CPU), embedding (32103, CPU), title generation (32104, CPU).
Inference model: **per-user config** (llama-server service / Settings → Inference Servers) — no model is pinned in the repo. This deployment prioritizes intelligence over raw speed.
**Speculative decoding is workload-dependent** — code generation gains enormously, open-ended conversation minimally. The mechanism and speedup depend on the model and decoding mode configured per deployment (dense vs MoE, MTP vs n-gram).
Synthesis: four-phase cycle, pre-synthesis archiving, synthesis lock. `SynthesisEmitter` wraps headless LiveStream for SSE streaming.
Sleep cycle: button is a "release" signal (stamps `sleepModeTriggeredAt`, 2h synthesis cooldown). Inactivity is anchored by `lastAgentCompletedAt` or completed foreground interactions (`lastUserInteractionAt`) while still treating newer chat sends as pending until the assistant completes. Logic in `sleep-cycle.ts`.
Wake cycle: autonomous exploration on inactivity (15-min check, 20-iter cap, 30-min timeout). Mutual exclusivity enforced.

## Chat System
Two types: agent (memory-augmented) and system (synthesis, wake cycles, automations). `chat.ts`: memory augmentation, LLM streaming, tools (pi-ai native, `ask_user` persists with optional `options` (2–6 normalized answers) that ride the SSE event, the pending-state row, and `/chat/status` so the client's answer picker survives refresh; 500-iteration guard in the HTTP route). SQLite + FTS5, multi-provider.
Stranded tool recovery: detects `<function=` in thinking after stopReason="stop", triggers continuation.
SSE via the reconnectable `LiveStream` registry (`live-streams.ts`). Buffer replay has been **retired entirely** — reconnection is snapshot-based, not replay-based, and ended streams are retained for 60s. Mid-turn compaction resumes via `runAgentLoop({ mode: "continue", context: activeContext })`, not a callback. Pending turn intents are registered at request entry so `/stop` can abort a turn that hasn't started streaming yet.
Activity stamping: chat sends stamp `lastUserActivityAt` and `lastUserInteractionAt` before synthesis wait; assistant responses stamp `lastAgentCompletedAt` after `done` (non-system only). Non-chat foreground actions such as manual cache pre-warm stamp `lastUserInteractionAt`.
**Recap**: long assistant messages (>1500 chars) get 15-40 word summary via Qwen 3.5 0.8B. `callServer` accepts optional `maxTokens` (default 30; recaps pass 80). Persisted on message row, sent via SSE `done`, displayed as italic with `▸` marker. Push notifications use recap as body. Fire-and-forget, 15s timeout.
**Thinking block toggle**: `onMessageComplete` preserves thinking visibility across tool-loop SSE fragments — doesn't clear `streamingThinking` during inter-fragment gaps.
**Turn gate** (`turn-gate.ts`): a global FIFO single-slot scheduler serializes every GPU-bound turn (user chats, artifact repair, automation/system-chat turns) on one lease — the inference server processes one session at a time. Cache-warm prefills take the same lease at background priority; a foreground turn preempts a running warm. Queued turns wait FIFO: the HTTP route keeps the SSE open and emits `waiting` events until the lease is granted, then `turn_start`. State lives on `globalThis` so tsx watch reloads don't drop an active lease.
**Request viewer** (`request-log.ts`): wire-level per-request capture at the provider choke point — every LLM request/response is recorded per chat (blobs deduplicated) and served by `/api/llm-requests` (list/detail/clear).

## Python Execution
`run_python` executes in a **persistent per-chat kernel** (`python-kernel.ts`) — variables and imports survive across calls, failures, and timeouts, and top-level `await` is supported. Long work (`background: true`) returns a job id immediately without holding the turn; `python_jobs` inspects/controls those jobs (list/status/tail/kill; kill escalates to a kernel kill only with `force`). Output spills to disk past a size cap. `sandbox.ts` is the underlying exec helper (not a security sandbox). The remote/SSH kernel extension is documented in [remote-python-kernel.md](design/remote-python-kernel.md).

## Tool-Loop Persistence
KV cache was lost during tool loops because storage collapsed multiple iterations into single `ChatMessage` row, breaking longest-common-prefix match on follow-up turns.
**Fix**: each iteration stored as separate canonical row with `_toolLoopId` and `_toolLoopFragment` (commit 47eca29).
- `chatMessagesToPiMessages` replay maps canonical fragments to `AssistantMessage(toolUse)`/`ToolResultMessage`, final → `AssistantMessage(stop)`. Legacy collapsed rows produce old 3-message pattern for backward compat.
- Accumulators (`committedTextLength`, `committedToolCallCount`) track committed positions for delta-only persistence.
- Display layer: `buildDisplayMessages` + `mergeToolLoopMessages` handle visual merging. Raw rows = source of truth.
- **Phase 1 migration**: dual-write/dual-read, incremental sync (`syncChatMessageRows`), transaction-wrapped saves.
- **Phase 2 (shipped)**: `getChatMessageWindow` recent-window loading, `messageOffset`-based scroll-to-top paging via `GET /api/chats/:id/messages`, and removal of the 200-message hard cap. The 200-message cap is gone; windows are now bounded by a `messageLimit` capped at 1000.

## Compaction & KV Cache
Compaction-as-cache-reset strategy — system messages counted toward budget, included in `icIndices`. Stale delta stripping marks old system messages `_outOfContext` to prevent double-injection.
Qwen hybrid architecture (Gated DeltaNet + Gated Attention/SSM recurrent layers) causes KV cache checkpoint search failure in llama.cpp (issue #22384, closed without merge). Two-line patch: `pos_max <= pos_next`, checkpoint min 64→4 (11s→115ms on Qwen 3.6 27B). `preserve_thinking` fixes template drift but NOT checkpoint bug.
RDNA 3 (gfx11xx): Q8_0 quantization optimal (halves KV cache, <5% throughput penalty). EMA hit ratio, `inferredCachedTokens` = `reportedPromptTokens - promptEvalTokens`, CacheBar UI.
**Turn engine (D1–D6)** (`turn-compaction.ts`): end-of-turn compaction decision + execution is centralized in one function. Pre-send triggers are 0.85 (usage-anchored) / 0.95 (hard cap) / 1.15 (pure character estimate); end-of-turn fires at **0.80** by default, with automation as the named delta at **0.85** (D3). The pre-archive memory flush now runs on **every** compaction path (D4 — `preCompactionFlushHook` moved to `memory-extraction.ts`, wired at HTTP and every headless site; it holds the global turn-gate lease). D5 raised the cap 3→5; D6 made it a single writer. See [turn-engine.md](design/turn-engine.md).
**KV snapshot parking** (`kv-snapshot.ts`): a disk tier for idle-slot KV — app-side save/restore orchestration around llama.cpp's `/slots` API, with a scaled op budget, hourly prune, and a breaker on wire-level restore failures. Summary served at `/api/settings/kv-snapshots`. See [kv-snapshot-parking.md](design/kv-snapshot-parking.md).

## Memory System
8 categories + reflection. Retrieval: vector + FTS5 (RRF) → Qwen3 rerank → 0.85 cosine dedup. Extraction: `extractInChunks`, per-chunk retry, 500-char overlap. Delayed extraction supersession: two-phase — extract then batch-compare ambiguous candidates (similarity 0.90–0.95 band). Warm continuation reuses extraction KV cache when single-chunk; cold fallback otherwise. Comparison token budget capped 800–4000.
Passive mid-turn recall: after tool-use iterations, `PassiveMemoryRecallController` runs fast hybrid search/MMR in the background from a topical query that preserves agent thinking but scrubs operational anchors, reranks a small accumulated batch, persists selected memories as hidden system rows, and live-injects replay-equivalent synthetic user context before a later provider call.
Conscious/subconscious model: atomic memories (subconscious) consolidated into blocks (conscious) during synthesis.
System chat delayed extraction: synthesis messages flagged `_isSynthesisMessage: true` (both triggers and responses), quarantined from extraction context.
Compaction: archives to `context_archives` w/ FTS. Greedy backfill (50% floor). Skills reinjected post-compaction. Stable prefix excludes skills.
Embedding resilience: graceful degradation — (1) buildStablePrefix fail → bare prompt; (2) first-turn retrieval fail → stablePrefix no memories; (3) delta fail → frozen memories. `dirty=true` on fail for natural retry.
Configurable `maxBlockChars` setting (default 6000, clamped 5000–20000, step 500) replaces the hardcoded limit. Slider in SettingsModal "Delayed Memory Extraction" section.
**Mid-turn extraction**: extraction has four triggers (immediate, mid-turn pulse, pre-compaction, delayed). The mid-turn pulse fires when the signal-token counter crosses a threshold; it is graded (every pulse advances at least one budget-width slice), slices the uncovered window FIFO, and advances a cursor triad (optimistic advance → rewind on partial → full rollback on failure/timeout). It reuses the cached KV prefix from the same extraction session.
**Memory context persistence** (`memory-context.ts`, `memory_context_state`): per-chat frozen prefix state that hydrates byte-exact; new memories are appended as delta messages to preserve longest-common-prefix KV caching (hard reset only on chat deletion). **Durability**: every memory is `durable` or `session` (monotonic session→durable promotion on dedup; server-side filter + session-only chips). **Block scoping**: `global`/`project`/`archived` scopes with `supersedes_block_id` lineage and per-edit history.

## search_conversation Tool
BM25 ranking, 6000-char output budget with truncation flags. SQL alias: `message_index AS messageIndex`.

## Automation System
Synthesis/wake cycles generalized into user-configurable automation framework. Shared agent turn runner (`chat-turn-runner.ts`) — core loop returns raw results; callers handle presentation (SSE for chat, push-dispatch for headless). Built-in tasks reuse `runSystemSynthesis()`/`runWakeCycle()`. Custom automations via `runPromptAutomation`.
`ensureAutomationDefaults()` moved from per-route to single startup call (was ~6 DB queries/min). Scheduler checks every 5 minutes (`AUTOMATION_CHECK_INTERVAL_MS`), and requires 2 minutes of idle before a due task may start.
`automation-lock.ts`: promise-based mutex. Lock is exception-safe (outer `runAutomationTask` has try/finally). `producedNothing` check duplicated across 3 paths.
Task activation policies: `idle`, `absent` (the absence-threshold policy both built-ins use), `manual_only`. Legacy `sleep_only` normalizes to `absent`; there is no `always` policy, and `manual_only` tasks are hard-skipped by the scheduler rather than gated on idle.

## Push Notifications
Cold start: `?chat=` via `URLSearchParams` on mount. Hot start: `push-click` via `navigator.serviceWorker.messages`. Race condition fixed by ordering `selectChat` effect before push-click/restore listeners in App.tsx.

## Mobile Safari Reconnection
Async IIFE for `reconnectChat` was missing try/catch — unhandled rejection could leave `reconnecting` state stuck true. Fixed by wrapping IIFE in try/catch, clearing state on error. User-facing message: "Connection lost — your message was saved on the server." Race guard: `bgStreams.get(streamChatId) === bg` to prevent stale updates.

## UI
PWA theme adapts via `var(--theme-bg-flat)`. Skill chips use theme-accent variables. TTS button bottom-right. MemoryDebugPanel: Memories/Blocks/Graph/Extraction tabs. Theming: 13 preset themes plus a custom mode with a luminance-gated background and saved named presets (see [ui-patterns.md](ui-patterns.md)).
Automation settings: expandable prompt editors (collapsible by default). Custom dropdowns in SettingsModal (replaced native `<select>`, fixed React #310 with keyed state + centralized click-outside handler).
Mobile layout corrections: `w-full` on row wrappers, `flex-wrap` on rigid flex rows, "show what matters, hide what doesn't" responsive philosophy. Context indicator visible on mobile (hides arrows on narrow screens). Provider icon hidden on mobile in model selector.
Search provider checkboxes: Brave/Exa/Tavily visibility toggles, default Brave enabled.
**Browser observability** (Phases 1–2): live browser frames as a viewport-anchored picture-in-picture card. Frames are observability bytes — bounded per chat, an in-memory ring, cleared on session close, never on disk — served by `/api/browser/frame/:chatId/:frameId`; `/api/browser/status/:chatId` hydrates the viewer on open/reconnect. See [browser-observability.md](design/browser-observability.md).
**Planned**: settings modal mobile redesign.

Theming (`ThemePicker` + `utils/custom-theme.ts`): 12 built-in themes (Lapis, Ocean, Forest, Crimson, Asphalt, Strawberry, Coffee, Emerald, Copper, Verdigris, Iron, Rust) plus a `custom` mode where the user sets background and accent colors directly. Custom colors can be saved as named presets (unique case-insensitive names, 32-char cap, edit-in-place by id); presets persist server-side, and `chat-storage.ts` owns the authoritative `normalizeThemePresetName` rules that the client mirrors.
