# Image Sandbox Extraction

**Status:** Executed
**Date:** 2026-10-02

> **This plan has been carried out.** The Image Sandbox now lives in its own repository
> (`image-studio`). The file names below are the Porrima-side names at the time this was
> written; most of them no longer exist here.

**Decision:** Cut the Image Sandbox (analyze / generate / corpus) out of Porrima. Ship it as a separate standalone app built from the extracted code.

## Why

The Image Sandbox is a self-contained workspace with no agent surface. No image-generation or vision-analysis tool is registered in `agent-tools.ts` — the agent can only *ingest* images, never produce or analyze them through a tool call. Everything in the sandbox is driven by a dedicated UI calling dedicated routes. Meanwhile the sandbox pulls ~10,300 lines of feature code plus a corpus database, a clustering engine, an HTML graph generator, and a GPU coordination layer into the agent repo, and it is the only reason Porrima depends on `corpus.db`, on corpus snapshot/restore, and on corpus background enrichment.

Separating it also gives the image product a configuration surface it should have had: today vision is hardwired to the local llama.cpp inference slot, which means it cannot be used without the full local model manager.

## Decisions

| Question | Decision |
| --- | --- |
| Scope | The whole sandbox, including corpus mode. Corpus is a sandbox mode, not an agent feature. |
| Destination | A separate repository, seeded with `git subtree split` to preserve history. |
| Vision backend | A user-supplied OpenAI-compatible endpoint + API key. No local model manager. |
| Element extraction | The same OpenAI-compatible endpoint, text-only completion. |
| Auth | Localhost trust by default, optional bearer token for LAN/remote use. |
| Data | New app-owned data dir; one-time importer reads Porrima's existing image dirs. |

## Non-goals

- No agent-side image generation, vision tools, or corpus tools are being added to Porrima in exchange.
- No change to chat image ingestion. Attachments, tool-result figures, artifact screenshots, markdown local images, and header images all stay.
- No visual redesign of the sandbox. The extraction is a port, not a redesign.

---

## 1. Scope boundary

The hard part of this cut is that "image" in Porrima means two unrelated things. Only one of them is the sandbox.

### 1.1 Moves to the standalone app

Everything reachable from the sandbox's three modes.

### 1.2 Stays in Porrima — do not cut

This list is load-bearing for the agent. Cutting any of it breaks chat.

| Area | Files | Why it stays |
| --- | --- | --- |
| Chat attachments | `services/user-image-storage.ts`, `routes/user-images.ts` | Base64 attachments in `POST /api/chat` / `/edit`, WebP thumbs, removal by rewriting the message row. Called from `routes/chat.ts`, `routes/notebooks.ts`, `services/agent.ts`. |
| Tool-result images | `services/tool-result-image-storage.ts`, `routes/tool-result-images.ts` | `read_pdf` with `extractImages`, `browser_screenshot`, artifact preview screenshots. Called from `routes/chat.ts`, `services/chat-turn-runner.ts`, `services/agent.ts`. |
| Payload migrations | `services/inline-image-payload-migration.ts`, `services/tool-result-image-payload-migration.ts`, `scripts/migrate-*.ts` | One-shot base64 externalization for existing chats. Must run to completion in Porrima before any corpus data is touched. |
| Markdown local images | `services/local-image-serving.ts`, `routes/local-images.ts` | Serves `/tmp/render.png`-style scratch images referenced by agent markdown, straight from disk with root/magic-byte/size checks. |
| Header images | `services/header-image-storage.ts`, `routes/settings.ts` header endpoints | Chat header artwork, 96×96 WebP thumb, mtime cache-busting. |
| Chat vision | `services/openai-compat-provider.ts` (`normalizeImageForLlamaCpp`, `resolveImagePixelBudget`, `IMAGE_CAP_PRESETS`), `services/models.ts` (`supportsImages`) | Images attached to chat messages still go to a vision model. `settings.imageCapPreset` is a **chat** setting and stays. |
| Client image rendering | `components/UserImage.tsx`, `components/ImageLightbox.tsx`, `components/ui/MarkdownImage.tsx`, `components/ui/MarkdownRenderer.tsx`, `utils/image.ts`, `utils/localImage.ts` (+ `localImage.test.ts`) | Attachment rendering, lightbox, markdown `<img>`. `ImageLightbox` is imported by `MessageBubble`, `ToolCallDisplay`, `MarkdownImage` — it stays even though it looks sandbox-adjacent. |
| `sharp` dependency | — | Also used by `browser-session.ts`, `artifact-preview.ts`, `header-image-storage.ts`. Stays regardless. |

