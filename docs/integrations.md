# Integrations & Features

## Notebook System

Dual user/agent notebook for structured notes, reflections, and cross-referencing:
- **Storage**: **SQLite, not files.** User entries live in the `user_notebook_entries` table (+ `user_notebook_entries_fts`) in `~/.porrima/memory/memories.db`; agent entries are `memory_blocks` rows with `blockType IN ('notebook','synthesis')`, so `search_memory` and `list_memory_blocks` find them. `~/.porrima/notebooks/` is retained only as the one-time JSON migration source and backup. `searchNotebookEntries()` queries both FTS5 indexes and rank-merges their BM25 scores with excerpts.
- **Entry types**: user-created and agent-created entries (e.g., synthesis summaries)
- **Linking**: `NotebookLink` cross-references between notebooks, chats, and external URLs
- **Attachments**: image attachments, tool results, artifacts, visuals, and memory associations. Agent-entry updates *merge* attachments rather than replacing them
- **Synthesis integration**: synthesis loads recent notebook entries (user + agent, excluding prior synthesis entries) as context. The synthesis prompt tells the agent to persist narrative output through `create_notebook_entry`; the server no longer auto-saves assistant text as a notebook entry.
- **UI**: `NotebookView.tsx`, `NotebookEntryComposer.tsx`, `NotebookEntryDisplay.tsx`, `NotebookLinkPicker.tsx`, `ChatLinkPicker.tsx`
- **Routes** (`notebooks.ts`): CRUD keyed by `:author/:id` (user or agent), plus `/search` across both authors and `POST /bulk` for multi-fetch

## TTS (Text-to-Speech)

- **Kokoro TTS**: Original integration (ported from GreenGale codebase)
- **Qwen3-TTS** (`tts-qwen3.ts`): Alternative backend with caching
- **Supertonic 3** (`tts-supertonic.ts`): Fast local CPU backend via the official Python SDK, with M1-M5/F1-F5 multilingual voice styles
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
- Stored in `~/.porrima/user-images/`

## Skills

- Agent Skills compatible directory format: `<skill-name>/SKILL.md` with required `name` and `description` frontmatter
- Global skills are discovered from Porrima-managed `~/.porrima/skills/` and shared read-only `~/.agents/skills/`
- Skill names must match the parent directory and use lowercase letters, digits, and single hyphens
- Optional spec fields are preserved: `license`, `compatibility`, `metadata`, and `allowed-tools`
- Optional `scripts/`, `references/`, and `assets/` directories are discovered and exposed for progressive disclosure
- Activated per chat, project-scoped vs. global filtering
- Active skills append an `[Active Skills]` section to the system prompt on every transport — HTTP turns, cache-warm, and headless automation/wake runs (`automation-runner.ts` mirrors the HTTP augmentation). The prompt must stay byte-identical across transports or the cached KV prefix diverges at the prompt tail
- Installation from direct `SKILL.md` URLs or GitHub skill-directory URLs
- UI: `SkillSelector` (caret-anchored popover opened by typing `/` in the composer — `MessageInput.tsx` tracks the cursor and reports the caret rect), `SkillsBrowser` (Settings → Skills: install, delete, expandable details). Active skills show as chips in the chat header and are cached per `projectId`

## Persona

- Dynamic persona synthesis from memories
- Updated through synthesis and memory-block maintenance
- Persona-aware responses
- Versioned: `GET /api/persona/history` and `/history/:filename` expose prior revisions

## Extraction Prompt

- The memory-extraction policy prefix is **user-editable** from Settings → Extraction, stored at `~/.porrima/extraction-prompt.md`
- Every save records a version: `GET /api/extraction-prompt/history` and `/history/:filename` list and read them
- Note: the history endpoints have **no client UI yet** — `api/extraction-prompt.ts` exports `getExtractionPromptHistory` / `getExtractionPromptVersion` but no component calls them

## Authentication

- Passkey-based auth (WebAuthn)
- Session management via express-session
- Protected `/api/*` routes
- Login page for initial setup

## Push Notifications

- Server: VAPID keys in `~/.porrima/push/`, subscriptions in the `push_subscriptions` table, delivery via `push-dispatch.ts`
- Client: `usePushNotifications.ts` handles support detection (including iOS, which requires Home-Screen install / standalone display mode), a 6-stage time-boxed subscribe flow, a 20s presence keepalive ping, and `pushsubscriptionchange` endpoint-rotation recovery
- UI: a Notifications section in Settings with a toggle and a **test push** button
- Navigation: cold start via a `?chat=` query param, hot start via a `push-click` service-worker message. `selectChat` is deliberately ordered before the push-click and restore listeners in `App.tsx` to avoid a race

> Known gap: `sw.ts` posts a `kind: "push"` message to foreground clients so the app can show its own toast, but no client listener handles that message kind — and the same code path suppresses the OS notification when a window is visible. A foregrounded, non-test push therefore surfaces nothing. Either add the listener or remove both branches.

## PWA / Offline

- `sw.ts` runs in Workbox `injectManifest` mode. It precaches the **app shell** (JS/CSS/HTML/icons/fonts from `__WB_MANIFEST`) and adds two long-lived `CacheFirst` routes for Google Fonts stylesheets and webfonts. There is **no runtime caching of API responses**
- `registerSW({ immediate: true })` with `registerType: "autoUpdate"`, plus `skipWaiting()` + `clients.claim()` in the worker, so an existing install picks up a new service worker without closing tabs
- Chat and message data live in IndexedDB (`lib/db.ts`), not the SW cache
- `main.tsx` disables pinch-zoom only in standalone display mode, by rewriting the viewport meta to add `user-scalable=no, interactive-widget=overlays-content`

## Message Queueing

- Server: offline message queueing (`message-queue.ts`) with per-chat persistence and retry on reconnect
- Client: `lib/db.ts` holds a `messageQueue` object store with a `by-chatId` index. `useChat.processQueue` drains one message at a time and halts on a `__OFFLINE__:` sentinel, and `App.tsx` triggers a drain on reconnect
- **UI**: `OfflineIndicator.tsx` in the chat header shows online/offline/back-online state. Queue depth is shown per chat in the sidebar instead — an optimistic `queueCount` on the chat list item, plus a `QueuedMessageIcon` glyph. (The `queuedCount` prop on `OfflineIndicator` is currently never passed, so its count branch is unreachable.)

## User Profile

- Markdown-based user information document (`user-store.ts`)
- **Routes** (`user.ts`): `GET/PUT/DELETE /api/user/`

## UI State Persistence

- Client state mirrored to the backend (`ui-state.ts`). Five keys are persisted: `sidebarState`, `notebookLastSeen`, `activeChatId`, `activeView`, and `memoryGraphSettings`
- **Routes**: `GET/PUT /api/ui-state/`

## Remote Hosts (SSH)

- SSH connections are configured in Settings → Remote Hosts and stored in the `ssh_connections` table (`host`, `port`, `username`, `identityFile`, `knownHostsMode`, plus the permission flags `allowBash`, `allowFileWrite`, `allowAbsolutePaths`)
- `workspace.ts` implements a multiplexed SSH adapter (`ssh -fMN` with `ControlPersist=600`, control sockets in `~/.porrima/ssh-mux/`, stale-socket cleanup, `UserKnownHostsFile` pinned to `~/.porrima/ssh-known-hosts`), executing each operation by piping a Python script over the connection
- **Routes**: CRUD at `/api/settings/ssh-connections` plus `POST /:id/test`
