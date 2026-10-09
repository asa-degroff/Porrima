# Tool System (Agent Chats)

Uses **native pi-ai tool calling** (`Context.tools`, `ToolCall`, `ToolResultMessage`) with TypeBox schemas — NOT fenced code blocks.

## Registry (`server/src/services/agent-tools.ts`)

- `getAgentTools(chatId, effects, contextWindow, project, chatType, timeMarker?)` returns the runtime registry with context-aware result limits and chat-type gating. System chats omit `ask_user` and the per-chat skill tools. Headless **agent** runs (automations, cross-chat wakes) keep the interactive tool surface byte-identical — `ask_user` stays in the schema with a headless-safe executor (`headless-tools.ts`) — because tool schemas render into the system prompt and any per-path difference busts the chat's KV prefix. Automation management tools (`schedule_reminder`, `list_automations`, `update_automation`) remain available — reminder chaining from within fired automation runs is deliberate, bounded by the pending-reminder cap (10), the 2-minute minimum lead time, three-tier update permissions, and per-run iteration/time budgets.
- The registry is the concatenation of six groups: `MEMORY_TOOLS` (`memory-tools.ts`), `WEB_TOOLS` (`web-tools.ts`), `BROWSER_TOOLS` (`browser-tools.ts`), `AUTOMATION_TOOLS`, `FILESYSTEM_TOOLS`, and `SKILL_TOOLS` (`skills.ts`). 32 tools total.

### Tool inventory

| Group | Tools |
| --- | --- |
| Memory (`memory-tools.ts`) | `save_memory`, `search_memory`, `update_memory`, `create_memory_block`, `update_memory_block`, `read_memory_block`, `list_memory_blocks`, `create_notebook_entry` |
| Conversation & archive search | `search_conversation` (FTS5 over chat history **and** archived context, cross-chat, scoped to one chat or global); `read_archived_context` (dereferences an archive block ID to return full original messages — tool outputs, code, reasoning) |
| Filesystem | `list_files`, `read_file`, `write_file`, `edit_file`, `read_pdf` |
| Sandbox | `bash`, `run_python` |
| Web (`web-tools.ts`) | `web_search`, `web_fetch` — provider-backed search (Brave, Exa, Tavily) plus rendered page fetch. Large fetches paginate through `web_fetch` offsets, not server-local file paths |
| Browser (`browser-tools.ts`) | `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_hover`, `browser_type`, `browser_screenshot` |
| Artifacts | `create_artifact`, `update_artifact` |
| Automations & cross-chat | `schedule_reminder`, `list_automations`, `update_automation`, `schedule_chat_message`, `list_chats` |
| Skills (`skills.ts`) | `list_skills`, `install_skill`, `remove_skill` |
| Flow control | `ask_user` |

> There is no `forget_memory` tool — memories are retired by supersession or direct deletion. There is no `get_block_history` tool either; block history is exposed over HTTP at `GET /api/memory/blocks/:id/history`, not to the agent.

- **Memory blocks**: `create_memory_block`, `update_memory_block`, `read_memory_block`, `list_memory_blocks` — structured knowledge documents (see [memory-blocks.md](memory-blocks.md))
- **Workspace tools**: `read_file`, `write_file`, `edit_file`, `list_files`, `read_pdf`, `bash`, and `run_python` share the same local/SSH workspace adapter, path policy, and cancellation signal. Remote SSH connections are configured in Settings, and their per-connection permission flags (`allowBash`, `allowFileWrite`, `allowAbsolutePaths`) are enforced here.
- **Web tools**: `web_search`, `web_fetch` — provider-backed web search (Brave, Exa, Tavily) plus rendered page fetch. Large fetches are paginated through `web_fetch` offsets, not server-local file paths.
- **Browser tools**: per-chat Chrome session (`chrome.ts` speaks the DevTools Protocol). When a local Chrome has remote debugging enabled (Chrome 144+: `chrome://inspect/#remote-debugging`), the session attaches to that real browser and works in a tab of its own; otherwise it launches a private headless instance. Attached sessions close only their tab and disconnect on idle timeout (a 10-minute sweep on a 60s timer), chat deletion, and server shutdown — never the user's browser or its other tabs. Overrides: `PORRIMA_BROWSER_CDP_URL` (explicit CDP endpoint), `PORRIMA_BROWSER_USER_DATA_DIR` (path-delimiter separated profile dirs to probe), `PORRIMA_BROWSER_ATTACH=0` (never attach), `PORRIMA_BROWSER_HEADLESS=0` (headed private browser), `PORRIMA_BROWSER_CONSENT_TIMEOUT_MS` (consent-window deadline, default 60000).