**Trap:** `express.json({ limit: "50mb" })` in `server/src/index.ts` looks like it exists for sandbox base64 payloads. It does not — chat still posts inline base64 attachments. Do not reduce it.

**Trap:** `ImageLightbox.tsx` and `ProgressiveImage.tsx` read as a matched pair. `ImageLightbox` stays, `ProgressiveImage` moves. Verify the import list before deleting either.

---

## 2. What moves — inventory

### 2.1 Server (≈5,950 lines)

| File | Lines | Notes |
| --- | --- | --- |
| `routes/images.ts` | 333 | 12 endpoints under `/api/images` |
| `routes/vision.ts` | 380 | 11 endpoints under `/api/vision` |
| `routes/corpus.ts` | 229 | 8 endpoints under `/api/corpus`, dynamic-imports `visualization.ts` |
| `routes/image-corpus.ts` | 101 | 7 endpoints under `/api/image-corpus` |
| `services/image-backend.ts` | 41 | `ImageBackend` interface + factory. Clean port. |
| `services/comfyui.ts` | 411 | REST queue + WebSocket progress |
| `services/sdcpp.ts` | 325 | A1111 `txt2img`, scheduler mapping, `sd-server.service` lifecycle |
| `services/image-generation.ts` | 217 | In-memory `GenerationState` registry, SSE bus, debounced `generations.json` |
| `services/image-storage.ts` | 172 | Blob store, JXL encode, WebP thumbs |
| `services/vision-analysis.ts` | 827 | **Rewrite the LLM layer** — see §3.2 |
| `services/image-corpus.ts` | 1071 | Corpus SQLite + sqlite-vec + FTS5 + RRF hybrid search |
| `services/cluster-engine.ts` | 245 | Density clustering, threshold 0.97 |
| `services/cluster-storage.ts` | 280 | Cluster map + centroid/element/variance math |
| `services/element-extraction.ts` | 123 | **Rewrite the LLM call** — see §3.4 |
| `services/visualization.ts` | 861 | D3 v7 force-directed graph HTML. Self-contained. |
| `services/resource-coordinator.ts` | 336 | **Truncate** — see §3.3 |

### 2.2 Client (≈3,940 lines)

| File | Lines | Notes |
| --- | --- | --- |
| `components/ImageSandbox.tsx` | 960 | Mode shell, header, drawers, lightbox, keyboard nav |
| `components/ImageControls.tsx` | 645 | Generation form. Owns `MODEL_PRESETS` for `z-image-base` / `z-image-turbo`. |
| `components/ImageGallery.tsx` | 309 | Masonry grid, live tiles |
| `components/ImageDetails.tsx` | 115 | Right-rail params panel |
| `components/ImageCarousel.tsx` | 71 | Thumbnail strip |
| `components/ProgressiveImage.tsx` | 189 | Blur-thumb → sharp cross-fade loader |
| `components/ImageSearch.tsx` | 95 | Debounced hybrid search box |
| `components/VisionControls.tsx` | 266 | Preset picker, upload with WebP compression |
| `components/VisionChat.tsx` | 334 | Analyze-mode conversation pane. Mirrors `VISION_PRESETS` client-side. |
| `components/CorpusView.tsx` | 157 | Sandboxed iframe of `/api/corpus/visualization` |
| `components/GeneratedImagePanel.tsx` | 29 | Chat inline card — see §6.1 |
| `hooks/useImageSandbox.ts` | 396 | Generate-mode state |
| `hooks/useVisionSandbox.ts` | 257 | Analyze-mode state |
| `utils/imageCache.ts` | 113 | Cache API image cache. Only `ProgressiveImage` + `ImageGallery` use it. |

Plus `api/client.ts` lines 774–1024 (image generation) and 1026–1215 (vision) — ≈450 lines — and the image interfaces in `client/src/types.ts`.

### 2.3 Wiring that must be unwound

