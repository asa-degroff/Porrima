# UI Patterns

## Streaming & Reasoning

- Server-Sent Events for real-time token streaming
- Collapsible thinking blocks for reasoning-capable models (Qwen3+) with live duration timer (100ms updates), user toggle override, accumulated duration tracking
- Token usage indicator (`TokenIndicator.tsx`) with context window progress bar, compaction warning, and a compacted badge whose tooltip decomposes the removed count the same way the indicator card does — whole messages plus separately counted partial-turn splits, or "Partial turn archived" when nothing whole was removed. The breakdown popover splits context into five groups, using a `ProgressRing` on mobile
- Compaction indicator (`CompactionIndicator.tsx`) — collapsible UI showing where messages were compacted, removed count (whole removed messages plus separately counted partial-turn splits), timestamp, expandable indexed summary with archive IDs
- Context boundary visualization — messages before the last compaction point render at 45% opacity ("out of context"), with a green "In context" divider marking where active context resumes. Live mid-turn compaction mirrors the boundary immediately: the SSE `compaction` event carries `firstKeptSequence`, and `useChat` dims locally synced rows with a lower `_rowSequence` and splices the summary card before the first kept row — the position the server uses — instead of waiting for a reload
- Mid-turn compaction handoff rows (`_isSystemMessage` + `_isMidTurnCompaction`) render as a `MidTurnCompactionIndicator` card at their persisted position — the model replay actually consumes their content, so they are not hidden from the display projection; the chevron expands to show the persisted handoff marker text (progress summary + recent tool calls) that the replayed context actually contains; no-op cycles (zero removedCount, nothing archived) stay hidden, since their card would assert a compaction that didn't happen
- Messages synced from server after compaction to ensure correct chronological ordering
- Context window editing restricted to fresh chats (no messages yet) to prevent mid-conversation model reloads
- Long-history loading: initial chat fetch requests the most recent 200 messages, and `ChatView` loads older windows on scroll-to-top via `GET /api/chats/:id/messages`. Absolute indexes are preserved with `messageOffset`
- Tool-loop display grouping: raw canonical assistant rows remain split for replay/storage, but consecutive rows sharing `_toolLoopId` render as one visible assistant bubble with merged segments, tool cards, artifacts, generated images, thinking, and final text. Hidden system rows, including passive memory recalls, are filtered from the display projection and do not split the bubble; mid-turn compaction handoff rows pass through as their own indicator card (grouping still breaks on them)
- **Steering (mid-turn follow-up)**: sending while a turn is streaming optimistically appends the queued user message *plus an empty assistant placeholder* marked `_steeringPending`, and the drained response streams into that bubble. `lib/steeringPlaceholders.ts` (`applyFollowUpStart()`) owns the transition; `_steeringPending` gates delta application so pre-steering in-flight content cannot leak into the follow-up bubble. Triggered by the server's `follow_up_start` SSE event
- **Reconnect on refresh**: `useChat` re-attaches to a still-active stream via `GET /api/chat/status/:chatId` (which folds the message window into the same response) and then `GET /api/chat/reconnect/:chatId`. A stale, ended stream is never in the live registry, so the probe distinguishes "finished while you were away" from "still going"

## Mobile & Touch

- **Gesture drawer** (`useGestureDrawer.ts`): Up/right direction swipe with velocity-based snapping, 30% threshold, axis lock, and edge resistance
- **Keyboard inset** (`useKeyboardInset.ts`): VisualViewport API detection for mobile keyboard handling, needed because the viewport is served with `interactive-widget=overlays-content`
- **Desktop predicate** (`useIsDesktop.ts`): `matchMedia(min-width)` at 1024px, gating pinning, drag-resize, and card-vs-drawer layouts. Note `ModelStatsModal.tsx` carries a private duplicate of this hook
- **Reduced motion** (`useReducedMotion.ts`): live `prefers-reduced-motion` so animated indicators collapse to a static frame

