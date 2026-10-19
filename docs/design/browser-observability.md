# Browser Observability — Live Screenshot Viewer (design plan)

**Status:** Phases 1–2 implemented (live PiP viewer, movable/resizable card, auto-capture
follow-along); the consent handshake design is shipped.

## 1. Problem

The agent drives the user's Chrome (attached mode) or a private launched browser, but the
user has no way to watch. Today the only trace of what the agent sees is the image inside a
collapsed `browser_screenshot` tool chip (`ToolCallDisplay.tsx` renders `toolResult.images`
only when expanded). To "follow along" the user must hunt for and expand each chip.

Desired: a small **persistent window in the chat interface** that shows the latest browser
screenshot, updates in place as newer screenshots arrive, and click-to-enlarges. Later, this
becomes a true live view: a frame after *every* browser action, not just explicit screenshots.

## 2. What already exists (grounding)

- **Capture**: `screenshotPage()` (`browser-session.ts:558`) → PNG base64, ≤1280px wide,
  plus `url`/`title`/`width`/`height`. Only `browser_screenshot` calls it today
  (`browser-tools.ts:181`); the label text is `Screenshot of <url> — "<title>" (…)`.
- **Persistence**: `buildPersistedToolResult()` (`routes/chat.ts:861`) externalizes every
  tool-emitted image via `saveToolResultImage()` to
  `~/.porrima/tool-result-images/<id>/image.png` and strips base64. The persisted row and the
  SSE carry `{ id, url, mimeType, name }` only.
- **Transport**: the `tool_result` `segment` SSE frame (`chat.ts:2637`) already includes
  `images[].url`. Reconnect replays segments (`/api/chat/reconnect/:chatId` + `buildResync`),
  and history loads (`ChatMessage.toolResults` / `.segments`) carry the same URL refs.
- **Serving**: `GET /api/tool-result-images/:id/image.:ext` — immutable, auth-gated, stream.
- **Client rendering**: `ToolCallDisplay.tsx` renders these via `UserImage` +
  `ImageLightbox` (portal, prefers `image.url`). Browser tool icons exist in `ToolIcons.tsx`.
  No browser-specific UI exists; session state (`sessions` Map in `browser-session.ts`) is
  server-memory-only with no HTTP surface.
- **Invariants** (`docs/tool-system.md:73,77`): tool-result content is strict
  `{type:"text"}`/`{type:"image",data,mimeType}` — **never add fields or extra items**, and
  never put base64 on the SSE. Any new frame data must ride a side channel or reuse the
  externalized URL pattern.
- **Mid-tool side-channel precedents**: `artifact` / `visual` events fire *during* tool
  execution via `ToolSideEffects` (`agent-tools.ts:189`, wired ~`chat.ts:1943`); the
  `onLlmRequestEvent → emitToStream(liveStreams)` global-bus fan-out (`chat.ts:967`) is the
  template for events that don't originate in the tool executor.

## 3. Prior art

| Product | What they show | Takeaway |
|---|---|---|
| OpenAI Operator / ChatGPT agent | Full-browser side panel, user can take over | Side panel is the "premium" shape; our PiP is the cheap 80%. |
| Claude for Chrome | Small "Claude is working in your browser" pill + tab highlighting; click to watch | A persistent *compact* affordance with expand-on-click is the right default; status text matters as much as pixels. |
| browser-use (Python) "watch" HUD | Floating PiP overlay with latest screenshot, pause/close | Exactly the shape we're building; validates the floating-card UX. |
| Playwright trace viewer | Timeline of snapshots post-hoc | Out of scope; our history is already the chat transcript (tool chips). |

## 4. Phase 1 — mirror explicit screenshots (client-only)

**Zero server changes.** The data already reaches the client in three paths (live SSE,
reconnect resync, history load), so the viewer *derives* its state from message data rather
than a new event stream. That makes reload/resync continuity free and keeps one source of
truth. Locked design constraints: ship Phase 1 first; the viewer is a floating PiP card over
the message area (not a side panel).

### 4.1 State derivation

New hook `client/src/hooks/useBrowserViewer.ts` (the pure scan is exported as
`findLatestFrame` for direct unit tests):

