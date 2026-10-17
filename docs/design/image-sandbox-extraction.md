# Image Sandbox Extraction

**Completed extraction record:** the Image Sandbox (analyze / generate / corpus) was cut
out of Porrima into a separate app (`image-studio`). Everything listed below as *moving*
no longer exists in this repo — the file names are Porrima-side names at cut time. Two
carry-over facts: the dependency win was one package (`icodec`), while `sharp` and
`undici` stay for other features; and the ordering invariant that made the cut safe —
**extract first, cut second**: the standalone app must be usable before the sandbox
leaves Porrima, or there is a gap where the feature exists nowhere. Everything §1.2
lists as *staying* is load-bearing for the agent — cutting any of it breaks chat.

**Decision:** Cut the Image Sandbox (analyze / generate / corpus) out of Porrima. Ship it as a separate standalone app built from the extracted code.

## Why

The Image Sandbox is a self-contained workspace with no agent surface. No image-generation or vision-analysis tool is registered in `agent-tools.ts` — the agent can only *ingest* images, never produce or analyze them through a tool call. Everything in the sandbox is driven by a dedicated UI calling dedicated routes. Meanwhile the sandbox pulled ~10,300 lines of feature code plus a corpus database, a clustering engine, an HTML graph generator, and a GPU coordination layer into the agent repo, and it was the only reason Porrima depended on `corpus.db`, on corpus snapshot/restore, and on corpus background enrichment.

Separating it also gives the image product a configuration surface it should have had: vision was hardwired to the local llama.cpp inference slot, which means it cannot be used without the full local model manager.

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
| Payload migrations | `services/inline-image-payload-migration.ts`, `services/tool-result-image-payload-migration.ts`, `scripts/migrate-*.ts` | One-shot base64 externalization for existing chats — they rewrite chat rows, so they stay with chat storage; the cut sequenced them ahead of any corpus move. |
| Markdown local images | `services/local-image-serving.ts`, `routes/local-images.ts` | Serves `/tmp/render.png`-style scratch images referenced by agent markdown, straight from disk with root/magic-byte/size checks. |
| Header images | `services/header-image-storage.ts`, `routes/settings.ts` header endpoints | Chat header artwork, 96×96 WebP thumb, mtime cache-busting. |
| Chat vision | `services/openai-compat-provider.ts` (`normalizeImageForLlamaCpp`, `resolveImagePixelBudget`, `IMAGE_CAP_PRESETS`), `services/models.ts` (`supportsImages`) | Images attached to chat messages still go to a vision model. `settings.imageCapPreset` is a **chat** setting and stays. |
| Client image rendering | `components/UserImage.tsx`, `components/ImageLightbox.tsx`, `components/ui/MarkdownImage.tsx`, `components/ui/MarkdownRenderer.tsx`, `utils/image.ts`, `utils/localImage.ts` (+ `localImage.test.ts`) | Attachment rendering, lightbox, markdown `<img>`. `ImageLightbox` is imported by `MessageBubble`, `ToolCallDisplay`, `MarkdownImage` — it stays even though it looks sandbox-adjacent. |
| `sharp` dependency | — | Also used by `browser-session.ts`, `artifact-preview.ts`, `header-image-storage.ts`. Stays regardless. |

**Retired settings keys.** The sandbox's settings fields (`imageSandboxEnabled`,
`imageBackend`, `comfyuiUrl`/`sdcppUrl`, `defaultVisionPreset`, `defaultVisionModelId`)
are stripped through `RETIRED_SETTINGS_KEYS` in `chat-storage.ts`. Stale persisted
settings rows are harmless on read — the settings table is a key/value blob and unknown
keys are ignored — but `saveSettings` merges rather than replaces, so retired keys would
linger in rows forever unless dropped at the `normalizeSettings()` choke point that both
reads and writes pass through. `defaultVisionModelId` was already dead before the cut:
declared in both `types.ts` files, read by nothing (`resolveVisionModelId()` fell back to
`defaultModelId`). `imageCapPreset` is a **chat** setting and stays.

**Trap:** `express.json({ limit: "50mb" })` in `server/src/index.ts` looks like it exists for sandbox base64 payloads. It does not — chat still posts inline base64 attachments. Do not reduce it.

**Trap:** `ImageLightbox.tsx` and `ProgressiveImage.tsx` read as a matched pair, but the import lists tell a different story: `ImageLightbox` stays (chat renders it), `ProgressiveImage` moved with the sandbox. The pairing is not evidence of shared ownership.

**Not the Image Sandbox:** `services/sandbox.ts` is the Python executor and artifact writer — unrelated to the Image Sandbox and never part of this extraction. Likewise the Chromium `--no-sandbox` flags in `browser-session.ts`, `artifact-preview.ts`, and `web-tools.ts`, and CorpusView's HTML `sandbox="allow-scripts allow-same-origin"` attribute.

---

## 2. Standalone app design

The standalone app as designed at cut time:

### 2.1 Shape

