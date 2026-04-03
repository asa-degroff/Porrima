# Data Storage

All data is stored in `~/.quje-agent/`:

```
~/.quje-agent/
├── app.db              # SQLite database (chats, projects, settings, pending states, chat_messages FTS5)
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
    └── daily/          # Daily synthesis logs (YYYY-MM-DD.md)
```

## SQLite Schemas

- `chats` — chat metadata with JSON `messages` column, delayed extraction tracking (`lastDelayedExtractionAt`, `lastDelayedExtractionMessageIndex`)
- `chat_messages` — denormalized message table for FTS5 (chat_id, message_index, role, content, timestamp)
- `chat_messages_fts` — FTS5 virtual table with automatic triggers for full-text search
- `projects` — project metadata
- `settings` — key-value settings (single 'settings' key)
- `pending_states` — ask_user tool loop state for resume after server restart
- `corpus_entries` — image corpus metadata (type, imagePath, prompt, description, elements JSON, chat/project/direction IDs)
- `vec_corpus` — sqlite-vec virtual table (id, embedding float[1024] with cosine distance)
- `fts_corpus` — FTS5 virtual table (id, prompt, description) with auto-sync triggers
