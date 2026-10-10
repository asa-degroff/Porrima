# Browser Observability — Live Screenshot Viewer (design plan)

Status: **Phase 1 implemented** — 2026-10-09 (§8 records what shipped and deltas) ·
**Phase 1.5 movable/resizable** — 2026-10-10 (§9) · **Phase 2 live follow-along** —
2026-10-10 (§10). Decisions locked with the user: ship Phase 1 first, viewer is a
floating PiP card over the message area.

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
truth.

### 4.1 State derivation

New hook `client/src/hooks/useBrowserViewer.ts`:

- Scan the active chat's messages **newest → oldest** (streaming assistant bubble segments
  first, then persisted `ChatMessage.segments`/`.toolResults`) and return the first
  `ChatToolResult` where `toolName === "browser_screenshot"`, `!isError`, and
  `images?.[0]?.url` exists → `{ url, id, pageUrl, pageTitle, capturedAt }`.
  `pageUrl`/`pageTitle` parsed from the `content` label (`Screenshot of <url> — "<title>"`),
  regex-tolerant: fall back to filename-less generic copy.
- Also return `running: boolean` — true while any `browser_*` tool call has a segment with
  `liveStatus.status === "running"` — so the card can show a "working…" pulse and, in
  Phase 2, an imminent-update hint.
- Recompute is cheap: browser tool results are sparse; memoize on message/segment identity.

### 4.2 The PiP card

New component `client/src/components/BrowserViewer.tsx`, rendered inside the messages
positioned container in `ChatView.tsx` (sibling of the scroll-to-bottom pill at
`ChatView.tsx:1037-1050`, same `absolute … z-20 backdrop-blur` idiom):

- **Placement**: top-right of the scroll area (bottom-right is taken by the "New" pill;
  top-left collides with nothing). `sm`-and-up: ~220px wide card, `object-contain` frame
  capped at ~160px tall; on phones: ~140px, corner-tucked, slightly translucent until tapped.
- **Contents**: latest screenshot, one-line host + title from the parsed label, live-pulse dot
  while a browser tool runs, and a collapse button. `fullPage` shots letterbox — acceptable
  for v1 (the lightbox is the real view; a scroll-mode toggle is an open question, §7).
- **Click to enlarge**: reuse `ImageLightbox` via `createPortal` exactly as
  `ToolCallDisplay.tsx:283` does, passing the derived `ImageAttachment` (`url` present → no
  object-URL work in `UserImage`/`ImageLightbox`).
- **Visibility lifecycle**: hidden while the chat has no browser screenshot in the loaded
  window; auto-shows when the derived frame changes. Manual collapse minimizes it to a small
  browser-icon chip (the `ToolIcons` entry) that pulses on new frames — the user's "ignore"
  path, since a popping card is a focus-stealer.
- **State persistence**: collapsed/docked preference in `localStorage` (global, not per-chat —
  mirrors existing client-only UI prefs). *Not* the server `ui-state` route: this is a
  throwaway display pref, same class as theme-local toggles.
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

- In `browser-tools.ts`, after each successful action returns, capture a **viewport-only**
  frame via `screenshotPage(session, false)` downscaled to ~720px (new small option or
  post-resize in the frame path; keep the LLM-facing 1280px path untouched).
- Frame data rides a **side channel**, never tool content. Add to `ToolSideEffects`
  (`agent-tools.ts:189`): `onBrowserFrame(frame: BrowserFrameEvent)`. `chat.ts` wires it to
  `emitToStream(liveStreams.get(chatId), browserFrameFrame(...))` so mid-tool delivery works
  for the primary `res` *and* reconnect subscribers — the exact `visual`-event pattern.
  Frame constructor lives beside the other live-only frames in `synthesis-stream.ts` so the
  HTTP and headless transports can't drift.
- SSE shape (live-only, not persisted, replayed via resync — §5.3):
  `event: browser_frame` + `{ chatId, frameId, imageUrl, pageUrl, pageTitle, mode, capturedAt }`.
