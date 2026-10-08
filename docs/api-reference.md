# API Reference

Server runs on port 3001. All `/api/*` routes except `/api/auth/*` and `/api/app/*` are behind `requireAuth` (`server/src/middleware/auth.ts`). JSON responses are compressed unless the route is an SSE stream (`server/src/middleware/compression.ts`).

**Endpoint count: 185.** Tables are grouped by domain. Paths are the full mounted paths (mount prefix + router path), derived from `server/src/index.ts` and `server/src/routes/*.ts`.

---

## Auth (`routes/auth.ts`)

WebAuthn / passkey with `express-session`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/status` | Whether auth is enforced and whether any passkey is registered |
| POST | `/api/auth/register/options` | WebAuthn registration challenge |
| POST | `/api/auth/register/verify` | Verify and persist a new passkey credential |
| POST | `/api/auth/login/options` | WebAuthn authentication challenge |
| POST | `/api/auth/login/verify` | Verify assertion and establish a session |
| POST | `/api/auth/logout` | Destroy the session |

## App (`routes/app.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/app/version` | Current baked Porrima build metadata |
| GET | `/api/app/update-check` | Check the latest GitHub release against the current build. Optional `?force=1` bypasses the short server cache |

## Models (`routes/models.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List models from the configured provider(s) |
| POST | `/api/models/refresh` | Invalidate the model cache and re-discover |
| GET | `/api/models/discover` | Re-discover models by kind. `?kind=chat\|embedding\|rerank` and `?url=` override |
| GET | `/api/models/health/:modelId` | Health of a single model |
| GET | `/api/models/health-all` | Health across inference, extraction, and reranker endpoints in one call |
| GET | `/api/models/llamacpp/health` | llama.cpp router health |

## llama.cpp Servers (`routes/llama-servers.ts`)