## Conversation Search

- **Sidebar inline** (`SidebarSearch.tsx`): inline search embedded in the sidebar (2-char minimum, 300ms debounce, jump-to-message via `chatId` + `messageIndex`)
- There is **no** separate modal search surface — the former `ConversationSearch.tsx` modal was removed as dead code (10-01)
- Backend: FTS5 via the `search_conversation` tool and `POST /api/memory/conversations/search`

## Memory Inspection

`MemoryDebugPanel.tsx` has four tabs:

- **Memories** — list, edit, supersede, and delete atomic memories
- **Blocks** — structured knowledge documents, including per-block revision history
- **Graph** (`MemoryGraphView.tsx`) — a WebGL Sigma.js force-directed graph of memories, laid out with ForceAtlas2 (Barnes-Hut and gravity tuned by node count). Nodes are colored by category; edges are typed `semantic` (embedding similarity) vs `lineage` (supersession). Supports category and scope filters, a similarity threshold, k-NN neighbor expansion, and a fullscreen mode. Its own settings persist to both localStorage (`porrima-memory-graph-settings`) and server UI state (`memoryGraphSettings`), and node positions are cached in memory across reloads
- **Extraction** — live extraction run stream, fed by the `GET /api/memory/extraction/stream` SSE endpoint

## Pinned Panel

Desktop-only right-hand column (`PinnedPanel.tsx` + `PinnedItemContext.tsx`). "Pin" here means *promote one artifact or inline visual out of the message stream* into a persistent side panel — it is unrelated to the separate "pin project in the sidebar" feature.

- Pinning is **single-slot**; toggles live in `ArtifactPanel.tsx` and `InlineVisual.tsx`
- On desktop the originating bubble swaps to a `PinnedPlaceholder` so the panel is not duplicated
- Pin state is in-memory React state, not persisted, and is cleared on every chat switch

## Reminders & Cross-Chat Posts

- `ReminderCard.tsx` renders a message scheduled by the `schedule_reminder` tool — including reminders that fire inside the target chat rather than as a separate notification
- `CrossChatPostCard.tsx` renders messages delivered into a chat by `schedule_chat_message` or an automation, as a purple envelope card with edit/retry deliberately suppressed

## Instrumentation Surfaces

- **Model Stats modal** (`ModelStatsModal.tsx`): per-model token throughput, latency, and prompt-cache residency; opened from the sidebar. Calls `getCacheResidency` directly rather than through the hook
- **System stats bar** (`SystemStatsBar.tsx`): CPU/GPU telemetry in the sidebar, polled every 3s, with per-GPU hiding via `settings.systemStatsHiddenGpus`
- **Cache residency affordances**: `useCacheResidency.ts` polls every 3s and drives per-chat warming spinners, warm-queue position, warm-error toasts, and a manual "warm cache" action, plus a separate new-chat-baseline spinner.
- **Setup wizard** (`SetupModal.tsx`): auto-opens on first run when `!settings.setupCompleted`
- **Sidebar automation rail**: `AutomationRunnerDropdown` + `PrefillActivityIcon` + system-pause controls, driven by a 10s poll of `/api/memory/synthesis-status` that reports which task holds the global automation lock. On completion the client refreshes notebooks and forces a system-chat reload

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue; projects use emerald

### Theming

`ThemePicker.tsx` offers 13 themes: Lapis (`default`), Ocean, Forest, Crimson, Asphalt (`mono`), Strawberry, Coffee, Emerald, Copper, Verdigris (`oxidized-copper`), Iron, Rust, and **Custom**.

Custom mode takes a background and accent color directly, subject to a luminance gate (`CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE = 0.183` in `utils/custom-theme.ts`) so a light background cannot be saved, and derives accent text color from WCAG contrast. It expands into ~9 CSS custom properties including three gradient stops. Custom color sets can be saved as named presets — names are unique case-insensitively, capped at 32 characters, and re-saving an existing preset edits it in place (renaming and recoloring both preserve the id). `chat-storage.ts` owns the authoritative `normalizeThemePresetName` rules that the client mirrors. `App.tsx` also rewrites `<meta name="theme-color">` per theme.