| File | What |
| --- | --- |
| `client/src/App.tsx` | Lazy import (L12), `imageSandboxOpen` state, 4 restore/close handlers, conditional render, 5 Sidebar props, 3 effect guards |
| `client/src/components/Sidebar.tsx` | "Images" launcher button (L1840–1857) + props |
| `client/src/components/SettingsModal.tsx` | `imageSandboxEnabled` state, backend/corpus tab group, image-cap section (partially stays), persisted payload keys |
| `server/src/index.ts` | 4 route mounts (L190–193), `CORPUS_CLEANUP` startup block (L214–228) |
| `server/src/services/chat-storage.ts` | Default `imageSandboxEnabled: true` (L1349); `UserUIState.activeView` union (L2765) |
| `server/src/services/agent-snapshots.ts` | Corpus snapshot/restore — 13 sites, L8/21/36/50/55/61/136–257 |
| `server/src/services/scheduler.ts` | `enrichCorpusBatchDetailed` background job |
| `server/src/services/embedding-migration.ts` | Corpus embedding backup/migrate/restore |
| `server/src/types.ts`, `client/src/types.ts` | Settings fields + image interfaces |
| `server/rebuild_corpus.mjs`, `rebuild_corpus2.mjs` | Ad-hoc scripts at package root, not in `src/`, not wired to any npm script |

### 2.4 Settings fields

| Field | Action |
| --- | --- |
| `imageSandboxEnabled` | Cut (default flips to nothing) |
| `imageBackend` (`"comfyui" \| "sdcpp"`) | Cut |
| `comfyuiUrl`, `sdcppUrl` | Cut |
| `defaultVisionPreset` | Cut |
| `defaultVisionModelId` | Cut — **already dead.** Declared in both `types.ts` files, read by nothing. |
| `imageCapPreset` | **Stays.** Chat vision sizing. |

Stale persisted settings rows are harmless — the settings table is a key/value blob and unknown keys are ignored on read.

---

## 3. Standalone app design

### 3.1 Shape

- **Repo:** new, seeded by `git subtree split` over the paths in §2 plus their test files.
- **Stack:** unchanged — Express + TypeScript + vitest server, React + Vite + Tailwind v4 client. Reusing the patterns costs less than diverging from them.
- **Data dir:** `~/.image-studio/` via the same `PORRIMA_DATA_DIR`-style env override. Subtrees: `images/`, `vision/`, `corpus/corpus.db`, `clusters/clusters.json`.
- **Port:** pick something outside Porrima's 3001/32100–32104 band.
- **Routing:** the sandbox becomes the app root. Drop `App.tsx`'s chat/notebook/chat-view machinery, `useChat`, `Sidebar`, and the ui-state `activeView` persistence; keep `activeView` as a plain localStorage mode key (`porrima-sandbox-mode` carries over as-is).

### 3.2 Vision: llama.cpp → OpenAI-compatible endpoint

`vision-analysis.ts` is the largest rewrite. Today it is wired to the local inference slot at every layer:

| Current | Replacement |
| --- | --- |
| `resolveVisionBackend()` → `getDefaultLlamaServerUrl("inference")` | `visionBaseUrl` setting, default `https://api.openai.com/v1` |
| *(none)* | `visionApiKey` setting → `Authorization: Bearer` |
| `resolveVisionModelId()` → `defaultModelId` / `VLM_MODEL_NAME` / `qwen3-vl:4b` | `visionModel` setting, populated from `GET /v1/models` |
| `ensureModelLoaded()` | *Delete.* No model manager. |
| `chat_template_kwargs: { enable_thinking: true }` | *Delete.* llama.cpp-specific. |
| `requestLlamaCppVisionCompletion()` | Generic POST to `${baseUrl}/chat/completions` |
| `normalizeImageForLlamaCpp()` | `normalizeImage()` — see below |
| `beginStream`/`endStream` from `llm-activity.ts` | *Delete.* Only exists to tell the resource coordinator an LLM stream is live. |
| `discoverAllModels` from `models.ts` | `GET /v1/models` probe |
| `reasoning_content` in the stream | Keep as best-effort. Many OpenAI-compatible servers return it; several do not. Make thinking display conditional on it being present, never a required field. |

**Request body** stays close to the current one — it is already valid OpenAI chat-completions:

```jsonc
{
  "model": "<visionModel>",
  "stream": true,
  "max_tokens": 2048,
  "temperature": 0.7,
  "messages": [
    { "role": "system", "content": "<preset prompt>" },
    { "role": "user", "content": [
      { "type": "text", "text": "Describe this image." },
      { "type": "image_url", "image_url": { "url": "data:image/webp;base64,..." } }
    ]}
  ]
}
```

Only the auth header and `Authorization`-less llama.cpp routing change.

