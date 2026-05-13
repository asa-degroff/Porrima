import { v4 as uuidv4 } from "uuid";
import type {
  AutomationActivationPolicy,
  AutomationKind,
  AutomationNotificationSettings,
  AutomationPromptStep,
  AutomationRun,
  AutomationRunStatus,
  AutomationSchedule,
  AutomationTask,
} from "../types.js";
import { getDb, getSettings } from "./chat-storage.js";
import {
  getDefaultSynthesisPromptSteps,
  getDefaultWakePromptSteps,
} from "./system-chat.js";

export const SYNTHESIS_AUTOMATION_ID = "builtin:synthesis";
export const WAKE_AUTOMATION_ID = "builtin:wake";

const DEFAULT_SYNTHESIS_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_WAKE_INTERVAL_MINUTES = 6 * 60;
const DEFAULT_CUSTOM_INTERVAL_MINUTES = 24 * 60;
const MAX_CUSTOM_FAILURES_BEFORE_DISABLE = 5;
let schemaReady = false;

interface AutomationTaskRow {
  id: string;
  kind: string;
  title: string;
  enabled: number;
  builtIn: number;
  orderIndex: number;
  chatId: string;
  scheduleJson: string;
  activationPolicy: string;
  promptStepsJson: string;
  notificationsJson: string;
  maxIterations: number;
  timeoutMs: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  consecutiveFailures: number | null;
  createdAt: string;
  updatedAt: string;
}

interface AutomationRunRow {
  id: string;
  taskId: string;
  status: string;
  origin: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: string | null;
  toolCallCount: number | null;
  chatId: string | null;
  assistantMessageIndex: number | null;
}