- Scan the active chat's messages **newest → oldest** — streaming assistant bubble segments
  first, then persisted `ChatMessage.segments`, with the flat `toolResults` array as the
  fallback for rows without segments — and return the first `ChatToolResult` where
  `toolName === "browser_screenshot"`, `!isError`, and `images?.[0]?.url` exists →
  `{ url, id, pageUrl, pageTitle, capturedAt }`. Frames without a server `url` (legacy
  base64-only rows) are skipped rather than rebuilt from `data` — the payload migration is
  the supported path for those rows. `pageUrl`/`pageTitle` parsed from the `content` label
  (`Screenshot of <url> — "<title>"`), regex-tolerant: fall back to filename-less generic
  copy.
- Running signal: the card reads ChatView's existing `activeTools` (the same signal as the
  running tool chips, less plumbing than a segment `liveStatus` scan) — true while any
  `browser_*` tool is active, so the card can show a "working…" pulse and, in Phase 2, an
  imminent-update hint.
- Recompute is cheap: browser tool results are sparse; memoize on message/segment identity.

### 4.2 The PiP card

New component `client/src/components/BrowserViewer.tsx`, rendered inside the messages
position wrapper in `ChatView.tsx` (sibling of the scroll-to-bottom pill at
`ChatView.tsx:1037-1050`, same `absolute … z-20 backdrop-blur` idiom). Mount gating: the
viewer renders while a frame exists or a browser tool runs (`frame || browserToolActive`)
and only when the chat is settled — `!isSwitching && !isFirstMessageMode`.

**Placement — a movable, width-resizable card** (the fixed top-right placement made the
card a focus-stealer in exactly the position a user might want it in — over the composer,
over the scroll pill). Coordinates live in messages-wrapper space; the wrapper carries
`messagesAreaRef` as the measured bounds source.

- `client/src/hooks/useBrowserViewerGeometry.ts` — geometry state `{ x, y, w }` with pure
  `clampGeometry` / `defaultGeometry` / `estimateCardHeight` exported and unit-tested. The
  hook clamps on every change (idempotent layout pass) and on a `ResizeObserver` over the
  wrapper — window resizes and the pinned panel appearing can never push the card out of
  the visible area; stored geometry that predates a smaller window is clamped back in on
  load. Degenerate bounds (no layout, e.g. jsdom) pass through unclamped.
- **Drag from the frame image** (not a handle strip): pointer capture with a 4px travel
  threshold separating drag from click-to-enlarge; the click that follows a drag is
  suppressed.
- **Width-only resize** from any corner — four invisible corner zones (the resize
  cursor is the affordance, no visible grip). Right corners drag the right edge
  (x pinned); left corners drag the left edge (the right edge pinned). Height stays
  locked to the 16:10 frame aspect (free 2D would make `object-cover` crop
  unpredictably). The top-corner zones sit under the reset/minimize buttons, which
  ride `z-20` above the `z-10` zones so they stay clickable. A reset button restores
  the default docked position. Keyboard: arrows nudge (shift = 3× step), `+`/`-`
  resize, while the frame is focused.
- Limits: 120–520px width, 8px margin from wrapper edges. Defaults: 210px desktop / 132px
  mobile — the historical fixed top-right placement, computed from wrapper width (the `sm`
  breakpoint).
- Persistence: geometry in `localStorage` under `porrima-browser-viewer-geom`, written at
  gesture end and on clamping events, not per pointer move. The collapsed/docked preference
  is a separate global key, `porrima-browser-viewer-collapsed` (not per-chat — mirrors
  existing client-only UI prefs; *not* the server `ui-state` route: throwaway display
  prefs, same class as theme-local toggles).
- **z-order**: the scroll-to-bottom pill bumps to `z-30` so it stays clickable when the
  card parks in its corner; the lightbox remains `z-50`, above both.
- Testing: the corner-resize wiring has jsdom pointer tests (direct pointer sequences
  drive the handlers on the corner zones; pointer *capture* itself remains untested —
  jsdom lacks it). The clamping math (the part with real edge cases) is fully
  unit-tested.

**Contents**: latest screenshot with `object-cover object-top` thumbnails (crops tall
full-page shots to the top instead of letterboxing — reads better at card size), one-line
host + title from the parsed label, live-pulse dot while a browser tool runs, and a
collapse button.

- **Click to enlarge**: reuse `ImageLightbox` via `createPortal` exactly as
  `ToolCallDisplay.tsx:283` does, passing the derived `ImageAttachment` (`url` present → no
  object-URL work in `UserImage`/`ImageLightbox`).