**`normalizeImageForLlamaCpp` must be split, not copied.** It does two things: enforce a pixel budget, and align dimensions to llama.cpp's 28px `smart_resize` grid so repeated sends produce byte-identical input for slot-cache matching. The second half is meaningless against a remote API. Keep `targetSizeForBudget` and delete the 28-alignment; keep the pixel-budget presets as a useful cap on upload size.

Also drop `readImageCapEnvCeiling()`'s llama.cpp coupling and reuse `IMAGE_CAP_PRESETS` as a plain `standard | detailed | maximum` setting.

### 3.3 Resource coordinator: 336 → ~150 lines

This is the single biggest simplification win, and it is exactly what "we are separating it from porrima" buys.

`resource-coordinator.ts` currently serves two masters: the image backends, and the local LLM. **Delete the LLM half** — there is no LLM in this app:

- `unloadLLMModels()`, `collectLoadedModels()`, `estimateLlamaCppSize()`, `loadModelSizeBytes()`
- The `llm-activity.js` import and the `waitForIdle()` step at the head of `acquireResources()`
- The `llama-ports.js` import

**Keep:** `checkFreeVRAM()`, `getFreeRAMBytes()`, `freeComfyUIModels()`, `restartComfyUIService()` (the ROCm leak workaround is a ComfyUI problem, not an LLM problem), `MIN_FREE_VRAM_BYTES` (6 GB), `MIN_FREE_RAM_BYTES` (15 GB), `acquireResources()`, and the `CoordinatorPhase` / `CoordinatorStatus` types the UI status dot reads.

Net effect on the backends: `acquireResources()` becomes "check headroom, free ComfyUI models if needed" instead of "wait for the LLM to go idle, then unload models smallest-first until the deficit is covered".

`comfyui.ts` and `sdcpp.ts` change only in that import. `sdcpp.ts` keeps its entire `sd-server.service` lifecycle manager — that is one of the two managers being retained.

### 3.4 Element extraction on the API endpoint

`element-extraction.ts` imports `streamChat` from `./agent` (the whole agent harness) and `withExtractionMutex` from `./memory-extraction`. Both must go.

- Replace `streamChat` with a plain non-streaming chat completion through the new vision client. The endpoint must support text completions — any vision-capable OpenAI-compatible server does, but make the requirement explicit in setup docs and fail with a clear message if the model rejects a text-only request.
- Replace `withExtractionMutex` with a local ~10-line promise-chain mutex.
- `ELEMENT_EXTRACTION_MODEL` env → the `visionModel` setting, or a separate `extractionModel` if users want a cheap text model. Prefer separate, defaulting to `visionModel`.

This drops the last hard dependency of the image stack on the agent harness.

### 3.5 Auth

Drop `routes/auth.ts`, `services/auth-storage.ts`, `middleware/auth.ts`, `services/session-cookie-config.ts`, `hooks/useAuth.ts`, `api/auth.ts`, and `@simplewebauthn/server`. Bind `127.0.0.1` and trust the connection; add an optional bearer token checked in middleware for LAN/remote use.

### 3.6 Data import

Porrima leaves `~/.porrima/{images,vision,image-corpus,clusters}` untouched after the cut — **no deletion, no migration out of Porrima.** The new app gets a one-time importer:

```
image-studio-import --source ~/.porrima [--dry-run]
```

- Copy `images/{id}/` trees and `vision/images/{id}/` trees.
- Copy `image-corpus/corpus.db` and `clusters/clusters.json` **together** — cluster entries reference corpus entry ids, so migrating one without the other orphans the map.
- Re-hydrate `images/generations.json`. Its 24-hour GC and its force-mark-stale-rows-as-`error`-on-load behavior are both correct; port them unchanged.
- Rewrite nothing in the copied SQLite. Corpus entries store relative paths under the data dir, so a plain directory copy works.

### 3.7 Other simplification candidates

Not required, but worth a decision:

- **JXL encode.** `image-storage.ts` is the only consumer of `icodec` (JPEG XL). Dropping it to PNG/WebP removes a native dependency for no user-visible loss in a browser. *Recommend dropping.*
- **D3 via CDN.** `visualization.ts:92` embeds `https://d3js.org/d3.v7.min.js`, so `/api/corpus/visualization` renders nothing offline. *Recommend vendoring d3 into the client build.*
- **`ImageSandbox` already is the app.** Don't rebuild a shell around it.

---

## 4. Dependency delta

### Porrima