- Headless/automation path (`chat-turn-runner.ts`): emit the same event onto any live stream
  for that chat; harmless no-op when nobody is watching.

### 5.2 Frame storage — in-memory ring, not disk

Auto-frames are **observability bytes, not conversation content**: they are never referenced
by message rows, never hydrated for replay, and would leak on disk with no owner. So:

- `browser-session.ts` (or a new `browser-frames.ts`) keeps a per-chat ring of the last ~5
  frames `{ frameId, png: Buffer, pageUrl, pageTitle, capturedAt }`, dropped with the session
  in the 10-min idle sweeper.
- Serve `GET /api/browser/frame/:chatId/:frameId` (auth-gated, `Cache-Control: private,
  max-age=3600`, `image/png` from memory). Client points `<img src>` at it.
- Explicit `browser_screenshot` frames keep their existing disk lifecycle untouched.

### 5.3 Status, resync, consent

- `GET /api/browser/status/:chatId` → `{ active, mode, pageUrl, pageTitle, latestFrameId }`
  read off the `sessions` Map — the first-ever public view of session state.
- Chat `buildResync` additionally carries `browser: status | null` so a reconnecting client
  restores the current frame without waiting for the next action.
- Attach-consent UX: `attachSession` blocks up to 60s on Chrome's native remote-debugging
  prompt. Record a `pendingConsent: { endpoint, startedAt }` marker on the opening path and
  expose it via status; the PiP card renders "Approve debugging in Chrome…" — turning today's
  silent stall into the feature's best observability win.