- **Visibility lifecycle**: hidden while the chat has no frame (live or derived) in the
  loaded window; auto-shows when the frame changes. Manual collapse minimizes it to a
  small browser-icon chip (the `ToolIcons` entry) that pulses/badges on new frames — the
  user's "ignore" path, since a popping card is a focus-stealer. The chip **docks at the
  card rectangle's top-right corner** (where the minimize button was — under the cursor)
  and is itself **draggable**: the window moves with it and restores at the same spot.
  Because the chip is *derived* from the card rectangle, `clampGeometry` always clamps the
  card (no separate `collapsed` mode): a clamped card rectangle always contains its
  top-right corner inside the wrapper, which guarantees a visible chip. Chip drag-vs-expand
  reuses the frame's 4px threshold and click suppression.
- **No new fetch layer**: `ImageLightbox`/`UserImage` already load server URLs with
  `credentials: "include"`.

### 4.3 Explicit non-goals for Phase 1

- No changes to tool-result content, SSE schemas, persistence, or KV-cache-visible bytes.
- No cross-chat/global browser dashboard.
- No auto-capture after non-screenshot actions (that is Phase 2). Until then, between explicit
  screenshots the card simply holds the last frame — honest, since that's all the *model* saw.

## 5. Phase 2 — live follow-along (server-side auto-capture)

Goal: a fresh frame after every `browser_navigate` / `browser_click` / `browser_type` /
`browser_hover` (plus the explicit `browser_screenshot` already covered), without the frames
touching model context.

### 5.1 Capture + emission

- In `browser-tools.ts`, after each successful `browser_navigate` / `browser_click` /
  `browser_type` / `browser_hover` returns, `captureActionFrame` captures a
  **viewport-only** frame via `screenshotPage(session, false, FRAME_MAX_WIDTH)` downscaled
  to 720px, and can never fail the observed action (capture errors are caught and logged).
  `screenshotPage` (`browser-session.ts`) takes a `maxWidth` override and returns the raw
  `buffer` alongside the base64 — the LLM-facing 1280px path is untouched.
- Frame data rides a **side channel**, never tool content. Add to `ToolSideEffects`
  (`agent-tools.ts:189`): `onBrowserFrame?(frame: BrowserFrameEvent)` — optional, so the
  many noop/estimation effects sites stay untouched. `executeBrowserTool` accepts the sink
  **locally typed** in `browser-tools.ts` (structurally `ToolSideEffects.onBrowserFrame`,
  kept local to avoid an import cycle). `publishFrame` stores the frame in the ring and
  emits it.
- Transports share one SSE frame constructor, `browserFrameFrame`, defined in
  `synthesis-stream.ts` next to the other live-only frames, so the HTTP and headless
  transports can't drift: `chat.ts` wires the effects to
  `emitToStream(liveStreams.get(chatId), browserFrameFrame(...))` so mid-tool delivery works
  for the primary `res` *and* reconnect subscribers — the exact `visual`-event pattern —
  and `createEmitterSideEffects` wires the headless (synthesis/wake/automation) path to
  `SynthesisEmitter.emitBrowserFrame`, a harmless no-op when nobody is watching.
- SSE shape (live-only, not persisted, replayed via resync — §5.3):
  `event: browser_frame` + `{ chatId, frameId, imageUrl, pageUrl, pageTitle, mode, capturedAt }`.

### 5.2 Frame storage — in-memory ring, not disk

Auto-frames are **observability bytes, not conversation content**: they are never referenced
by message rows, never hydrated for replay, and would leak on disk with no owner. So:

- `server/src/services/browser-frames.ts` keeps a per-chat ring of the last 5 frames
  `{ frameId, png: Buffer, pageUrl, pageTitle, capturedAt }`, with a 1.5s per-chat throttle
  marker for auto-captures. The ring is cleared by `closeBrowserSession` — so it also goes
  on the 10-min idle sweep and on chat deletion. Never touches disk.
