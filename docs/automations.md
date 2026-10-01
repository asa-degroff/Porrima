# Automations

Automations are configurable recurring system-chat tasks. They replace the older hard-coded synthesis and wake scheduler with editable tasks, run history, ordering, schedules, and optional push notifications.

## Built-In Tasks

`ensureAutomationDefaults()` creates or repairs built-ins once during server startup:

- **Daily Synthesis** (`builtin:synthesis`) — enabled by default, with an `absent` activation policy (it runs when the user has been *away*, not merely idle). Its schedule comes from `settings.synthesisScheduleType`: an `interval` of 1440 minutes by default, or a `daily` wall-clock time from `synthesisScheduleTimeOfDay` (default `03:00`). Limits are `maxIterations: 30` and `timeoutMs: 90 min`. Uses the persistent `system` chat and executes the multi-phase synthesis prompts.
- **Wake Cycle** (`builtin:wake`) — follows `wakeCycleEnabled` (default **false** — the wake cycle ships disabled) / `wakeCycleIntervalHours`, also uses the `absent` activation policy, and is bounded by `maxIterations: 20` and `timeoutMs: 60 min`. An existing 30-minute timeout is auto-migrated up to 60 minutes. Uses the persistent `system` chat.

Built-ins can be disabled, reordered, rescheduled, and have their prompt steps edited. They cannot be deleted. The UI exposes a reset action to restore their default prompts.

## Custom Tasks

Custom automations are user-created tasks with:

- `title`
- `schedule`: `interval` (`everyMinutes`), `daily` (`timeOfDay`, local server time), or `once` (`runAt`)
- `activationPolicy`: `idle`, `absent`, or `manual_only`
- optional `absentWindow`: `{ start, end }` as `HH:mm` local server time — when set with the `absent` policy, the inactivity threshold only counts during this daily window (supports midnight-crossing like `22:00`–`07:00`; empty or equal bounds mean unrestricted). A manual sleep release always bypasses the window.
- ordered `promptSteps`
- `promptDispatchMode`: `sequence`, `random`, or `cycle`
- optional push notifications
- `maxIterations` and `timeoutMs`

Each custom task uses a system chat, defaulting to `automation:<task-id>`, so its history, tool calls, compaction summaries, and results are auditable like any other chat.

Prompt dispatch modes:

- `sequence` preserves the original behavior: every prompt step is sent during one automation run.
- `random` sends one random non-empty prompt step at the start of the run.
- `cycle` sends one non-empty prompt step per run and advances `nextPromptStepId` under the automation lock, so manual and scheduled runs share the same cursor.

Synthesis automations always use `sequence` because their prompt steps are phases. Wake and custom automations can use any dispatch mode.

## Reminders (In-Chat Routing)

The `schedule_reminder` tool creates a once-task (kind `custom`, `createdBy: "agent"`) that fires as a full agent turn **in the destination chat**, not always in the system chat:

- **Default destination is the calling chat** — the tool captures the current chat id from its execution context and stores it in `automation_tasks.chatId`. The fired turn runs with that chat's full history, memory augmentation, project context, and agent toolset (so a fired reminder can schedule the next follow-up — watch loops stay anchored to the thread they were born in).
- **Explicit destination** via `targetChat` (chat id or unique title fragment), resolved with the same rules as cross-chat posts: agent and system chats only. The system chat remains available as an explicit target for housekeeping watches that belong to no single thread.
- **Quick chats are not targets.** An explicit quick-chat target is rejected; a reminder scheduled from inside a quick chat falls back to the system chat and says so in the tool result.
- **Fire-time dispatch** (`resolveInChatReminderDispatch` in `automation-runner.ts`): a live agent/system target runs `runPromptAutomation` with the wake-shaped options — the target's `chatType`, `preserveChatModel` (the chat's own model wins, the row is never rewritten), `skipTitleRefresh`, `requireExistingChat`, `enableMemoryRetrieval`. A target that no longer exists (or is a quick chat) reroutes to the system chat through a **cloned** task — the task row keeps its declared target, the run row records where the turn actually landed, and nothing is resurrected (the system chat is the only chat `ensureAutomationChat` may create).
- **The trigger row is the visible message.** In-chat reminders persist their trigger row with the bare reminder prompt as content plus `_reminder` metadata (`taskId`, `runId`, `title`, `firedAt`). The UI renders it as a `ReminderCard` (amber envelope, title + fire stamp + prompt); like cross-chat posts, the row is excluded from edit/retry (editing would truncate the thread after the row) and from TTS auto-read. The row keeps the standard automation flags (`_isSystemMessage`, `_isAutomationMessage`) so extraction filtering and replay behave as they do for system-chat reminders, and it carries a frozen `timeAnchor`.
- **Firing semantics are unchanged by the destination.** The scheduler's global gates (active chats, busy turn gate, 2-minute idle grace) and the single global turn slot apply exactly as before — an in-chat reminder never interleaves a live turn. The headless stream is keyed to the destination chat, so an open pane watches the fired turn live.
- **Side effects on the destination chat:** the pre-send `truncateBeforeSend()` and end-of-turn compaction check run there, the same as for a user turn. New rows are picked up by delayed memory extraction like any other chat activity.
- **Backward compatible by construction:** existing reminders (and any caller omitting `chatId`) have `chatId: "system"` and take the legacy path byte-for-byte. Rescheduling via `update_automation` never changes the destination.

## Scheduler

`startScheduler()` starts `startAutomationScheduler()` from `automation-scheduler.ts`. The automation scheduler:

