# Porrima Implementation Overview

## Core Architecture
npm workspaces monorepo. `server/`: Express + TS (3001). `client/`: React + Vite + Tailwind v4 (5173).
Services: llama.cpp chat router (32100, GPU), extraction (32101, CPU), reranker (32102, CPU), embedding (32103, CPU), title generation (32104, CPU).
Model: Qwen 3.6 27B (dense, 1M context via YaRN). User prioritizes intelligence over raw speed.
**Speculative decoding**: n-gram decoding gives 10x speedup on dense model (13→137 tok/s) but zero benefit on MoE variants (expert slice pull cost exceeds batching benefit). Workload-dependent — code generation gains enormous, open-ended conversation minimal.
Synthesis: four-phase cycle, pre-synthesis archiving, synthesis lock. `SynthesisEmitter` wraps headless LiveStream for SSE streaming.
Sleep cycle: button is a "release" signal (stamps `sleepModeTriggeredAt`, 2h synthesis cooldown). Inactivity from `lastAgentCompletedAt`. Logic in `sleep-cycle.ts`.
Wake cycle: autonomous exploration on inactivity (15-min check, 20-iter cap, 30-min timeout). Mutual exclusivity enforced.

## Chat System
Two types: agent (memory-augmented), quick. `chat.ts`: memory augmentation, LLM streaming, tools (max 20 iters, pi-ai native, `ask_user` persists). SQLite + FTS5, multi-provider.
Stranded tool recovery: detects `<function=` in thinking after stopReason="stop", triggers continuation.
SSE: `LiveStream` with headless flag for background tasks. Bounded replay, grace timer. Mid-turn compaction resume via `onCompaction(midTurn=true)`.
Activity stamping: user stamps before synthesis wait, assistant stamps after `done` (non-system only).
**Recap**: long assistant messages (>1500 chars) get 15-40 word summary via Qwen 3.5 0.8B. `callServer` accepts optional `maxTokens` (default 30; recaps pass 80). Persisted on message row, sent via SSE `done`, displayed as italic with `▸` marker. Push notifications use recap as body. Fire-and-forget, 15s timeout.
**Thinking block toggle**: `onMessageComplete` preserves thinking visibility across tool-loop SSE fragments — doesn't clear `streamingThinking` during inter-fragment gaps.

## Tool-Loop Persistence
KV cache was lost during tool loops because storage collapsed multiple iterations into single `ChatMessage` row, breaking longest-common-prefix match on follow-up turns.
**Fix**: each iteration stored as separate canonical row with `_toolLoopId` and `_toolLoopFragment` (commit 47eca29).
- `chatMessagesToPiMessages` replay maps canonical fragments to `AssistantMessage(toolUse)`/`ToolResultMessage`, final → `AssistantMessage(stop)`. Legacy collapsed rows produce old 3-message pattern for backward compat.
- Accumulators (`committedTextLength`, `committedToolCallCount`) track committed positions for delta-only persistence.
- Display layer: `buildDisplayMessages` + `mergeToolLoopMessages` handle visual merging. Raw rows = source of truth.
- **Phase 1 migration**: dual-write/dual-read, incremental sync (`syncChatMessageRows`), transaction-wrapped saves.
- **Phase 2 planned**: `getChatMessageWindow` (recent-window loading), scroll-to-top paging, removing 200-message hard cap.

