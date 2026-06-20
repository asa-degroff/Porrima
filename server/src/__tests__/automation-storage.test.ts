import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAutomationStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/automation-storage.js");
}

async function closeStorage() {
  const chatStorage = await import("../services/chat-storage.js");
  chatStorage.closeChatDb();
}

afterEach(async () => {
  await closeStorage().catch(() => {});
  vi.doUnmock("os");
  vi.resetModules();
});

describe("automation storage prompt dispatch", () => {
  it("defaults custom automations to sequence dispatch", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-automation-storage-"));
    try {
      const storage = await loadAutomationStorage(homeDir);

      const task = storage.createCustomAutomationTask({
        promptSteps: [{ id: "step-1", title: "Prompt", prompt: "Run this." }],
      });

      expect(task.promptDispatchMode).toBe("sequence");
      expect(task.nextPromptStepId).toBeUndefined();
      expect(storage.getAutomationTask(task.id)?.promptDispatchMode).toBe("sequence");
    } finally {
      await closeStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("normalizes cycle cursors when prompt steps change", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-automation-storage-"));
    try {
      const storage = await loadAutomationStorage(homeDir);

      const task = storage.createCustomAutomationTask({
        promptDispatchMode: "cycle",
        nextPromptStepId: "b",
        promptSteps: [
          { id: "a", title: "Alpha", prompt: "Run alpha." },
          { id: "b", title: "Beta", prompt: "Run beta." },
        ],
      });

      expect(task.nextPromptStepId).toBe("b");

      const updated = storage.updateAutomationTask(task.id, {
        promptSteps: [{ id: "a", title: "Alpha", prompt: "Run alpha." }],
      });

      expect(updated?.promptDispatchMode).toBe("cycle");
      expect(updated?.nextPromptStepId).toBe("a");
      expect(storage.getAutomationTask(task.id)?.nextPromptStepId).toBe("a");
    } finally {
      await closeStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("records selected prompt metadata on runs", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-automation-storage-"));
    try {
      const storage = await loadAutomationStorage(homeDir);

      const task = storage.createCustomAutomationTask({
        promptSteps: [{ id: "step-1", title: "Prompt", prompt: "Run this." }],
      });
      const run = storage.startAutomationRun(task.id, "manual");
      storage.updateAutomationRunPromptSelection(run.id, task.promptSteps);
      const finished = storage.finishAutomationRun(run.id, "success", {
        summary: "Done.",
        toolCallCount: 0,
      });

      expect(finished?.selectedPromptStepIds).toEqual(["step-1"]);
      expect(finished?.selectedPromptStepTitles).toEqual(["Prompt"]);
    } finally {
      await closeStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("migrates legacy automation tables without prompt dispatch columns", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-automation-storage-"));
    try {
      const dataDir = join(homeDir, ".porrima");
      mkdirSync(dataDir, { recursive: true });
      const db = new Database(join(dataDir, "app.db"));
      const now = "2026-06-07T00:00:00.000Z";
      db.exec(`
        CREATE TABLE automation_tasks (
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
        CREATE TABLE automation_runs (
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
      `);
      db.prepare(
        `INSERT INTO automation_tasks (
          id, kind, title, enabled, builtIn, orderIndex, chatId, scheduleJson,
          activationPolicy, promptStepsJson, notificationsJson, maxIterations,
          timeoutMs, createdAt, updatedAt
        ) VALUES (
          @id, @kind, @title, @enabled, @builtIn, @orderIndex, @chatId, @scheduleJson,
          @activationPolicy, @promptStepsJson, @notificationsJson, @maxIterations,
          @timeoutMs, @createdAt, @updatedAt
        )`,
      ).run({
        id: "legacy",
        kind: "custom",
        title: "Legacy",
        enabled: 1,
        builtIn: 0,
        orderIndex: 0,
        chatId: "automation:legacy",
        scheduleJson: JSON.stringify({ type: "interval", everyMinutes: 60 }),
        activationPolicy: "idle",
        promptStepsJson: JSON.stringify([{ id: "step-1", title: "Prompt", prompt: "Run this." }]),
        notificationsJson: JSON.stringify({ enabled: false }),
        maxIterations: 20,
        timeoutMs: 30 * 60 * 1000,
        createdAt: now,
        updatedAt: now,
      });
      db.close();

      const storage = await loadAutomationStorage(homeDir);
      const task = storage.getAutomationTask("legacy");
      const chatStorage = await import("../services/chat-storage.js");
      const cols = chatStorage.getDb().prepare("PRAGMA table_info(automation_tasks)").all() as Array<{ name: string }>;
      const runCols = chatStorage.getDb().prepare("PRAGMA table_info(automation_runs)").all() as Array<{ name: string }>;

      expect(task?.promptDispatchMode).toBe("sequence");
      expect(task?.nextPromptStepId).toBeUndefined();
      expect(cols.some((col) => col.name === "promptDispatchMode")).toBe(true);
      expect(cols.some((col) => col.name === "nextPromptStepId")).toBe(true);
      expect(runCols.some((col) => col.name === "selectedPromptStepIdsJson")).toBe(true);
      expect(runCols.some((col) => col.name === "selectedPromptStepTitlesJson")).toBe(true);
    } finally {
      await closeStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("preserves customized synthesis schedule across ensureAutomationDefaults runs", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-automation-storage-"));
    try {
      const storage = await loadAutomationStorage(homeDir);

      // First run seeds the built-in synthesis task with the default schedule.
      await storage.ensureAutomationDefaults();
      const seeded = storage.getAutomationTask(storage.SYNTHESIS_AUTOMATION_ID);
      expect(seeded).toBeDefined();
      expect(seeded?.schedule.type).toBe("interval");

      // User customizes the schedule to daily at 05:00 via the automation block.
      storage.updateAutomationTask(storage.SYNTHESIS_AUTOMATION_ID, {
        schedule: { type: "daily", timeOfDay: "05:00" },
      });

      // Re-running ensureAutomationDefaults must NOT clobber the custom schedule.
      await storage.ensureAutomationDefaults();
      const after = storage.getAutomationTask(storage.SYNTHESIS_AUTOMATION_ID);
      expect(after?.schedule).toEqual({ type: "daily", timeOfDay: "05:00" });
    } finally {
      await closeStorage().catch(() => {});
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