Managed systemd user units. Slot ids: `inference`, `extraction`, `reranker`, `embedding`, `title-generation`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/llama-servers` | List managed units with process state, HTTP health, and launch metadata |
| GET | `/api/llama-servers/:id` | Get one unit's status |
| PATCH | `/api/llama-servers/:id` | Update per-server settings (URL, model, toggles) |
| POST | `/api/llama-servers/:id/:action` | Start, stop, or restart an allowlisted unit |
| GET | `/api/llama-servers/:id/logs` | Recent journal logs for the unit |
| GET | `/api/llama-servers/:id/config` | Current service config with defaults, capabilities, and systemd unit info |
| PUT | `/api/llama-servers/:id/config` | Save service configuration (writes systemd drop-in override) |
| POST | `/api/llama-servers/:id/config/preview` | Preview the drop-in override without writing |
| DELETE | `/api/llama-servers/:id/config` | Remove saved override (reverts to defaults) |
| PUT | `/api/llama-servers/:id/enabled` | Enable/disable the systemd unit (`{ enabled: true/false }`) |
| POST | `/api/llama-servers/:id/apply-model` | Apply a model override via drop-in (`{ modelPath, modelId }`) |
| DELETE | `/api/llama-servers/:id/model-override` | Remove model override |
| POST | `/api/llama-servers/:id/convert-to-router` | Convert a router-capable slot from single to router mode. 400 for slots that pin a model class (embedding/reranker) |
| GET | `/api/llama-servers/available-models` | List available models across all configured servers |
| GET | `/api/llama-servers/scan-paths` | Directories scanned for GGUF models, with per-path validity and model count |
| POST | `/api/llama-servers/scan-paths/preview` | Preview what a candidate scan path would yield |
| POST | `/api/llama-servers/scan-paths` | Add a model scan directory |
| DELETE | `/api/llama-servers/scan-paths` | Remove a model scan directory |

## Chats (`routes/chats.ts`, `routes/chat.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/chats` | List all chats |
| POST | `/api/chats` | Create chat (`{ modelId, projectId? }`); always creates an agent chat. The `system` chat is created on server startup — clients don't POST it |
| PATCH | `/api/chats/:id` | Update chat metadata |
| DELETE | `/api/chats/:id` | Delete a chat |
| GET | `/api/chats/:id` | Get a chat with messages. `?messageLimit=N` returns the most recent window plus `messageOffset`, `messageTotal`, `hasMoreMessages`; `N` capped at 1000 |
| GET | `/api/chats/:id/messages` | Paged window before an absolute sequence: `?before=N&limit=M` (capped at 1000). Used by scroll-to-top history loading |
| GET | `/api/chats/:id/header` | Lightweight chat header (id, title, type, modelId, lastModified, projectId, contextWindow, message count) — avoids loading the message window |
| GET | `/api/chats/:id/context-view` | Context tab payload: last-assembled system prompt (request log → in-memory cache → base-prompt fallback), per-section token breakdown, and tool definitions including parameter schemas |
| GET | `/api/chats/:id/context-breakdown` | Per-section token attribution for the effective context window |
| POST | `/api/chat` | Send a message (SSE stream) |
| POST | `/api/chat/edit` | Edit and resend a message |
| POST | `/api/chat/enqueue` | Queue a message for later delivery |
| POST | `/api/chat/stop` | Abort the in-flight turn (`{ chatId }`). Aborts both the pending-intent and live-stream registries |
| GET | `/api/chat/status/:chatId` | Whether a live stream is active. `?includeWindow=1` folds the recent message window into the same response |
| GET | `/api/chat/reconnect/:chatId` | Re-attach to an active SSE stream (resync snapshot). 404 `no_active_stream` when none |
| POST | `/api/chat/artifact-error` | Client-forwarded artifact/visual runtime error report (`diagnosticKind`, `title`, `url`) |

## Memory (`routes/memory.ts`)

Atomic memories, memory blocks, and the graph/supersession surface.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/memory` | List memories (without embeddings) |
| POST | `/api/memory` | Create a memory |
| GET | `/api/memory/:id` | Get one memory |
| PATCH | `/api/memory/:id` | Update a memory |
| DELETE | `/api/memory/:id` | Delete a memory |
| POST | `/api/memory/search` | Semantic search (`{ query, topK? }`) |
| GET | `/api/memory/status` | Embedding model status, memory count, extraction metrics |
| GET | `/api/memory/graph` | Memory graph nodes + edges. `?category=`, `?includeSuperseded=`, `?minSimilarity=`, `?neighbors=`, `?limit=` |
| GET | `/api/memory/timeline` | Memories over a time range (`?from=`, `?to=`, `?groupedBy=`) |
| GET | `/api/memory/contradictions` | Heuristically grouped potentially-conflicting memories |
| GET | `/api/memory/:id/lineage` | Supersession lineage for a memory |
| POST | `/api/memory/:id/supersede` | Mark a memory superseded by another |
| DELETE | `/api/memory/:id/supersession` | Remove a supersession edge |
| POST | `/api/memory/backfill-supersessions` | Rebuild supersession edges across all memories |
| GET | `/api/memory/blocks` | List memory blocks |
| POST | `/api/memory/blocks` | Create a memory block |
| GET | `/api/memory/blocks/:id` | Get one memory block |
| PATCH | `/api/memory/blocks/:id` | Update a memory block |
| DELETE | `/api/memory/blocks/:id` | Delete a memory block |
| GET | `/api/memory/blocks/:id/history` | Version history for a memory block |
| POST | `/api/memory/conversations/search` | Conversation search (`{ query, chatId?, limit? }`) — FTS5 across chat history and archives |
| GET | `/api/memory/synthesis/status` | Last synthesis timestamp, memory count, `isSynthesizing` |
| POST | `/api/memory/synthesis/run` | Dispatch synthesis. **202** `{ started: true }`, background. **409** if already running |
| POST | `/api/memory/synthesis/sleep` | As `/run`, plus stamps `settings.sleepModeTriggeredAt` to suppress periodic runs for 2 hours. **202** |
| POST | `/api/memory/wake/run` | Manually dispatch a wake cycle |
| GET | `/api/memory/extraction/recent` | Recent extraction runs with status |
| GET | `/api/memory/extraction/stream` | SSE stream of live extraction events (`event: run`, `data: { type: start\|output\|complete\|error, run }`) |
| POST | `/api/memory/cache-warm/:chatId` | Warm the llama.cpp prompt cache for a chat |
| POST | `/api/memory/cache-warm/new-agent-chat-baseline` | Warm the new-agent-chat baseline prefix |
| GET | `/api/memory/cache-residency` | Observed prompt-cache residency records |

## Automations (`routes/automations.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/automations` | List tasks plus `{ isRunning, activeTaskId }` |
| POST | `/api/automations` | Create a custom task |
| PATCH | `/api/automations/:id` | Update schedule, order, enabled state, activation policy, prompt steps, prompt dispatch mode, notifications, or runtime limits |
| DELETE | `/api/automations/:id` | Delete a custom task. Built-ins return **400** — disable them instead |
| POST | `/api/automations/:id/run` | Manually dispatch. **202** `{ started: true }`, **409** if another automation is active |
| POST | `/api/automations/:id/reset-prompts` | Restore default prompt steps for a built-in |
| GET | `/api/automations/:id/runs` | Run history. `?limit=N`, capped at 200 |

