import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../types.js";

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
    crossChat: await import("../services/cross-chat.js"),
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
  const now = new Date("2026-09-09T15:00:00.000Z").toISOString();
  return {
    id,
    title,
    type,
    modelId: "test-model",
    systemPrompt: "You are helpful.",
    messages: [],
    createdAt: now,
    lastModified: now,
  };
}

describe("cross-chat target resolution", () => {
  it("resolves by id and by unique title fragment, rejecting 0/multi/quick", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, crossChat } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("build-chat", "Build Chat"));
      await chatStorage.createChat(makeChat("deploy-alpha", "Deploy Alpha"));
      await chatStorage.createChat(makeChat("deploy-beta", "Deploy Beta"));
      await chatStorage.createChat(makeChat("quick-notes", "Quick Notes", "quick"));
      await chatStorage.createChat(makeChat("system", "System", "system"));

      const byId = await crossChat.resolveCrossChatTarget("build-chat");
      expect(byId).toEqual({ ok: true, target: { id: "build-chat", title: "Build Chat", type: "agent" } });

      const byFragment = await crossChat.resolveCrossChatTarget("build");
      expect(byFragment.ok && byFragment.target.id).toBe("build-chat");

      const systemTarget = await crossChat.resolveCrossChatTarget("system");
      expect(systemTarget.ok && systemTarget.target.type).toBe("system");

      const missing = await crossChat.resolveCrossChatTarget("zzz-nothing");
      expect(missing.ok).toBe(false);
      expect(missing.ok ? "" : missing.error).toMatch(/No chat matches/);

      const multi = await crossChat.resolveCrossChatTarget("deploy");
      expect(multi.ok).toBe(false);
      expect(multi.ok ? "" : multi.error).toMatch(/matches 2 chats/);
      expect(multi.ok ? "" : multi.error).toContain("deploy-alpha");
      expect(multi.ok ? "" : multi.error).toContain("deploy-beta");

      const quick = await crossChat.resolveCrossChatTarget("quick-notes");
      expect(quick.ok).toBe(false);
      expect(quick.ok ? "" : quick.error).toMatch(/quick chat/);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("cross-chat immediate delivery", () => {
  it("appends an attributed row with a frozen anchor, indexed for search", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, automationStorage, crossChat } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat"));
      await chatStorage.createChat(makeChat("target", "Target Chat"));

      const result = await crossChat.deliverCrossChatPost({
        targetChatId: "target",
        fromChatId: "origin",
        fromChatTitle: "Origin Chat",
        subject: "Status",
        body: "Build is green.",
      });
      expect(result.delivered).toBe(true);

      const target = await chatStorage.getChat("target");
      expect(target?.messages).toHaveLength(1);
      const post = target!.messages[0];
      expect(post.role).toBe("user");
      expect(post._crossChatPost?.fromChatId).toBe("origin");
      expect(post._crossChatPost?.fromChatTitle).toBe("Origin Chat");
      expect(post._crossChatPost?.subject).toBe("Status");
      expect(post._crossChatPost?.originTaskId).toBeUndefined();

      // Envelope ↔ metadata parity.
      const stamp = crossChat.formatCrossChatStamp(post._crossChatPost!.at);
      expect(post.content.startsWith(`[quje from Origin Chat — ${stamp}] Status\n\n`)).toBe(true);
      expect(post.content.endsWith("Build is green.")).toBe(true);
      expect(typeof post.timeAnchor).toBe("string");
      expect(post.timeAnchor!.length).toBeGreaterThan(0);

      // No automation run for immediate delivery.
      expect(automationStorage.listAutomationRuns()).toHaveLength(0);

      // Searchable immediately.
      const hits = chatStorage.searchChatMessages("green", { chatId: "target" });
      expect(hits.map((hit) => hit.messageIndex)).toEqual([0]);

      // Reload keeps content + anchor byte-identical.
      const reloaded = await chatStorage.getChat("target");
      expect(reloaded?.messages[0].content).toBe(post.content);
      expect(reloaded?.messages[0].timeAnchor).toBe(post.timeAnchor);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("cross-chat scheduled delivery", () => {
  it("delivers once at fire time and is idempotent on a second run", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, automationStorage, crossChat } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat"));
      await chatStorage.createChat(makeChat("target", "Target Chat"));

      const task = await automationStorage.createCrossChatTask({
        targetChatId: "target",
        targetChatTitle: "Target Chat",
        fromChatId: "origin",
        fromChatTitle: "Origin Chat",
        subject: "Deploy",
        body: "Deploy finished.",
        runAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      expect(task.kind).toBe("crossChat");
      expect(task.createdBy).toBe("agent");
      expect(task.crossChat?.targetChatId).toBe("target");
      expect((await chatStorage.getChat("target"))?.messages).toHaveLength(0);

      const { runAutomationTask } = await import("../services/automation-runner.js");
      const first = await runAutomationTask(task.id, "scheduler");
      expect(first.success).toBe(true);

      const afterFirst = await chatStorage.getChat("target");
      expect(afterFirst?.messages).toHaveLength(1);
      expect(afterFirst?.messages[0]._crossChatPost?.originTaskId).toBe(task.id);
      expect((await automationStorage.getAutomationTask(task.id))?.archived).toBe(true);

      const second = await runAutomationTask(task.id, "scheduler");
      expect(second.success).toBe(true);
      expect((await chatStorage.getChat("target"))?.messages).toHaveLength(1);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("fails a fire to a deleted target without resurrecting a chat", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, automationStorage } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat"));
      await chatStorage.createChat(makeChat("target", "Target Chat"));

      const task = await automationStorage.createCrossChatTask({
        targetChatId: "target",
        targetChatTitle: "Target Chat",
        fromChatId: "origin",
        fromChatTitle: "Origin Chat",
        subject: "",
        body: "Late note.",
        runAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      await chatStorage.deleteChat("target");

      const { runAutomationTask } = await import("../services/automation-runner.js");
      const result = await runAutomationTask(task.id, "scheduler");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no longer exists/);
      expect(await chatStorage.chatExists("target")).toBe(false);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("shares the extended agent cap with reminders (created-in-last-hour window)", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, automationStorage } = await loadModules(homeDir);
      await chatStorage.createChat(makeChat("target", "Target Chat"));

      for (let i = 0; i < 10; i++) {
        const task = await automationStorage.createCrossChatTask({
          targetChatId: "target",
          targetChatTitle: "Target Chat",
          fromChatId: "origin",
          fromChatTitle: "Origin Chat",
          subject: "",
          body: `Post ${i}`,
          runAt: new Date(Date.now() + (10 + i) * 60 * 1000).toISOString(),
        });
        // Disable so the cap can only be triggered by the createdAt window.
        automationStorage.updateAutomationTask(task.id, { enabled: false });
      }

      await expect(
        automationStorage.createCrossChatTask({
          targetChatId: "target",
          targetChatTitle: "Target Chat",
          fromChatId: "origin",
          fromChatTitle: "Origin Chat",
          subject: "",
          body: "Post 11",
          runAt: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
        }),
      ).rejects.toThrow(/cap reached/);

      await expect(
        automationStorage.createReminderTask({
          message: "Reminder 11",
          title: "Reminder 11",
          scheduledAt: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
        }),
      ).rejects.toThrow(/cap reached/);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

describe("schedule_chat_message tool", () => {
  async function toolHarness(homeDir: string) {
    const modules = await loadModules(homeDir);
    const { getAgentTools } = await import("../services/agent-tools.js");
    const effects = { onArtifact: () => {}, onVisual: () => {}, onAskUser: () => {} };
    const tools = getAgentTools("origin", effects, 32768, undefined, "agent", null);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    return { ...modules, byName };
  }

  it("delivers immediately and enumerates chats", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, byName } = await toolHarness(homeDir);
      await chatStorage.createChat(makeChat("origin", "Origin Chat"));
      await chatStorage.createChat(makeChat("target", "Target Chat"));

      const scheduleTool = byName.get("schedule_chat_message")!;
      const delivered = await scheduleTool.execute("call-1", {
        targetChat: "target",
        message: "Hello from the origin.",
        subject: "Note",
      });
      expect(JSON.stringify(delivered)).toContain("Delivered to **Target Chat**");
      expect((await chatStorage.getChat("target"))?.messages).toHaveLength(1);

      const listTool = byName.get("list_chats")!;
      const listed = await listTool.execute("call-2", {});
      const text = JSON.stringify(listed);
      expect(text).toContain("Origin Chat");
      expect(text).toContain("target");
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("rejects wake, bad timing, and ambiguous targets", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-crosschat-"));
    try {
      const { chatStorage, byName } = await toolHarness(homeDir);
      await chatStorage.createChat(makeChat("target", "Target Chat"));
      await chatStorage.createChat(makeChat("deploy-alpha", "Deploy Alpha"));
      await chatStorage.createChat(makeChat("deploy-beta", "Deploy Beta"));

      const tool = byName.get("schedule_chat_message")!;
      await expect(tool.execute("c1", { targetChat: "target", message: "x", wake: true }))
        .rejects.toThrow(/wake/);
      await expect(tool.execute("c2", {
        targetChat: "target",
        message: "x",
        when: new Date(Date.now() + 30_000).toISOString(),
      })).rejects.toThrow(/2 minutes/);
      await expect(tool.execute("c3", { targetChat: "deploy", message: "x" }))
        .rejects.toThrow(/matches 2 chats/);
      chatStorage.closeChatDb();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
