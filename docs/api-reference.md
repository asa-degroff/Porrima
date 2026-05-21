# API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/models` | List available models across configured providers |
| GET | `/api/llama-servers` | List managed llama.cpp systemd units with process state, HTTP health, and launch metadata |
| GET | `/api/llama-servers/:id` | Get one managed llama.cpp server status (`inference`, `extraction`, `reranker`, `embedding`) |
| POST | `/api/llama-servers/:id/:action` | Start, stop, or restart an allowlisted llama.cpp systemd unit |
| GET | `/api/llama-servers/:id/logs` | Recent journal logs for an allowlisted llama.cpp systemd unit |
| GET | `/api/chats` | List all chats |
| POST | `/api/chats` | Create chat (`{ modelId, type: "agent"\|"quick", projectId? }`). The `system` chat is created automatically on server startup — clients don't POST it. |
| PATCH | `/api/chats/:id` | Update chat metadata |
| DELETE | `/api/chats/:id` | Delete a chat |
| GET | `/api/chats/:id` | Get single chat with messages. Optional `?messageLimit=N` returns the most recent message window with `messageOffset`, `messageTotal`, and `hasMoreMessages`; `N` is capped at 1000. |
| GET | `/api/chats/:id/messages` | Get a paged message window before an absolute sequence: `?before=N&limit=M`. Used by scroll-to-top history loading; `limit` is capped at 1000. |
| POST | `/api/chat` | Send message (SSE stream) |
| POST | `/api/chat/enqueue` | Queue message for later delivery |
| POST | `/api/chat/edit` | Edit and resend a message |
| GET | `/api/memory` | List memories (without embeddings) |
| POST | `/api/memory` | Create memory |
| POST | `/api/memory/search` | Semantic search (`{ query, topK? }`) |
| GET | `/api/memory/status` | Embedding model status + memory count + extraction metrics |
| GET | `/api/memory/synthesis/status` | Last synthesis timestamp + memory count + `isSynthesizing` flag |
| POST | `/api/memory/synthesis/run` | Dispatch a synthesis run. Returns **202 Accepted** `{ started: true }` immediately and runs in the background (synthesis can take minutes; longer than any reasonable HTTP idle timeout). Clients poll `/synthesis/status` for completion. Returns **409 Conflict** if a run is already active. |
| POST | `/api/memory/synthesis/sleep` | Same as `/run`, but also stamps `settings.sleepModeTriggeredAt` so the scheduler suppresses periodic runs for 2 hours. Returns **202** `{ started: true, sleepModeTriggeredAt }`. |
| POST | `/api/memory/conversations/search` | Conversation search (`{ query, chatId?, limit? }`) — FTS5 on chat history |
| GET | `/api/snapshots` | List agent database snapshots |
| POST | `/api/snapshots` | Create an agent database snapshot (`{ label?, includeCorpus? }`) containing `app.db` and `memory/memories.db`, optionally `image-corpus/corpus.db`. Filesystem assets are not included. |
| DELETE | `/api/snapshots/:id` | Delete an agent database snapshot |
| POST | `/api/snapshots/:id/restore` | Restore an agent database snapshot as a full database replacement. Creates a pre-restore snapshot before replacing databases; automatic pre-restore snapshots retain the latest 10 for up to 30 days. |
| GET | `/api/automations` | List automation tasks plus `{ isRunning, activeTaskId }` |
| POST | `/api/automations` | Create a custom automation task |
| PATCH | `/api/automations/:id` | Update schedule, order, enabled state, activation policy, prompt steps, notifications, or runtime limits |
| DELETE | `/api/automations/:id` | Delete a custom automation. Built-ins return **400** and must be disabled instead. |
| POST | `/api/automations/:id/run` | Manually dispatch an automation. Returns **202 Accepted** `{ started: true }`; returns **409 Conflict** if another automation is active. |
| POST | `/api/automations/:id/reset-prompts` | Restore the default prompt steps for a built-in automation |
| GET | `/api/automations/:id/runs` | List recent run history for a task. Optional `?limit=N`, capped at 200. |
| GET | `/api/projects` | List all projects |
| POST | `/api/projects` | Create project (`{ name, path }`) |
| PATCH | `/api/projects/:id` | Update project |
| DELETE | `/api/projects/:id` | Delete project (orphans chats) |
| GET | `/api/projects/:id/agents-md` | Get project's AGENTS.md content |
| GET | `/api/tts` | Get TTS settings |
| PUT | `/api/tts` | Update TTS settings |
| GET | `/api/tts/voices` | List available voices |
| GET | `/api/vision` | List analyzed images |
| POST | `/api/vision/analyze` | Analyze an image |
| POST | `/api/vision/save` | Save analyzed image |
| POST | `/api/vision/images/:id/chat` | Chat about analyzed image |
| GET | `/api/images` | List generated images |
| POST | `/api/images/generate` | Generate image via ComfyUI |
| DELETE | `/api/images/:id` | Delete generated image |
| GET | `/api/images/status` | ComfyUI status |
| GET | `/api/user-images` | List uploaded images |
| POST | `/api/user-images` | Upload image |
| DELETE | `/api/user-images/:id` | Delete uploaded image |
| GET | `/api/artifacts/:id` | Serve artifact HTML |
| GET | `/api/artifacts/:id/*` | Serve artifact assets |
| GET | `/api/skills` | List available skills |
| GET | `/api/persona` | Get current persona |
| GET | `/api/corpus/clusters` | Get all clusters |
| GET | `/api/corpus/clusters/:id` | Get single cluster with members |
| POST | `/api/corpus/rebuild-clusters` | Rebuild clusters from current corpus |
| GET | `/api/corpus/visualization` | Get D3 force-directed graph HTML |
| GET | `/api/corpus/stats` | Get corpus statistics |
| GET | `/api/corpus/stats-public` | Get corpus statistics (public) |
| POST | `/api/corpus/cleanup` | Delete orphaned corpus entries whose backing files no longer exist |
| GET | `/api/corpus/cleanup/dry-run` | Preview orphaned corpus entries without deleting them |
| POST | `/api/auth/register` | Register passkey |
| POST | `/api/auth/login` | Login with passkey |
| POST | `/api/auth/logout` | Logout |
| GET | `/api/push/public-key` | Get VAPID public key for browser push subscription |
| POST | `/api/push/subscribe` | Register or update a browser push subscription |
| POST | `/api/push/unsubscribe` | Remove a browser push subscription by device ID |
| POST | `/api/push/presence` | Update short-lived foreground presence for notification suppression |
| GET | `/api/push/devices` | List registered push devices |
| POST | `/api/push/test` | Send a test push notification |
| GET | `/api/notebooks/user` | List user notebook entries |
| GET | `/api/notebooks/agent` | List agent notebook entries |
| GET | `/api/notebooks/:id` | Get single notebook entry |
| POST | `/api/notebooks` | Create notebook entry |
| PATCH | `/api/notebooks/:id` | Update notebook entry |
| DELETE | `/api/notebooks/:id` | Delete notebook entry |
| GET | `/api/image-corpus/` | List all corpus entries |
| GET | `/api/image-corpus/stats` | Corpus statistics |
| GET | `/api/image-corpus/:id` | Get single corpus entry |
| POST | `/api/image-corpus/search` | Semantic corpus search |
| GET | `/api/image-corpus/by-chat/:chatId` | Corpus entries by chat |
| GET | `/api/image-corpus/by-project/:projectId` | Corpus entries by project |
| POST | `/api/image-corpus/enrich` | Batch corpus enrichment |
| GET | `/api/ui-state/` | Get persisted UI state |
| PUT | `/api/ui-state/` | Save UI state |
| GET | `/api/user/` | Get user profile document |
| PUT | `/api/user/` | Save user profile document |
| DELETE | `/api/user/` | Delete user profile document |
| GET | `/api/visuals/:id` | Serve visual HTML by ID |
