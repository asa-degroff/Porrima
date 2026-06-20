import { v4 as uuidv4 } from "uuid";
import type {
  AutomationActivationPolicy,
  AutomationKind,
  AutomationNotificationSettings,
  AutomationPromptDispatchMode,
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
const DEFAULT_MAX_PENDING_AGENT_REMINDERS = 10;
let schemaReady = false;

function fallbackMinutesForKind(kind: AutomationKind): number {
  if (kind === "wake") return DEFAULT_WAKE_INTERVAL_MINUTES;
  if (kind === "synthesis") return DEFAULT_SYNTHESIS_INTERVAL_MINUTES;
  return DEFAULT_CUSTOM_INTERVAL_MINUTES;
}

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
  promptDispatchMode: string | null;
  nextPromptStepId: string | null;
  notificationsJson: string;
  maxIterations: number;
  timeoutMs: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  consecutiveFailures: number | null;
  createdBy: string | null;
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
  selectedPromptStepIdsJson: string | null;
  selectedPromptStepTitlesJson: string | null;
  chatId: string | null;
  assistantMessageIndex: number | null;
  triggerMessageInserted: number | null;
  triggerMessageIndex: number | null;
  promptTokenEstimate: number | null;
  timeoutMs: number | null;
  stopReason: string | null;
  timedOut: number | null;
  timeoutReason: string | null;
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
      promptDispatchMode TEXT NOT NULL DEFAULT 'sequence',
      nextPromptStepId TEXT,
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
      selectedPromptStepIdsJson TEXT,
      selectedPromptStepTitlesJson TEXT,
      chatId TEXT,
      assistantMessageIndex INTEGER,
      triggerMessageInserted INTEGER,
      triggerMessageIndex INTEGER,
      promptTokenEstimate INTEGER,
      timeoutMs INTEGER,
      stopReason TEXT,
      timedOut INTEGER NOT NULL DEFAULT 0,
      timeoutReason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_automation_tasks_order ON automation_tasks(enabled, orderIndex, nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_task ON automation_runs(taskId, startedAt DESC);
  `);

  const taskCols = db.prepare("PRAGMA table_info(automation_tasks)").all() as Array<{ name: string }>;
  if (!taskCols.some((c) => c.name === "consecutiveFailures")) {
    db.exec("ALTER TABLE automation_tasks ADD COLUMN consecutiveFailures INTEGER NOT NULL DEFAULT 0");
    console.log("[automation] Added consecutiveFailures column to automation_tasks");
  }
  if (!taskCols.some((c) => c.name === "promptDispatchMode")) {
    db.exec("ALTER TABLE automation_tasks ADD COLUMN promptDispatchMode TEXT NOT NULL DEFAULT 'sequence'");
    console.log("[automation] Added promptDispatchMode column to automation_tasks");
  }
  if (!taskCols.some((c) => c.name === "nextPromptStepId")) {
    db.exec("ALTER TABLE automation_tasks ADD COLUMN nextPromptStepId TEXT");
    console.log("[automation] Added nextPromptStepId column to automation_tasks");
  }
  if (!taskCols.some((c) => c.name === "createdBy")) {
    db.exec("ALTER TABLE automation_tasks ADD COLUMN createdBy TEXT NOT NULL DEFAULT 'user'");
    console.log("[automation] Added createdBy column to automation_tasks");
  }

  const runCols = db.prepare("PRAGMA table_info(automation_runs)").all() as Array<{ name: string }>;
  if (!runCols.some((c) => c.name === "selectedPromptStepIdsJson")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN selectedPromptStepIdsJson TEXT");
    console.log("[automation] Added selectedPromptStepIdsJson column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "selectedPromptStepTitlesJson")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN selectedPromptStepTitlesJson TEXT");
    console.log("[automation] Added selectedPromptStepTitlesJson column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "triggerMessageInserted")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN triggerMessageInserted INTEGER");
    console.log("[automation] Added triggerMessageInserted column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "triggerMessageIndex")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN triggerMessageIndex INTEGER");
    console.log("[automation] Added triggerMessageIndex column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "promptTokenEstimate")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN promptTokenEstimate INTEGER");
    console.log("[automation] Added promptTokenEstimate column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "timeoutMs")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN timeoutMs INTEGER");
    console.log("[automation] Added timeoutMs column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "stopReason")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN stopReason TEXT");
    console.log("[automation] Added stopReason column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "timedOut")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN timedOut INTEGER NOT NULL DEFAULT 0");
    console.log("[automation] Added timedOut column to automation_runs");
  }
  if (!runCols.some((c) => c.name === "timeoutReason")) {
    db.exec("ALTER TABLE automation_runs ADD COLUMN timeoutReason TEXT");
    console.log("[automation] Added timeoutReason column to automation_runs");
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
  if (schedule?.type === "once") {
    const runAt = typeof schedule.runAt === "string" && schedule.runAt.trim()
      ? schedule.runAt.trim()
      : null;
    if (runAt) {
      const parsed = new Date(runAt).getTime();
      if (Number.isFinite(parsed)) {
        return { type: "once", runAt: new Date(parsed).toISOString() };
      }
    }
    // Invalid once schedule falls through to interval
  }
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
  // Migrate: "sleep_only" → "absent" (backward compat)
  if (value === "sleep_only") return "absent";
  return value === "absent" || value === "manual_only" || value === "idle" ? value as AutomationActivationPolicy : fallback;
}

function normalizePromptDispatchMode(
  value: unknown,
  kind: AutomationKind,
  fallback: AutomationPromptDispatchMode,
): AutomationPromptDispatchMode {
  if (kind === "synthesis") return "sequence";
  return value === "random" || value === "cycle" || value === "sequence" ? value : fallback;
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

function normalizeNextPromptStepId(
  value: unknown,
  steps: AutomationPromptStep[],
  mode: AutomationPromptDispatchMode,
): string | undefined {
  if (mode !== "cycle") return undefined;
  const ids = steps.map((step) => step.id);
  if (typeof value === "string" && ids.includes(value)) return value;
  return ids[0];
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
  if (task.schedule.type === "once") {
    return task.schedule.runAt!;
  }
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
    promptDispatchMode: normalizePromptDispatchMode(row.promptDispatchMode, row.kind as AutomationKind, "sequence"),
    nextPromptStepId: normalizeNextPromptStepId(
      row.nextPromptStepId,
      parseJson<AutomationPromptStep[]>(row.promptStepsJson, []),
      normalizePromptDispatchMode(row.promptDispatchMode, row.kind as AutomationKind, "sequence"),
    ),
    notifications: parseJson<AutomationNotificationSettings>(row.notificationsJson, { enabled: false }),
    maxIterations: row.maxIterations,
    timeoutMs: row.timeoutMs,
    ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
    ...(row.nextRunAt ? { nextRunAt: row.nextRunAt } : {}),
    ...(row.lastStatus ? { lastStatus: row.lastStatus as AutomationRunStatus } : {}),
    consecutiveFailures: row.consecutiveFailures ?? 0,
    ...(row.createdBy && (row.createdBy === "agent" || row.createdBy === "user") ? { createdBy: row.createdBy as "agent" | "user" } : {}),
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
    ...(row.selectedPromptStepIdsJson
      ? { selectedPromptStepIds: parseJson<string[]>(row.selectedPromptStepIdsJson, []) }
      : {}),
    ...(row.selectedPromptStepTitlesJson
      ? { selectedPromptStepTitles: parseJson<string[]>(row.selectedPromptStepTitlesJson, []) }
      : {}),
    ...(row.chatId ? { chatId: row.chatId } : {}),
    ...(row.assistantMessageIndex !== null ? { assistantMessageIndex: row.assistantMessageIndex } : {}),
    ...(row.triggerMessageInserted !== null ? { triggerMessageInserted: row.triggerMessageInserted === 1 } : {}),
    ...(row.triggerMessageIndex !== null ? { triggerMessageIndex: row.triggerMessageIndex } : {}),
    ...(row.promptTokenEstimate !== null ? { promptTokenEstimate: row.promptTokenEstimate } : {}),
    ...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
    ...(row.stopReason ? { stopReason: row.stopReason } : {}),
    ...(row.timedOut !== null ? { timedOut: row.timedOut === 1 } : {}),
    ...(row.timeoutReason ? { timeoutReason: row.timeoutReason } : {}),
  };
}

function insertTask(task: AutomationTask): void {
  ensureSchema();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO automation_tasks (
        id, kind, title, enabled, builtIn, orderIndex, chatId, scheduleJson,
        activationPolicy, promptStepsJson, promptDispatchMode, nextPromptStepId,
        notificationsJson, maxIterations,
        timeoutMs, lastRunAt, nextRunAt, lastStatus, consecutiveFailures, createdBy, createdAt, updatedAt
      ) VALUES (
        @id, @kind, @title, @enabled, @builtIn, @orderIndex, @chatId, @scheduleJson,
        @activationPolicy, @promptStepsJson, @promptDispatchMode, @nextPromptStepId,
        @notificationsJson, @maxIterations,
        @timeoutMs, @lastRunAt, @nextRunAt, @lastStatus, @consecutiveFailures, @createdBy, @createdAt, @updatedAt
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
      promptDispatchMode: task.promptDispatchMode,
      nextPromptStepId: task.nextPromptStepId ?? null,
      notificationsJson: JSON.stringify(task.notifications),
      maxIterations: task.maxIterations,
      timeoutMs: task.timeoutMs,
      lastRunAt: task.lastRunAt ?? null,
      nextRunAt: task.nextRunAt ?? null,
      lastStatus: task.lastStatus ?? null,
      consecutiveFailures: task.consecutiveFailures ?? 0,
      createdBy: task.createdBy ?? "user",
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
  promptDispatchMode?: AutomationPromptDispatchMode;
  nextPromptStepId?: string | null;
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
    promptDispatchMode: normalizePromptDispatchMode(params.promptDispatchMode, params.kind, "sequence"),
    nextPromptStepId: normalizeNextPromptStepId(
      params.nextPromptStepId,
      params.promptSteps,
      normalizePromptDispatchMode(params.promptDispatchMode, params.kind, "sequence"),
    ),
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

  // Legacy settings only seed first-run built-ins. Existing automation rows keep
  // their stored schedules so the automation table remains the runtime source.
  const synthesisSchedule: AutomationSchedule = settings.synthesisScheduleType === "daily"
    ? normalizeSchedule({ type: "daily", timeOfDay: settings.synthesisScheduleTimeOfDay || "03:00" }, DEFAULT_SYNTHESIS_INTERVAL_MINUTES)
    : normalizeSchedule({ type: "interval", everyMinutes: settings.synthesisScheduleEveryMinutes ?? DEFAULT_SYNTHESIS_INTERVAL_MINUTES }, DEFAULT_SYNTHESIS_INTERVAL_MINUTES);

  const defaults = [
    makeBuiltinTask({
      id: SYNTHESIS_AUTOMATION_ID,
      kind: "synthesis",
      title: "Daily Synthesis",
      enabled: true,
      orderIndex: 0,
      chatId: "system",
      schedule: synthesisSchedule,
      activationPolicy: "absent",
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
      activationPolicy: "absent",
      promptSteps: getDefaultWakePromptSteps(),
      maxIterations: 20,
      timeoutMs: 60 * 60 * 1000,
      lastRunAt: lastWake,
    }),
  ];

  for (const fallback of defaults) {
    const existing = getAutomationTask(fallback.id);
    if (!existing) {
      insertTask(fallback);
      continue;
    }

    // Migrate activation policy: "sleep_only" → "absent" (backward compat for old data)
    const migratedPolicy = (existing.activationPolicy as string) === "sleep_only"
      ? "absent"
      : existing.activationPolicy;

    const patched: AutomationTask = {
      ...existing,
      builtIn: true,
      kind: fallback.kind,
      chatId: existing.chatId || fallback.chatId,
      promptSteps: existing.promptSteps.length > 0 ? existing.promptSteps : fallback.promptSteps,
      promptDispatchMode: normalizePromptDispatchMode(existing.promptDispatchMode, fallback.kind, fallback.promptDispatchMode),
      nextPromptStepId: normalizeNextPromptStepId(
        existing.nextPromptStepId,
        existing.promptSteps.length > 0 ? existing.promptSteps : fallback.promptSteps,
        normalizePromptDispatchMode(existing.promptDispatchMode, fallback.kind, fallback.promptDispatchMode),
      ),
      // Preserve the in-DB schedule. If stored fields are missing or invalid,
      // normalize against this built-in kind's interval default rather than
      // overwriting from legacy settings on startup.
      schedule: normalizeSchedule(existing.schedule, fallbackMinutesForKind(fallback.kind)),
      // Migrate: "idle" → "absent" (synthesis) and "sleep_only" → "absent" (all built-ins)
      activationPolicy: normalizeActivationPolicy(migratedPolicy, fallback.activationPolicy),
      maxIterations: existing.maxIterations || fallback.maxIterations,
      // Migrate: wake cycle timeout bumped from 30m → 60m for deep research
      timeoutMs: fallback.id === WAKE_AUTOMATION_ID && existing.timeoutMs <= 30 * 60 * 1000
        ? fallback.timeoutMs
        : (existing.timeoutMs || fallback.timeoutMs),
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
  const promptSteps = normalizePromptSteps(input.promptSteps, [
    { id: "step-1", title: "Prompt", prompt: "Describe what you want this automation to do." },
  ]);
  const promptDispatchMode = normalizePromptDispatchMode(input.promptDispatchMode, "custom", "sequence");
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
    promptSteps,
    promptDispatchMode,
    nextPromptStepId: normalizeNextPromptStepId(input.nextPromptStepId, promptSteps, promptDispatchMode),
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

export function createReminderTask(input: {
  message: string;
  title: string;
  scheduledAt: string;  // ISO 8601
  activationPolicy?: AutomationActivationPolicy;
  maxIterations?: number;
  timeoutMs?: number;
  maxPending?: number;
}): AutomationTask {
  ensureSchema();

  const maxPending = input.maxPending ?? DEFAULT_MAX_PENDING_AGENT_REMINDERS;

  // Check pending cap: count enabled agent-created tasks with future nextRunAt
  const pendingRow = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM automation_tasks
      WHERE createdBy = 'agent' AND enabled = 1 AND julianday(nextRunAt) > julianday('now')`)
    .get() as { cnt: number };
  if (pendingRow.cnt >= maxPending) {
    throw new Error(`Agent reminder cap reached (${maxPending} pending). Complete or delete existing reminders first.`);
  }

  // Validate scheduledAt is in the future (min 2 minutes ahead, respecting grace period)
  const runMs = new Date(input.scheduledAt).getTime();
  if (!Number.isFinite(runMs) || runMs <= Date.now() + 2 * 60 * 1000) {
    throw new Error("scheduledAt must be a valid future timestamp at least 2 minutes from now");
  }

  const now = new Date().toISOString();
  const id = `reminder-${uuidv4()}`;
  const orderRow = getDb()
    .prepare("SELECT COALESCE(MAX(orderIndex), 0) as maxOrder FROM automation_tasks")
    .get() as { maxOrder: number };
  const schedule: AutomationSchedule = { type: "once", runAt: new Date(runMs).toISOString() };
  const promptSteps: AutomationPromptStep[] = [
    { id: "step-1", title: input.title.trim(), prompt: input.message.trim() },
  ];
  const activationPolicy = normalizeActivationPolicy(input.activationPolicy, "idle");

  const task: AutomationTask = {
    id,
    kind: "custom",
    title: input.title.trim() || "Reminder",
    enabled: true,
    builtIn: false,
    orderIndex: orderRow.maxOrder + 100,  // high order so reminders sort after everything else
    chatId: "system",
    schedule,
    activationPolicy,
    promptSteps,
    promptDispatchMode: "sequence",
    notifications: { enabled: false },
    maxIterations: input.maxIterations ?? 5,
    timeoutMs: input.timeoutMs ?? 5 * 60 * 1000,
    consecutiveFailures: 0,
    createdBy: "agent",
    nextRunAt: schedule.runAt,
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
  const promptSteps = patch.promptSteps ? normalizePromptSteps(patch.promptSteps, existing.promptSteps) : existing.promptSteps;
  const promptDispatchMode = normalizePromptDispatchMode(
    patch.promptDispatchMode,
    existing.builtIn ? existing.kind : patch.kind ?? existing.kind,
    existing.promptDispatchMode,
  );
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
    promptSteps,
    promptDispatchMode,
    nextPromptStepId: normalizeNextPromptStepId(
      patch.nextPromptStepId ?? existing.nextPromptStepId,
      promptSteps,
      promptDispatchMode,
    ),
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

export function updateAutomationPromptCursor(id: string, nextPromptStepId: string | undefined): AutomationTask | null {
  const task = getAutomationTask(id);
  if (!task) return null;
  const promptDispatchMode = normalizePromptDispatchMode(task.promptDispatchMode, task.kind, "sequence");
  const normalizedNext = normalizeNextPromptStepId(nextPromptStepId, task.promptSteps, promptDispatchMode);
  const updated: AutomationTask = {
    ...task,
    nextPromptStepId: normalizedNext,
    updatedAt: new Date().toISOString(),
  };
  insertTask(updated);
  return updated;
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

export function updateAutomationRunPromptSelection(
  runId: string,
  steps: AutomationPromptStep[],
): AutomationRun | null {
  ensureSchema();
  getDb()
    .prepare(
      `UPDATE automation_runs
       SET selectedPromptStepIdsJson = @selectedPromptStepIdsJson,
           selectedPromptStepTitlesJson = @selectedPromptStepTitlesJson
       WHERE id = @id`,
    )
    .run({
      id: runId,
      selectedPromptStepIdsJson: JSON.stringify(steps.map((step) => step.id)),
      selectedPromptStepTitlesJson: JSON.stringify(steps.map((step) => step.title)),
    });
  return getAutomationRun(runId);
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
	           selectedPromptStepIdsJson = COALESCE(@selectedPromptStepIdsJson, selectedPromptStepIdsJson),
	           selectedPromptStepTitlesJson = COALESCE(@selectedPromptStepTitlesJson, selectedPromptStepTitlesJson),
	           chatId = @chatId,
	           assistantMessageIndex = @assistantMessageIndex,
	           triggerMessageInserted = @triggerMessageInserted,
	           triggerMessageIndex = @triggerMessageIndex,
	           promptTokenEstimate = @promptTokenEstimate,
	           timeoutMs = @timeoutMs,
	           stopReason = @stopReason,
	           timedOut = @timedOut,
	           timeoutReason = @timeoutReason
       WHERE id = @id`,
    )
    .run({
      id: runId,
      status,
      finishedAt,
      error: details.error ?? null,
      summary: details.summary ?? null,
      toolCallCount: details.toolCallCount ?? null,
      selectedPromptStepIdsJson: details.selectedPromptStepIds
        ? JSON.stringify(details.selectedPromptStepIds)
        : null,
      selectedPromptStepTitlesJson: details.selectedPromptStepTitles
        ? JSON.stringify(details.selectedPromptStepTitles)
        : null,
      chatId: details.chatId ?? null,
      assistantMessageIndex: details.assistantMessageIndex ?? null,
      triggerMessageInserted: details.triggerMessageInserted === undefined
        ? null
        : details.triggerMessageInserted ? 1 : 0,
      triggerMessageIndex: details.triggerMessageIndex ?? null,
      promptTokenEstimate: details.promptTokenEstimate ?? null,
      timeoutMs: details.timeoutMs ?? null,
      stopReason: details.stopReason ?? null,
      timedOut: details.timedOut ? 1 : 0,
      timeoutReason: details.timeoutReason ?? null,
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
      // Once-schedule tasks self-disable after running (success or failure)
      const isOnce = task.schedule.type === "once";
      const onceDisable = isOnce && isSuccess;
      insertTask({
        ...task,
        enabled: (shouldDisable || onceDisable) ? false : task.enabled,
        lastRunAt: isSuccess ? finishedAt : task.lastRunAt,
        nextRunAt: (shouldDisable || onceDisable)
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
      if (onceDisable) {
        console.log(`[automation] One-time task ${task.id} completed, self-disabled`);
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