Discovery is **file-based**, not HTTP-probed: the adapter reads `DevToolsActivePort` (port + browser WebSocket path) from the profile directory, trying 7 candidate directories. This is deliberate — targeting Chrome 152's consent-mode behavior, the legacy `/json/*` HTTP routes answer 404 and the WebSocket upgrade stays PENDING until the user approves, so a pre-flight `GET /json/version` cannot distinguish "waiting for consent" from "dead". Consequently `browser-session.ts` supplies a custom `WsTransport` with a real `handshakeTimeout`, because puppeteer-core 25.x has no connect-timeout field and an unanswered consent dialog would otherwise hang the entire agent turn.

Attached and launched sessions also differ: attached sessions use `defaultViewport: null` (never resize the user's windows) while launched sessions get 1280×800, and attached sessions adopt only their own popups whereas launched sessions may also adopt the newest page. Snapshots assign `[eN]` refs to interactive elements; refs are invalidated by navigation and every action, so re-snapshot before further interaction. `browser_hover` moves the pointer over an element and leaves it there (hover-driven UI). Runs sequentially (never parallelized) and auto-dismisses page dialogs.
- **Artifact tools**: `create_artifact`, `update_artifact`. HTML guidance (including p5 instance-mode checks) is emitted as result-side lint warnings instead of repeated in the tool schema.
- **Automation tools**: `schedule_reminder`, `list_automations`, `update_automation` (interactive agent chats only).
- **Cross-chat tools**: `schedule_chat_message` — deliver a message to any agent/system chat, optionally waking a turn there, optionally at a future time (delivery semantics in [automations.md](automations.md)); `list_chats` — chat enumeration (`search_conversation` already owns content search).
- **Skill tools**: `list_skills`, `install_skill`, `remove_skill` (interactive agent chats only).
- **Flow control**: `ask_user` (pauses tool loop, saves pending state to `pending_states` table in SQLite, resumes on next user message)

### Chat-type gating

`toolIsAvailable(name, chatType)` excludes a fixed set for `system` chats: `ask_user` plus every `SKILL_TOOLS` entry. `ask_user` is excluded because it would stall a headless loop forever, and system chats do not activate skills. Everything else — including all automation management tools — stays available in system chats. This gate is keyed to `chatType` only, so HTTP and headless builds of the same chat type produce identical schemas. Headless callers must never re-filter the array (`automation-runner.ts` used to drop `ask_user` here): tool schemas render into the system prompt, so a per-path schema difference shifts the tools block and forces a full KV re-prefill. Agent-chat automation runs keep `ask_user` and swap only its executor via `withHeadlessAskUser`.

### Sequential vs parallel execution

The global default is parallel tool execution. Tools that mutate shared state declare membership in `SEQUENTIAL_TOOL_NAMES`, and if any tool in a batch is in that set the whole batch is serialized. Members: `save_memory`, `create_memory_block`, `update_memory_block`, `create_notebook_entry`, `write_file`, `edit_file`, `bash`, `run_python`, `web_fetch`, all six `browser_*` tools, `create_artifact`, `update_artifact`, `ask_user`, `schedule_reminder`, `schedule_chat_message`, `update_automation`, `install_skill`, `remove_skill`.

## Tool Result Limits

Tool results are dynamically truncated based on the effective context window to prevent a single large result from overflowing the context:

- **Formula**: `Math.max(8000, contextWindow * 4 * 0.15)` — 15% of context as chars (4 chars/token estimate)
- 50k context → ~30k char limit; 128k → ~77k; 256k → ~154k
- `read_file` and `web_fetch` expose explicit pagination. Other oversized results are truncated without claiming that a remote workspace can read a server-local spill file.
- `contextWindow` is passed to `getAgentTools()` after model discovery

## Workspace Tools

`WorkspaceAdapter` (`workspace.ts`) is the single interface behind the filesystem and execution tools. `getWorkspaceForProject()` picks a local or SSH adapter per project, so every operation has one implementation regardless of where the bytes live.

- **Local**: `bash` runs through the shared process supervisor (`process-supervisor.ts`: detached spawn in its own process group, timeout/abort kill the group TERM → grace → KILL with confirmed death) and the shared output capture (`output-capture.ts`: bounded tail window, incremental updates, spill). Output over 100 KB spills to `~/.porrima/tool-output/<chatId>/bash-*.log` (64 MiB per-file cap, newest 64/chat, 24 h TTL) and the result footer points at `read_file`.
- **`run_python` (local chats — agent and system)**: a persistent per-chat kernel (`python-kernel.ts` + `server/python/porrima_kernel.py`) on the same supervisor. The namespace survives calls, failures, and timeouts; top-level `await` is supported; interrupts preserve state (L1 SIGINT, then L2 task cancel + child-group kill after a grace window). `background: true` returns a job id immediately and runs without holding the turn; `python_jobs` (list/status/tail/kill) answers from server-side state (4 jobs per chat, 8 box-wide). Idle executions snapshot to `~/.porrima/kernels/<chatId>/` (debounced; EOF flush on hard server death) and restore on the next kernel; `emit({"image/png": …})` attaches images to the tool result. Capacity/spawn/wedge/protocol failures fall back to one-shot with a notice. The system chat shares one kernel (chatId `system` — synthesis, wake, and automation runs are the same chat): its cadence lands past the idle TTL on nearly every run, so each spawn restores from the last debounced snapshot and the namespace persists across cycles; `python_jobs` stays exposed there because it is the only job-completion read between runs and the only model-reachable wedge/L3 escape. A protocol failure disables that chat's kernel only until disposal (the TTL/LRU reaper bounds it) — every fresh generation gets a clean attempt. Idle TTL 30 min, max 4 kernels (env-tunable).
- **`run_python` (SSH workspaces)**: per-call execution by default. With `PORRIMA_REMOTE_KERNEL=1` (P4a, dark), bash-permitted SSH chats run the same driver **on the remote host**: the driver is staged to `~/.porrima/kernel/porrima_kernel.py` (content-hash, re-checked at the `ready` handshake), spawned as a supervised `ssh` session whose stdio carries the full protocol, and snapshots to `~/.porrima/kernels/<chatId>/` on the host. A dropped connection tears the remote kernel down (EOF flush + final snapshot; the driver's getppid watchdog covers wedged loops); the next call respawns and restores. Any transport/staging/spawn failure degrades to per-call with a `[kernel: remote session unavailable; ran per-call this call]` notice; background jobs over ssh stay one-shot until P4b (remote spill placement). Driver boot self-heal (pidfile predecessor kill, stale child-journal reap, 14-day state expiry) runs on the host before `ready`. See [design/remote-python-kernel.md](design/remote-python-kernel.md).
- **Remote (SSH)**: each operation pipes a Python script over a multiplexed connection. The adapter keeps a control-mux master registry keyed by connection id (`ssh -fMN` with `ControlPersist=600`, stale sockets cleaned up after 5 minutes, `BatchMode=yes`, and `StrictHostKeyChecking` derived from the connection's `knownHostsMode` of `strict` / `off` / `accept-new`). Remote `python3` is resolved through a **login shell** so pyenv/conda/asdf `PATH` values apply, cached per connection.
- **Permission flags**: `allowBash`, `allowFileWrite`, and `allowAbsolutePaths` are enforced per connection. When absolute paths are disallowed, every script enforces `target.relative_to(root)` containment — including glob matches.
- **Spill protocol**: remote bash output spills to `.porrima-tool-output/bash-*.log` inside the workspace at 50KB, and the model is pointed at `read_file` for the rest.

> `sandbox.ts` is **not** a security sandbox — it runs Python with full system access. Its own source comment says so. It is now reachable only from the URL branch of `read_pdf`; the model-facing `run_python` tool routes through `workspace.ts`.

## Tool Result Images

Any image a tool emits is externalized rather than stored inline: the file is written to `~/.porrima/tool-result-images/{id}/image.{ext}` and served from `GET /api/tool-result-images/:id/image.:ext`, and the base64 `data` field is **stripped from the persisted chat row**. `hydrateToolResultImageAttachment()` re-attaches the base64 on replay by probing candidate extensions, so both the HTTP chat path and the headless automation path must externalize. Producers include `browser_screenshot`, `read_pdf` with `extractImages`, and artifact preview screenshots. A one-off repair migration (`tool-result-image-payload-migration.ts`) fixes rows still holding inline base64.

## Tool Result Wire Shape

`normalizeToolResultContent()` runs at the execute boundary on **every** tool and strips the result to the strict `{ type: "text" | "image" }` item shape, converting a bare string into a single text item. This matters because tool results enter both the live wire context and the persisted row: any extra field an executor attaches (e.g. a `name` on a screenshot or an extracted PDF figure) would ride the wire but vanish on replay, producing a KV-cache digest divergence and a full re-prefill. Do not add fields to a tool result's `content` — put them elsewhere.

## Time Markers

`wrapToolsWithTimeMarker()` appends an elapsed-time line (`[time: HH:MM — Nm since last marker]`) to the **tail** of a tool result, before it reaches either the live wire or the persisted row, so wire and replay stay byte-identical and the KV prefix is never disturbed. Gating is `settings.timeMarkerIntervalMinutes` (0 or unset disables it). The first marker measures from turn start and later markers from the previous marker, so the model reconstructs the clock by summing deltas. The check-and-set is synchronous, so a parallel batch can never emit two markers.

## Tool Loop (`agent-loop-runner.ts`)

- `server/src/services/agent-loop-runner.ts` is the shared low-level driver around pi-ai's `agentLoop` / `agentLoopContinue`.
- `createSafeStreamFn` in `llm-stream.ts` wraps model streaming with inactivity timeout protection and LLM activity tracking.
- The HTTP chat route owns SSE, persistence, memory extraction, compaction, and pending `ask_user` behavior through callbacks around the shared runner.
- Headless system-chat, wake, and custom automation turns use `runHeadlessChatTurn()` in `chat-turn-runner.ts`, which adapts the same runner to `SynthesisEmitter` events and persisted system-chat rows.
- Tool iterations tracked via `turn_end` events from the agent loop
- See the sequential-execution note above for how batches are serialized.
- Each `turn_end` with `stopReason === "toolUse"` is persisted immediately as a canonical assistant row containing only that iteration's tool calls/results. Rows in the same visible assistant response share `_toolLoopId`; tool-use rows have `_toolLoopFragment: true`.
- The route emits `message_complete` with `continues: true` after a persisted tool-use row so the client can finalize that raw row and create the next live assistant placeholder without showing multiple bubbles.
- **Mid-turn overflow detection**: At each `turn_end` with `stopReason === "toolUse"`, checks if token usage > 85% of context. If so, aborts the agent loop and enters compaction cycle.
- **Multi-cycle compaction** (up to 5): Archives overflow, compacts, injects handoff message (progress summary + tool call log), resumes via `agentLoopContinue`. Each cycle strips all trailing assistant messages before resume.
- **MAX_ITERATIONS**: the HTTP chat route uses a 500-iteration guard; headless automation tasks use each task's `maxIterations` (agent-created reminders default to 20, range 1–100). System-chat turns are bounded a second time: `MAX_ITERATIONS_PER_PHASE = 12` per synthesis phase, with a distinct per-segment stop reason, both enforced by `evaluateTurnGuards()` in `context-pressure.ts`.
- `ask_user` is intercepted — sends SSE `ask_user` event and breaks the loop.
- SSE events during loop: `text_delta`, `thinking_delta`, `tool_status` (running/done/error), `segment`, `artifact`, `ask_user`, `iteration`, `message_complete`, `compaction`.

## Message Reconstruction (`server/src/services/agent.ts`, `chatMessagesToPiMessages()`)

- Canonical persisted rows already mirror pi-ai's live transcript. A `_toolLoopFragment` row with `toolCalls` reconstructs to `AssistantMessage(stopReason:"toolUse")` with its thinking/text/tool calls, followed by that row's `ToolResultMessage[]`. The final assistant row in the same `_toolLoopId` group reconstructs as a normal `AssistantMessage(stopReason:"stop")`.
- Legacy collapsed rows are still supported. A single older `ChatMessage` with `toolCalls` + `toolResults` + final `content` reconstructs as: `AssistantMessage(stopReason:"toolUse")` → `ToolResultMessage[]` → `AssistantMessage(stopReason:"stop")`.
- This shape is critical for KV cache behavior. The follow-up prompt must be byte-compatible with the live tool loop transcript the model previously saw; flattening all tool calls into one assistant row changes the prompt at the first assistant token after the user message and destroys longest-common-prefix reuse.
- For llama.cpp (OpenAI-compat provider): assistant messages include `reasoning_content` for thinking replay; tool results use `tool_call_id` format instead of the native `tool_name` field.
