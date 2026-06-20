# Automation System Scope

## Overview

Four interlocking changes:
1. Agent-created one-time reminders (new `once` schedule type)
2. Agent visibility + editing of existing automations (new tools)
3. Activation policy rename (`sleep_only` → `absent`)
4. Synthesis daily schedule (user-configurable time of day)

---

## 1. Types (`types.ts`)

### New schedule type
```typescript
export type AutomationScheduleType = "interval" | "daily" | "once";

export interface AutomationSchedule {
  type: AutomationScheduleType;
  everyMinutes?: number;   // interval
  timeOfDay?: string;      // daily, "HH:mm"
  runAt?: string;          // once, ISO 8601
}
```

### Activation policy rename
```typescript
export type AutomationActivationPolicy = "idle" | "absent" | "manual_only";
// was: "idle" | "sleep_only" | "manual_only"
```

### Creator tracking
```typescript
// On AutomationTask:
_createdBy?: "agent" | "user";  // tracks who created the task
```

### Settings additions
```typescript
// On Settings:
synthesisScheduleType?: "interval" | "daily";  // default: "interval"
synthesisScheduleTimeOfDay?: string;           // "HH:mm", default "03:00", used when type==="daily"
synthesisScheduleEveryMinutes?: number;        // default 1440, used when type==="interval"
```

---

## 2. Server — Storage (`automation-storage.ts`)

### normalizeSchedule
Handle `once` type:
- Validate `runAt` is a valid ISO 8601 timestamp
- Validate `runAt` is in the future (reject past timestamps)
- Return `{ type: "once", runAt }`

### computeNextRunAt
Add `once` case:
```typescript
if (task.schedule.type === "once") {
  return task.schedule.runAt!;
}
```

### finishAutomationRun
After a successful run, if `schedule.type === "once"`, set `enabled = false`:
```typescript
if (isSuccess && task.schedule.type === "once") {
  next.enabled = false;
}
```

### createReminderTask
New convenience function for agent-created reminders:
```typescript
export function createReminderTask(input: {
  message: string;
  title: string;
  scheduledAt: string;  // ISO 8601
  activationPolicy?: AutomationActivationPolicy;
  maxIterations?: number;
  timeoutMs?: number;
}): AutomationTask
```
- Creates a `kind: "custom"` task
- `chatId: "system"`
- `builtIn: false`, `_createdBy: "agent"`
- `schedule: { type: "once", runAt: scheduledAt }`
- Single prompt step with the message
- Default `activationPolicy: "idle"`, `maxIterations: 5`, `timeoutMs: 5 * 60 * 1000`
- Validates against max pending cap (default 10, configurable)

### deleteAutomationTask
Allow agent-created deletions:
- Current: blocks deletion of built-in tasks
- Add: check `_createdBy === "agent"` for agent-tool path

### ensureAutomationDefaults
Update synthesis default:
- Read `settings.synthesisScheduleType` to determine schedule
- If `daily`: `{ type: "daily", timeOfDay: settings.synthesisScheduleTimeOfDay || "03:00" }`
- If `interval`: `{ type: "interval", everyMinutes: settings.synthesisScheduleEveryMinutes || 1440 }`

### Backward compat
- `normalizeActivationPolicy`: accept both `"sleep_only"` and `"absent"`, normalize to `"absent"`
- DB values remain strings; migration path is transparent

---

## 3. Server — Scheduler (`automation-scheduler.ts`)

### No structural changes needed
`taskIsDue()` works with `nextRunAt` regardless of schedule type. `shouldRunTask()` already handles `idle`/`sleep_only` (→ `absent`) policies.

