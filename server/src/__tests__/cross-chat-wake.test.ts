import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

const captured: {
  headless?: any;
  splitPromptArgs?: any[];
  toolArgs?: any[];
  commitMemoryDelta?: any;
  resetMemoryContext?: any;
  skillAugmentArgs?: any[];
} = {};

// Configurable build result so the delta-delivery test can exercise a
// late-freeze memoriesMessage; reset in afterEach.
const deltaConfig: { memoriesMessage: string; newMemoryIds: string[] } = {
  memoriesMessage: "",
  newMemoryIds: [],
};

async function loadModules(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  vi.doMock("../services/system-chat.js", () => ({
    SYSTEM_CHAT_ID: "system",
    runSystemSynthesis: vi.fn(),
    runWakeCycle: vi.fn(),
    isSynthesisActive: vi.fn(() => false),
    isWakeCycleActive: vi.fn(() => false),
    getDefaultSynthesisPromptSteps: vi.fn(() => []),
    getDefaultWakePromptSteps: vi.fn(() => []),
    createSystemChat: vi.fn(),
  }));

  vi.doMock("../services/chat-turn-runner.js", () => ({
    runHeadlessChatTurn: vi.fn(async (opts: any) => {
      captured.headless = opts;
      const reply = { role: "assistant", content: "wake reply", timestamp: Date.now() };
      opts.chat.messages.push(reply);
      await opts.saveChat(opts.chat);
      return {
        summary: "wake reply",
        thinking: "",
        toolCalls: [],
        memoryUpdates: [],
        success: true,
        assistantMessage: reply,
        assistantMessageIndex: opts.chat.messages.length - 1,
        stopReason: "stop",
      };
    }),
  }));
  vi.doMock("../services/models.js", () => ({
    discoverAllModels: vi.fn(async () => [
      { id: "target-model", contextWindow: 4096 },
      { id: "global-model", contextWindow: 4096 },
    ]),
    createPiModelFromProvider: vi.fn(async (model: any) => ({ ...model })),
  }));
  vi.doMock("../services/agent-tools.js", () => ({
    getAgentTools: vi.fn((...args: any[]) => {
      captured.toolArgs = args;
      return [
        {
          name: "ask_user",
          description: "Ask the user a question.",
          parameters: { type: "object", properties: { question: { type: "string" } } },
          execute: vi.fn(),
        },
      ];
    }),
  }));
  vi.doMock("../services/skills.js", () => ({
    buildSkillAugmentedPrompt: vi.fn((...args: any[]) => {
      captured.skillAugmentArgs = args;
      const [base, names] = args as [string, string[]];
      return names.length > 0 ? `${base}\n\n[Active Skills]\n${names.join(", ")}` : base;
    }),
    discoverSkills: vi.fn(async () => [
      { name: "demo", folderPath: "/skills/demo", instructions: "Do demo things." },
    ]),
  }));
  vi.doMock("../services/compaction.js", () => ({
    estimateContextTokens: vi.fn(() => 42),
    truncateBeforeSend: vi.fn(async () => null),
  }));
  vi.doMock("../services/turn-compaction.js", () => ({
    runEndOfTurnCompaction: vi.fn(async () => {}),
  }));
  vi.doMock("../services/memory-context.js", () => {
    const commitMemoryDelta = vi.fn();
    const resetMemoryContext = vi.fn();
    captured.commitMemoryDelta = commitMemoryDelta;
    captured.resetMemoryContext = resetMemoryContext;
    return {
      buildSplitAugmentedPrompt: vi.fn(async (...args: any[]) => {
        captured.splitPromptArgs = args;
        return { systemPrompt: "wake system prompt", ...deltaConfig };
      }),
      commitMemoryDelta,
      invalidateAllStablePrefixCaches: vi.fn(),
      resetMemoryContext,
      buildTimeAnchor: vi.fn(() => "\n\n[time: test]"),
    };
  });
  vi.doMock("../services/synthesis-stream.js", () => {
    class FakeEmitter {
      state = { artifacts: [], visuals: [], segments: [], finalUsage: undefined };
      stream = { abort: new AbortController() };
      emitError = vi.fn();
      end = vi.fn();
      emitTitleUpdate = vi.fn();
      emitTextDelta = vi.fn();
      emitThinkingDelta = vi.fn();
      emitToolCall = vi.fn();
      emitToolResult = vi.fn();
      emitDone = vi.fn();
      setUsage = vi.fn();
      flushPendingText = vi.fn();
      buildAssistantMessage = vi.fn(() => ({ role: "assistant", content: "wake reply", timestamp: Date.now() }));
    }
    return {
      SynthesisEmitter: FakeEmitter,
      createEmitterSideEffects: () => ({ onArtifact() {}, onVisual() {}, onAskUser() {} }),
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return {
    chatStorage: await import("../services/chat-storage.js"),
    automationStorage: await import("../services/automation-storage.js"),
    crossChat: await import("../services/cross-chat.js"),
    runner: await import("../services/automation-runner.js"),
  };
}

async function closeStorage() {
  const chatStorage = await import("../services/chat-storage.js").catch(() => null);
  chatStorage?.closeChatDb?.();
}

afterEach(async () => {
  await closeStorage().catch(() => {});
  for (const path of [
    "../services/chat-turn-runner.js",
    "../services/models.js",
    "../services/agent-tools.js",
    "../services/compaction.js",
    "../services/turn-compaction.js",
    "../services/memory-context.js",
    "../services/skills.js",
    "../services/synthesis-stream.js",
    "../services/system-chat.js",
    "os",
  ]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
  vi.clearAllMocks();
  captured.headless = undefined;
  captured.splitPromptArgs = undefined;
  captured.toolArgs = undefined;
  captured.commitMemoryDelta = undefined;
  captured.resetMemoryContext = undefined;
  captured.skillAugmentArgs = undefined;
  deltaConfig.memoriesMessage = "";
  deltaConfig.newMemoryIds = [];
});

function makeChat(id: string, title: string, modelId: string, type: Chat["type"] = "agent"): Chat {
  const now = new Date("2026-09-09T15:00:00.000Z").toISOString();
  return {
    id,
    title,
    type,
    modelId,
    messages: [],
    createdAt: now,
    lastModified: now,
  };
}

describe("cross-chat wake turns", () => {
  it("runs the target's agent over the post with target semantics and no rewrite", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-wake-"));
    try {
      const { chatStorage, automationStorage, crossChat, runner } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat", "origin-model"));
      await chatStorage.createChat(makeChat("target", "Target Chat", "target-model"));

      const task = await automationStorage.createCrossChatTask({
        targetChatId: "target",
        targetChatTitle: "Target Chat",
        fromChatId: "origin",
        fromChatTitle: "Origin Chat",
        subject: "Report",
        body: "Build is green.",
        runAt: new Date().toISOString(),
        wake: true,
      });
      expect(task.crossChat?.wake).toBe(true);

      const result = await runner.runAutomationTask(task.id, "scheduler");
      expect(result.success).toBe(true);

      const target = await chatStorage.getChat("target");
      expect(target?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(target?.messages[0]._crossChatPost?.originTaskId).toBe(task.id);
      expect(target?.messages[0].content.startsWith(`[${crossChat.DEFAULT_AGENT_NAME} from Origin Chat — `)).toBe(true);
      expect(target?.messages[1].content).toBe("wake reply");

      // The turn ran on the target chat, with the post as the last user row.
      expect(captured.headless?.chat.id).toBe("target");
      expect(captured.headless?.chat.messages[0].role).toBe("user");
      expect(captured.headless?.modelId).toBe("target-model");

      // Target semantics: chatType flows to prompt, tools, and passive recall.
      expect(captured.splitPromptArgs?.[3]).toBe("agent");
      expect(captured.splitPromptArgs?.[5]).toBeUndefined();
      expect(captured.toolArgs?.[4]).toBe("agent");
      expect(captured.headless?.passiveMemoryRecall?.chatType).toBe("agent");

      // Headless parity: ask_user stays in the tool schema (schemas render into
      // the system prompt; filtering it busted the KV prefix on 10-05) and only
      // its executor is swapped for a headless-safe one.
      const headlessTools = (captured.headless?.tools ?? []) as any[];
      const askUser = headlessTools.find((tool) => tool.name === "ask_user");
      expect(askUser).toBeDefined();
      expect(askUser.description).toBe("Ask the user a question.");
      expect(askUser.parameters).toEqual({ type: "object", properties: { question: { type: "string" } } });

      // Follow-up semantics: the run keeps the target's memory context intact —
      // no hard reset (the build hydrates and retains the frozen section).
      expect(captured.resetMemoryContext).not.toHaveBeenCalled();

      // No title refresh, no model rewrite, no trigger row.
      expect(target?.title).toBe("Target Chat");
      expect(target?.modelId).toBe("target-model");
      expect(target?.messages).toHaveLength(2);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("applies the target chat's active skills to the headless prompt", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-wake-skills-"));
    try {
      const { chatStorage, automationStorage, runner } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat", "origin-model"));
      const target = makeChat("target", "Target Chat", "target-model");
      target.activeSkills = ["demo"];
      await chatStorage.createChat(target);

      const task = await automationStorage.createCrossChatTask({
        targetChatId: "target",
        targetChatTitle: "Target Chat",
        fromChatId: "origin",
        fromChatTitle: "Origin Chat",
        subject: "Report",
        body: "Build is green.",
        runAt: new Date().toISOString(),
        wake: true,
      });

      const result = await runner.runAutomationTask(task.id, "scheduler");
      expect(result.success).toBe(true);

      // Interactive turns append skill instructions to the system prompt; the
      // headless run must produce the same bytes or the KV prefix diverges at
      // the prompt tail for chats with active skills.
      expect(captured.skillAugmentArgs?.[1]).toEqual(["demo"]);
      expect(captured.headless?.systemPrompt).toContain("[Active Skills]");
      expect(captured.headless?.systemPrompt).toContain("demo");
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("delivers a late-freeze memory delta before the wake post, then commits it", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-wake-delta-"));
    try {
      deltaConfig.memoriesMessage = "## Updated context — my newly recalled memories:\n- [m1] Remember the build status.";
      deltaConfig.newMemoryIds = ["m1"];

      const { chatStorage, automationStorage, runner } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat", "origin-model"));
      await chatStorage.createChat(makeChat("target", "Target Chat", "target-model"));

      const task = await automationStorage.createCrossChatTask({
        targetChatId: "target",
        targetChatTitle: "Target Chat",
        fromChatId: "origin",
        fromChatTitle: "Origin Chat",
        subject: "Report",
        body: "Build is green.",
        runAt: new Date().toISOString(),
        wake: true,
      });

      const result = await runner.runAutomationTask(task.id, "scheduler");
      expect(result.success).toBe(true);

      const target = await chatStorage.getChat("target");
      // The delta lands directly before the post (the row this run answers),
      // so the replay merge folds it into that user message.
      expect(target?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
      expect(target?.messages[0].content).toContain("[System context — updated memories]");
      expect(target?.messages[0].content).toContain("Remember the build status.");
      expect(target?.messages[1]._crossChatPost?.originTaskId).toBe(task.id);

      // Delivery receipt: committed only after the save, like the HTTP paths.
      expect(captured.commitMemoryDelta).toHaveBeenCalledWith("target", ["m1"]);

      // The headless turn's persisted context carries the delta row.
      expect(captured.headless?.chat.messages[0].role).toBe("system");
      expect(captured.headless?.chat.messages[0].content).toContain("Remember the build status.");
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
