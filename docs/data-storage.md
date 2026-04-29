# Data Storage

All data is stored in `~/.quje-agent/`:

```
~/.quje-agent/
├── app.db              # SQLite database (chats, chat_message_rows, projects, settings, pending states, chat_messages FTS5)
├── chats/              # Legacy JSON files (migrated to app.db on startup)
├── projects/           # Legacy JSON files (migrated to app.db on startup)
├── artifacts/          # One folder per artifact (contains index.html + assets)
├── images/             # Generated images from ComfyUI ({uuid}/image.jxl + metadata.json)
├── user-images/        # Uploaded user images (originals + thumbnails)
├── vision/             # Analyzed images
├── pending/            # Legacy JSON files (migrated to app.db on startup)
├── settings.json       # Legacy JSON file (migrated to app.db on startup)
├── clusters/           # Cluster data (clusters.json with centroids, dominant elements)
├── directions/         # Creative direction cache (cache.json)
├── notebooks/          # Notebook entries (user + agent)
├── image-corpus/       # Image corpus SQLite database
│   ├── corpus.db       # SQLite: corpus_entries + vec_corpus (sqlite-vec) + fts_corpus (FTS5)
│   └── corpus.json.bak # Legacy JSON (migrated on first startup)
└── memory/
    ├── memories.db     # SQLite database (memories + vector embeddings via sqlite-vec)
    └── daily/          # Legacy — daily synthesis markdown logs from the pre-system-chat era. Not written anymore; synthesis output now lives in the system chat + agent notebook entries.
```

## SQLite Schemas

- `chats` — chat metadata with JSON `messages` column retained as a compatibility snapshot, delayed extraction tracking (`lastDelayedExtractionAt`, `lastDelayedExtractionMessageIndex`)
- `chat_message_rows` — full-fidelity message row store keyed by `(chat_id, sequence)`, with `payload_json` plus metadata columns (`role`, `timestamp`, `out_of_context`, `is_compaction_summary`, `is_system_message`). Used for paged chat loading and as the authoritative source when populated.
- `chat_messages` — denormalized message table for FTS5 (chat_id, message_index, role, content, timestamp). This is a search projection, not the full-fidelity message source.
- `chat_messages_fts` — FTS5 virtual table with automatic triggers for full-text search
- `projects` — project metadata
- `settings` — key-value settings (single 'settings' key)
- `pending_states` — ask_user tool loop state for resume after server restart
- `corpus_entries` — image corpus metadata (type, imagePath, prompt, description, elements JSON, chat/project/direction IDs)
- `vec_corpus` — sqlite-vec virtual table (id, embedding float[1024] with cosine distance)
- `fts_corpus` — FTS5 virtual table (id, prompt, description) with auto-sync triggers

## Chat Message Compatibility

`saveChat()` writes both the legacy `chats.messages` JSON snapshot and the normalized `chat_message_rows` tail. `getChat()` prefers `chat_message_rows` when rows exist, falling back to the JSON column for legacy or partially migrated chats. Startup migration backfills rows from the JSON snapshot.

`chat_message_rows.sequence` deliberately matches the absolute `Chat.messages` array index during the compatibility window. This keeps edit/retry indexes, conversation search jumps, and paged windows aligned:

- `GET /api/chats/:id?messageLimit=200` returns the most recent rows plus `messageOffset`, `messageTotal`, and `hasMoreMessages`.
- `GET /api/chats/:id/messages?before=<sequence>&limit=<n>` returns rows before an absolute sequence. The route clamps `limit` to 1000.
- The browser IndexedDB cache stores the current window, not necessarily the full history.

Canonical tool-loop rows are stored without flattening: each persisted assistant row represents one assistant stop from the live loop. Rows in one visible assistant turn share `_toolLoopId`; rows that end in a tool call also carry `_toolLoopFragment: true`.