### Rename
- `sleepCycleActive` call site → the function itself stays (it's in `sleep-cycle.ts`), but the variable name in the scheduler can change to `absenceThresholdMet` or similar for clarity

---

## 4. Server — Runner (`automation-runner.ts`)

### No changes needed
Custom automations (including `once` reminders) run through `runPromptAutomation` which already handles full tool execution in the system chat.

---

## 5. Server — Agent Tools (`agent-tools.ts`)

Three new tools, registered in `getAgentTools()`:

### schedule_reminder
```
Description: "Schedule a one-time reminder for yourself. Creates a message
in the system chat that fires at the specified time, respecting inactivity
gates. Use this to follow up on open threads, check on tasks, or revisit
ideas later."

Parameters:
  message: string          — the prompt content to deliver to your future self
  title: string            — short label for the reminder
  scheduledAt: string      — ISO 8601 timestamp for when to fire
  activationPolicy: enum   — "idle" (default, fires when system is idle) |
                             "absent" (waits for user absence threshold) |
                             "manual_only" (never auto-fires)
  maxIterations: number    — max tool-loop iterations (default 5)
  timeoutMs: number        — max execution time in ms (default 300000)

Returns: AutomationTask — created task with id, nextRunAt, status
```

Implementation:
- Calls `createReminderTask()`
- Validates scheduledAt is in the future (min 2 minutes from now, respecting grace period)
- Checks pending cap: count enabled agent-created tasks with `nextRunAt` in the future

### list_automations
```
Description: "List all automation tasks. Shows schedules, prompt steps,
next run times, and status. Use to see what's scheduled and when."

Parameters:
  filter: enum  — "all" (default) | "enabled" | "agent-created" | "built-in"
  includeRuns: boolean — include last run status per task (default false)

Returns: AutomationTask[] with optional last run info
```

Implementation:
- Calls `listAutomationTasks()` or `listEnabledAutomationTasks()`
- Filter by `_createdBy` for `agent-created`
- Filter by `builtIn` for `built-in`
- If `includeRuns`, joins with last entry from `listAutomationRuns(taskId, 1)`

### update_automation
```
Description: "Modify an automation task. You can edit your own reminders
freely. For user-created automations, you can only suggest changes in your
response. For built-in automations (synthesis, wake), you can edit prompt
steps but not schedule or structural fields."

Parameters:
  automationId: string    — task ID to modify
  title: string           — updated title (optional)
  promptSteps: array      — updated prompt steps (optional)
  enabled: boolean        — toggle on/off (optional, agent tasks only)
  schedule: object        — updated schedule (optional, agent tasks only)

Returns: AutomationTask | null
```

Permission matrix:
| Field | Agent reminders | User custom | Built-in |
|---|---|---|---|
| title | ✅ | ❌ | ❌ |
| promptSteps | ✅ | ❌ | ⚠️ allowed (soft boundary) |
| enabled | ✅ | ❌ | ❌ |
| schedule | ✅ | ❌ | ❌ |
| activationPolicy | ✅ | ❌ | ❌ |
| delete | ✅ (separate tool call) | ❌ | ❌ |

Implementation:
- Calls `getAutomationTask(id)` to check ownership
- For agent tasks (`_createdBy === "agent"`): pass all fields through
- For built-in tasks: only allow `promptSteps` patch
- For user custom: reject all patches, return error with guidance

---

## 6. Server — Sleep Cycle (`sleep-cycle.ts`)

### No functional changes
The function `isSleepCycleActive` computes whether the user absence threshold is met. Under the new naming, this is conceptually "is the user absent enough for automation?" — but the function name can stay for backward compat, or be aliased.

Option: add `export const isUserAbsent = isSleepCycleActive;` as an alias.

---

## 7. Server — Routes (`routes/automations.ts`)

### No structural changes needed
Existing CRUD endpoints work for `once` schedule type and `absent` policy transparently.

### Optional additions
- `GET /api/automations?createdBy=agent` — filter parameter
- `POST /api/automations/:id/run` already works for reminders

---

## 8. Client — Settings (`SettingsModal.tsx`)

### Synthesis schedule section
Currently shows sleep cycle threshold and wake cycle controls. Add synthesis scheduling:

```
Synthesis Schedule
┌─────────────────────────────────────┐
│ [○] Every 24 hours                  │
│ [●] Daily at  [03:00] time picker   │
│                                     │
│ Memory consolidation and cache      │
│ warming. Runs during inactivity.    │
└─────────────────────────────────────┘
```

- Radio: interval vs daily
- If daily: time picker (HTML `<input type="time">`)
- Saves to `settings.synthesisScheduleType` and `settings.synthesisScheduleTimeOfDay`
- On save, calls `PATCH /api/automations/builtin:synthesis` with updated schedule

### Setup Modal
The setup modal already has synthesis schedule presets. Update to:
- Default to `daily` at a sensible time (e.g. 03:00 or 09:00)
- Add a "Custom time" option for the daily schedule
- Keep interval option available

---

## 9. Client — Sidebar State Indicators

### Current
- `sleepCycleActive` — shows when the absence threshold is met
- `sleepModeActive` — shows when user clicked sleep button
- `isSynthesizing` — shown during synthesis runs

### Agent state model
Map the three states to UI:
- **sleep** — no indicator (system is at rest)
- **idle** — no indicator (system is ready, user was recently active)
- **working** — existing `isSynthesizing` or automation spinner

The sidebar sleep button pulse (from the recalled instruction) already covers "absence threshold met." This is the gateway to working state, not sleep itself — but the current naming in the UI props can stay for now since the behavior is correct even if the name isn't.

---

## 10. Migration Path

### DB migrations (in `ensureSchema()`)
```sql
-- Add _createdBy column to automation_tasks
ALTER TABLE automation_tasks ADD COLUMN createdBy TEXT NOT NULL DEFAULT 'user';
```

### Activation policy migration
- `normalizeActivationPolicy()` already handles unknown strings by falling back
- Add explicit mapping: `"sleep_only"` → `"absent"`
- Existing DB rows with `"sleep_only"` are transparently normalized on read
- On first write after upgrade, rows get `"absent"` saved

### Settings migration
- On load, if `synthesisScheduleType` is undefined:
  - Check existing synthesis automation schedule
  - If `daily`: set `synthesisScheduleType = "daily"`, extract `timeOfDay`
  - If `interval`: set `synthesisScheduleType = "interval"`, extract `everyMinutes`
  - Default fallback: `interval`, 1440 minutes

---

## 11. File-by-File Change List

| File | Change | Effort |
|---|---|---|
| `server/src/types.ts` | Add `once` schedule, `absent` policy, `_createdBy`, settings fields | Small |
| `server/src/services/automation-storage.ts` | normalize `once`, `createReminderTask`, self-disable, migration column | Medium |
| `server/src/services/automation-scheduler.ts` | Rename references, no logic changes | Small |
| `server/src/services/automation-runner.ts` | No changes | None |
| `server/src/services/agent-tools.ts` | Three new tools: `schedule_reminder`, `list_automations`, `update_automation` | Medium |
| `server/src/services/sleep-cycle.ts` | Optional alias | Small |
| `server/src/routes/automations.ts` | Optional filter param | Small |
| `client/src/components/SettingsModal.tsx` | Synthesis schedule UI | Medium |
| `client/src/components/SetupModal.tsx` | Update synthesis schedule presets | Small |
| `client/src/types.ts` | Mirror type changes | Small |
| `client/src/api/client.ts` | Add `synthesisSchedule*` fields to API types | Small |

---

## 12. Risk Assessment

### Schedule `once` self-disable
- Risk: task disabled on failure too
- Mitigation: only disable on `status === "success"`. Failed reminders stay enabled and retry next scheduler tick (5 min), giving them another shot. After `MAX_CUSTOM_FAILURES_BEFORE_DISABLE` (5), the existing auto-disable kicks in.

### Agent scheduling loops
- Risk: agent schedules reminders in a loop during a single turn
- Mitigation: pending cap (default 10). Tool returns error when cap reached.

### Built-in prompt step editing
- Risk: agent corrupts synthesis prompts
- Mitigation: user can always reset via existing `POST /:id/reset-prompts`. Also, `ensureAutomationDefaults()` patches in defaults when `promptSteps.length === 0`, providing a safety net.

### Backward compat for `sleep_only`
- Risk: client sends `sleep_only`, server rejects
- Mitigation: `normalizeActivationPolicy` maps `sleep_only` → `absent` transparently. Both values accepted on input, only `absent` stored.

### Synthesis schedule drift
- Risk: switching from interval to daily changes when synthesis runs
- Mitigation: user-controlled. The setting is explicit. Existing interval behavior preserved until user changes it.
