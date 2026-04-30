import type { Message, StopReason, ToolCall } from "@mariozechner/pi-ai";
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
  const { discoverAllModels } = await import("./models.js");
  const { streamChat, chatMessagesToPiMessages } = await import("./agent.js");
  const { getAgentTools } = await import("./agent-tools.js");
  const { truncateBeforeSend, estimateContextTokens } = await import("./compaction.js");
  const { buildStablePrefix, invalidateAllStablePrefixCaches } = await import("./memory-context.js");
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

    const { stablePrefix } = await buildStablePrefix(
      chat.systemPrompt || "You are a helpful assistant.",
      task.chatId,
    );
    const systemPrompt = stablePrefix;

    const artifacts: any[] = [];
    const visuals: any[] = [];
    const generatedImages: any[] = [];
    const memoryUpdates: string[] = [];

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

    const piMessages = chatMessagesToPiMessages(chat.messages, modelId);
    const messages: Message[] = [...piMessages];
    const textChunks: string[] = [];
    const thinkingChunks: string[] = [];
    const allToolCalls: ToolCall[] = [];
    let stopReason: StopReason = "stop";
    let iterations = 0;
    let stepIndex = 0;

    while (iterations < task.maxIterations) {
      const iterationToolCalls: ToolCall[] = [];
      let assistantMessage: Message | undefined;
      let streamResult: any;

      try {
        streamResult = await streamChat(
          modelId,
          messages,
          systemPrompt,
          (event) => {
            if (event.type === "text_delta") {
              emitter.emitTextDelta(event.delta);
            } else if (event.type === "thinking_delta") {
              emitter.emitThinkingDelta(event.delta);
            } else if (event.type === "toolcall_end") {
              iterationToolCalls.push(event.toolCall);
              emitter.emitToolCall({
                id: event.toolCall.id,
                name: event.toolCall.name,
                arguments: event.toolCall.arguments,
              });
            }
          },
          {
            signal: AbortSignal.timeout(task.timeoutMs),
            tools,
            keepAlive: `${Math.max(1, Math.ceil(task.timeoutMs / 60_000))}m`,
          },
        );

        if (streamResult.content) textChunks.push(streamResult.content);
        if (streamResult.thinking) thinkingChunks.push(streamResult.thinking);
        if (streamResult.toolCalls) allToolCalls.push(...streamResult.toolCalls);
        stopReason = streamResult.stopReason;
        assistantMessage = streamResult.assistantMessage;
        emitter.setUsage(streamResult.usage);
      } catch (e: any) {
        console.error(`[automation] ${task.id} stream failed at iter ${iterations}:`, e.message);
        stopReason = "error";
        break;
      }

      const hasOutput = (streamResult?.content?.length ?? 0) > 0;
      const hasToolCalls = iterationToolCalls.length > 0;
      if (iterations === 0 && !hasOutput && !hasToolCalls) {
        console.log(`[automation] ${task.id} produced no output, ending`);
        break;
      }

      if (assistantMessage) messages.push(assistantMessage);

      for (const toolCall of iterationToolCalls) {
        const toolDef = tools.find((t) => t.name === toolCall.name);
        if (!toolDef) continue;
        try {
          const result = await toolDef.execute(toolCall.id, toolCall.arguments);
          const content = result.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("\n");
          if (content.toLowerCase().includes("memory saved")) {
            memoryUpdates.push(content.slice(0, 200));
          }
          const toolResult = {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content,
            isError: false,
          };
          emitter.emitToolResult(toolResult);
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: content }],
            isError: false,
            timestamp: Date.now(),
          } as Message);
        } catch (e: any) {
          console.warn(`[automation] ${task.id} tool ${toolCall.name} failed:`, e.message);
          const toolResult = {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: `Error: ${e.message}`,
            isError: true,
          };
          emitter.emitToolResult(toolResult);
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
            timestamp: Date.now(),
          } as Message);
        }
      }

      if (hasOutput) {
        emitter.emitTextDelta("\n\n");
      }

      emitter.emitIteration({
        iteration: iterations + 1,
        stopReason,
        toolCount: iterationToolCalls.length,
        usage: emitter.state.finalUsage,
        estimatedTokens: estimateContextTokens(chat.messages, systemPrompt, tools),
      });

      let transitioned = false;
      if (!hasToolCalls && stepIndex < steps.length - 1) {
        stepIndex++;
        const nextTrigger = formatAutomationTrigger(task, steps[stepIndex]);
        chat.messages.push(makeTriggerMessage(task, run, nextTrigger));
        messages.push({
          role: "user",
          content: [{ type: "text", text: nextTrigger }],
          timestamp: Date.now(),
        } as Message);
        transitioned = true;
        console.log(`[automation] ${task.id} step ${stepIndex + 1}/${steps.length} trigger injected`);
      }

      if (!transitioned && !hasToolCalls) {
        break;
      }

      iterations++;
    }

    const textSummary = textChunks.join("\n\n").trim();
    const thinking = thinkingChunks.join("\n\n");
    const summary = textSummary || `*The automation ended without visible output (stopReason=${stopReason}).*`;
    const assistantChatMsg: ChatMessage = {
      ...emitter.buildAssistantMessage(thinking, summary),
      timestamp: Date.now(),
      _isAutomationMessage: true,
      _automationTaskId: task.id,
      _automationRunId: run.id,
    };
    chat.messages.push(assistantChatMsg);
    await saveChat(chat);
    const assistantMessageIndex = chat.messages.length - 1;

    emitter.emitDone(assistantChatMsg, iterations);
    await refreshAutomationChatTitle(task, chat, assistantChatMsg.content, (title) => {
      emitter.emitTitleUpdate(title);
    });

    try {
      invalidateAllStablePrefixCaches();
    } catch (e: any) {
      console.warn("[automation] Failed to invalidate stable prefix caches:", e.message);
    }

    emitter.end();

    const producedNothing =
      stopReason === "error" &&
      textSummary.length === 0 &&
      thinking.length === 0 &&
      allToolCalls.length === 0;
    if (producedNothing) {
      return {
        ...makeErrorResult("Automation failed: model returned error before producing any output"),
        chatId: task.chatId,
        assistantMessageIndex,
      };
    }

    return {
      summary,
      thinking,
      toolCalls: allToolCalls,
      artifacts,
      visuals,
      generatedImages,
      memoryUpdates,
      success: true,
      chatId: task.chatId,
      assistantMessageIndex,
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
      automationTaskId: task.id,
      automationRunId: run.id,
    });
    return { ...result, chatId: "system" };
  }

  if (task.id === WAKE_AUTOMATION_ID || task.kind === "wake") {
    const result = await runWakeCycle({
      promptSteps: task.promptSteps,
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
  const run = startAutomationRun(task.id, origin);
  try {
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
    finishAutomationRun(run.id, "failed", { error: result.error });
    return result;
  } finally {
    releaseAutomationLock(task.id);
  }
}
