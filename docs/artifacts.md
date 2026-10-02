# Artifacts

## Artifact System

**Creation**: The `create_artifact` tool receives `{ title, html, display? }`. `display` selects rendering placement: `"panel"` (default, dedicated side panel) or `"inline"` (rendered in the chat flow). `sandbox.ts` writes the HTML to `~/.porrima/artifacts/{uuid}/versions/1/index.html` (panel) or `~/.porrima/visuals/{uuid}/versions/1/index.html` (inline) and returns URL `/api/artifacts/{uuid}/versions/1` or `/api/visuals/{uuid}/versions/1`.

**Versioning**: Artifacts and visuals are fully versioned trees. Each `{id}/` directory holds a `metadata.json` (`{ canonicalId, currentVersion, versions[] }`) plus `versions/{N}/index.html`. `update_artifact` / `updateVisual` append `versions/{N+1}/` and return `/versions/{N+1}`. Every returned URL is version-scoped; the bare `/:id` route is a "latest version" convenience shim that reads `currentVersion` from metadata. `GET /:id/*subpath` is legacy-only and serves from the current version.

**Serving** (`server/src/routes/artifacts.ts`) — the same handler set is mounted at both `/api/artifacts` and `/api/visuals`, plus an `/api/artifacts/visuals/*` alias:

- `GET /api/artifacts/:id` — serves the current version's `index.html` with `Content-Type: text/html`
- `GET /api/artifacts/:id/versions` — list saved versions
- `GET /api/artifacts/:id/versions/:version` — serve a specific version
- `GET /api/artifacts/:id/versions/:version/*subpath` — serve a specific version's sub-files (CSS, JS, images) with path-traversal protection
- `GET /api/artifacts/:id/metadata` — artifact metadata
- `GET /api/artifacts/:id/*subpath` — legacy sub-file serving from the current version
- `GET /api/visuals/:id`, `/versions`, `/versions/:version`, `/metadata` — the same four for inline visuals

**Persistence**: `ChatMessage.artifacts?: Artifact[]` stores `{ id, title, url, version }` for each artifact created during the message's tool loop. The `version` field matters — a message can reference several versions of the same artifact. Artifacts survive server restarts because both the versioned HTML on disk and the version-scoped URLs in chat JSON are stable.

**Automatic preview review**: Successful `create_artifact` and `update_artifact` calls render the persisted versioned HTML in headless Chromium and attach a PNG screenshot to the tool result. The next model step reviews that image and can either confirm the result or call `update_artifact` again with complete corrected HTML. Screenshot capture is non-fatal; if Chromium is unavailable or `PORRIMA_ARTIFACT_REVIEW_SCREENSHOTS=0`, the tool result notes that no screenshot was attached. Automatic screenshot-driven updates are capped per artifact/visual in a turn to avoid revision loops.

**Client rendering** (`client/src/components/ArtifactPanel.tsx`):
- Fetches artifact HTML via `fetch(artifact.url)`, creates a `Blob` URL, and uses it as the iframe `src`.
- **Blob URLs are same-origin**, which avoids Chrome's `requestAnimationFrame` throttling on cross-origin iframes. Do NOT use `sandbox` attribute or direct `/api/artifacts/` URLs as iframe src — animations will freeze.
- "Code" tab shows the fetched source; "Open" link opens the raw `/api/artifacts/{id}` URL in a new tab.
- In `MessageBubble.tsx`, artifacts render via `(artifacts || message.artifacts)?.map(...)` — live streaming prop takes precedence, falls back to persisted `message.artifacts`.
- The iframe injects a small runtime-error forwarder for `error` and `unhandledrejection` events. It also instruments WebGPU shader module and pipeline creation so WGSL compiler errors report shader labels, shader-source excerpts, and compilation messages instead of treating shader line numbers as HTML line numbers.
- The client reports runtime diagnostics to `POST /api/chat/artifact-error`, which starts or queues a hidden repair turn. Deduplication is scoped to artifact/version/diagnostic identity, with a short bounded cap per artifact to avoid repair loops while still allowing a repaired version to report a different follow-up error. The server persists the repair prompt as a hidden system row and live-injects it as user-role context so provider replay avoids mid-transcript system messages.

**WebGPU artifact guidance** (`artifact-guidance.ts`):

Alongside the p5 pass, a second detector family lints WebGPU/WGSL in artifact HTML. These fire when `hasWebGpu()` is true:

- Missing `ctx.configure(...)` before submitting work
- Using `ctx.format` where a `GPUTextureFormat` is required
- Missing `label:` on `createShaderModule` (which makes WGSL compiler errors far harder to read)
- Struct attributes declared *after* member types instead of before
- Return attributes declared after the return type
- A `for` loop counter not declared in its initializer
- `let` used for a WGSL binding that is reassigned
- `textureStore` called with non-vector coordinates

All hits are appended under `"HTML artifact guidance warnings:"` in the `create_artifact` / `update_artifact` tool result rather than being repeated in the tool schema. The preview browser is launched with `--enable-unsafe-webgpu --ignore-gpu-blocklist` so WebGPU artifacts actually render during review.

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
