# UI Patterns

## Streaming & Reasoning

- Server-Sent Events for real-time token streaming
- Collapsible thinking blocks for reasoning-capable models (Qwen3+) with live duration timer (100ms updates), user toggle override, accumulated duration tracking
- Token usage indicator (`TokenIndicator.tsx`) with context window progress bar, compaction warning, removed message count
- Compaction indicator (`CompactionIndicator.tsx`) — collapsible UI showing where messages were compacted, removed count, timestamp, expandable summary

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
- Agent-related UI uses purple accent colors; quick chats use blue; bluesky chats use sky blue; projects use emerald
- No external state management — React hooks + API calls
- Lazy loading for heavy components (ImageSandbox, MarkdownRenderer, RippleGridBackground)

## Other

- Per-chat model selector and system prompt editor
- Markdown rendering with GFM support
- SQLite + sqlite-vec for memory storage with SIMD-accelerated vector search
