import type { ToolSideEffects } from "./agent-tools.js";
import type { AutomationRun, AutomationTask, Chat, ChatMessage } from "../types.js";
import { acquireAutomationLock, releaseAutomationLock } from "./automation-lock.js";
import {
  finishAutomationRun,
  getAutomationTask,
  startAutomationRun,
  SYNTHESIS_AUTOMATION_ID,
  WAKE_AUTOMATION_ID,
} from "./automation-storage.js";
import { runSystemSynthesis, runWakeCycle, type SynthesisResult } from "./system-chat.js";
import { runHeadlessChatTurn } from "./chat-turn-runner.js";
import { SYSTEM_CHAT_ID } from "./system-chat.js";

interface AutomationExecutionResult extends SynthesisResult {
  chatId?: string;
  assistantMessageIndex?: number;
}

function makeErrorResult(message: string): AutomationExecutionResult {
  return {
    summary: `*Automation failed: ${message}*`,
    thinking: "",
    toolCalls: [],
    artifacts: [],
    visuals: [],
    generatedImages: [],
    memoryUpdates: [],
    success: false,
    error: message,
  };
}

async function resolveAutomationModelId(storedModelId?: string): Promise<string | null> {
  const { discoverAllModels } = await import("./models.js");
  const { getSettings } = await import("./chat-storage.js");
  const models = await discoverAllModels();
  if (models.length === 0) return null;

  try {
    const settings = await getSettings();
    if (settings.defaultModelId) {
      const found = models.find((m) => m.id === settings.defaultModelId);
      if (found) return found.id;
    }
  } catch {
    // fall through to stored/first available
  }

  if (storedModelId) {
    const found = models.find((m) => m.id === storedModelId);
    if (found) return found.id;
  }

  return models[0].id;
}

async function ensureAutomationChat(task: AutomationTask): Promise<Chat | null> {
  const { createChat, getChat, getSettings } = await import("./chat-storage.js");
  let chat = await getChat(task.chatId);
  if (chat) return chat;

  const settings = await getSettings();
  const now = new Date().toISOString();
  await createChat({
    id: task.chatId,
    title: task.title,
    type: "system",
    modelId: settings.defaultModelId || "",
    systemPrompt: settings.defaultSystemPrompt || "You are a helpful assistant.",
    messages: [],
    createdAt: now,
    lastModified: now,
  });
  chat = await getChat(task.chatId);
  return chat;
}

async function refreshAutomationChatTitle(
  task: AutomationTask,
  chat: Chat,
  assistantContent: string,
  emitTitleUpdate: (title: string) => void,
): Promise<void> {
  if (!assistantContent.trim()) return;
  try {
    const { saveChat } = await import("./chat-storage.js");
    const { generateSystemCycleTitle } = await import("./title-generation.js");
    const title = await generateSystemCycleTitle(task.kind === "custom" ? task.title : task.kind, assistantContent);
    if (!title || title === chat.title) return;
    chat.title = title;
    await saveChat(chat);
    emitTitleUpdate(title);
  } catch (e: any) {
    console.warn(`[automation] title update failed for ${task.id}:`, e?.message || e);
  }
}

function formatAutomationTrigger(task: AutomationTask, step: { title: string; prompt: string }): string {
  const stamp = new Date().toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return [`# ${task.title} - ${stamp}`, `## ${step.title}`, step.prompt].join("\n\n");
}

function makeTriggerMessage(
  task: AutomationTask,
  run: AutomationRun,
  content: string,
): ChatMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now(),
    _isSystemMessage: true,
    _isAutomationMessage: true,
    _automationTaskId: task.id,
    _automationRunId: run.id,
  };
}

async function sendAutomationPush(task: AutomationTask, result: AutomationExecutionResult): Promise<void> {
  if (!task.notifications.enabled || !result.summary?.trim() || !result.chatId) return;
  try {
    const { sendPush, truncateForBody } = await import("./push-dispatch.js");
    await sendPush("owner", {
      type: "task_complete",
      title: task.notifications.titleTemplate || task.title,
      body: truncateForBody(result.summary),
      url: `/?chat=${result.chatId}`,
      chatId: result.chatId,
      tag: `automation:${task.id}`,
      data: { automationTaskId: task.id },
    });
  } catch (e: any) {
    console.warn(`[automation] push dispatch failed for ${task.id}:`, e?.message || e);
  }
}

