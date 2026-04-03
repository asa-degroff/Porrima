# Integrations & Features

## Notebook System

Dual user/agent notebook for structured notes, reflections, and cross-referencing:
- **Storage**: `notebook-storage.ts` with file-based persistence in `~/.quje-agent/notebooks/`
- **Entry types**: user-created and agent-created entries (e.g., synthesis summaries)
- **Linking**: `NotebookLink` cross-references between notebooks, chats, and external URLs
- **Attachments**: image attachments, tool results, artifacts, visuals, and memory associations
- **Daily synthesis integration**: synthesis loads today's notebook entries (user + agent, excluding prior synthesis entries) as context; writes an agent notebook entry with the synthesis summary
- **UI**: `NotebookView.tsx`, `NotebookEntryComposer.tsx`, `NotebookEntryDisplay.tsx`, `NotebookLinkPicker.tsx`
- **Routes** (`notebooks.ts`): CRUD for entries, filtered by author (user/agent)

## Bluesky Integration

Social media integration with the AT Protocol (Bluesky):
- **Authentication** (`bluesky-agent.ts`): AT Protocol agent with encrypted session persistence
- **Notification polling** (`bluesky-poller.ts`): EventEmitter-based polling with configurable interval, auto-respond capability
- **Agent tools** (`bluesky-tools.ts`): `list_notifications`, `get_thread`, `reply`, `post` — available in bluesky chat type
- **Chat type**: Dedicated `"bluesky"` chat type with specialized system prompt, notification context injection
- **Multi-post replies**: Automatic thread splitting for responses >300 characters
- **Thread context**: Reads parent thread before replying for conversational awareness
- **Settings**: `BlueskySettings` — polling interval, notification types, auto-send, auto-respond, dedicated chat ID
- **UI**: `BlueskySection.tsx` in sidebar with expand/collapse, unread count, quick access to dedicated chat
- **Routes** (`bluesky.ts`): `POST /api/bluesky/login`, `POST /api/bluesky/logout`

## TTS (Text-to-Speech)

- **Kokoro TTS**: Original integration (ported from GreenGale codebase)
- **Qwen3-TTS** (`tts-qwen3.ts`): Alternative backend with caching
- **Streaming TTS** (`tts-streaming.ts`, `tts-buffer.ts`): Generator-based streaming with 3-tier boundary detection (word/clause/sentence) for chunking
- **Text preprocessing** (`tts-text-preprocessor.ts`): Markdown-to-speech text extraction
- **Client streaming** (`useStreamingTTS.ts`): MediaSource API with WAV/PCM and MP3 codec support, chunk queueing, pause on tool execution, graceful fallback to non-streaming
- Voice selection, speed, pitch controls
- Auto-read toggle for assistant messages
- Playback state in control bar

## User Images

- Upload and attach images to chats
- Vision model analysis
- Thumbnails and full-resolution serving
- Stored in `~/.quje-agent/user-images/`

## Skills

- Pluggable skill definitions
- Activated per chat, project-scoped vs. global filtering
- Installation from URL with custom naming
- UI: `SkillSelector`, `SkillsBrowser` (install, delete, expandable details)

## Persona

- Dynamic persona synthesis from memories
- Daily persona updates
- Persona-aware responses

## Authentication

- Passkey-based auth (WebAuthn)
- Session management via express-session
- Protected `/api/*` routes
- Login page for initial setup

## Message Queueing

- Offline message queueing (`message-queue.ts`) with per-chat persistence
- Retry on reconnect
- Queue state persistence
- **UI**: `OfflineIndicator.tsx` with real-time online/offline status, queued message count

## User Profile

- Markdown-based user information document (`user-store.ts`)
- **Routes** (`user.ts`): `GET/PUT/DELETE /api/user/`

## UI State Persistence

- Client state management via backend (`ui-state.ts`)
- **Routes**: `GET/PUT /api/ui-state/`