| Package | Action |
| --- | --- |
| `icodec` | **Remove.** Sole consumer was `image-storage.ts`. |
| `sharp` | Stays — `browser-session.ts`, `artifact-preview.ts`, `header-image-storage.ts`, `user-image-storage.ts`, `openai-compat-provider.ts`. |
| `sqlite-vec`, `better-sqlite3` | Stay — memory system uses both. |
| `ws` | Stay — `browser-session.ts`. |
| `undici` | Stay — `openai-compat-provider.ts`, `cache-warm.ts`, `skills.ts`. |

Be honest about this in the release notes: the dependency win is one package. The real win is ~10,300 lines of feature code, a database, a background job, and a subsystem that had no business being in the agent repo.

### Standalone app

`sharp`, `sqlite-vec`, `better-sqlite3`, `ws`, `undici`, `uuid`. Plus optional `icodec`. Loses `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@simplewebauthn/server`, `puppeteer-core`, `web-push`, `linkedom`, `@mozilla/readability`, `turndown`, `busboy`, `sentence-tokenizer`, and the TTS stack.

---

## 5. Execution order

Extract first, cut second. The standalone app must be usable before the sandbox leaves Porrima, or there is a gap where the feature exists nowhere.

| Phase | Work | Gate |
| --- | --- | --- |
| **0. Freeze** | Tag the extraction point. Record the `porrima` version so the new app can offer a matching importer. | — |
| **1. Extract** | `git subtree split` the §2 paths into the new repo. Delete the llama.cpp, agent-harness, and Porrima-settings imports. Get it to build and run on the local backend before rewiring. | New app builds, runs, and round-trips a ComfyUI generation against a real backend. |
| **2. Rewire** | OpenAI-compatible vision client (§3.2), trimmed coordinator (§3.3), element extraction on the API (§3.4), auth swap (§3.5), data dir + importer (§3.6). | Analyze mode works against a hosted vision model; generate mode works against ComfyUI **and** SDCPP; corpus mode builds clusters and renders the graph. |
| **3. Cut** | Remove the §2 files, unmount the 4 routes, unwire §2.3, drop the settings fields, delete `icodec`. Delete the `generatedImages` chat plumbing (§6.1). | `npx tsc --noEmit` clean in `server/` and `client/`; `npm test` green; boot the server and confirm chat attachments, `read_pdf` figures, artifact screenshots, and markdown local images all still work. |
| **4. Docs & install** | Split `docs/artifacts-and-images.md`. Update `api-reference.md`, `data-storage.md`, `ui-patterns.md`, `AGENTS.md`. Remove the `images` feature from `install/features.json` and `install/render-agent-prompt.mjs`. Delete `rebuild_corpus*.mjs`. | Docs contain no dangling references to removed files or endpoints. |
| **5. Verify** | Full regression on image ingestion paths. Confirm `~/.porrima/{images,vision,image-corpus,clusters}` is untouched and the importer produces a byte-complete copy. | Manual pass over §1.2. |

Phases 1–2 are the new repo's work and do not block on Porrima. Phases 3–4 are the Porrima cut and can proceed once phase 2 ships.

---

## 6. Findings from the review

### 6.1 The `generatedImages` chat channel is dead code

`GeneratedImagePanel.tsx` renders generated images inline in chat. Tracing it end to end:

- `synthesis-stream.ts:198` defines `emitGeneratedImage()`.
- **It has zero callers.**
- No image-generation tool is registered in `agent-tools.ts`, so the agent can never produce a `GeneratedImage`.
- No chat route emits the `generated_image` SSE event.

The plumbing is nonetheless threaded through ~40 sites: `ChatMessage.generatedImages` (`types.ts:78`), the `generated_image` segment type (`types.ts:33`), `chat-turn-runner.ts` (7 sites), `synthesis-stream.ts`, `automation-runner.ts`, `system-chat.ts`, `ChatView.tsx`, `MessageBubble.tsx` (3 sites), `useChat.ts` (10 sites), `steeringPlaceholders.ts`.

`GeneratedImagePanel.tsx` moves to the new app as part of §2, but the surrounding chat plumbing is Porrima's to remove.

**Caveat:** `ChatMessage.generatedImages` is persisted inside the JSON `messages` blob on `chats`. If any historical row carries a non-empty array, a hard type removal is still safe as long as readers stay tolerant of the unknown field — JSON.parse drops nothing, but the TypeScript type must not become a reason to reject a row. Verify against `app.db` before assuming every row is empty.

### 6.2 `server/src/services/image-presets.ts` does not exist

