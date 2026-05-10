import type { AgentContext, AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, Model, StopReason, ToolCall } from "@mariozechner/pi-ai";
import type { Chat, ChatMessage, ChatToolResult, ImageAttachment } from "../types.js";
import { chatMessagesToPiMessages, type ReplayModelIdentity } from "./agent.js";
import { estimateContextTokens } from "./compaction.js";
import type { SynthesisEmitter } from "./synthesis-stream.js";
import { createSafeStreamFn } from "./llm-stream.js";
import { createAgentLoopConfig, runAgentLoop } from "./agent-loop-runner.js";

export interface HeadlessFollowUp {
  message: ChatMessage;
  llmMessage?: Message;
  label?: string;
}

export interface HeadlessTurnState {
  iterations: number;
  stopReason: StopReason;
  textSummary: string;
  thinking: string;
  toolCalls: ToolCall[];
  memoryUpdates: string[];
}

export interface HeadlessChatTurnOptions {
  chat: Chat;
  modelId: string;
  model: Model<string>;
  systemPrompt: string;
  tools: AgentTool[];
  emitter: SynthesisEmitter;
  maxIterations: number;
  timeoutMs: number;
  keepAlive?: string | number;
  logPrefix: string;
  saveChat: (chat: Chat) => Promise<void>;
  getFollowUp?: (state: HeadlessTurnState) => Promise<HeadlessFollowUp | null>;
  summarize?: (state: HeadlessTurnState) => string;
  decorateAssistantMessage?: (message: ChatMessage, state: HeadlessTurnState) => ChatMessage;
  /** When true, the caller is responsible for building and persisting the final
   * assistant message. The turn still returns the message in the result but
   * does NOT push it to chat.messages, save, or emit `done`. Used by multi-phase
   * synthesis to combine all phases into a single chat message. */
  skipMessagePersistence?: boolean;
}

export interface HeadlessChatTurnResult extends HeadlessTurnState {
  summary: string;
  assistantMessage: ChatMessage;
  assistantMessageIndex: number;
  success: boolean;
  error?: string;
}

function isPlaceholderEllipsis(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s/g, "").replace(/…/g, "...");
  return normalized.length > 0 && /^(\.{3})+$/.test(normalized);
}

function stripPlaceholderEllipsisBlocks(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((block) => !isPlaceholderEllipsis(block))
    .join("\n\n");
}

function extractTextFromAssistantMessage(msg: AssistantMessage): string {
  return stripPlaceholderEllipsisBlocks(
    msg.content
      .filter((block) => block.type === "text" && block.text && !isPlaceholderEllipsis(block.text))
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(""),
  );
}

function extractThinkingFromAssistantMessage(msg: AssistantMessage): string {
  return msg.content
    .filter((block) => block.type === "thinking" && block.thinking && !isPlaceholderEllipsis(block.thinking))
    .map((block) => (block.type === "thinking" ? block.thinking : ""))
    .join("\n");
}

function extractToolCallsFromAssistantMessage(msg: AssistantMessage): ToolCall[] {
  return msg.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      type: "toolCall" as const,
      id: block.id,
      name: block.name,
      arguments: block.arguments,
      thoughtSignature: block.thoughtSignature,
    }));
}

function usageFromAssistantMessage(msg: AssistantMessage): ChatMessage["usage"] | undefined {
  return msg.usage
    ? { input: msg.usage.input, output: msg.usage.output, totalTokens: msg.usage.totalTokens }
    : undefined;
}

function resultText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text || "")
    .join("\n");
}

function resultImages(result: any, toolCallId: string): ImageAttachment[] | undefined {
  const content = Array.isArray(result?.content) ? result.content : [];
  const images = content
    .filter((c: any) => c?.type === "image" && c.data && c.mimeType)
    .map((c: any) => ({
      data: c.data,
      mimeType: c.mimeType,
      name: `generated-${toolCallId}.jxl`,
    }));
  return images.length ? images : undefined;
}

function defaultSummary(state: HeadlessTurnState): string {
  return state.textSummary ||
    `*The run ended without visible output (stopReason=${state.stopReason}).*`;
}

