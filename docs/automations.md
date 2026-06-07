# Automations

Automations are configurable recurring system-chat tasks. They replace the older hard-coded synthesis and wake scheduler with editable tasks, run history, ordering, schedules, and optional push notifications.

## Built-In Tasks

`ensureAutomationDefaults()` creates or repairs built-ins once during server startup:

- **Daily Synthesis** (`builtin:synthesis`) — enabled by default, runs every 24 hours when idle, uses the persistent `system` chat, and executes the multi-phase synthesis prompts.
- **Wake Cycle** (`builtin:wake`) — follows `wakeCycleEnabled` / `wakeCycleIntervalHours`, runs only during sleep mode, uses the persistent `system` chat.

Built-ins can be disabled, reordered, rescheduled, and have their prompt steps edited. They cannot be deleted. The UI exposes a reset action to restore their default prompts.

## Custom Tasks

Custom automations are user-created tasks with:

- `title`
- `schedule`: `interval` (`everyMinutes`) or `daily` (`timeOfDay`, local server time)
- `activationPolicy`: `idle`, `sleep_only`, or `manual_only`
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

## Scheduler

`startScheduler()` starts `startAutomationScheduler()` from `automation-scheduler.ts`. The automation scheduler:

- runs an initial check after 30 seconds
- checks every 5 minutes
- loads enabled tasks ordered by `orderIndex`
- starts at most one due task per tick
- skips while another automation, synthesis, wake cycle, or user chat is active
- honors `manual_only` and `sleep_only` activation policies
- skips synthesis if there are no memories or the sleep-mode cooldown is active

The legacy `checkAndRunSynthesis()` / wake helper functions still exist in `scheduler.ts`, but startup scheduling is owned by `automation-scheduler.ts`.

## Execution Model

`runAutomationTask()` records an `automation_runs` row, acquires the global automation lock, executes the task, optionally sends a push notification, updates run status, and releases the lock in `finally`.

Execution paths:

- Built-in synthesis calls `runSystemSynthesis()` with automation metadata.
- Built-in wake calls `runWakeCycle()` with automation metadata.
- Custom prompt tasks call `runHeadlessChatTurn()` through `automation-runner.ts`.

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

## UI And API

The Settings modal has an **Automations** section for enabling tasks, editing schedules and prompts, changing order, running a task manually, toggling push notifications, and viewing run history.

API endpoints are mounted at `/api/automations`; see [api-reference.md](api-reference.md).