function ensureSchema(): void {
  if (schemaReady) return;

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      builtIn INTEGER NOT NULL DEFAULT 0,
      orderIndex INTEGER NOT NULL DEFAULT 0,
      chatId TEXT NOT NULL,
      scheduleJson TEXT NOT NULL,
      activationPolicy TEXT NOT NULL,
      promptStepsJson TEXT NOT NULL,
      notificationsJson TEXT NOT NULL,
      maxIterations INTEGER NOT NULL,
      timeoutMs INTEGER NOT NULL,
      lastRunAt TEXT,
      nextRunAt TEXT,
      lastStatus TEXT,
      consecutiveFailures INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      status TEXT NOT NULL,
      origin TEXT NOT NULL,
      startedAt TEXT NOT NULL,
      finishedAt TEXT,
      error TEXT,
      summary TEXT,
      toolCallCount INTEGER,
      chatId TEXT,
      assistantMessageIndex INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_automation_tasks_order ON automation_tasks(enabled, orderIndex, nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_runs(taskId, startedAt DESC);
  `);

  const taskCols = db.prepare("PRAGMA table_info(automation_tasks)").all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === "consecutiveFailures")) {
    db.exec("ALTER TABLE automation_tasks ADD COLUMN consecutiveFailures INTEGER NOT NULL DEFAULT 0");
    console.log("[automation] Added consecutiveFailures column to automation_tasks");
  }
  schemaReady = true;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clampIntervalMinutes(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 366 * 24 * 60);
}

function normalizeSchedule(
  schedule: Partial<AutomationSchedule> | undefined,
  fallbackMinutes: number,
): AutomationSchedule {
  if (schedule?.type === "daily") {
    const timeOfDay = typeof schedule.timeOfDay === "string" && /^\d{2}:\d{2}$/.test(schedule.timeOfDay)
      ? schedule.timeOfDay
      : "09:00";
    return { type: "daily", timeOfDay };
  }
  return {
    type: "interval",
    everyMinutes: clampIntervalMinutes(schedule?.everyMinutes, fallbackMinutes),
  };
}

function normalizeActivationPolicy(value: unknown, fallback: AutomationActivationPolicy): AutomationActivationPolicy {
  return value === "sleep_only" || value === "manual_only" || value === "idle" ? value : fallback;
}

function normalizeNotifications(value: Partial<AutomationNotificationSettings> | undefined): AutomationNotificationSettings {
  return {
    enabled: value?.enabled === true,
    ...(value?.titleTemplate ? { titleTemplate: String(value.titleTemplate) } : {}),
  };
}

function normalizePromptSteps(steps: unknown, fallback: AutomationPromptStep[]): AutomationPromptStep[] {
  if (!Array.isArray(steps)) return fallback;
  const normalized = steps
    .map((step, index) => {
      const s = step as Partial<AutomationPromptStep>;
      const prompt = typeof s.prompt === "string" ? s.prompt : "";
      return {
        id: typeof s.id === "string" && s.id.trim() ? s.id.trim() : `step-${index + 1}`,
        title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : `Step ${index + 1}`,
        prompt,
      };
    })
    .filter((step) => step.prompt.trim().length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function nextDailyRun(timeOfDay: string, fromMs: number): string {
  const [h, m] = timeOfDay.split(":").map((v) => Number(v));
  const next = new Date(fromMs);
  next.setHours(Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0, 0, 0);
  if (next.getTime() <= fromMs) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

export function computeNextRunAt(task: Pick<AutomationTask, "schedule">, fromMs = Date.now()): string {
  if (task.schedule.type === "daily") {
    return nextDailyRun(task.schedule.timeOfDay || "09:00", fromMs);
  }
  const minutes = clampIntervalMinutes(task.schedule.everyMinutes, DEFAULT_CUSTOM_INTERVAL_MINUTES);
  return new Date(fromMs + minutes * 60 * 1000).toISOString();
}

function computeFailureRetryAt(task: AutomationTask, consecutiveFailures: number, fromMs = Date.now()): string {
  const baseMinutes = task.builtIn ? 15 : 30;
  const capMinutes = task.builtIn ? 6 * 60 : 24 * 60;
  const multiplier = Math.pow(2, Math.max(0, consecutiveFailures - 1));
  const delayMinutes = Math.min(baseMinutes * multiplier, capMinutes);
  return new Date(fromMs + delayMinutes * 60 * 1000).toISOString();
}

function taskFromRow(row: AutomationTaskRow): AutomationTask {
  return {
    id: row.id,
    kind: row.kind as AutomationKind,
    title: row.title,
    enabled: row.enabled === 1,
    builtIn: row.builtIn === 1,
    orderIndex: row.orderIndex,
    chatId: row.chatId,
    schedule: parseJson<AutomationSchedule>(row.scheduleJson, {
      type: "interval",
      everyMinutes: DEFAULT_CUSTOM_INTERVAL_MINUTES,
    }),
    activationPolicy: normalizeActivationPolicy(row.activationPolicy, "idle"),
    promptSteps: parseJson<AutomationPromptStep[]>(row.promptStepsJson, []),
    notifications: parseJson<AutomationNotificationSettings>(row.notificationsJson, { enabled: false }),
    maxIterations: row.maxIterations,
    timeoutMs: row.timeoutMs,
    ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
    ...(row.nextRunAt ? { nextRunAt: row.nextRunAt } : {}),
    ...(row.lastStatus ? { lastStatus: row.lastStatus as AutomationRunStatus } : {}),
    consecutiveFailures: row.consecutiveFailures ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runFromRow(row: AutomationRunRow): AutomationRun {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status as AutomationRunStatus,
    origin: row.origin as AutomationRun["origin"],
    startedAt: row.startedAt,
    ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.toolCallCount !== null ? { toolCallCount: row.toolCallCount } : {}),
    ...(row.chatId ? { chatId: row.chatId } : {}),
    ...(row.assistantMessageIndex !== null ? { assistantMessageIndex: row.assistantMessageIndex } : {}),
  };
}

function insertTask(task: AutomationTask): void {
  ensureSchema();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO automation_tasks (
        id, kind, title, enabled, builtIn, orderIndex, chatId, scheduleJson,
        activationPolicy, promptStepsJson, notificationsJson, maxIterations,
        timeoutMs, lastRunAt, nextRunAt, lastStatus, consecutiveFailures, createdAt, updatedAt
      ) VALUES (
        @id, @kind, @title, @enabled, @builtIn, @orderIndex, @chatId, @scheduleJson,
        @activationPolicy, @promptStepsJson, @notificationsJson, @maxIterations,
        @timeoutMs, @lastRunAt, @nextRunAt, @lastStatus, @consecutiveFailures, @createdAt, @updatedAt
      )`,
    )
    .run({
      id: task.id,
      kind: task.kind,
      title: task.title,
      enabled: task.enabled ? 1 : 0,
      builtIn: task.builtIn ? 1 : 0,
      orderIndex: task.orderIndex,
      chatId: task.chatId,
      scheduleJson: JSON.stringify(task.schedule),
      activationPolicy: task.activationPolicy,
      promptStepsJson: JSON.stringify(task.promptSteps),
      notificationsJson: JSON.stringify(task.notifications),
      maxIterations: task.maxIterations,
      timeoutMs: task.timeoutMs,
      lastRunAt: task.lastRunAt ?? null,
      nextRunAt: task.nextRunAt ?? null,
      lastStatus: task.lastStatus ?? null,
      consecutiveFailures: task.consecutiveFailures ?? 0,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
}

function makeBuiltinTask(params: {
  id: string;
  kind: AutomationKind;
  title: string;
  enabled: boolean;
  orderIndex: number;
  chatId: string;
  schedule: AutomationSchedule;
  activationPolicy: AutomationActivationPolicy;
  promptSteps: AutomationPromptStep[];
  maxIterations: number;
  timeoutMs: number;
  lastRunAt?: string | null;
}): AutomationTask {
  const now = new Date().toISOString();
  const lastRunAt = params.lastRunAt ?? undefined;
  const nextRunAt = lastRunAt
    ? computeNextRunAt({ schedule: params.schedule }, new Date(lastRunAt).getTime())
    : now;
  return {
    id: params.id,
    kind: params.kind,
    title: params.title,
    enabled: params.enabled,
    builtIn: true,
    orderIndex: params.orderIndex,
    chatId: params.chatId,
    schedule: params.schedule,
    activationPolicy: params.activationPolicy,
    promptSteps: params.promptSteps,
    notifications: { enabled: false },
    maxIterations: params.maxIterations,
    timeoutMs: params.timeoutMs,
    consecutiveFailures: 0,
    ...(lastRunAt ? { lastRunAt } : {}),
    nextRunAt,
    createdAt: now,
    updatedAt: now,
  };
}

export async function ensureAutomationDefaults(): Promise<void> {
  ensureSchema();
  const { getLastSynthesis, getLastWakeCycleAt } = await import("./memory-storage.js");
  const settings = await getSettings();
  const lastSynthesis = await getLastSynthesis();
  const lastWake = await getLastWakeCycleAt();
  const wakeMinutes = clampIntervalMinutes(
    (settings.wakeCycleIntervalHours ?? 6) * 60,
    DEFAULT_WAKE_INTERVAL_MINUTES,
  );

  const defaults = [
    makeBuiltinTask({
      id: SYNTHESIS_AUTOMATION_ID,
      kind: "synthesis",
      title: "Daily Synthesis",
      enabled: true,
      orderIndex: 0,
      chatId: "system",
      schedule: normalizeSchedule({ type: "interval", everyMinutes: DEFAULT_SYNTHESIS_INTERVAL_MINUTES }, DEFAULT_SYNTHESIS_INTERVAL_MINUTES),
      activationPolicy: "sleep_only",
      promptSteps: getDefaultSynthesisPromptSteps(),
      maxIterations: 30,
      timeoutMs: 90 * 60 * 1000,
      lastRunAt: lastSynthesis,
    }),
    makeBuiltinTask({
      id: WAKE_AUTOMATION_ID,
      kind: "wake",
      title: "Wake Cycle",
      enabled: settings.wakeCycleEnabled ?? false,
      orderIndex: 10,
      chatId: "system",
      schedule: normalizeSchedule({ type: "interval", everyMinutes: wakeMinutes }, DEFAULT_WAKE_INTERVAL_MINUTES),
      activationPolicy: "sleep_only",
      promptSteps: getDefaultWakePromptSteps(),
      maxIterations: 20,
      timeoutMs: 30 * 60 * 1000,
      lastRunAt: lastWake,
    }),
  ];

  for (const fallback of defaults) {
    const existing = getAutomationTask(fallback.id);
    if (!existing) {
      insertTask(fallback);
      continue;
    }

    const patched: AutomationTask = {
      ...existing,
      builtIn: true,
      kind: fallback.kind,
      chatId: existing.chatId || fallback.chatId,
      promptSteps: existing.promptSteps.length > 0 ? existing.promptSteps : fallback.promptSteps,
      schedule: existing.schedule ?? fallback.schedule,
      // Migrate: built-in synthesis task changed from "idle" to "sleep_only"
      // so it respects the sleep cycle (requires inactivity before starting).
      // The ?? operator won't override an existing truthy value, so we
      // force-migrate the synthesis task specifically.
      activationPolicy: fallback.id === SYNTHESIS_AUTOMATION_ID && existing.activationPolicy === "idle"
        ? "sleep_only"
        : (existing.activationPolicy ?? fallback.activationPolicy),
      maxIterations: existing.maxIterations || fallback.maxIterations,
      timeoutMs: existing.timeoutMs || fallback.timeoutMs,
      updatedAt: new Date().toISOString(),
    };
    insertTask(patched);
  }
}

export function getAutomationTask(id: string): AutomationTask | null {
  ensureSchema();
  const row = getDb()
    .prepare("SELECT * FROM automation_tasks WHERE id = ?")
    .get(id) as AutomationTaskRow | undefined;
  return row ? taskFromRow(row) : null;
}

export function listAutomationTasks(): AutomationTask[] {
  ensureSchema();
  const rows = getDb()
    .prepare("SELECT * FROM automation_tasks ORDER BY orderIndex ASC, createdAt ASC")
    .all() as AutomationTaskRow[];
  return rows.map(taskFromRow);
}

export function listEnabledAutomationTasks(): AutomationTask[] {
  ensureSchema();
  const rows = getDb()
    .prepare("SELECT * FROM automation_tasks WHERE enabled = 1 ORDER BY orderIndex ASC, createdAt ASC")
    .all() as AutomationTaskRow[];
  return rows.map(taskFromRow);
}

export function createCustomAutomationTask(input: Partial<AutomationTask>): AutomationTask {
  ensureSchema();
  const now = new Date().toISOString();
  const id = input.id && !input.builtIn ? input.id : `auto-${uuidv4()}`;
  const orderRow = getDb()
    .prepare("SELECT COALESCE(MAX(orderIndex), 0) as maxOrder FROM automation_tasks")
    .get() as { maxOrder: number };
  const schedule = normalizeSchedule(input.schedule, DEFAULT_CUSTOM_INTERVAL_MINUTES);
  const task: AutomationTask = {
    id,
    kind: "custom",
    title: input.title?.trim() || "Custom Automation",
    enabled: input.enabled ?? true,
    builtIn: false,
    orderIndex: input.orderIndex ?? orderRow.maxOrder + 10,
    chatId: input.chatId || `automation:${id}`,
    schedule,
    activationPolicy: normalizeActivationPolicy(input.activationPolicy, "idle"),
    promptSteps: normalizePromptSteps(input.promptSteps, [
      { id: "step-1", title: "Prompt", prompt: "Describe what you want this automation to do." },
    ]),
    notifications: normalizeNotifications(input.notifications),
    maxIterations: input.maxIterations ?? 20,
    timeoutMs: input.timeoutMs ?? 30 * 60 * 1000,
    consecutiveFailures: 0,
    nextRunAt: computeNextRunAt({ schedule }),
    createdAt: now,
    updatedAt: now,
  };
  insertTask(task);
  return task;
}

export function updateAutomationTask(id: string, patch: Partial<AutomationTask>): AutomationTask | null {
  const existing = getAutomationTask(id);
  if (!existing) return null;
  const fallbackMinutes =
    existing.kind === "synthesis"
      ? DEFAULT_SYNTHESIS_INTERVAL_MINUTES
      : existing.kind === "wake"
        ? DEFAULT_WAKE_INTERVAL_MINUTES
        : DEFAULT_CUSTOM_INTERVAL_MINUTES;
  const schedule = patch.schedule
    ? normalizeSchedule(patch.schedule, fallbackMinutes)
    : existing.schedule;
  const updated: AutomationTask = {
    ...existing,
    ...patch,
    id: existing.id,
    kind: existing.builtIn ? existing.kind : patch.kind ?? existing.kind,
    builtIn: existing.builtIn,
    title: patch.title?.trim() || existing.title,
    chatId: existing.builtIn ? existing.chatId : patch.chatId || existing.chatId,
    schedule,
    activationPolicy: normalizeActivationPolicy(patch.activationPolicy, existing.activationPolicy),
    promptSteps: patch.promptSteps ? normalizePromptSteps(patch.promptSteps, existing.promptSteps) : existing.promptSteps,
    notifications: patch.notifications ? normalizeNotifications(patch.notifications) : existing.notifications,
    maxIterations: Math.max(1, Math.floor(Number(patch.maxIterations ?? existing.maxIterations))),
    timeoutMs: Math.max(60_000, Math.floor(Number(patch.timeoutMs ?? existing.timeoutMs))),
    consecutiveFailures: existing.consecutiveFailures ?? 0,
    updatedAt: new Date().toISOString(),
  };
  if (patch.schedule || patch.enabled !== undefined) {
    updated.nextRunAt = updated.enabled
      ? computeNextRunAt(updated, updated.lastRunAt ? new Date(updated.lastRunAt).getTime() : Date.now())
      : undefined;
  }
  insertTask(updated);
  return updated;
}

export function deleteAutomationTask(id: string): boolean {
  const task = getAutomationTask(id);
  if (!task || task.builtIn) return false;
  const result = getDb().prepare("DELETE FROM automation_tasks WHERE id = ?").run(id);
  return result.changes > 0;
}

export function resetBuiltinAutomationPrompts(id: string): AutomationTask | null {
  const task = getAutomationTask(id);
  if (!task?.builtIn) return null;
  const promptSteps =
    task.kind === "synthesis"
      ? getDefaultSynthesisPromptSteps()
      : task.kind === "wake"
        ? getDefaultWakePromptSteps()
        : task.promptSteps;
  return updateAutomationTask(id, { promptSteps });
}

export function startAutomationRun(taskId: string, origin: AutomationRun["origin"]): AutomationRun {
  ensureSchema();
  const run: AutomationRun = {
    id: uuidv4(),
    taskId,
    status: "running",
    origin,
    startedAt: new Date().toISOString(),
  };
  getDb()
    .prepare(
      `INSERT INTO automation_runs (id, taskId, status, origin, startedAt)
       VALUES (@id, @taskId, @status, @origin, @startedAt)`,
    )
    .run(run);
  return run;
}

export function finishAutomationRun(
  runId: string,
  status: AutomationRunStatus,
  details: Partial<AutomationRun> = {},
): AutomationRun | null {
  ensureSchema();
  const finishedAt = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE automation_runs
       SET status = @status,
           finishedAt = @finishedAt,
           error = @error,
           summary = @summary,
           toolCallCount = @toolCallCount,
           chatId = @chatId,
           assistantMessageIndex = @assistantMessageIndex
       WHERE id = @id`,
    )
    .run({
      id: runId,
      status,
      finishedAt,
      error: details.error ?? null,
      summary: details.summary ?? null,
      toolCallCount: details.toolCallCount ?? null,
      chatId: details.chatId ?? null,
      assistantMessageIndex: details.assistantMessageIndex ?? null,
    });

  const run = getAutomationRun(runId);
  if (run) {
    const task = getAutomationTask(run.taskId);
    if (task) {
      const isSuccess = status === "success";
      const isFailure = status === "failed";
      const consecutiveFailures = isSuccess
        ? 0
        : isFailure
          ? (task.consecutiveFailures ?? 0) + 1
          : task.consecutiveFailures ?? 0;
      const shouldDisable =
        isFailure && !task.builtIn && consecutiveFailures >= MAX_CUSTOM_FAILURES_BEFORE_DISABLE;
      insertTask({
        ...task,
        enabled: shouldDisable ? false : task.enabled,
        lastRunAt: isSuccess ? finishedAt : task.lastRunAt,
        nextRunAt: shouldDisable
          ? undefined
          : isSuccess
            ? computeNextRunAt(task, Date.now())
            : isFailure
              ? computeFailureRetryAt(task, consecutiveFailures)
              : task.nextRunAt,
        lastStatus: status,
        consecutiveFailures,
        updatedAt: finishedAt,
      });
      if (shouldDisable) {
        console.warn(
          `[automation] Disabled ${task.id} after ${consecutiveFailures} consecutive failures`,
        );
      }
    }
  }
  return run;
}

export function getAutomationRun(id: string): AutomationRun | null {
  ensureSchema();
  const row = getDb()
    .prepare("SELECT * FROM automation_runs WHERE id = ?")
    .get(id) as AutomationRunRow | undefined;
  return row ? runFromRow(row) : null;
}

export function listAutomationRuns(taskId?: string, limit = 50): AutomationRun[] {
  ensureSchema();
  const capped = Math.min(Math.max(Math.floor(limit), 1), 200);
  const rows = taskId
    ? (getDb()
        .prepare("SELECT * FROM automation_runs WHERE taskId = ? ORDER BY startedAt DESC LIMIT ?")
        .all(taskId, capped) as AutomationRunRow[])
    : (getDb()
        .prepare("SELECT * FROM automation_runs ORDER BY startedAt DESC LIMIT ?")
        .all(capped) as AutomationRunRow[]);
  return rows.map(runFromRow);
}
