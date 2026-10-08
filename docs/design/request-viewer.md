# Per-Turn Request Viewer (design plan)

Status: **implemented (P1–P3)** — 2026-10-08. §7 records what shipped and the deltas
from the original plan.

Decisions locked (2026-10-07): viewer is scoped to the **currently-selected chat only** (no
global/cross-chat browse in v1); retention default **50 requests/chat**; response capture is
**structured content blocks only** — raw SSE chunk capture is out of scope for v1.

## 1. Problem

Users currently have only fragmentary visibility into what the agent model actually
receives and returns:

- The header **Prompt** button opens "Rendered Agent Context" (`ChatView.tsx:519-531, 1176-1234`,
  backed by `GET /api/chats/:id/rendered-prompt`, `routes/chats.ts:163-192`). It shows only the
  last-built **system prompt string** from an in-memory per-chat cache (`memory-context.ts`
  `promptCache`) plus name+description of tools. It has no transcript, no tool schemas, no
  response, and goes cold (`cached: false`) on restart.
- The **ModelStatsModal run viewer** shows per-run *metrics* (tokens, cache hits, latency,
  `requestMessageCount` / `requestCharCount` / `requestDigest`) but no content
  (`model_stats` rows carry no chatId/turnId and raw prompts are never persisted).
- `llama-prompt-debug.ts` and `kv-prefix-diagnostics.ts` hold full rendered prompts / digests
  only in memory, console-only.

What's missing: **a single UI that shows the exact wire request and response for every LLM
call in a turn, live as turns happen, plus the assembled context (system prompt, sections,
tools with schemas).** The old system prompt viewer should be removed and absorbed into it.

## 2. Prior art