- **Repo:** new, seeded by `git subtree split` over the sandbox paths plus their test files.
- **Stack:** unchanged — Express + TypeScript + vitest server, React + Vite + Tailwind v4 client. Reusing the patterns costs less than diverging from them.
- **Data dir:** `~/.image-studio/` via the same `PORRIMA_DATA_DIR`-style env override. Subtrees: `images/`, `vision/`, `corpus/corpus.db`, `clusters/clusters.json`.
- **Port:** pick something outside Porrima's 3001/32100–32104 band.
- **Routing:** the sandbox becomes the app root. Drop `App.tsx`'s chat/notebook/chat-view machinery, `useChat`, `Sidebar`, and the ui-state `activeView` persistence; keep `activeView` as a plain localStorage mode key (`porrima-sandbox-mode` carries over as-is).

### 2.2 Vision: llama.cpp → OpenAI-compatible endpoint

`vision-analysis.ts` is the largest rewrite. It was wired to the local inference slot at every layer:

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

### 2.3 Resource coordinator: 336 → ~150 lines

This is the single biggest simplification win, and it is exactly what "we are separating it from porrima" buys.

`resource-coordinator.ts` currently serves two masters: the image backends, and the local LLM. **Delete the LLM half** — there is no LLM in this app:

- `unloadLLMModels()`, `collectLoadedModels()`, `estimateLlamaCppSize()`, `loadModelSizeBytes()`
- The `llm-activity.js` import and the `waitForIdle()` step at the head of `acquireResources()`
- The `llama-ports.js` import

**Keep:** `checkFreeVRAM()`, `getFreeRAMBytes()`, `freeComfyUIModels()`, `restartComfyUIService()` (the ROCm leak workaround is a ComfyUI problem, not an LLM problem), `MIN_FREE_VRAM_BYTES` (6 GB), `MIN_FREE_RAM_BYTES` (15 GB), `acquireResources()`, and the `CoordinatorPhase` / `CoordinatorStatus` types the UI status dot reads.

Net effect on the backends: `acquireResources()` becomes "check headroom, free ComfyUI models if needed" instead of "wait for the LLM to go idle, then unload models smallest-first until the deficit is covered".

`comfyui.ts` and `sdcpp.ts` change only in that import. `sdcpp.ts` keeps its entire `sd-server.service` lifecycle manager — that is one of the two managers being retained.

### 2.4 Element extraction on the API endpoint

`element-extraction.ts` imports `streamChat` from `./agent` (the whole agent harness) and `withExtractionMutex` from `./memory-extraction`. Both must go.

- Replace `streamChat` with a plain non-streaming chat completion through the new vision client. The endpoint must support text completions — any vision-capable OpenAI-compatible server does, but make the requirement explicit in setup docs and fail with a clear message if the model rejects a text-only request.
- Replace `withExtractionMutex` with a local ~10-line promise-chain mutex.
- `ELEMENT_EXTRACTION_MODEL` env → the `visionModel` setting, or a separate `extractionModel` if users want a cheap text model. Prefer separate, defaulting to `visionModel`.

This drops the last hard dependency of the image stack on the agent harness.

### 2.5 Auth

Drop `routes/auth.ts`, `services/auth-storage.ts`, `middleware/auth.ts`, `services/session-cookie-config.ts`, `hooks/useAuth.ts`, `api/auth.ts`, and `@simplewebauthn/server`. Bind `127.0.0.1` and trust the connection; add an optional bearer token checked in middleware for LAN/remote use.

### 2.6 Data import

Porrima leaves `~/.porrima/{images,vision,image-corpus,clusters}` untouched after the cut — **no deletion, no migration out of Porrima.** The new app gets a one-time importer:

```
image-studio-import --source ~/.porrima [--dry-run]
```

- Copy `images/{id}/` trees and `vision/images/{id}/` trees.
- Copy `image-corpus/corpus.db` and `clusters/clusters.json` **together** — cluster entries reference corpus entry ids, so migrating one without the other orphans the map.
- Re-hydrate `images/generations.json`. Its 24-hour GC and its force-mark-stale-rows-as-`error`-on-load behavior are both correct; port them unchanged.
- Rewrite nothing in the copied SQLite. Corpus entries store relative paths under the data dir, so a plain directory copy works.

### 2.7 Other simplification candidates

Not required, but worth a decision:

- **JXL encode.** `image-storage.ts` is the only consumer of `icodec` (JPEG XL). Dropping it to PNG/WebP removes a native dependency for no user-visible loss in a browser. *Recommend dropping.*
- **D3 via CDN.** `visualization.ts:92` embeds `https://d3js.org/d3.v7.min.js`, so `/api/corpus/visualization` renders nothing offline. *Recommend vendoring d3 into the client build.*
- **`ImageSandbox` already is the app.** Don't rebuild a shell around it.

---

## 3. Risks

| Risk | Mitigation |
| --- | --- |
| Cluster map orphans on migration | `clusters.json` references `corpus_entries` ids. `corpus.db` and `clusters.json` must travel as one unit (§2.6) — splitting them orphans the map. |
| Chat image regressions in Porrima | §1.2 is the checklist. `sharp` and the 50 MB body limit are the most likely accidental casualties. |
| Persisted rows referencing removed fields | Removed fields linger in old persisted `messages` JSON blobs (`ChatMessage.generatedImages` lived inside the chat row blob). `JSON.parse` drops nothing, but readers must stay tolerant — a hard type removal is safe only while the TypeScript type is not a reason to reject a historical row. |
| Corpus search quality after a model change | The 0.97 clustering threshold and the embedding dimension are tuned to the current model. Re-cluster after the extraction model changes and treat the threshold as tunable. |
