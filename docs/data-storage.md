# Data Storage

All persistent application data is stored in `~/.porrima/`. The root is `APP_DATA_DIR` (`server/src/services/paths.ts`), overridable with the `PORRIMA_DATA_DIR` env var.

**One exception**: the TTS audio caches are resolved from `process.cwd()`, not the data dir — `server/data/tts-cache/` (Kokoro), `tts-cache-qwen3/`, and `tts-cache-supertonic/`. Under systemd (`WorkingDirectory=.../server`) these land in the working directory, so they are wiped by a reinstall and are invisible to `GET /api/settings/storage-diagnostics`. Interpreter overrides for these backends live in `~/.porrima/tts.env`.

## Data Directory Rename

The project was renamed from `quje-agent` to `Porrima`. `paths.ts` performs both migrations on first import:

| Legacy | Current | Migration |
|--------|---------|-----------|
| `~/.quje-agent/` | `~/.porrima/` | Directory `renameSync` (skipped when `PORRIMA_DATA_DIR` is set or the target already exists) |
| `~/.porrima/quje-agent.db` | `~/.porrima/porrima.db` | File `renameSync`, only when the target does not already exist |

`QUJE_DATA_DIR` still overrides the legacy source path. The client carries the same pattern for `localStorage` keys and its IndexedDB database name (`LEGACY_*` constants in `App.tsx`, `lib/db.ts`, `hooks/useSidebarState.ts`, `hooks/useNotebooks.ts`).

## Directory Layout

```
~/.porrima/
├── app.db              # Main SQLite database — see schemas below
├── porrima.db          # Observability database (model + reranker stats)
├── llama-slot-bindings.json # Persisted slot→chat lease bindings (only when slot binding is enabled)
├── tts.env             # Python interpreter overrides for the TTS backends
├── diagnostics/        # token-estimates.jsonl — token estimate observability
├── cache/web-pages/    # web_fetch rendered-page cache
├── auth/               # Passkey credential storage
├── artifacts/          # create_artifact output; one folder per artifact (versions/{N}/index.html + metadata.json)
├── visuals/            # Visual artifacts, same layout as artifacts/
├── backups/            # Embedding-migration backups + migration-progress.json
├── chats/              # Legacy JSON files (migrated to app.db on startup)
├── projects/           # Legacy JSON files (migrated to app.db on startup)
├── pending/            # Legacy JSON files (migrated to app.db on startup)
├── logs/               # Server logs
├── queue/              # Offline message queue
├── skills/             # Installed skill definitions
├── snapshots/          # Agent database snapshots
├── ssh-known-hosts/    # Trusted host key material for remote SSH workspace connections
├── ssh-mux/            # Multiplexed SSH control sockets
├── tool-result-images/ # Images emitted as tool results
├── workspace/          # Sandbox/workspace scratch space
├── header-image/       # Custom chat header image (+ thumb)
├── user-images/        # User-uploaded attachments (originals + WebP thumbs)
├── notebooks/          # Notebook entry files — migration source/backup only; see below
├── push/               # VAPID keys for browser push notifications
├── settings.json       # Legacy JSON file (migrated to app.db on startup)
└── memory/
    ├── memories.db     # Memory + block SQLite — see schemas below
    └── daily/          # Legacy — pre-system-chat daily synthesis markdown. No longer written
```

TTS audio caches (`tts-cache/`, `tts-cache-qwen3/`, `tts-cache-supertonic/`) are **not** under this root — see the note above.

## SQLite Schemas

Three live databases. The owning service determines the handle: `chat-storage.ts` (`app.db`), `memory-storage.ts` (`memories.db`), and `model-stats.ts` / `reranker-stats.ts` (`porrima.db`, which each open directly rather than through a shared `getDb()`).

### `app.db`

- `chats` — chat metadata with a JSON `messages` column retained as a compatibility snapshot, delayed extraction tracking (`lastDelayedExtractionAt`, `lastDelayedExtractionMessageIndex`), and `revision` (optimistic-concurrency counter, bumped in-transaction on every row write — see [chat-message-architecture.md](chat-message-architecture.md))
- `chat_message_rows` — full-fidelity message row store keyed by `(chat_id, sequence)`, with `payload_json` plus metadata columns (`role`, `timestamp`, `out_of_context`, `is_compaction_summary`, `is_system_message`, and a durable `row_id` that is stable per row and survives renumbering). Authoritative source when populated; supports paged window reads
- `chat_messages` — denormalized message table for FTS5 (`chat_id`, `message_index`, `role`, `content`, `timestamp`). A search projection, not the message source
- `chat_messages_fts` — FTS5 virtual table with automatic sync triggers
- `context_archives` — compaction archives: `id`, `chatId`, `sequenceNum`, `messages` JSON, LLM-written one-line `indexEntry`, `messageCount`, `estimatedTokens`, `createdAt`; `UNIQUE(chatId, sequenceNum)` plus `idx_archives_chat`
- `context_archives_fts` — FTS5 virtual table over archived context. This is what makes compaction cross-chat searchable
- `projects` — project metadata
- `settings` — key-value settings (single `settings` key)
- `pending_states` — `ask_user` tool-loop state for resume after server restart, including `fullText` for mid-turn recovery
- `storage_migrations` — one-shot migration ledger (`name`, `appliedAt`)
- `user_ui_state` — persisted client UI state (`key`, `value` JSON, `updatedAt`)
- `ssh_connections` — remote workspace connections: `name`, `host`, `port`, `username`, `identityFile`, `knownHostsMode`, `enabled`, and the per-connection permission flags `allowBash`, `allowFileWrite`, `allowAbsolutePaths`
- `automation_tasks` — built-in and custom automation configuration: kind/title, enabled state, order, target chat, schedule JSON, activation policy, prompt steps, prompt dispatch mode/cycle cursor, push notification settings, runtime limits, last/next run timestamps, status, and consecutive failure count
- `automation_runs` — audit history: task ID, status, origin (`scheduler`, `manual`, `migration`), start/finish timestamps, selected prompt step metadata, error/summary, tool call count, chat ID, and assistant message index
- `push_subscriptions` — browser push devices and subscription secrets, keyed by `deviceId`, with failure counts and last-seen timestamps