async function runPromptAutomation(task: AutomationTask, run: AutomationRun): Promise<AutomationExecutionResult> {
  const { getChat, saveChat } = await import("./chat-storage.js");
  const { createPiModelFromProvider, discoverAllModels } = await import("./models.js");
  const { getAgentTools } = await import("./agent-tools.js");
  const { truncateBeforeSend } = await import("./compaction.js");
  const { buildSplitAugmentedPrompt, invalidateAllStablePrefixCaches, resetMemoryContext } = await import("./memory-context.js");
  const { SynthesisEmitter, createEmitterSideEffects } = await import("./synthesis-stream.js");

  const emitter = new SynthesisEmitter(task.chatId);

  try {
    const chat = await ensureAutomationChat(task);
    if (!chat) {
      emitter.emitError("Automation chat not found after creation");
      emitter.end();
      return makeErrorResult("Automation chat not found after creation");
    }

    const modelId = await resolveAutomationModelId(chat.modelId);
    if (!modelId) {
      emitter.emitError("No model available for automation");
      emitter.end();
      return makeErrorResult("No model available for automation");
    }

    const models = await discoverAllModels();
    const piModel = models.find((m) => m.id === modelId);
    if (!piModel) {
      emitter.emitError(`Model "${modelId}" not available`);
      emitter.end();
      return makeErrorResult(`Model "${modelId}" not available`);
    }
    const contextWindow = piModel.contextWindow || 32768;
    const runtimeModel = await createPiModelFromProvider(piModel);
    runtimeModel.contextWindow = contextWindow;

    const steps = task.promptSteps.filter((step) => step.prompt.trim().length > 0);
    if (steps.length === 0) {
      emitter.emitError("Automation has no prompt steps");
      emitter.end();
      return makeErrorResult("Automation has no prompt steps");
    }

    const firstTrigger = formatAutomationTrigger(task, steps[0]);
    chat.messages.push(makeTriggerMessage(task, run, firstTrigger));
    if (chat.modelId !== modelId) chat.modelId = modelId;
    await saveChat(chat);

    resetMemoryContext(task.chatId);
    const splitPrompt = await buildSplitAugmentedPrompt(
      chat.systemPrompt || "You are a helpful assistant.",
      chat.messages,
      task.chatId,
      chat.projectId,
      "system",
      undefined,
      { skipMemoryRetrieval: true },
    );
    const systemPrompt = splitPrompt.systemPrompt;

    const artifacts: any[] = [];
    const visuals: any[] = [];
    const generatedImages: any[] = [];

    const effects: ToolSideEffects = createEmitterSideEffects(emitter, {
      artifacts,
      visuals,
      generatedImages,
    });
    const tools = getAgentTools(task.chatId, effects, contextWindow, undefined, "system")
      .filter((tool) => tool.name !== "ask_user");

    const compactionResult = await truncateBeforeSend(
      chat,
      contextWindow,
      systemPrompt,
      undefined,
      undefined,
      tools,
    );
    if (compactionResult?.truncated) {
      console.log(
        `[automation] Pre-compaction removed ${compactionResult.removedCount} messages for ${task.id}`,
      );
      await saveChat(chat);
    }

    let stepIndex = 0;
    const turn = await runHeadlessChatTurn({
      chat,
      modelId,
      model: runtimeModel,
      systemPrompt,
      tools,
      emitter,
      maxIterations: task.maxIterations,
      timeoutMs: task.timeoutMs,
      keepAlive: `${Math.max(1, Math.ceil(task.timeoutMs / 60_000))}m`,
      logPrefix: `automation:${task.id}`,
      saveChat,
      passiveMemoryRecall: {
        enabled: true,
        chatType: "system",
        projectId: chat.projectId,
        decorateMessage: (message) => ({
          ...message,
          _isAutomationMessage: true,
          _automationTaskId: task.id,
          _automationRunId: run.id,
        }),
      },
      getFollowUp: async (state) => {
        if (
          state.iterations === 1 &&
          state.textSummary.length === 0 &&
          state.toolCalls.length === 0
        ) {
          return null;
        }
        if (stepIndex >= steps.length - 1) return null;
        stepIndex++;
        const nextTrigger = formatAutomationTrigger(task, steps[stepIndex]);
        return {
          message: makeTriggerMessage(task, run, nextTrigger),
          label: `step ${stepIndex + 1}/${steps.length}`,
        };
      },
      summarize: (state) =>
        state.textSummary || `*The automation ended without visible output (stopReason=${state.stopReason}).*`,
      decorateAssistantMessage: (message) => ({
        ...message,
        timestamp: Date.now(),
        _isAutomationMessage: true,
        _automationTaskId: task.id,
        _automationRunId: run.id,
      }),
    });

    await refreshAutomationChatTitle(task, chat, turn.assistantMessage.content, (title) => {
      emitter.emitTitleUpdate(title);
    });

    try {
      invalidateAllStablePrefixCaches();
    } catch (e: any) {
      console.warn("[automation] Failed to invalidate stable prefix caches:", e.message);
    }

    emitter.end();

    if (!turn.success) {
      return {
        ...makeErrorResult(`Automation failed: ${turn.error || "model returned error before producing any output"}`),
        chatId: task.chatId,
        assistantMessageIndex: turn.assistantMessageIndex,
      };
    }

    return {
      summary: turn.summary,
      thinking: turn.thinking,
      toolCalls: turn.toolCalls,
      artifacts,
      visuals,
      generatedImages,
      memoryUpdates: turn.memoryUpdates,
      success: true,
      chatId: task.chatId,
      assistantMessageIndex: turn.assistantMessageIndex,
    };
  } catch (e: any) {
    console.error(`[automation] ${task.id} failed:`, e);
    emitter.emitError(e.message || "Automation failed");
    emitter.end();
    return makeErrorResult(e.message || "Automation failed");
  } finally {
    // Refresh the chat row after possible title updates so any later caller sees
    // the final title/message state. Failure is non-fatal here.
    try {
      await getChat(task.chatId);
    } catch {}
  }
}