- Throttle: min ~1.5s between auto-frames per chat; skip when no live stream has subscribers
  for `chatId` (don't pay sharp+PNG for nobody); drop a capture if the page isn't settled
  (short `load`/idle wait already implicit in tool completion is enough for v1).

### 5.4 Client updates

- `client.ts` `processSSEEvent` + `StreamCallbacks`: `onBrowserFrame(frame)`; `useChat`'s
  per-chat stream state keeps `latestBrowserFrame` (like `partialText` on segments);
  `useBrowserViewer` prefers the live frame when newer than the derived history frame.
- Same PiP card; header text switches to the live page URL/title.

## 6. File map

| Area | Files |
|---|---|
| Phase 1 client | `client/src/hooks/useBrowserViewer.ts` (new), `client/src/components/BrowserViewer.tsx` (new), `client/src/components/ChatView.tsx` (mount card), `client/src/components/ToolIcons.tsx` (reuse) |
| Phase 1.5 client | `client/src/hooks/useBrowserViewerGeometry.ts` (new), `client/src/components/BrowserViewer.tsx` (drag/resize/keyboard/reset), `client/src/components/ChatView.tsx` (wrapper ref, pill z-30) |
| Phase 2 server | `server/src/services/browser-tools.ts`, `browser-session.ts`, `agent-tools.ts` (`ToolSideEffects`), `routes/chat.ts` (wiring + resync), `services/synthesis-stream.ts` (frame constructor), `services/chat-turn-runner.ts`, new `routes/browser.ts` (status/frame), `index.ts` (mount) |
| Phase 2 client | `client/src/api/client.ts`, `client/src/hooks/useChat.ts`, `BrowserViewer.tsx`, `useBrowserViewer.ts` |

## 7. Open questions

1. Does the agent's Chrome tab need a user "take over" affordance (focus that window) in a
   later phase? Out of scope now; status endpoint makes it feasible.
2. `fullPage` shots in the card: letterbox (v1) vs. a scroll/fit toggle — revisit after using it.
3. Should Phase 2 auto-frames ever be *visible to the model* (e.g., attach latest frame as
   context on the next turn)? Deliberately no for now — KV-cache + token cost; revisit if the
   agent proves too blind between snapshots.
4. Card position on phones: top-right may fight the header; prototype top-right vs.
   bottom-left-of-composer before locking.
5. Do we ever need to prune/clean the in-memory ring beyond session sweep? (No — bounded.)

## 8. Phase 1 — what shipped (2026-10-09)

- `client/src/hooks/useBrowserViewer.ts` — reverse scan over messages (segments first,
  flat `toolResults` fallback) returning the newest `browser_screenshot` frame; page
  URL/title parsed from the result label; exported `findLatestFrame` for direct unit tests.
- `client/src/components/BrowserViewer.tsx` — top-right floating card (`absolute … z-20`,
  same idiom as the "New" pill), host + title footer, live-pulse while any `browser_*` tool
  runs, click → shared `ImageLightbox` via portal, minimize → icon chip with unseen-update
  badge; collapsed pref in `localStorage` under `porrima-browser-viewer-collapsed`.
- `client/src/components/ChatView.tsx` — mounts the viewer inside the messages position
  wrapper, gated on `!isSwitching && !isFirstMessageMode`.
- Tests: `useBrowserViewer.test.ts` (8) + `BrowserViewer.test.tsx` (5, jsdom).

Deltas from plan: thumbnails use `object-cover object-top` (crops tall full-page shots to
the top instead of letterboxing — reads better at card size; §7.2 stays open for the
lightbox scroll-mode question). The running indicator reads ChatView's existing
`activeTools` prop instead of segment `liveStatus` — same signal, less plumbing. Frames
without a server `url` (legacy base64-only rows) are skipped rather than rebuilt from
`data`, since the payload migration is the supported path.

Field-verified 10-10 in a live browser session: card appearance, in-place frame
updates across three screenshots, host/title footer, pulse-while-running, and
minimize all confirmed by the user from the client.

## 9. Phase 1.5 — movable + resizable card (2026-10-10)

The fixed top-right placement made the card a focus-stealer in exactly the
position a user might want it in (over the composer, over the scroll pill).
The card is now movable and width-resizable, still zero-server:

- `client/src/hooks/useBrowserViewerGeometry.ts` (new) — geometry state
  `{ x, y, w }` in messages-wrapper coordinates. Pure
  `clampGeometry` / `defaultGeometry` / `estimateCardHeight` exported and
  unit-tested. The hook clamps on every change (idempotent layout pass) and
  on a `ResizeObserver` over the wrapper — window resizes and the pinned
  panel appearing can never push the card out of the visible area. Stored
  geometry that predates a smaller window is clamped back in on load.
  Degenerate bounds (no layout, e.g. jsdom) pass through unclamped.
- `BrowserViewer.tsx` — **drag from the frame image**: pointer capture with
  a 4px travel threshold separating drag from click-to-enlarge (the click
  that follows a drag is suppressed). **Width-only resize** via a
  bottom-right corner grip — height stays locked to the 16:10 frame aspect
  (free 2D would make `object-cover` crop unpredictably). A reset button
  restores the default docked position. The chip on minimize **sits where
  the card was** — the window shrinks in place and restores in place.
  Keyboard: arrows nudge (shift = 3× step), `+`/`-` resize, while the frame
  is focused.
- `ChatView.tsx` — the messages wrapper carries `messagesAreaRef` (the
  measured bounds source); the scroll-to-bottom pill bumps to `z-30` so it
  stays clickable when the card is parked in its corner (lightbox remains
  `z-50`, above both).
- Limits: 120–520px width, 8px margin from wrapper edges. Defaults: 210px
  desktop / 132px mobile — the original fixed placement, computed from
  wrapper width (the `sm` breakpoint).
- Persistence: `porrima-browser-viewer-geom` in localStorage, written at
  gesture end and on clamping events, not per pointer move.

Decisions locked with the user: width-only fixed-aspect resize (not free
2D), drag-from-image (not a handle strip), chip follows position.

Caveat: jsdom has no pointer capture, so the drag/resize wiring is
field-verified, not unit-tested — the clamping math (the part with real
edge cases) is fully unit-tested instead.

## 10. Phase 2 — live follow-along, what shipped (2026-10-10)

Auto-capture after every browser action, delivered on a live-only side channel.
§5 described the design; this records what shipped and the deltas.

**Server**

- `services/browser-frames.ts` (new) — per-chat in-memory ring (last 5 frames,
  PNG `Buffer` + page metadata) with a 1.5s per-chat throttle for auto-captures.
  Cleared by `closeBrowserSession` (so also on idle sweep and chat deletion).
  Never touches disk — observability bytes, not conversation content.
- `browser-session.ts` — `screenshotPage` takes a `maxWidth` override and returns
  the raw `buffer` alongside base64; a `consentPending` set tracks chats parked on
  Chrome's remote-debugging WS handshake (`withConsentPending` around
  `openConsentTransport`); new sync `getBrowserSessionSnapshot(chatId)` exposes
  `{ active, mode, pageUrl, pendingConsent, latestFrame }` (title comes from the
  frame's capture-time metadata so the read stays sync on the resync path).
- `browser-tools.ts` — `executeBrowserTool` accepts a frame sink (passed from
  `agent-tools.ts`, structurally `ToolSideEffects.onBrowserFrame`; kept local to
  avoid an import cycle). `publishFrame` stores + emits; `captureActionFrame`
  (viewport-only, 720px) runs after successful navigate/click/type/hover, gated on
  subscriber presence + throttle, and can never fail the observed action.
- `ToolSideEffects.onBrowserFrame?` — optional member, so the many noop/estimation
  effects sites are untouched.
- Transports: `chat.ts` effects write the shared `browserFrameFrame` builder
  (defined in `synthesis-stream.ts` next to the other live-only frames);
  `createEmitterSideEffects` wires the headless (synthesis/wake/automation) path
  to `SynthesisEmitter.emitBrowserFrame` — the two transports cannot drift.
  Both `buildResyncPayload` implementations carry `browser: getBrowserSessionSnapshot(...)`
  so a reconnect restores the PiP without waiting for the next action.
- `routes/browser.ts` (new, mounted at `/api/browser`, behind the global
  `requireAuth`): `GET /frame/:chatId/:frameId` (PNG from memory,
  `private, max-age=1y, immutable`) and `GET /status/:chatId`.

**Client**

- `useChat` — per-chat `browserFrame` accumulator in `bgStreams` (mirrored to
  `liveBrowserFrame` state while displayed), fed by `onBrowserFrame` (new
  `StreamCallbacks` member + `browser_frame` SSE case in `client.ts`); resync
  adopts `payload.browser.latestFrame` (null clears back to derived); hydration
  on chat switch follows the `modelProgress` pattern.
- `useBrowserViewer` — `pickViewerFrame(live, derived)`: live wins when present,
  else the Phase 1 derivation. This is the merge that makes "live is always the
  freshest visual" true: **delta from §5** — explicit `browser_screenshot`s now
  also push to the ring and publish a live event (their bytes already exist, so
  it costs a uuid + SSE frame; deliberately not subscriber-gated or throttled).
  Without this, a message-row `timestamp` (turn-start for the streaming
  placeholder) could lose a timestamp comparison against an action frame and
  show a stale image.
- `ChatView` — passes `liveBrowserFrame`; viewer mounts while any `browser_*`
  tool runs (`frame || browserToolActive`), showing the connecting placeholder;
  consent probe (§5.3): while a browser tool runs and nothing is captured yet,
  status is polled every 2s and `pendingConsent` swaps the placeholder copy to
  the "allow remote debugging" prompt hint. App.tsx plumbs the state through.
- `BrowserViewer` — `frame: BrowserViewerFrame | null` renders a spinner
  placeholder (consent copy when flagged); `img onError` shows "Frame expired —
  waiting for the next browser action" when a live URL outlives its ring entry.

**Tests**: server `browser-frames.test.ts` (7: storage/eviction/per-chat throttle
reset/clear/summary shape); client +`pickViewerFrame` (4) and null-frame/consent
placeholder (2). Full suites green: server 950, client 69, both builds clean.

**Field verification still open**: attach-consent hint and mid-turn reconnect
restore need a real Chrome session to confirm end-to-end.