- Serve `GET /api/browser/frame/:chatId/:frameId` (auth-gated, `Cache-Control: private,
  max-age=1y, immutable` — a given frameId's bytes never change — `image/png` from memory).
  Client points `<img src>` at it.
- Explicit `browser_screenshot` frames keep their existing disk lifecycle untouched; they
  additionally push into the ring and publish a live event (§5.4).

### 5.3 Status, resync, consent

- `GET /api/browser/status/:chatId` returns the sync `getBrowserSessionSnapshot(chatId)` —
  `{ active, mode, pageUrl, pendingConsent, latestFrame }`, read off the `sessions` Map and
  the frame ring: the first-ever public view of session state. The page title comes from
  the latest frame's capture-time metadata, which keeps the read synchronous — the resync
  path cannot await a live `page.title()`.
- Chat resync carries `browser: getBrowserSessionSnapshot(chatId)` — **both
  `buildResyncPayload` implementations** (HTTP chat route and `synthesis-stream.ts`) — so a
  reconnecting client restores the current frame without waiting for the next action.
- Attach-consent UX: `attachSession` blocks up to 60s on Chrome's native remote-debugging
  prompt. A `consentPending` set tracks chats parked on the handshake (`withConsentPending`
  around `openConsentTransport`), exposed as `pendingConsent` via the snapshot; the PiP
  card renders "Approve debugging in Chrome…" — turning today's silent stall into the
  feature's best observability win. While a browser tool runs and nothing has been
  captured yet, the client polls status every 2s to pick that state up.
- Gating applies to **auto-captures only**: min ~1.5s between auto-frames per chat; skip
  when no live stream has subscribers for `chatId` (don't pay the PNG encode for nobody);
  drop a capture if the page isn't settled (short `load`/idle wait already implicit in tool
  completion is enough). Explicit `browser_screenshot`s are deliberately **not**
  subscriber-gated or throttled — see §5.4.

### 5.4 Client updates

- `client.ts` `processSSEEvent` + `StreamCallbacks`: `onBrowserFrame(frame)` (the
  `browser_frame` case); `useChat` keeps the frame in the per-chat `bgStreams` accumulator
  (like `partialText` on segments) and mirrors it to `liveBrowserFrame` state while the chat
  is displayed; resync adopts `payload.browser.latestFrame` (null clears back to the derived
  frame); hydration on chat switch follows the `modelProgress` pattern. `App.tsx` plumbs the
  state through to `ChatView`.
- `useBrowserViewer` merges the sources with `pickViewerFrame(live, derived)`: the live frame
  wins when present, else the Phase 1 history derivation.
- Explicit `browser_screenshot`s **also** push to the ring and publish a live event (their
  bytes already exist, so it costs a uuid + SSE frame) — deliberately not subscriber-gated
  or throttled. The invariant this protects: without it, a message-row `timestamp`
  (turn-start for the streaming placeholder) could lose a timestamp comparison against an
  action frame and show a stale image; `pickViewerFrame` can then always treat the live
  frame as the freshest visual.
- Same PiP card; header text switches to the live page URL/title. The card mounts while a
  frame exists or any `browser_*` tool runs, showing a connecting placeholder (consent copy
  when `pendingConsent` is set — §5.3). `img onError` shows "Frame expired — waiting for the
  next browser action" when a live URL outlives its ring entry.

## 6. File map

| Area | Files |
|---|---|
| Phase 1 client | `client/src/hooks/useBrowserViewer.ts` (new), `client/src/components/BrowserViewer.tsx` (new), `client/src/components/ChatView.tsx` (mount card), `client/src/components/ToolIcons.tsx` (reuse) |
| Phase 1.5 client | `client/src/hooks/useBrowserViewerGeometry.ts` (new), `client/src/components/BrowserViewer.tsx` (drag/resize/keyboard/reset), `client/src/components/ChatView.tsx` (wrapper ref, pill z-30) |
| Phase 2 server | `server/src/services/browser-tools.ts`, `browser-session.ts`, new `services/browser-frames.ts` (ring), `agent-tools.ts` (`ToolSideEffects`), `routes/chat.ts` (wiring + resync), `services/synthesis-stream.ts` (frame constructor), `services/chat-turn-runner.ts`, new `routes/browser.ts` (status/frame), `index.ts` (mount) |
| Phase 2 client | `client/src/api/client.ts`, `client/src/hooks/useChat.ts`, `client/src/App.tsx` (state plumbing), `BrowserViewer.tsx`, `useBrowserViewer.ts` |

## 7. Open questions

1. `fullPage` shots: the card crops to the top (`object-cover object-top`), which reads well at
   card size; the open question is the *lightbox* — letterbox the full frame or add a scroll/fit
   mode for tall pages?
2. Do we ever need to prune/clean the in-memory ring beyond session sweep? No — bounded.