## Compaction & KV Cache
Compaction-as-cache-reset strategy — system messages counted toward budget, included in `icIndices`. Stale delta stripping marks old system messages `_outOfContext` to prevent double-injection.
Qwen hybrid architecture (Gated DeltaNet + Gated Attention/SSM recurrent layers) causes KV cache checkpoint search failure in llama.cpp (issue #22384, closed without merge). Two-line patch: `pos_max <= pos_next`, checkpoint min 64→4 (11s→115ms on Qwen 3.6 27B). `preserve_thinking` fixes template drift but NOT checkpoint bug.
RDNA 3 (gfx11xx): Q8_0 quantization optimal (halves KV cache, <5% throughput penalty). EMA hit ratio, `inferredCachedTokens` = `reportedPromptTokens - promptEvalTokens`, CacheBar UI.

## Memory System
8 categories + reflection. Retrieval: vector + FTS5 (RRF) → Qwen3 rerank → 0.85 cosine dedup. Extraction: `extractInChunks`, per-chunk retry, 500-char overlap. Delayed extraction supersession: two-phase — extract then batch-compare ambiguous candidates (similarity 0.90–0.95 band). Warm continuation reuses extraction KV cache when single-chunk; cold fallback otherwise. Comparison token budget capped 800–4000.
Passive mid-turn recall: after tool-use iterations, `PassiveMemoryRecallController` runs fast hybrid search/MMR in the background from a topical query that preserves agent thinking but scrubs operational anchors, reranks a small accumulated batch, persists selected memories as hidden system rows, and live-injects replay-equivalent synthetic user context before a later provider call.
Conscious/subconscious model: atomic memories (subconscious) consolidated into blocks (conscious) during synthesis.
System chat delayed extraction: synthesis messages flagged `_isSynthesisMessage: true` (both triggers and responses), quarantined from extraction context.
Compaction: archives to `context_archives` w/ FTS. Greedy backfill (50% floor). Skills reinjected post-compaction. Stable prefix excludes skills.
Embedding resilience: graceful degradation — (1) buildStablePrefix fail → bare prompt; (2) first-turn retrieval fail → stablePrefix no memories; (3) delta fail → frozen memories. `dirty=true` on fail for natural retry.
Configurable `maxBlockChars` setting (default 4000, range 1000-10000, step 500) replaces hardcoded limit. Slider in SettingsModal "Delayed Memory Extraction" section.

## search_conversation Tool
BM25 ranking, 6000-char output budget with truncation flags. SQL alias: `message_index AS messageIndex`.

## Automation System
Synthesis/wake cycles generalized into user-configurable automation framework. Shared agent turn runner (`chat-turn-runner.ts`) — core loop returns raw results; callers handle presentation (SSE for chat, push-dispatch for headless). Built-in tasks reuse `runSystemSynthesis()`/`runWakeCycle()`. Custom automations via `runPromptAutomation`.
`ensureAutomationDefaults()` moved from per-route to single startup call (was ~6 DB queries/min). Scheduler checks every 60s.
`automation-lock.ts`: promise-based mutex. Lock is exception-safe (outer `runAutomationTask` has try/finally). `producedNothing` check duplicated across 3 paths.
Task activation policies: `sleep_only`, `manual_only`, `always`.

## Push Notifications
Cold start: `?chat=` via `URLSearchParams` on mount. Hot start: `push-click` via `navigator.serviceWorker.messages`. Race condition fixed by ordering `selectChat` effect before push-click/restore listeners in App.tsx.

## Mobile Safari Reconnection
Async IIFE for `reconnectChat` was missing try/catch — unhandled rejection could leave `reconnecting` state stuck true. Fixed by wrapping IIFE in try/catch, clearing state on error. User-facing message: "Connection lost — your message was saved on the server." Race guard: `bgStreams.get(streamChatId) === bg` to prevent stale updates.

## UI
PWA theme adapts via `var(--theme-bg-flat)`. Skill chips use theme-accent variables. TTS button bottom-right. MemoryDebugPanel: Memories/Blocks/Extraction tabs.
Automation settings: expandable prompt editors (collapsible by default). Custom dropdowns in SettingsModal (replaced native `<select>`, fixed React #310 with keyed state + centralized click-outside handler).
Mobile layout corrections: `w-full` on row wrappers, `flex-wrap` on rigid flex rows, "show what matters, hide what doesn't" responsive philosophy. Context indicator visible on mobile (hides arrows on narrow screens). Provider icon hidden on mobile in model selector.
ImageSandbox: unified `useGestureDrawer` hook for slide-over drawers. iPad portrait (768-834px) now treated as mobile with drawers (breakpoint moved from `md` to `lg`). Vision Controls button: Eye icon (replaced gear).
Search provider checkboxes: Brave/Exa/Tavily visibility toggles, default Brave enabled.
**Planned**: settings modal mobile redesign.

## Image Generation
ComfyUI w/ `waitForFreeVRAM`. Dual-GPU: GPU 0 for LLMs, GPU 1 for ComfyUI. Themes: Emerald, Copper, Iron, Rust.
sdcpp: stable-diffusion.cpp pipeline.