export async function runHeadlessChatTurn(
  options: HeadlessChatTurnOptions,
): Promise<HeadlessChatTurnResult> {
  const {
    chat,
    modelId,
    model,
    systemPrompt,
    tools,
    emitter,
    maxIterations,
    timeoutMs,
    keepAlive,
    logPrefix,
    saveChat,
  } = options;

  const replayIdentity: ReplayModelIdentity = {
    api: String(model.api),
    provider: String(model.provider),
    model: model.id,
  };
  const contextMessages = chatMessagesToPiMessages(chat.messages, modelId, replayIdentity);
  const context: AgentContext = {
    systemPrompt,
    messages: [...contextMessages],
    tools,
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.error(`[${logPrefix}] turn timeout after ${timeoutMs}ms`);
    controller.abort();
  }, timeoutMs);

  const textChunks: string[] = [];
  const thinkingChunks: string[] = [];
  const allToolCalls: ToolCall[] = [];
  const memoryUpdates: string[] = [];
  let stopReason: StopReason = "stop";
  let iterations = 0;
  let duplicateToolCallStreak = 0;
  let lastToolCallSignature: string | null = null;

  const currentState = (): HeadlessTurnState => ({
    iterations,
    stopReason,
    textSummary: textChunks.join("\n\n").trim(),
    thinking: thinkingChunks.join("\n\n"),
    toolCalls: allToolCalls,
    memoryUpdates,
  });

  const config = createAgentLoopConfig({
    model,
    keepAlive,
    getFollowUpMessages: async () => {
      if (controller.signal.aborted || iterations >= maxIterations) return [];
      const followUp = await options.getFollowUp?.(currentState());
      if (!followUp) return [];
      chat.messages.push(followUp.message);
      await saveChat(chat);
      if (followUp.label) {
        console.log(`[${logPrefix}] follow-up injected: ${followUp.label}`);
      }
      return [
        followUp.llmMessage || {
          role: "user" as const,
          content: followUp.message.content,
          timestamp: followUp.message.timestamp,
        },
      ];
    },
  });

  try {
    await runAgentLoop({
      mode: "continue",
      context,
      config,
      signal: controller.signal,
      streamFn: createSafeStreamFn(chat.ollamaOptions),
      logPrefix,
      onEvent: async (event) => {
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") {
            emitter.emitTextDelta(update.delta);
          } else if (update.type === "thinking_delta") {
            emitter.emitThinkingDelta(update.delta);
          }
        } else if (event.type === "tool_execution_start") {
          const toolCall: ToolCall = {
            type: "toolCall",
            id: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
          };
          allToolCalls.push(toolCall);
          emitter.emitToolCall({
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          });
        } else if (event.type === "tool_execution_end") {
          const content = resultText(event.result);
          if (content.toLowerCase().includes("memory saved")) {
            memoryUpdates.push(content.slice(0, 200));
          }
          const toolResult: ChatToolResult = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content,
            isError: event.isError,
            images: resultImages(event.result, event.toolCallId),
          };
          emitter.emitToolResult(toolResult);
        } else if (event.type === "turn_end") {
          const msg = event.message as AssistantMessage;
          stopReason = msg.stopReason || "stop";
          iterations++;

          const text = extractTextFromAssistantMessage(msg);
          const thinking = extractThinkingFromAssistantMessage(msg);
          const turnToolCalls = extractToolCallsFromAssistantMessage(msg);
          if (text) {
            textChunks.push(text);
            emitter.emitTextDelta("\n\n");
          }
          if (thinking) thinkingChunks.push(thinking);
          emitter.setUsage(usageFromAssistantMessage(msg));

          const estimatedTokens = estimateContextTokens(chat.messages, systemPrompt, tools);
          emitter.emitIteration({
            iteration: iterations,
            stopReason,
            toolCount: event.toolResults?.length || 0,
            usage: emitter.state.finalUsage,
            estimatedTokens,
          });

          if (turnToolCalls.length > 0) {
            const sig = JSON.stringify(turnToolCalls.map((c) => ({ name: c.name, args: c.arguments })));
            duplicateToolCallStreak = sig === lastToolCallSignature ? duplicateToolCallStreak + 1 : 1;
            lastToolCallSignature = sig;
            if (duplicateToolCallStreak >= 3) {
              const names = turnToolCalls.map((c) => c.name).join(", ");
              console.warn(`[${logPrefix}] duplicate tool call streak hit ${duplicateToolCallStreak}: ${names}`);
              emitter.emitWarning({
                type: "duplicate_tool_call",
                message: `Stopped - model called the same tool ${duplicateToolCallStreak} times in a row (${names})`,
              });
              controller.abort();
            }
          } else {
            duplicateToolCallStreak = 0;
            lastToolCallSignature = null;
          }

          if (iterations >= maxIterations) {
            console.warn(`[${logPrefix}] hit iteration cap (${maxIterations}), aborting`);
            emitter.emitWarning({
              type: "iteration_limit",
              message: `Stopped - reached ${maxIterations} iteration limit`,
            });
            controller.abort();
          }
        }
      },
    });
  } catch (e: any) {
    console.error(`[${logPrefix}] agent loop failed:`, e?.message || e);
    stopReason = "error";
  } finally {
    clearTimeout(timeout);
  }

  const state = currentState();
  const summary = (options.summarize || defaultSummary)(state);
  const assistantMessage = options.decorateAssistantMessage
    ? options.decorateAssistantMessage(emitter.buildAssistantMessage(state.thinking, summary), state)
    : emitter.buildAssistantMessage(state.thinking, summary);
  assistantMessage._api = replayIdentity.api;
  assistantMessage._provider = replayIdentity.provider;
  assistantMessage._model = replayIdentity.model;

  let assistantMessageIndex = -1;
  if (options.skipMessagePersistence) {
    // Caller owns persistence — don't push/save/emit-done here.
    // The emitter's state (segments, toolCalls, etc.) continues accumulating
    // across phases and will be captured by the caller's single final message.
  } else {
    chat.messages.push(assistantMessage);
    await saveChat(chat);
    assistantMessageIndex = chat.messages.length - 1;
    emitter.emitDone(assistantMessage, iterations);
  }

  const stopReasonText = String(stopReason);
  const producedNothing =
    (stopReasonText === "error" || stopReasonText === "aborted") &&
    state.textSummary.length === 0 &&
    state.thinking.length === 0 &&
    allToolCalls.length === 0;

  return {
    ...state,
    summary,
    assistantMessage,
    assistantMessageIndex,
    success: !producedNothing,
    ...(producedNothing
      ? { error: `Model returned ${stopReasonText} before producing any output` }
      : {}),
  };
}
