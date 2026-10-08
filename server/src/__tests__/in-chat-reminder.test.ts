import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationTask, Chat } from "../types.js";

async function loadModules(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return {
    chatStorage: await import("../services/chat-storage.js"),
    automationStorage: await import("../services/automation-storage.js"),
    automationRunner: await import("../services/automation-runner.js"),
  };
}

async function closeStorage() {
  const chatStorage = await import("../services/chat-storage.js").catch(() => null);
  chatStorage?.closeChatDb?.();
}

afterEach(async () => {
  await closeStorage().catch(() => {});
  vi.doUnmock("os");
  vi.resetModules();
});

function makeChat(id: string, title: string, type: Chat["type"] = "agent"): Chat {
  const now = new Date("2026-09-19T23:00:00.000Z").toISOString();
  return {
    id,
    title,
    type,
    modelId: "test-model",
    messages: [],
    createdAt: now,
    lastModified: now,
  };
}

function makeTask(overrides: Partial<AutomationTask>): AutomationTask {
  const now = new Date("2026-09-19T23:00:00.000Z").toISOString();
  return {
    id: "reminder-test",
    kind: "custom",
    title: "Test Reminder",
    enabled: true,
    builtIn: false,
    orderIndex: 0,
    chatId: "system",
    schedule: { type: "once", runAt: now },
    activationPolicy: "idle",
    promptSteps: [{ id: "step-1", title: "Test Reminder", prompt: "Do the thing." }],
    promptDispatchMode: "sequence",
    notifications: { enabled: false },
    maxIterations: 10,
    timeoutMs: 300000,
    consecutiveFailures: 0,
    createdBy: "agent",
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("in-chat reminder: storage", () => {
  it("stores the target chat, defaulting to system", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-reminder-"));
    try {
      const { automationStorage } = await loadModules(homeDir);
      const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const defaulted = await automationStorage.createReminderTask({
        message: "Legacy destination",
        title: "Legacy",
        scheduledAt: future,
      });
      expect(defaulted.chatId).toBe("system");

      const targeted = await automationStorage.createReminderTask({
        message: "In-thread follow-up",
        title: "Threaded",
        scheduledAt: future,
        chatId: "build-chat",
      });
      expect(targeted.chatId).toBe("build-chat");
      expect(targeted.createdBy).toBe("agent");
      expect(targeted.kind).toBe("custom");
      await import("../services/chat-storage.js").then((m) => m.closeChatDb());
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("in-chat reminder: tool destination", () => {
  const future = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();

  it("defaults to the calling chat", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-reminder-"));
    try {
      const { chatStorage, automationStorage, byName } = await (async () => {
        const { chatStorage } = await loadModules(homeDir);
        await chatStorage.createChat(makeChat("origin", "Origin Chat"));
        await chatStorage.createChat(makeChat("system", "System", "system"));
        const { getAgentTools } = await import("../services/agent-tools.js");
        const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
        const tools = getAgentTools("origin", effects, 32768, undefined, "agent", null);
        const automationStorage = await import("../services/automation-storage.js");
        return { chatStorage, automationStorage, byName: new Map(tools.map((t: any) => [t.name, t])) };
      })();

      const tool = byName.get("schedule_reminder")!;
      const result = await tool.execute("c1", {
        message: "Check the gate decision.",
        title: "Gate check",
        scheduledAt: future(),
      });
      expect(JSON.stringify(result)).toContain("Origin Chat (origin)");

      const created = automationStorage.listEnabledAutomationTasks().find((t) => t.title === "Gate check");
      expect(created?.chatId).toBe("origin");
      await chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("resolves an explicit target by id and title fragment", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-reminder-"));
    try {
      const { chatStorage, automationStorage, byName } = await (async () => {
        const { chatStorage } = await loadModules(homeDir);
        await chatStorage.createChat(makeChat("origin", "Origin Chat"));
        await chatStorage.createChat(makeChat("deploy", "Deploy Watch"));
        const { getAgentTools } = await import("../services/agent-tools.js");
        const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
        const tools = getAgentTools("origin", effects, 32768, undefined, "agent", null);
        const automationStorage = await import("../services/automation-storage.js");
        return { chatStorage, automationStorage, byName: new Map(tools.map((t: any) => [t.name, t])) };
      })();

      const tool = byName.get("schedule_reminder")!;
      await tool.execute("c1", {
        message: "ById.",
        title: "ById",
        scheduledAt: future(),
        targetChat: "deploy",
      });
      expect(automationStorage.listEnabledAutomationTasks().find((t) => t.title === "ById")?.chatId)
        .toBe("deploy");

      await tool.execute("c2", {
        message: "ByFragment.",
        title: "ByFragment",
        scheduledAt: future(),
        targetChat: "Deploy",
      });
      expect(automationStorage.listEnabledAutomationTasks().find((t) => t.title === "ByFragment")?.chatId)
        .toBe("deploy");
      await chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects an ambiguous or missing explicit target", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-reminder-"));
    try {
      const { chatStorage, byName } = await (async () => {
        const { chatStorage } = await loadModules(homeDir);
        await chatStorage.createChat(makeChat("origin", "Origin Chat"));
        await chatStorage.createChat(makeChat("deploy-alpha", "Deploy Alpha"));
        await chatStorage.createChat(makeChat("deploy-beta", "Deploy Beta"));
        const { getAgentTools } = await import("../services/agent-tools.js");
        const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
        const tools = getAgentTools("origin", effects, 32768, undefined, "agent", null);
        return { chatStorage, byName: new Map(tools.map((t: any) => [t.name, t])) };
      })();

      const tool = byName.get("schedule_reminder")!;
      await expect(tool.execute("c1", {
        message: "x",
        title: "Ambiguous",
        scheduledAt: future(),
        targetChat: "deploy",
      })).rejects.toThrow(/matches 2 chats/);

      await expect(tool.execute("c2", {
        message: "x",
        title: "Missing",
        scheduledAt: future(),
        targetChat: "zzz-nothing",
      })).rejects.toThrow(/No chat matches/);
      await chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("called from the system chat stays on the system chat", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-reminder-"));
    try {
      const { chatStorage, automationStorage, byName } = await (async () => {
        const { chatStorage } = await loadModules(homeDir);
        await chatStorage.createChat(makeChat("system", "System", "system"));
        const { getAgentTools } = await import("../services/agent-tools.js");
        const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
        const tools = getAgentTools("system", effects, 32768, undefined, "system", null);
        const automationStorage = await import("../services/automation-storage.js");
        return { chatStorage, automationStorage, byName: new Map(tools.map((t: any) => [t.name, t])) };
      })();

      const tool = byName.get("schedule_reminder")!;
      await tool.execute("c1", {
        message: "Housekeeping.",
        title: "Housekeeping",
        scheduledAt: future(),
      });
      expect(automationStorage.listEnabledAutomationTasks().find((t) => t.title === "Housekeeping")?.chatId)
        .toBe("system");
      await chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("in-chat reminder: fire-time dispatch decision", () => {
  it("runs in a live agent chat with the wake-shaped options", async () => {
    const { automationRunner } = await loadModules(mkdtempSync(join(tmpdir(), "porrima-reminder-")));
    const live = makeChat("build-chat", "Build Chat");
    const task = makeTask({ chatId: "build-chat" });

    const dispatch = automationRunner.resolveInChatReminderDispatch(task, live);
    expect(dispatch.task).toBe(task);
    expect(dispatch.options).toEqual({
      chatType: "agent",
      skipTriggerRow: false,
      skipTitleRefresh: true,
      requireExistingChat: true,
      preserveChatModel: true,
      enableMemoryRetrieval: true,
      triggerStyle: "reminder",
    });
  });

  it("keeps the target's own type for a live system chat", async () => {
    const { automationRunner } = await loadModules(mkdtempSync(join(tmpdir(), "porrima-reminder-")));
    const dispatch = automationRunner.resolveInChatReminderDispatch(
      makeTask({ chatId: "system" }),
      makeChat("system", "System", "system"),
    );
    expect(dispatch.options.chatType).toBe("system");
  });

  it("reroutes a deleted target to the system chat via a clone", async () => {
    const { automationRunner } = await loadModules(mkdtempSync(join(tmpdir(), "porrima-reminder-")));
    const task = makeTask({ chatId: "build-chat" });

    const dispatch = automationRunner.resolveInChatReminderDispatch(task, null);
    expect(dispatch.task).not.toBe(task);
    expect(dispatch.task.chatId).toBe("system");
    // The original task keeps its declared target — the run row records the
    // reroute, the task row never lies about where it was aimed.
    expect(task.chatId).toBe("build-chat");
    expect(dispatch.options).toEqual({});
  });
});