## System control & stats (`routes/system.ts`, `routes/system-stats.ts`, `routes/model-stats.ts`, `routes/reranker-stats.ts`, `routes/request-log.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/system/pause` | Pause state plus `pending` (an automation or extraction is still running) |
| POST | `/api/system/pause` | Pause background work. `{ indefinite: true }` or `{ durationMs }` |
| POST | `/api/system/resume` | Resume background work |
| GET | `/api/system-stats` | Current CPU/GPU/memory stats, history buffer, hidden + all GPUs |
| PATCH | `/api/system-stats` | Update stats settings (`{ bufferSeconds, hiddenGpus }`) |
| GET | `/api/model-stats` | Per-model usage summaries (tokens, latency) |
| GET | `/api/model-stats/:modelId` | Summaries for one model, optionally `?provider=` |
| POST | `/api/model-stats/clear` | Reset collected model stats |
| GET | `/api/llm-requests?chatId=&limit=` | Per-chat wire-level LLM request log (summaries, newest first) — backs the request viewer |
| GET | `/api/llm-requests/:id` | Rehydrated full request body + response for one recorded LLM call |
| DELETE | `/api/llm-requests?chatId=` | Clear the recorded request log for a chat |
| GET | `/api/reranker-stats` | Reranker usage and latency stats |
| POST | `/api/reranker-stats/clear` | Reset reranker stats |

## Settings (`routes/settings.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | User settings |
| PUT | `/api/settings` | Update user settings |
| GET | `/api/settings/storage-diagnostics` | Per-database size and row counts |
| GET | `/api/settings/llama-path` | Current `llama-current` symlink info and service health |
| PUT | `/api/settings/llama-path` | Update symlink and restart all services (`{ path }`) — rolls back on failure |
| POST | `/api/settings/llama-path/validate` | Validate a candidate build directory without applying |
| GET | `/api/settings/llama-binaries` | Discover available llama.cpp binaries |
| GET | `/api/settings/slot-assignments` | Enforced-slot lease view |
| GET | `/api/settings/cache-residency` | Observed prompt-cache residency, enriched with warm-queue position |
| GET | `/api/settings/ssh-connections` | List remote SSH connections |
| POST | `/api/settings/ssh-connections` | Create an SSH connection |
| PATCH | `/api/settings/ssh-connections/:id` | Update an SSH connection |
| DELETE | `/api/settings/ssh-connections/:id` | Delete an SSH connection |
| POST | `/api/settings/ssh-connections/:id/test` | Test connectivity to an SSH connection |
| GET | `/api/settings/header-image` | Chat header image metadata |
| POST | `/api/settings/header-image` | Upload a chat header image |
| DELETE | `/api/settings/header-image` | Remove the header image |
| GET | `/api/settings/header-image/thumb` | Header image thumbnail |
| GET | `/api/settings/header-image/image.:ext` | Full-resolution header image |

## Snapshots & migrations (`routes/snapshots.ts`, `routes/embedding-migration.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/snapshots` | List agent database snapshots |
| POST | `/api/snapshots` | Create a snapshot (`{ label? }`) containing `app.db` and `memory/memories.db`. Filesystem assets are not included |
| DELETE | `/api/snapshots/:id` | Delete a snapshot |
| POST | `/api/snapshots/:id/restore` | Restore as a full database replacement. Creates a pre-restore snapshot first; automatic ones retain the latest 10 for up to 30 days |
| GET | `/api/embedding/backups` | List embedding migration backups |
| POST | `/api/embedding/backup` | Create an embedding backup (`{ label? }`) |
| DELETE | `/api/embedding/backup/:id` | Delete an embedding backup |
| POST | `/api/embedding/restore/:id` | Restore from an embedding backup |
| GET | `/api/embedding/progress` | Embedding migration progress |
| POST | `/api/embedding/progress/clear` | Clear migration progress |
| POST | `/api/embedding/migrate` | Run embedding migration (SSE progress stream) |

## Prompts & persona (`routes/extraction-prompt.ts`, `routes/persona.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/extraction-prompt` | Current memory extraction prompt |
| PUT | `/api/extraction-prompt` | Update the extraction prompt (saves a version) |
| GET | `/api/extraction-prompt/history` | List saved extraction prompt versions |
| GET | `/api/extraction-prompt/history/:filename` | One saved extraction prompt version |
| GET | `/api/persona` | Current persona |
| PUT | `/api/persona` | Update the persona |
| GET | `/api/persona/history` | List saved persona versions |
| GET | `/api/persona/history/:filename` | One saved persona version |

