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
- The iframe injects a small runtime-error forwarder for `error` and `unhandledrejection` events. The client reports the first runtime error for each artifact/version to `POST /api/chat/artifact-error`, which starts or queues a hidden repair turn. The server persists the repair prompt as a hidden system row and live-injects it as user-role context so provider replay avoids mid-transcript system messages.

**p5.js artifact guidance**:
- Prefer p5 instance mode for generated sketches. Global mode exposes lifecycle callbacks (`setup`, `draw`, `mouseMoved`, etc.) as global functions, which can interact badly with top-level `let`/`const` state and browser events during script initialization.
- Keep sketch state inside the `new p5((p) => { ... })` closure, define lifecycle handlers as `p.setup`, `p.draw`, and `p.mouseMoved`, and call p5 APIs through the instance object (`p.createCanvas`, `p.color`, `p.randomSeed`, `p.noiseSeed`).
- Avoid helper function names that shadow p5 APIs, especially `randomSeed`, `noiseSeed`, `color`, `createCanvas`, `resizeCanvas`, and `saveCanvas`.

Minimal pattern:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.min.js"></script>
<div id="sketch"></div>
<script>
  new p5((p) => {
    const canvasSize = 1200;
    let particles = [];
    let bg;

    p.setup = () => {
      const canvas = p.createCanvas(canvasSize, canvasSize);
      canvas.parent("sketch");
      bg = p.color(8, 8, 15);
      p.randomSeed(1);
      particles = [];
    };

    p.draw = () => {
      p.background(bg);
    };

    p.mouseMoved = () => {
      // Use p.mouseX/p.mouseY and other p.* APIs here.
    };
  });
</script>
```

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

## Corpus Utilities

The current corpus backend focuses on storage, enrichment, clustering, cleanup, and visualization:

- `image-corpus.ts` stores entries, embeddings, FTS rows, enrichment metadata, and orphan cleanup.
- `cluster-engine.ts` rebuilds density-based clusters from the current corpus.
- `cluster-storage.ts` persists cluster maps in `~/.quje-agent/clusters/clusters.json`.
- `visualization.ts` generates the D3 force-directed graph served by `/api/corpus/visualization`.

## Image Generation

**ComfyUI Integration** (`server/src/services/comfyui.ts`, `image-generation.ts`):
- Queue-based generation with progress tracking via SSE
- Generation state tracked in-memory with clientId for SSE subscriptions
- Links ComfyUI promptId to internal generationId for progress correlation
- Stored in `~/.quje-agent/images/{uuid}/` with metadata JSON

**Agent-driven generation**:
- Agent/tool-initiated image work flows through the image tools and ComfyUI services rather than a dedicated synthesis-time creative-direction scheduler.
- **GPU coordination**: model/resource coordination unloads LLMs as needed before ComfyUI execution to avoid VRAM contention.

**UI**: `ImageSandbox`, `ImageGallery`, `GeneratedImagePanel`, `CorpusView`

## Vision Analysis

- Image description and analysis with pluggable presets
- Conversation about analyzed images
- Stored in `~/.quje-agent/vision/`
- UI: `VisionGallery`, `VisionChat`, `VisionControls`