### `memory/memories.db`

Opened via `memory-storage.ts` `getDb()`. Also the handle used by `notebook-storage.ts`.

- `memories` — atomic memories. Text, category, importance, access tracking (`last_accessed`, `access_count`), `source_chat_id`, `project_id`, and temporal-layering columns `source_type` / `source_id`
- `vec_memories` — sqlite-vec virtual table (embedding vectors, cosine distance)
- `fts_memories` — FTS5 virtual table for lexical memory search
- `memory_graph_edges` — memory-to-memory similarity edges: `source_id`, `target_id`, `similarity`, `rank`, `embedding_version`, `updated_at`; `PRIMARY KEY (source_id, target_id)` with rank/target/similarity indexes
- `memory_supersession_history` — audit trail of supersession decisions: `older_memory_id`, `newer_memory_id`, `confidence`, and nullable `removed_at` / `removal_reason` so retracted supersessions are recoverable
- `memory_blocks` — structured knowledge documents: `name`, `description`, `content`, `scope`, `projectId`, `updatedBy`, `tokenEstimate`, `supersededBy`/`supersedes`, plus `blockType` (distinguishes plain notes from `notebook`, `synthesis`, and `zeitgeist-archive` blocks, replacing brittle `blk-notebook-*` id-prefix matching) and `attachments` (JSON of references — image/toolCall/toolResult/artifact/visual/link ids and URLs, never binary)
- `memory_blocks_fts` — FTS5 virtual table over `content`, `name`, `description`
- `memory_blocks_history` — per-update block snapshots, keyed implicitly by rowid. A trigger snapshots the old state on any content/name/description change *and* on supersession, so the superseded row's final state is still versioned
- `memory_context_state` — per-chat memory-context persistence: `frozen_section`, `section_hash`, `frozen_ids`, `delta_ids`, and a `dirty` flag that drives natural retry after a failed build
- `user_notebook_entries` — user notebook entries (`content`, `links`, `images` JSON). Agent notebook entries are dual-represented as memory blocks rather than living here
- `user_notebook_entries_fts` — FTS5 virtual table over notebook content
- `metadata` — key-value migration/version metadata

### `porrima.db`

- `model_stats` — per-request sampling rows: `modelId`, `provider`, `timestamp`, `promptTokens`, `predictedTokens`, `promptMs`, `predictedMs`, `sampleMs`, and derived `promptTokensPerSec` / `predictedTokensPerSec`
- `reranker_stats` — per-call reranking rows: `usedModel`, `latencyMs`, `documentCount`, `topN`, `totalTokens`, score distribution (`scoreMin`/`scoreMax`/`scoreMedian`), plus `chatType` and `source` for attribution

## Chat Message Compatibility

`saveChat()` writes both the legacy `chats.messages` JSON snapshot and the normalized `chat_message_rows` tail. `getChat()` prefers `chat_message_rows` when rows exist, falling back to the JSON column for legacy or partially migrated chats. Startup migration backfills rows from the JSON snapshot.

`chat_message_rows.sequence` deliberately matches the absolute `Chat.messages` array index during the compatibility window. This keeps edit/retry indexes, conversation search jumps, and paged windows aligned:

- `GET /api/chats/:id?messageLimit=200` returns the most recent rows plus `messageOffset`, `messageTotal`, and `hasMoreMessages`.
- `GET /api/chats/:id/messages?before=<sequence>&limit=<n>` returns rows before an absolute sequence. The route clamps `limit` to 1000.
- The browser IndexedDB cache stores the current window, not necessarily the full history.

Canonical tool-loop rows are stored without flattening: each persisted assistant row represents one assistant stop from the live loop. Rows in one visible assistant turn share `_toolLoopId`; rows that end in a tool call also carry `_toolLoopFragment: true`.

## Backups

`/api/snapshots` captures `app.db` and `memory/memories.db` — filesystem assets are not included, and `porrima.db` is not captured. Restores replace databases wholesale after taking a pre-restore snapshot; automatic pre-restore snapshots retain the latest 10 for up to 30 days.

## Maintenance Migrations

Some data-shape migrations are **CLI scripts, not HTTP endpoints** — run them from `server/src/scripts/`:

| Script | Purpose |
| --- | --- |
| `migrate-inline-image-payloads.ts` | Strips base64 image payloads out of `chat_message_rows.payload_json` and re-persists them to `~/.porrima/user-images/`. Supports `dryRun`, `limit`, and `persistMissing` options |
| `migrate-tool-result-image-payloads.ts` | Same treatment for images still held inline in tool results |
| `analyze-token-estimates.ts` | Reports token-estimate accuracy against observed usage |

Their effects are observable through `GET /api/settings/storage-diagnostics` (`inlineImageAttachments`, `inlineToolResultImageSummary`). The separate **embedding migration** *is* an HTTP surface (`/api/embedding/*`, SSE progress), and its progress survives client reconnects in `~/.porrima/backups/migration-progress.json`.