## Skills, projects, notebooks (`routes/skills.ts`, `routes/projects.ts`, `routes/notebooks.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/skills` | List available skills |
| GET | `/api/skills/:name` | Get one skill |
| PUT | `/api/skills/:name` | Update a global skill (`{ content }`) |
| DELETE | `/api/skills/:name` | Delete a skill |
| POST | `/api/skills/install` | Install a skill from a URL |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project (`{ name, path }`) |
| GET | `/api/projects/:id` | Get one project |
| PATCH | `/api/projects/:id` | Update a project |
| DELETE | `/api/projects/:id` | Delete a project (orphans chats) |
| GET | `/api/projects/:id/agents-md` | Project AGENTS.md content |
| GET | `/api/projects/defaults` | Default project directory suggestions |
| POST | `/api/projects/validate` | Validate a candidate project path (permissions, writability) |
| POST | `/api/projects/create-directory` | Create a project directory on disk |
| GET | `/api/notebooks/user` | List user notebook entries |
| POST | `/api/notebooks/user` | Create a user notebook entry |
| GET | `/api/notebooks/agent` | List agent notebook entries |
| GET | `/api/notebooks/search` | Search entries across both authors. `?q=`, `?author=user\|agent`, `?limit=` |
| POST | `/api/notebooks/bulk` | Bulk fetch entries (`{ entries: [{ author, id }] }`) |
| GET | `/api/notebooks/:author/:id` | Get one entry. `:author` is `user` or `agent` |
| PATCH | `/api/notebooks/:author/:id` | Update an entry |
| DELETE | `/api/notebooks/:author/:id` | Delete an entry |

## Artifacts & visuals (`routes/artifacts.ts`, `routes/visuals.ts`)

Artifacts and visuals are versioned. `create_artifact` writes to `~/.porrima/artifacts/`. The same handler set is mounted at both `/api/artifacts` and `/api/visuals`; `/api/artifacts/visuals/*` is an additional alias, so all four visual routes have a second path.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/artifacts/:id` | Serve the current artifact HTML |
| GET | `/api/artifacts/:id/*subpath` | Serve an asset of the current version (legacy route) |
| GET | `/api/artifacts/:id/metadata` | Artifact metadata |
| GET | `/api/artifacts/:id/versions` | List saved versions |
| GET | `/api/artifacts/:id/versions/:version` | Serve a specific version |
| GET | `/api/artifacts/:id/versions/:version/*subpath` | Serve a specific version's asset |
| GET | `/api/visuals/:id` | Serve visual HTML (alias: `/api/artifacts/visuals/:id`) |
| GET | `/api/visuals/:id/metadata` | Visual metadata (alias: `/api/artifacts/visuals/:id/metadata`) |
| GET | `/api/visuals/:id/versions` | List visual versions (alias: `/api/artifacts/visuals/:id/versions`) |
| GET | `/api/visuals/:id/versions/:version` | Serve a visual version (alias: `/api/artifacts/visuals/:id/versions/:version`) |
| GET | `/api/artifacts/visuals/:id` | Alias of `/api/visuals/:id` |
| GET | `/api/artifacts/visuals/:id/metadata` | Alias of `/api/visuals/:id/metadata` |
| GET | `/api/artifacts/visuals/:id/versions` | Alias of `/api/visuals/:id/versions` |
| GET | `/api/artifacts/visuals/:id/versions/:version` | Alias of `/api/visuals/:id/versions/:version` |

## Images uploaded by the user (`routes/user-images.ts`)

Attachments are uploaded **inline** as base64 in the `POST /api/chat` / `POST /api/chat/edit` body and persisted server-side (`services/user-image-storage.ts`). There is no separate upload or list endpoint.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user-images/:id/image.:ext` | Serve the full-resolution image |
| GET | `/api/user-images/:id/thumb` | Serve the WebP thumbnail |
| DELETE | `/api/user-images/chat/:chatId/image/:imageId` | Remove an attachment and strip it from the chat's messages |

## Tool result images (`routes/tool-result-images.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tool-result-images/:id/image.:ext` | Serve an image emitted as a tool result |

## Local filesystem images (`routes/local-images.ts`)

Markdown images in message content that point at a local filesystem path (`/tmp/render.png`, `~/out.png`, `file:///...`) are rewritten client-side to this endpoint. Files are served **on demand, straight from disk** — nothing is copied into `~/.porrima` and the persisted message row is never modified. Serving requires an allowed root (home, `/tmp`, `/var/tmp`, or a local project root), image magic bytes (extension is irrelevant), and a file size of at most 64 MB. Scratch files that are later cleaned up simply stop resolving; the client renders an inline "image unavailable" note instead of a broken image icon.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/local-images?path=...` | Serve a local image referenced by markdown |

## Push notifications (`routes/push.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/push/public-key` | VAPID public key |
| POST | `/api/push/subscribe` | Register or update a browser push subscription |
| POST | `/api/push/unsubscribe` | Remove a subscription by device ID |
| POST | `/api/push/presence` | Update short-lived foreground presence for notification suppression |
| GET | `/api/push/devices` | List registered push devices |
| POST | `/api/push/test` | Send a test notification |

## User profile & UI state (`routes/user.ts`, `routes/ui-state.ts`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/user` | Get the user profile document |
| PUT | `/api/user` | Save the user profile document |
| DELETE | `/api/user` | Delete the user profile document |
| GET | `/api/ui-state` | Get persisted UI state |
| PUT | `/api/ui-state` | Save UI state |