`AGENTS.md` and `docs/artifacts-and-images.md:126` both reference it. No such file, no import of it anywhere. The `z-image-base` / `z-image-turbo` presets are hardcoded client-side in `ImageControls.tsx:7-10`. Fix the docs; move the presets to a real shared module in the new app.

### 6.3 `sandbox.ts` is unrelated

`services/sandbox.ts` is the Python executor and artifact writer. It has nothing to do with the Image Sandbox and is not part of this extraction. Likewise the Chromium `--no-sandbox` flags in `browser-session.ts`, `artifact-preview.ts`, `web-tools.ts`, and `CorpusView`'s HTML `sandbox="allow-scripts allow-same-origin"` attribute.

### 6.4 `defaultVisionModelId` is already dead

Declared at `server/src/types.ts:415` and `client/src/types.ts:474`. Read by nothing — `vision-analysis.ts:resolveVisionModelId()` falls back to `settings.defaultModelId`, not this. Delete rather than migrate.

### 6.5 The stale-`data-storage.md` note about `imageCache.ts`

`docs/data-storage.md:16` lists `utils/imageCache.ts` among the files carrying `LEGACY_*` constants. It does not — it has a plain `porrima-images-v1` cache prefix with no legacy key. Cosmetic doc fix while in the area.

---

## 7. Tests

**Moves with the code:**
- `server/src/__tests__/image-corpus.test.ts` (95) — enrichment batching and idempotency
- `server/src/services/cluster-engine.test.ts` (111) — clustering math

**Must be rewritten, not moved** — all three depend on modules that no longer exist in the new app:
- `server/src/__tests__/delayed-extraction-scheduler.test.ts` — mocks `image-corpus.js`'s `enrichCorpusBatchDetailed`
- `server/src/services/system-pause-scheduler.test.ts` — mocks `enrichCorpusBatch`

**Stays in Porrima (image ingestion):**
- `__tests__/image-replay-hydration.test.ts`, `__tests__/user-image-storage.test.ts`, `__tests__/local-image-serving.test.ts`, `__tests__/inline-image-payload-migration.test.ts`, `__tests__/tool-result-image-payload-migration.test.ts`, `__tests__/openai-compat-provider.test.ts`, `__tests__/storage-diagnostics.test.ts`, `client/src/utils/localImage.test.ts`

**Test coverage gaps worth closing in the new app** — none of these have tests today:
`routes/images.ts`, `routes/vision.ts`, `routes/corpus.ts`, `routes/image-corpus.ts`, `services/image-generation.ts` (the `generations.json` GC and stale-row recovery are the easy things to get wrong), `services/image-storage.ts`, `comfyui.ts`, `sdcpp.ts` (scheduler name mapping, zombie-context restart), `visualization.ts`, `element-extraction.ts`, and every client sandbox component. The vision client rewrite in §3.2 is the highest-value place to start.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Corpus loses its embedding source | Corpus enrichment currently batches through `scheduler.ts` against the local extraction model. The new app has no scheduler to piggyback on — give the new app its own enrichment queue driven by the API endpoint, and budget for it (a remote text call per unenriched entry). |
| Cluster map orphans on migration | `clusters.json` references `corpus_entries` ids. Import `corpus.db` and `clusters.json` as one unit (§3.6). |
| Extraction rate limits | A first run over an existing corpus fires one API call per entry. Batch, back off on 429, and make the queue resumable. |
| Chat image regressions | §1.2 is the checklist. `sharp`, `icodec`, and the 50 MB body limit are the three most likely accidental casualties. |
| `generatedImages` removal hits persisted rows | Tolerant readers (§6.1). |
| Users lose the feature in the gap | Phase order: ship the new app before the cut. |
| Corpus search regresses on a different model | The 0.97 clustering threshold and the embedding dimension are tuned to the current model. Re-cluster after the extraction model changes and treat the threshold as tunable. |

---

## 9. Follow-ups

- Pick the app name, repo URL, and port. The data dir and `porrima-sandbox-mode` storage key should be renamed to match.
- Decide JXL: drop `icodec` from the new app (recommended) or keep parity.
- Decide whether the new app keeps the analyze → "Send to Generate" handoff. It is implemented in `VisionChat.tsx` and survives the port, but it is worth confirming it is a workflow people actually use before carrying it forward.
- Consider vendoring d3 so the corpus graph renders offline (§3.7).
- After phase 5, retire `Settings.imageSandboxEnabled` from any settings UI copy that still mentions generation being "available to agents and other features" — that copy is already wrong today, since no agent tool generates images.