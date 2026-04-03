# Key Patterns & Important Notes

## Key Patterns

- **Streaming**: SSE with event types `text_delta`, `thinking_delta`, `tool_status`, `artifact`, `ask_user`, `done`, `error`, `iteration`, `warning`, `compaction`, `title_update`, `message_complete`, `follow_up_start`
- **Types**: Shared interfaces in `server/src/types.ts` and `client/src/types.ts` (kept in sync manually)
- **Storage**: SQLite for chats/projects/settings/pending (`chat-storage.ts` → `~/.quje-agent/app.db`), SQLite + sqlite-vec for memories (`memory-storage.ts` → `~/.quje-agent/memory/memories.db`), SQLite + sqlite-vec for image corpus (`image-corpus.ts` → `~/.quje-agent/image-corpus/corpus.db`), notebooks via `notebook-storage.ts` → `~/.quje-agent/notebooks/`. All use `~/.quje-agent/` as the base directory.
- **LLM providers**: Two registered pi-ai providers — `ollama-native` for Ollama's `/api/chat` and `openai-compat` for llama.cpp / OpenAI-format servers. `discoverAllModels()` merges both; `createPiModelFromProvider()` routes by `provider` field. llama.cpp router mode tracks `lastLoadedModel` to minimize model swap overhead.
- **Context window**: Fetched per-model from Ollama `/api/show` (`model_info.*.context_length`). Per-chat override via `chat.contextWindow`; effective value is `chat.contextWindow ?? model.contextWindow`.
- **Embeddings**: Ollama `qwen3-embedding:0.6b` via `POST http://localhost:11434/api/embed` (supports 32k context). Vectors are L2-normalized, so cosine similarity = dot product.
- **Memory scoring**: `rrf_score * recency_decay * (importance / 10)` with RRF combining vector search and FTS5 full-text search rankings; 30-day half-life on recency.
- **Memory dedup**: cosine > 0.85 between a new fact and existing memory triggers UPDATE instead of ADD. Uses sqlite-vec KNN MATCH for nearest-neighbor lookup.
- **Supersession tracking**: memories can be linked via `superseded_by` / `supersedes` columns when contradicted or updated. Confidence threshold (default 0.75) determines automatic linking; manual override via API.
- **Delayed extraction**: time-based trigger (configurable, default 30 min) extracts memories from inactive chats. Uses `updateChatExtractionState()` to avoid modifying `lastModified` (preserves chat ordering).
- **Project scoping**: memories have optional `projectId`; synthesis groups chats and memories by project, loading each project's AGENTS.md for context.
- **GPU coordination**: Ollama LLM and ComfyUI cannot run concurrently on single GPU. Scheduler unloads Ollama model (`keep_alive: "0s"`) with 3s pause before ComfyUI execution. Direction generation jobs also unload after LLM work. llama.cpp shares GPU flag (`llamacppSharesGpu`) controls whether Ollama is unloaded before llama.cpp inference; `invalidateLoadedModel()` resets router mode cache when needed.
- **Creative direction caching**: 24h TTL, invalidates on corpus size change (>10%) or cluster count change. Prevents redundant LLM calls on page refresh.
- **Job queue**: Async direction generation avoids blocking UI; jobs processed sequentially with 1s delay between runs.
- **Novelty scoring**: `1.0 - avgTop5Similarity` against corpus embeddings; default threshold 0.15 (more permissive than original 0.6).
- **Clustering**: Density-based with 0.85 cosine similarity threshold; O(n²) pairwise matrix acceptable for n<500 images.
- **Element extraction**: `element-extraction.ts` extracts visual elements into 10 structured categories (themes, characters, settings, concepts, styles, colors, composition, lighting, textures, mood) using qwen3.5:9b with vision input.
- **Generate review**: `generate-review.ts` supports multi-iteration image generation with agent review loops for quality refinement.
- **Backward compat**: `getChat()` and `listChats()` default missing `type` to "quick". Memory DB auto-migrates `project_id` column. Chat/project/settings JSON files auto-migrate to SQLite on startup. Corpus JSON auto-migrates to SQLite on first startup.

## Important Notes

- The `memory.ts` routes must define `/status`, `/synthesis/*`, and `/search` **before** the `/:id` param routes to avoid Express matching those paths as IDs.
- `streamChat` from `agent.ts` is reused by extraction, synthesis, and tool execution — it's the single LLM call interface.
- The scheduler (`scheduler.ts`) runs a synthesis check on startup and then every 15 minutes via `setInterval`. Delayed extraction checks run every 5 minutes.
- **Creative cycle**: After successful synthesis, scheduler runs `runCorpusCreativeCycle()` — rebuilds clusters, generates directions, saves as memories, executes top directions. GPU coordination unloads Ollama before ComfyUI.
- **Direction cache**: Cached in `~/.quje-agent/directions/cache.json` with 24h TTL. Invalidates on corpus size change (>10%) or cluster count change. API returns cached results immediately while queuing background refresh.
- **Job queue**: Direction generation jobs are queued and processed sequentially to avoid GPU contention. Client polls `/api/corpus/directions/job/:id` for completion.
- **Cluster persistence**: Clusters saved to JSON (`~/.quje-agent/clusters/clusters.json`), not SQLite. Rebuilt on demand via `/api/corpus/rebuild-clusters`.
- **Corpus migration**: On first startup, `corpus.json` auto-migrates to `corpus.db` with FTS5 + sqlite-vec indexes. Original renamed to `corpus.json.bak`.
- When editing types, update both `server/src/types.ts` and `client/src/types.ts`.
- The server may run compiled `dist/index.js` (via `npm start` / systemd) rather than tsx dev mode — source changes require `npm run build` + restart to take effect.
- Blob URLs for artifacts are critical for Chrome animation performance — do not use cross-origin iframe src.
- Bluesky session is encrypted at rest via `bluesky-agent.ts`. The poller emits events that the chat route subscribes to for notification injection.
- llama.cpp provider supports both single-model and router mode. Router mode calls `/models/load` to switch models; single-model mode gracefully ignores 404s from that endpoint.
- The `extractionModelId` setting allows using a separate model for memory extraction; `extractionFallbackEnabled` controls whether to fall back to the default model if the extraction model is unavailable.