- runs an initial check after 30 seconds
- checks every 5 minutes
- loads enabled tasks ordered by `orderIndex`
- starts at most one due task per tick
- skips while another automation, synthesis, wake cycle, or user chat is active
- skips while the **turn gate** is busy (a turn is queued) and while the **system pause** is active (`POST /api/system/pause`)
- requires a short idle grace after the latest chat activity, assistant completion, or foreground user interaction
- skips while cache-warm work or llama.cpp slot processing is active
- honors `manual_only` and `absent` activation policies; `manual_only` tasks are hard-skipped rather than idle-gated, and `absent` also respects the optional per-task `absentWindow` (see Custom Tasks)
- skips synthesis if there are no memories or the sleep-mode cooldown is active

The legacy `checkAndRunSynthesis()` and `checkAndRunWakeCycle()` functions in `scheduler.ts` are unreachable — they are unexported with no call sites, and their interval constants are unused. Startup scheduling is owned entirely by `automation-scheduler.ts`; these can be deleted.

## System Pause

`system-pause.ts` is a user-facing kill switch for background work, independent of the automation framework itself. It is a single piece of user intent persisted as three settings fields (`systemPauseStartedAt`, `systemPauseUntil`, `systemPauseIndefinite`).

- `pauseSystem()` accepts either an indefinite flag or a positive `durationMs` stamped to an absolute `until`; a non-positive duration is rejected
- A pause is **active** while indefinite is set, or while `until > now`
- An expired pause **lazily self-clears** on the next read, so the fields don't linger in settings
- It gates the automation scheduler entirely (before any task dispatch) and delayed extraction
- It does **not** stop a run already in flight — only new dispatch
- It is **independent of the sleep cycle**: sleep is a *condition* derived from inactivity, pause is a user *override* on top of it. A chat can be both asleep and paused, and neither module knows about the other. Both read the same `user-activity.ts` stamps

**Routes**: `GET /api/system/pause` (state plus a `pending` flag reporting whether an automation or extraction is still running), `POST /api/system/pause` (`{ indefinite }` or `{ durationMs }`), `POST /api/system/resume`.

## Execution Model

`runAutomationTask()` acquires the global turn lease (`acquireTurn(SYSTEM_CHAT_ID)`) **first**, then the automation lock, records an `automation_runs` row, executes the task, optionally sends a push notification, updates run status, and releases both in `finally`. Because the turn gate is the outer serialization point, a *manual* automation run queues behind an in-flight user turn rather than failing.

Execution paths:

- Built-in synthesis calls `runSystemSynthesis()` with automation metadata.
- Built-in wake calls `runWakeCycle()` with automation metadata.
- Custom prompt tasks call `runHeadlessChatTurn()` through `automation-runner.ts`.
- Cross-chat posts (`schedule_chat_message` tool) create a once-task with kind `crossChat`; the payload rides in `crossChatJson` (the task row can't carry it as prompt steps) and `runCrossChatPost` dispatches it. Delivery is an `appendChatMessageRow` (envelope row with `_crossChatPost` metadata, idempotent by `originTaskId`, frozen time anchor) — `wake:false` at `when:now` appends at call time; everything else appends at fire time under a wake run on the target chat (post-row-as-prompt, no trigger row, target model preserved). Targets: agent + system chats only; existence checked at call and fire time (no chat resurrection). Cap: 10 pending cross-chat tasks shared across chats, queried over future-pending OR created-in-the-last-hour.

Custom automations preserve the same KV-cache-sensitive prompt shape as system chat:

1. Append the trigger as a user-role automation message.
2. Build the stable prefix with `buildStablePrefix()`.
3. Run `truncateBeforeSend()` before model dispatch.
4. Use full system tools except `ask_user`.
5. Let `runHeadlessChatTurn()` drive the shared `runAgentLoop()` core.
6. Inject later prompt steps through `getFollowUp` after turn boundaries when the task uses `sequence`.

Prompt text is kept in user-role trigger/follow-up messages. The system prompt remains the stable prefix so editing automation prompts does not unnecessarily invalidate the system chat KV cache.

Headless automation turns also enable passive mid-turn memory recall. `runHeadlessChatTurn()` schedules recall after tool-use iterations, searches over persisted history plus the current in-memory assistant/tool activity, and injects ready recalls before a later provider call. Before a recall is applied, the runner persists the assistant boundary since the previous saved point, then stores the recall as a hidden system row while live-injecting the replay-equivalent synthetic user context. This keeps automation replay byte-compatible with the live transcript and prevents hidden memory rows from moving ahead of the assistant work that triggered them.

## Failures

Failures are recorded in `automation_runs` and increment `consecutiveFailures` on the task. Retry delay uses exponential backoff:

- built-ins: 15 minute base, capped at 6 hours
- custom tasks: 30 minute base, capped at 24 hours

Custom tasks are automatically disabled after 5 consecutive failures. A successful run clears the failure count and schedules the next normal run.

**Once-task terminal state (mark-fired-at-start).** Single-shot tasks (reminders, cross-chat posts) are marked fired at START, not completion: the `startAutomationRun` transaction sets `enabled: false, archived: true` (the lever is the enabled flag — clearing `nextRunAt` alone is counterproductive, `taskIsDue` treats a missing next run as always-due). A process death mid-run therefore cannot re-arm the task, and no path may leave an enabled task with a null `nextRunAt`. Graceful failures of once-tasks re-arm through `computeFailureRetryAt` (backoff retry; auto-disable after 5 still wins), and a startup sweep marks runs interrupted by a restart `interrupted`.

## UI And API

The Settings modal has an **Automations** section for enabling tasks, editing schedules and prompts, changing order, running a task manually, toggling push notifications, and viewing run history.

API endpoints are mounted at `/api/automations`; see [api-reference.md](api-reference.md).