### Appearance & Effects

`App.tsx` applies the appearance settings as `data-*` attributes on the root element, which the stylesheets key off: `data-theme`, `data-flat-bg`, `data-bg-texture`, `data-opaque-bubbles`, `data-chromatic-aberration`, `data-mouse-warp`, `data-radius`, `data-depth`, `data-high-efficiency`.

- **Background effects**: six options, four of them lazy-loaded canvas components — `ripple-grid`, `scan-lines`, `ripple-dots`, `graph-paper`, plus `static` and `linen` (a CSS mask). Previewed in Settings via `BackgroundEffectPreview.tsx`
- **Chromatic aberration** and **mouse warp** are offered only when the active effect is `ripple-grid` or `ripple-dots`
- **Flat background** and **opaque bubbles** disable the glass treatment selectively
- **Corner radius**: tiny / small / default, with a squircle superellipse
- **High efficiency mode** is a *device-local* kill switch (not a server setting): cached in `porrima-high-efficiency-mode` and applied as `<html data-high-efficiency>` to drop backdrop blurs
- **Surface depth**: Flat (default) / Beveled, with a locally scoped preview. `surfaceDepth` is saved with settings and cached as `porrima-surface-depth` for startup. `data-depth` controls explicit `.depth-raised` / `.depth-inset` opt-ins in `styles/glass.css`: send buttons, model picker trigger/panel, active sidebar chat cards, and the composer. The masked `::after` lights the existing 1px border without changing fills, state colors, or shadows. Hosts must be positioned, reserve `::after`, and keep scrolling on a child. Unsupported masking and forced colors retain ordinary borders. No new blur or animation is added

### State

No state-management library. Client state is split across:

- React hooks, plus two local contexts — `PinnedItemContext` and `ActivityStyleContext` (via `ActivityStyleProvider` at the app root)
- Module-level singletons that outlive components: `bgStreams` / `drafts` (background stream and draft stores in `useChat`), `breakdownCache` (`TokenIndicator`), `blocksCache` (`BlockIndicator`), and `recentlyStreamingExpiries` (sessionStorage-backed)
- **IndexedDB** (`lib/db.ts`): three object stores — `chatList`, `chats`, and `messageQueue` (the latter with a `by-chatId` index)
- The **Cache API** for images (`utils/imageCache.ts`)
- **localStorage** with legacy `quje-*` → `porrima-*` key migration (`lib/storage.ts`)
- The **server** as a UI-state store: `GET/PUT /api/ui-state` persists five keys — `sidebarState`, `notebookLastSeen`, `activeChatId`, `activeView`, and `memoryGraphSettings`

### Lazy loading

`lazy()` covers `ImageSandbox` and all four animated background effects (ripple-grid, scan-lines, ripple-dots, graph-paper), `MarkdownRenderer` (which additionally gets its own `markdown` Rollup chunk, split from `vendor`), and `ArtifactPanel` / `InlineVisual` in the notebook path.

## Other

- Per-chat model selector showing models from llama.cpp server — **quick chats only**. Agent, project, and system chats show the configured default model read-only so their long-lived KV cache stays warm
- Favorites exist for **generated images** only (heart toggle in the Image Sandbox plus a Favorites filter). There is no per-model favorite
- System prompt presets: the editor (`SystemPromptEditor.tsx`) renders only for a **fresh quick chat** (quick type and zero messages), because editing the system prompt mid-conversation would invalidate the whole KV cache. The "Add preset" trigger label appears when no preset matches. The agent-only "None (persona only)" entry is currently unreachable — agent chats always pass `hidden` — and can be removed along with the now-dead `isAgent` prop
- Markdown rendering with GFM support
- Message edit preserves images from the original message