| Product | What they show | Takeaways for us |
|---|---|---|
| **opencode** (current v2) | No built-in prompt viewer. Issue #14674 requests `/dump-context` ("see exactly what system prompt the model receives after all layers are assembled", compaction debugging, bug reports). Third-party **opencode-trace** wraps the app just to capture raw LLM requests/responses. Old Go opencode: a full-screen `Ctrl+L` logs page. | Demand for *wire truth* is high; in-app, per-turn, live is better than a file dump. Confirms the value of our feature. |
| **LM Studio** | Developer page **Request Logs**: append-only live list of every HTTP request with expandable raw request/response JSON + copy; `lms log stream` shows the exact input string; prompt-preview shows the rendered template. | Live appends "as they come in" + raw JSON copy are table stakes. Rendered-template view is a nice second-tier feature. |
| **LangSmith / Langfuse / Phoenix** | Trace tree: parent run per turn, child runs per LLM call; each shows **Input messages** rendered per-role (collapsible), **Output**, and raw JSON. A known complaint (LangChain forum): tool definitions aren't visible because they're passed via API, not the prompt text → their viewer looked "incomplete". | Per-role message rendering with collapsibles; tool surface must be shown explicitly (our Context tab); parent/child grouping = turn → iterations. Retention must be bounded. |
| **SillyTavern** prompt log | Per-request entry: each prompt *section* (author's note, char description, history…) with token count per item, and the final assembled prompt. | Section-level token attribution — we already have `promptBreakdownCache` / `context-breakdown.ts` to power this. |
| **Cline / Roo Code** | Expandable "API Request" card per round-trip: what context pieces were included + token counts, response. | Per-iteration entry cards inline with the conversation flow; compact defaults, expand for detail. |

Consistent patterns to adopt: (1) list of requests newest-first, growing live; (2) each entry
expandable to request messages + response, rendered per-role with a raw-JSON toggle;
(3) separate context/tools "reference" view since tools aren't in the prompt text;
(4) per-section token counts; (5) copy-to-clipboard / export.

## 3. Product design

Replace the header **Prompt** button with **Requests**, opening a new `RequestViewerModal`
with two tabs:

### Tab A — Requests (default)

A live, per-LLM-call log scoped to the **currently-selected chat** (agent and system chats both
work; automations/headless turns included since they flow through the same provider — the entry
point is always the chat's header button, never a global page).

- **Entry list**, newest first. One row per wire request: timestamp, turn # (resolved user
  message), iteration index within the turn, model, stop reason, prompt/completion tokens,
  cached tokens + hit ratio, duration, status badge (`in progress` / `done` / `error` /
  `aborted` / `fallback`), and a divergence canary ⚠ where replay-vs-wire digests differ.
  Rows append live while the modal is open.
- **Expanded entry**:
  - **Request**: the actual wire `messages` array rendered per role (system / user /
    assistant / tool), collapsible bodies, tool results with full content, images shown as
    references. A "delta since previous request" toggle is a powerful affordance given our
    prefix architecture (iteration N ≈ iteration N-1 + appended rows).
  - **Response**: accumulated **structured content blocks** — thinking, text, tool calls with
    parsed arguments, usage, timings, cached-token report. Raw SSE-chunk capture is explicitly
    out of scope for v1 (revisit only if parsing quirks need forensics). For the *currently
    streaming* entry, show the live partial response from the deltas the client is already
    receiving — no extra SSE traffic.
  - **Raw**: the full JSON request body (`{model, messages, tools, stream_options, id_slot,
    cache_prompt, chat_template_kwargs}`) and accumulated response — pretty-printed, copyable.
- Header strip: request count, total tokens this session, "Clear" button. (v1 records
  chat-turn traffic only, so no purpose filters — see §4.)

### Tab B — Context

The replacement for the old system prompt viewer, showing what the model is *primed with*:

- **Full system prompt** (`stablePrefix + frozenMemoriesSection`), persisted so it survives
  restarts (see §4 storage).
- **Section breakdown** with token estimates per section: persona, user doc,
  global blocks, zeitgeist, project/AGENTS.md, project blocks, frozen memories, skills —
  already computed in `promptBreakdownCache` (`memory-context.ts:79-100`).
- **Tools**: full definitions — name, description, **JSON schema** (upgrade
  `getAgentToolDefinitions` beyond name+description; schema comes from the TypeBox
  `parameters` in `agent-tools.ts`), grouped by chat-type gating, plus the effective per-turn
  tool surface changes (`toolsAdded`/`toolsRemoved` deltas).
- **Memory delta state**: current `deltaIds` pending for next turn.
- Optional **Rendered template** view: on-demand call of `renderPromptForDebug`
  (`openai-compat-provider.ts:522-554`, llama.cpp `/apply-template`) to show the exact
  chat-template string with special tokens. On demand only — it costs a round trip.

### Removals

- Delete `promptModal` state, `openPromptViewer`, and the "Rendered Agent Context" modal from
  `ChatView.tsx` (L440, 519-531, 863-869, 1176-1234) and `fetchRenderedPrompt` from
  `api/client.ts`. Keep `GET /api/chats/:id/rendered-prompt` as the Context tab's data source,
  upgraded to return sections + tool schemas + persisted prompt (see §4).

## 4. Architecture

### Capture point

Record at the **provider choke point** in `openai-compat-provider.ts` — the only place the
complete wire truth exists per request:

- After `buildOpenAICompatChatBody` (~L401-469, body finalized, fetch at ~L1983): capture
  `body` (messages, tools, kwargs), `cacheMetadata.requestDigest`, message/tool counts.
- At response finalization (~L2349-2413): capture accumulated `output` content blocks,
  `stopReason`, usage, `llamaTimings`, `llamaCache`, error/abort status.
- Correlation already exists and just needs to be threaded into a recorder:
  `llamaPromptDebugChatId` passthrough (`llm-stream.ts:104-106`) for chatId, per-loop
  `iterationCount` (`llm-stream.ts:50,95`) for the request ordinal, `state.toolLoopId` /
  headless `turnId` (`chat.ts:1270`, `chat-turn-runner.ts:444`) for the turn. Add a
  `llamaRequestId = ${turnId}:${iteration}` alongside the existing chatId option — do **not**
  use pi-agent-core's `prepareRequest` hook for the primary capture: it fires pre-
  `convertMessages` and would miss the true wire shape.
- **Invariant: capture is a pure side-channel.** It must not alter, reorder, or reserialize
  anything in the outgoing body — byte-identical prefixes are the KV-cache contract
  (docs/memory-system.md, key-patterns.md). Recording must be async post-hoc, never blocking
  the stream.
- Tag `purpose`: `chat` | `warm` | `extraction` | `title`. In v1 the recorder **only stores
  `chat` turns** — cache-warm bodies are byte-clones of live bodies and extraction/title calls
  belong to background inference, so they skip recording entirely to keep `porrima.db` lean.
  The tag stays in the schema so broader capture can be added later without a migration.

### Storage (new: `request-log.ts` service + table in `porrima.db`)

Follow the reranker-stats precedent (raw LLM text already stored there):

```sql
CREATE TABLE llm_requests (
  id TEXT PRIMARY KEY,               -- ${turnId}:${iteration}
  chat_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'chat', -- 'chat' in v1; others reserved for future capture
  iteration INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,            -- 'llamacpp' in v1 (chat turns only)
  status TEXT NOT NULL,              -- in_progress | done | error | aborted
  request_json TEXT NOT NULL,        -- wire body minus deduped blocks (see blobs)
  response_json TEXT,                -- accumulated content blocks + usage + timings
  prompt_tokens INTEGER, completion_tokens INTEGER, cached_tokens INTEGER,
  duration_ms REAL,
  request_digest TEXT                -- ties to model_stats rows for cross-linking
);
```

- **Dedup via content-addressed blobs.** Each turn re-sends the whole transcript, so payloads
  would otherwise grow quadratically. Store long immutable strings (system prompt, individual
  message contents, tool arrays, response bodies) in
  `llm_request_blobs(hash TEXT PRIMARY KEY, text TEXT)` with `request_json` referencing hashes
  (same sha1-12 approach as `digestPromptPayload`). Storage collapses to "first copy + pointers";
  the viewer rehydrates the full body on read. Optionally compress blob text (gzip via the
  existing deps) later if needed.
- **Retention:** **50 stored requests per chat** (`MAX_REQUESTS_PER_CHAT = 50`), reusing the
  `pruneOldRuns` pattern from `model-stats.ts`. Fixed constant in v1 — a settings knob is
  deferred until usage shows a need. Cascade cleanup from `chat-deletion.ts`. Blobs are
  vacuumed by reference count on prune.
- The **latest live request** for a chat is also mirrored into the in-memory `promptCache`
  replacement (persisted system prompt survives restart — fixes the current `cached:false` bug).

### Live streaming to the client

Do **not** push raw bodies over SSE (doubles bandwidth on every chat whether or not anyone is
watching):

- Emit lightweight ID events on the existing chat SSE: `llm_request_start` `{requestId, turnId,
  iteration, model, messageCount, toolNames[]}` at dispatch and `llm_request_end` `{requestId,
  status, usage, durationMs, cachedTokens}` at finalization (emitted from recorder callbacks via
  the same registry pattern as `recordModelStats`, `chat.ts:2008-2066`).
- The open modal listens (extend `processSSEEvent` in `api/client.ts:637-739`), then fetches
  detail lazily via the API when an entry is selected or expanded. This mirrors how
  `ModelStatsModal` reacts to the `iteration` event with `statsVersion` instead of carrying
  payloads.
- Reconnect/live-stream (`live-streams.ts` attach frames) gets the events for free because they
  ride the same stream.

### API endpoints (new `routes/request-log.ts`, mounted `/api/llm-requests`)

- `GET /api/llm-requests?chatId=&purpose=&limit=` — list (summaries, newest first).
- `GET /api/llm-requests/:id` — rehydrated full request/response.
- `DELETE /api/llm-requests?chatId=` — clear.
- `GET /api/chats/:id/context-view` — Context tab payload (upgraded `rendered-prompt`: system
  prompt, section breakdown w/ tokens, tool definitions with schemas, delta state).
- `POST /api/chats/:id/context-view/rendered` — optional on-demand chat-template render.

### Client

- `components/RequestViewerModal.tsx` — new modal reusing ModelStatsModal's tab/list patterns
  and existing primitives (`Dropdown`, collapsibles, `ui/` components). Role-colored message
  blocks consistent with UI patterns (purple agent / emerald context, glassmorphism).
- `ChatView.tsx` header: swap `Prompt` button → `Requests`; keep desktop visibility rules.
- `api/client.ts`: add `fetchLlmRequests`, `fetchLlmRequestDetail`, `fetchContextView`;
  remove `fetchRenderedPrompt`.
- `useChat` SSE switch: new event cases bump a `requestLogVersion` the modal consumes.
- Mobile: modal renders full-screen sheet (existing modal patterns in the repo).

## 5. Phasing

1. **P1 — Server recorder**: `request-log.ts` service, `llm_requests` + blobs tables, provider
   capture with purpose/chatId/turnId threading, retention + deletion cascade, list/detail
   endpoints. (Testable without UI; cross-link `requestDigest` to `model_stats`.)
2. **P2 — Requests tab**: header button swap, `RequestViewerModal` list + expanded
   request/response/raw views, SSE id events + lazy fetch, live in-progress entries from
   existing deltas. Remove the old prompt modal.
3. **P3 — Context tab**: section breakdown with token attribution, tool schemas endpoint,
   delta state; retire `rendered-prompt` fallback path.
4. **P4 — Extras** (nice-to-have, separate decisions): on-demand rendered-template view,
   request-to-request diff view, export/share JSON, settings-tunable retention, canary
   linkage to kv-prefix digests. (Cross-chat/global browsing was considered and deferred by
   the v1 scope decision.)

## 6. Resolved decisions & remaining questions

Resolved (2026-10-07):
- **Scope:** per-chat only — the modal is reachable solely from the selected chat's header.
  No global/cross-chat browser; no separate sidebar entry for automations/system chats in v1
  (system chats are viewable by opening them like any chat).
- **Retention:** 50 requests/chat, hard-coded constant initially; settings-tunable retention is
  a later refinement if needed.
- **Fidelity:** structured content blocks for responses; raw SSE chunk capture out of scope.
- **Recorded traffic:** chat-turn requests only (`purpose='chat'`); warm/extraction/title skip
  the recorder.

Remaining questions:
- Tool-result truncation in stored request/response bodies: suggest **store-full +
  display-truncate** (reranker-stats precedent caps raw text; the blob-dedup scheme keeps full
  storage cheap since transcript rows are re-sent from cache).
- Blob dedup vs simple gzip for v1 — dedup is more code but near-linear storage; gzip is a
  one-liner. Could ship gzip first and migrate to dedup behind the same read path.
  → **Shipped as blob dedup** (`llm_request_blobs`, sha1 full-hex, `INSERT OR IGNORE`).

## 7. Implementation notes (shipped 2026-10-08)

What shipped, by file:

- `server/src/services/request-log.ts` — recorder + storage (porrima.db: `llm_requests`,
  `llm_request_blobs`), `MAX_REQUESTS_PER_CHAT = 50` prune on insert, throttled blob vacuum
  (every 20 inserts + on clear), in-progress rows marked `aborted` at init, event emitter,
  `getLatestRecordedSystemPrompt` (restart-safe Context tab).
- `server/src/services/llm-stream.ts` — `SafeStreamHooks.getTurnId`; per-call
  `llamaRequestId/llamaRequestTurnId/llamaRequestIteration` options threaded to the provider.
- `server/src/services/openai-compat-provider.ts` — `getRequestRecordMeta`; start capture
  after `buildOpenAICompatChatBody`/`buildCacheMetadata` (gated on explicit
  `llamaPromptDebugChatId` + request id = real chat turns only, so warm/extraction/title skip
  recording); end capture at `done` push and in the error path (aborted/error status, partial
  content kept). All recorder calls try/catch — pure side channel.
- `server/src/routes/chat.ts` — `getTurnId: () => state.toolLoopId`; module-level
  `onLlmRequestEvent` forwarder writing `llm_request_start` / `llm_request_end` frames to the
  chat's live stream (skips silently when nobody is streaming).
- `server/src/services/chat-turn-runner.ts` — headless parity: `getTurnId: () => turnId`.
- `server/src/routes/request-log.ts` + `index.ts` mount `/api/llm-requests` — list (`?chatId=`
  required), detail (rehydrated), delete (per-chat clear).
- `server/src/routes/chats.ts` — `GET /:id/context-view` **replaces** `/:id/rendered-prompt`
  (route removed): prompt resolved request-log → in-memory cache → base+skills fallback, with
  `source` field, `PromptSectionBreakdown`, and tools incl. parameter schemas.
- `server/src/services/agent-tools.ts` — `getAgentToolDefinitions` now returns `parameters`.
- `server/src/services/chat-deletion.ts` — `clearLlmRequests` on delete.
- Client: `api/client.ts` (fetchers + types + SSE cases; `fetchRenderedPrompt` removed),
  `hooks/useChat.ts` (`requestLogVersion` bumped by the wire events, returned), `App.tsx`
  (prop threading), `ChatView.tsx` (header `Prompt` → `Requests`; old modal deleted),
  `components/RequestViewerModal.tsx` (Requests + Context tabs, lazy detail fetch, per-role
  collapsible message blocks, raw JSON + copy, section token grid, tool schemas, Clear).
- `server/src/scripts/smoke-request-log.ts` — `npx tsx src/scripts/smoke-request-log.ts`
  end-to-end smoke (self-cleaning; run against a scratch chatId).

Deltas from plan:
- Old plan said keep `rendered-prompt` upgraded — actually replaced by `context-view`
  (single caller, cleaner cutover).
- "Delta since previous request" toggle and live partial-response rendering inside the
  in-progress row are deferred to P4 (v1 in-progress rows show the request + `Response still
  streaming…`, refreshed to the final response on the `llm_request_end` bump).
- Retention ordering key is `(timestamp DESC, iteration DESC)`; the id is `${turnId}:${iteration}`.

UX redesign (2026-10-08), same day as P1–P3: the v1 expanded entry nested scroll containers
inside the modal body (message list, message bodies, response blocks, raw JSON, and the
Context tab each had their own `max-h-[Nvh] overflow-y-auto` box), which made scrolling
confusing. The modal now enforces **one scroll container** (the body's `flex-1 overflow-y-auto`)
as an invariant, and content is a tree whose layers grow/shrink inline:

- request entry (accordion row, chevron) → section nodes → wire messages → message content.
- Section nodes are `<details>` trees (`TreeNode`): `Request` (message list, open by default),
  `Tool definitions sent`, `Response` (open by default, per-block thinking nodes nested inside),
  `Raw wire JSON` — children mount only while open, so collapsed sections cost nothing.
- The wire message list is **tail-truncated**: only the last `MESSAGE_TAIL = 8` messages render
  inline (each iteration re-sends the whole transcript and the tail is what gets inspected);
  the prefix collapses into one `N earlier messages · <role breakdown>` node that expands
  in place, with true wire-array indices preserved. Live in-progress refreshes keep following
  the tail as rows append.
- Context tab follows the same rule: system prompt and tool schemas render inline with no inner
  scroll caps; tool definitions became tree nodes.
