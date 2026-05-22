# UI Patterns

## Streaming & Reasoning

- Server-Sent Events for real-time token streaming
- Collapsible thinking blocks for reasoning-capable models (Qwen3+) with live duration timer (100ms updates), user toggle override, accumulated duration tracking
- Token usage indicator (`TokenIndicator.tsx`) with context window progress bar, compaction warning, removed message count
- Compaction indicator (`CompactionIndicator.tsx`) — collapsible UI showing where messages were compacted, removed count, timestamp, expandable indexed summary with archive IDs
- Context boundary visualization — messages before the last compaction point render at 45% opacity ("out of context"), with a green "In context" divider marking where active context resumes
- Messages synced from server after compaction to ensure correct chronological ordering
- Context window editing restricted to fresh chats (no messages yet) to prevent mid-conversation model reloads
- Long-history loading: initial chat fetch requests the most recent 200 messages, and `ChatView` loads older windows on scroll-to-top via `GET /api/chats/:id/messages`. Absolute indexes are preserved with `messageOffset`.
- Tool-loop display grouping: raw canonical assistant rows remain split for replay/storage, but consecutive rows sharing `_toolLoopId` render as one visible assistant bubble with merged segments, tool cards, artifacts, generated images, thinking, and final text. Hidden system rows, including passive memory recalls, are filtered from the display projection and do not split the bubble.

## Mobile & Touch

- **Gesture drawer** (`useGestureDrawer.ts`): Up/right direction swipe with velocity-based snapping, 30% threshold
- **Keyboard inset** (`useKeyboardInset.ts`): VisualViewport API detection for mobile keyboard handling
- **Haptic feedback** (`useHaptics.tsx`): Web Haptics API with patterns — light, medium, heavy, success, error, navigation, toolComplete, streamingComplete; settings-gated

## Conversation Search

- **Modal search** (`ConversationSearch.tsx`): 2-char minimum, 300ms debounce, jump-to-message (chatId + messageIndex)
- **Sidebar inline** (`SidebarSearch.tsx`): Inline search in sidebar
- Backend: FTS5 via `search_conversation` tool and `/api/memory/conversations/search`

## Style

- Tailwind v4 with glassmorphism (`backdrop-blur-xl bg-white/[0.08]`)
- Agent-related UI uses purple accent colors; quick chats use blue; projects use emerald
- No external state management — React hooks + API calls
- Lazy loading for heavy components (ImageSandbox, MarkdownRenderer, RippleGridBackground)

## Other

- Per-chat model selector showing models from llama.cpp server
- Model favorites: star toggle in settings, "Show only favorites in chat" mode
- System prompt presets with "None (persona only)" option for agent chats, "Add preset" label when none selected
- Markdown rendering with GFM support
- SQLite + sqlite-vec for memory storage with SIMD-accelerated vector search
- Message edit preserves images from original message; fixes stale closure in edit callback
