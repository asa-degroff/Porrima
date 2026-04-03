# Artifacts & Image Systems

## Artifact System

**Creation**: The `create_artifact` tool receives `{ title, html }`. `sandbox.ts` writes the HTML to `~/.quje-agent/artifacts/{uuid}/index.html` and returns URL `/api/artifacts/{uuid}`.

**Serving** (`server/src/routes/artifacts.ts`):
- `GET /api/artifacts/:id` — serves `index.html` with `Content-Type: text/html`
- `GET /api/artifacts/:id/*subpath` — serves sub-files (CSS, JS, images) with path-traversal protection

**Persistence**: `ChatMessage.artifacts?: Artifact[]` stores `{ id, title, url }` for each artifact created during the message's tool loop. Artifacts survive server restarts because both the HTML files on disk and the URL references in chat JSON are stable.

**Client rendering** (`client/src/components/ArtifactPanel.tsx`):
- Fetches artifact HTML via `fetch(artifact.url)`, creates a `Blob` URL, and uses it as the iframe `src`.
- **Blob URLs are same-origin**, which avoids Chrome's `requestAnimationFrame` throttling on cross-origin iframes. Do NOT use `sandbox` attribute or direct `/api/artifacts/` URLs as iframe src — animations will freeze.
- "Code" tab shows the fetched source; "Open" link opens the raw `/api/artifacts/{id}` URL in a new tab.
- In `MessageBubble.tsx`, artifacts render via `(artifacts || message.artifacts)?.map(...)` — live streaming prop takes precedence, falls back to persisted `message.artifacts`.

## Image Corpus & Clustering

**Corpus Storage** (`server/src/services/image-corpus.ts`):
- Migrated from JSON to SQLite (`~/.quje-agent/image-corpus/corpus.db`) with sqlite-vec for vector search
- Stores all images: generated (ComfyUI), analyzed (vision), uploaded (user)
- **Schema**: `corpus_entries` table with JSON `elements` column (themes, settings, characters, concepts, styles, mood)
- **Vector search**: `vec_corpus` virtual table with 1024-dim prompt embeddings, cosine distance
- **FTS5**: `fts_corpus` on prompt + description with auto-sync triggers
- **Hybrid search**: `searchCorpusHybrid()` combines FTS5 + vector similarity via RRF (Reciprocal Rank Fusion)
- **Novelty scoring**: `computeNovelty(embedding)` returns 1.0 - maxSimilarity against corpus

**Clustering** (`server/src/services/cluster-engine.ts`, `cluster-storage.ts`):
- Density-based clustering using pairwise cosine similarity matrix
- Threshold: 0.85 similarity (configurable); images above threshold grouped together
- **Cluster properties**: centroid (average embedding), dominantElements (top 5 themes/settings/etc.), variance, size
- **Singletons**: unclustered images become single-member clusters
- **Persistence**: clusters saved to `~/.quje-agent/clusters/clusters.json`
- **UI**: CorpusView with force-directed graph visualization (D3), cluster detail panels

## Creative Engine

**Direction Generation** (`server/src/services/creative-engine.ts`):
- Analyzes corpus to propose novel creative directions for autonomous generation
- **5 direction types**:
  - `gap-fill` — fills underrepresented themes (e.g., "first cyberpunk image")
  - `remix` — cross-pollinates distant clusters (similarity < 0.7)
  - `deepen` — adds intricate details to large clusters (>5 members)
  - `contrast` — opposes dominant corpus patterns (e.g., dark → luminous)
  - `explore` — variations within a cluster theme
- **LLM integration**: Uses qwen3.5:9b with Z_IMAGE_INSTRUCTIONS prompt for detailed image descriptions
- **Image context**: Loads representative cluster member thumbnails (up to 3) as vision input to LLM
- **Novelty scoring**: `scoreNovelty(embedding, corpus)` computes 1.0 - avgTop5Similarity; default threshold 0.15
- **Degenerate output detection**: Validates LLM output for token repetition, n-gram loops, malformed markdown

**Direction Cache** (`server/src/services/direction-cache.ts`):
- 24-hour TTL with invalidation on corpus size change (>10%) or cluster count change
- Persists to `~/.quje-agent/directions/cache.json`
- In-memory cache + disk fallback for fast access

**Job Queue** (`server/src/services/job-queue.ts`):
- Async direction generation to avoid blocking UI requests
- Job statuses: `pending` → `running` → `complete` | `failed`
- Processes pending jobs sequentially with 1s delay between jobs
- Auto-unloads Ollama model after LLM work to free VRAM

## Image Generation

**ComfyUI Integration** (`server/src/services/comfyui.ts`, `image-generation.ts`):
- Queue-based generation with progress tracking via SSE
- Generation state tracked in-memory with clientId for SSE subscriptions
- Links ComfyUI promptId to internal generationId for progress correlation
- Stored in `~/.quje-agent/images/{uuid}/` with metadata JSON

**Autonomous Generation** (`server/src/services/autonomous-generation.ts`):
- Executes creative directions automatically during synthesis cycle
- **Dimension analysis**: Detects portrait/landscape/square from prompt keywords (person, landscape, vehicle, etc.)
- **GPU coordination**: Unloads Ollama model (keep_alive: "0s") before ComfyUI execution to avoid VRAM contention
- **Config**: CFG scale, steps, model override via `creativeDirections` settings
- Tracks `generatedBy: 'agent'` and `directionId` on GeneratedImage metadata

**UI**: `ImageSandbox`, `ImageGallery`, `GeneratedImagePanel`, `CorpusView`

## Vision Analysis

- Image description and analysis with pluggable presets
- Conversation about analyzed images
- Stored in `~/.quje-agent/vision/`
- UI: `VisionGallery`, `VisionChat`, `VisionControls`