async function executeAutomation(task: AutomationTask, run: AutomationRun): Promise<AutomationExecutionResult> {
  if (task.id === SYNTHESIS_AUTOMATION_ID || task.kind === "synthesis") {
    const result = await runSystemSynthesis({
      promptSteps: task.promptSteps,
      timeoutMs: task.timeoutMs,
      automationTaskId: task.id,
      automationRunId: run.id,
    });

    // Post-synthesis: warm caches for system chat + recent agent chats.
    // After synthesis, memory blocks have changed, invalidating most caches.
    // Fire-and-forget — doesn't block the return.
    if (result.success) {
      try {
        const { schedulePostSynthesisWarms } = await import("./cache-warm-queue.js");
        const { listChats, getSettings } = await import("./chat-storage.js");
        const [chats, settings] = await Promise.all([listChats(), getSettings()]);
        const warmCount = Math.max(0, settings.postSynthesisWarmCount ?? 3);
        // Get recent agent chats (all types, ordered by lastModified DESC from listChats)
        const recentAgentChats = chats
          .filter((c) => c.type === "agent")
          .slice(0, warmCount)
          .map((c) => c.id);
        console.log(
          `[automation-runner] post-synthesis warm: ${recentAgentChats.length} agent chats scheduled: ${recentAgentChats.join(", ")}`,
        );
        // Fire-and-forget post-synthesis warms
        schedulePostSynthesisWarms(SYSTEM_CHAT_ID, recentAgentChats).catch((e: any) => {
          console.warn("[automation-runner] Post-synthesis warm failed:", e.message);
        });
      } catch (e: any) {
        console.warn("[automation-runner] Failed to schedule post-synthesis warms:", e.message);
      }
    }

    return { ...result, chatId: "system" };
  }

  if (task.id === WAKE_AUTOMATION_ID || task.kind === "wake") {
    const result = await runWakeCycle({
      promptSteps: task.promptSteps,
      maxIterations: task.maxIterations,
      timeoutMs: task.timeoutMs,
      automationTaskId: task.id,
      automationRunId: run.id,
    });
    return { ...result, chatId: "system" };
  }

  return runPromptAutomation(task, run);
}

export async function runAutomationTask(
  taskOrId: AutomationTask | string,
  origin: AutomationRun["origin"] = "scheduler",
): Promise<AutomationExecutionResult> {
  const task = typeof taskOrId === "string" ? getAutomationTask(taskOrId) : taskOrId;
  if (!task) return makeErrorResult("Automation task not found");

  await acquireAutomationLock(task.id);
  let run: AutomationRun | null = null;
  try {
    run = startAutomationRun(task.id, origin);
    const result = await executeAutomation(task, run);
    await sendAutomationPush(task, result);
    finishAutomationRun(run.id, result.success ? "success" : "failed", {
      error: result.error,
      summary: result.summary,
      toolCallCount: result.toolCalls.length,
      chatId: result.chatId,
      assistantMessageIndex: result.assistantMessageIndex,
    });
    return result;
  } catch (e: any) {
    const result = makeErrorResult(e?.message || "Automation failed");
    if (run) {
      finishAutomationRun(run.id, "failed", { error: result.error });
    }
    return result;
  } finally {
    releaseAutomationLock(task.id);
  }
}
