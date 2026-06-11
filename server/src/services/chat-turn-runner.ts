import type { AgentContext, AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, Model, StopReason, ToolCall } from "@mariozechner/pi-ai";
import { randomUUID } from "crypto";
import type { Chat, ChatMessage, ChatToolResult, ImageAttachment } from "../types.js";
import { chatMessagesToHydratedPiMessages, type ReplayModelIdentity } from "./agent.js";
import { estimateContextTokens } from "./compaction.js";
import type { SynthesisEmitter } from "./synthesis-stream.js";
import { createSafeStreamFn } from "./llm-stream.js";
import { createAgentLoopConfig, runAgentLoop } from "./agent-loop-runner.js";
import { PassiveMemoryRecallController } from "./passive-memory-recall.js";
import { saveToolResultImage, stripToolResultImageData } from "./tool-result-image-storage.js";

const PASSIVE_RECALL_TRANSIENT_ASSISTANT_CHARS = 360;

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
  /** Persist the assistant output accumulated since the previous follow-up
   * before injecting the next follow-up message. This preserves multi-step
   * headless transcripts as user -> assistant -> user -> assistant rows while
   * still running in one live pi-agent loop. */
  persistIntermediateAssistantMessages?: boolean;
  maxIterationsPerAssistantSegment?: number;
  passiveMemoryRecall?: {
    enabled?: boolean;
    chatType?: string;
    projectId?: string;
    decorateMessage?: (message: ChatMessage) => ChatMessage;
    /** Called when a post-turn recall injection becomes ready. */
    onRecallReady?: (content: string, memoryIds: string[]) => Promise<void> | void;
  };
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

function imageExtensionForMimeType(mimeType: string | undefined): string {
  switch ((mimeType || "").toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/jxl":
      return "jxl";
    default:
      return "bin";
  }
}

async function resultImages(result: any, toolCallId: string): Promise<ImageAttachment[] | undefined> {
  const content = Array.isArray(result?.content) ? result.content : [];
  const images = content
    .filter((c: any) => c?.type === "image" && c.data && c.mimeType)
    .map((c: any) => ({
      data: c.data,
      mimeType: c.mimeType,
      name: `tool-result-${toolCallId}.${imageExtensionForMimeType(c.mimeType)}`,
    }));
  if (!images.length) return undefined;

  return Promise.all(images.map(async (image: ImageAttachment) => {
    if (image.id && image.url) return stripToolResultImageData(image);
    if (!image.data) return image;
    try {
      const record = await saveToolResultImage(
        randomUUID(),
        Buffer.from(image.data, "base64"),
        image.mimeType,
        image.name,
      );
      return {
        mimeType: image.mimeType,
        name: image.name,
        id: record.id,
        url: record.url,
      };
    } catch (error) {
      console.warn("[tool-result-images] Failed to persist headless tool image:", error instanceof Error ? error.message : error);
      return image;
    }
  }));
}

function defaultSummary(state: HeadlessTurnState): string {
  return state.textSummary ||
    `*The run ended without visible output (stopReason=${state.stopReason}).*`;
}

function joinChunks(chunks: string[]): string {
  return chunks.join("\n\n").trim();
}

function clampTransientAssistantText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PASSIVE_RECALL_TRANSIENT_ASSISTANT_CHARS) return trimmed;
  return `${trimmed.slice(0, PASSIVE_RECALL_TRANSIENT_ASSISTANT_CHARS)}\n[truncated]`;
}

export function splitAssistantMessageIntoCanonicalToolLoopRows(
  message: ChatMessage,
  toolLoopId: string = randomUUID(),
): ChatMessage[] {
  if (!message.toolCalls?.length) return [message];

  const {
    content,
    thinking,
    thinkingDurationMs,
    toolCalls,
    toolResults,
    usage,
    artifacts,
    visuals,
    generatedImages,
    segments,
    ...base
  } = message;

  const fragment: ChatMessage = {
    ...base,
    role: "assistant",
    content: "",
    ...(thinking ? { thinking } : {}),
    ...(thinkingDurationMs ? { thinkingDurationMs } : {}),
    toolCalls,
    ...(toolResults?.length ? { toolResults } : {}),
    ...(artifacts?.length ? { artifacts } : {}),
    ...(visuals?.length ? { visuals } : {}),
    ...(generatedImages?.length ? { generatedImages } : {}),
    timestamp: message.timestamp,
    _toolLoopId: toolLoopId,
    _toolLoopFragment: true,
  };

  const hasFinalContent = Boolean(content.trim() || segments?.length);
  if (!hasFinalContent) {
    return [fragment];
  }

  const finalRow: ChatMessage = {
    ...base,
    role: "assistant",
    content,
    ...(usage ? { usage } : {}),
    ...(segments?.length ? { segments } : {}),
    timestamp: message.timestamp,
    _toolLoopId: toolLoopId,
  };
  delete finalRow._toolLoopFragment;

  return [fragment, finalRow];
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
  const contextMessages = await chatMessagesToHydratedPiMessages(chat.messages, modelId, replayIdentity);
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
  const allToolResults: ChatToolResult[] = [];
  const memoryUpdates: string[] = [];
  let stopReason: StopReason = "stop";
  let iterations = 0;
  let duplicateToolCallStreak = 0;
  let lastToolCallSignature: string | null = null;
  let lastPersistedAssistantBoundary = {
    textChunks: 0,
    thinkingChunks: 0,
    toolCalls: 0,
    toolResults: 0,
    memoryUpdates: 0,
    iterations: 0,
    artifacts: 0,
    visuals: 0,
    generatedImages: 0,
    segments: 0,
  };
  let assistantMessageIndex = -1;
  let finalAssistantMessage: ChatMessage | null = null;
  const persistedAssistantBoundaries: ChatMessage[] = [];
  const persistPostTurnPassiveRecall = async (content: string, memoryIds: string[]) => {
    const rowBase: ChatMessage = {
      role: "system",
      content,
      timestamp: Date.now(),
      _isSystemMessage: true,
      _isPassiveMemoryRecall: true,
      _recalledMemoryIds: memoryIds,
      _mergeIntoNextUserMessage: true,
    };
    const row = options.passiveMemoryRecall?.decorateMessage
      ? options.passiveMemoryRecall.decorateMessage(rowBase)
      : rowBase;
    chat.messages.push(row);
    await saveChat(chat);
  };
  const passiveRecall = options.passiveMemoryRecall?.enabled === false || !options.passiveMemoryRecall
    ? null
    : new PassiveMemoryRecallController(chat.id, {
        onReady: options.passiveMemoryRecall?.onRecallReady ?? persistPostTurnPassiveRecall,
      });

  const currentState = (): HeadlessTurnState => ({
    iterations,
    stopReason,
    textSummary: joinChunks(textChunks),
    thinking: thinkingChunks.join("\n\n"),
    toolCalls: allToolCalls,
    memoryUpdates,
  });

  const stateSinceLastPersistedBoundary = (): HeadlessTurnState => ({
    iterations: iterations - lastPersistedAssistantBoundary.iterations,
    stopReason,
    textSummary: joinChunks(textChunks.slice(lastPersistedAssistantBoundary.textChunks)),
    thinking: thinkingChunks.slice(lastPersistedAssistantBoundary.thinkingChunks).join("\n\n"),
    toolCalls: allToolCalls.slice(lastPersistedAssistantBoundary.toolCalls),
    memoryUpdates: memoryUpdates.slice(lastPersistedAssistantBoundary.memoryUpdates),
  });

  const advancePersistedAssistantBoundary = () => {
    lastPersistedAssistantBoundary = {
      textChunks: textChunks.length,
      thinkingChunks: thinkingChunks.length,
      toolCalls: allToolCalls.length,
      toolResults: allToolResults.length,
      memoryUpdates: memoryUpdates.length,
      iterations,
      artifacts: emitter.state.artifacts.length,
      visuals: emitter.state.visuals.length,
      generatedImages: emitter.state.generatedImages.length,
      segments: emitter.state.segments.length,
    };
  };

  const buildAssistantMessageForState = (
    state: HeadlessTurnState,
    toolResults: ChatToolResult[],
    output: {
      artifacts: ChatMessage["artifacts"];
      visuals: ChatMessage["visuals"];
      generatedImages: ChatMessage["generatedImages"];
      segments: ChatMessage["segments"];
    },
  ): ChatMessage => {
    const summary = (options.summarize || defaultSummary)(state);
    const message: ChatMessage = {
      role: "assistant",
      content: summary,
      thinking: state.thinking || undefined,
      usage: emitter.state.finalUsage,
      toolCalls: state.toolCalls.length > 0
        ? state.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        }))
        : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      artifacts: output.artifacts && output.artifacts.length > 0 ? output.artifacts : undefined,
      visuals: output.visuals && output.visuals.length > 0 ? output.visuals : undefined,
      generatedImages: output.generatedImages && output.generatedImages.length > 0
        ? output.generatedImages
        : undefined,
      segments: output.segments && output.segments.length > 0 ? output.segments : undefined,
      timestamp: Date.now(),
      _isSystemMessage: true,
    };
    const decorated = options.decorateAssistantMessage
      ? options.decorateAssistantMessage(message, state)
      : message;
    decorated._api = replayIdentity.api;
    decorated._provider = replayIdentity.provider;
    decorated._model = replayIdentity.model;
    return decorated;
  };

  const buildPassiveRecallSearchMessages = (): ChatMessage[] => {
    const state = stateSinceLastPersistedBoundary();
    const toolResults = allToolResults.slice(lastPersistedAssistantBoundary.toolResults);
    if (
      state.iterations === 0 &&
      state.textSummary.length === 0 &&
      state.thinking.length === 0 &&
      state.toolCalls.length === 0 &&
      toolResults.length === 0
    ) {
      return chat.messages;
    }

    const transientAssistant: ChatMessage = {
      role: "assistant",
      content: clampTransientAssistantText(state.textSummary),
      thinking: state.thinking || undefined,
      toolCalls: state.toolCalls.length > 0
        ? state.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        }))
        : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      timestamp: Date.now(),
    };
    return [...chat.messages, transientAssistant];
  };

  const persistAssistantSinceLastBoundary = async (): Promise<ChatMessage | null> => {
    emitter.flushPendingText();
    const state = stateSinceLastPersistedBoundary();
    const toolResults = allToolResults.slice(lastPersistedAssistantBoundary.toolResults);
    const output = {
      artifacts: emitter.state.artifacts.slice(lastPersistedAssistantBoundary.artifacts),
      visuals: emitter.state.visuals.slice(lastPersistedAssistantBoundary.visuals),
      generatedImages: emitter.state.generatedImages.slice(lastPersistedAssistantBoundary.generatedImages),
      segments: emitter.state.segments.slice(lastPersistedAssistantBoundary.segments),
    };
    if (
      state.iterations === 0 &&
      state.textSummary.length === 0 &&
      state.thinking.length === 0 &&
      state.toolCalls.length === 0 &&
      toolResults.length === 0 &&
      output.artifacts.length === 0 &&
      output.visuals.length === 0 &&
      output.generatedImages.length === 0 &&
      output.segments.length === 0
    ) {
      advancePersistedAssistantBoundary();
      return null;
    }

    const rows = splitAssistantMessageIntoCanonicalToolLoopRows(buildAssistantMessageForState(state, toolResults, output));
    chat.messages.push(...rows);
    persistedAssistantBoundaries.push(...rows);
    await saveChat(chat);
    assistantMessageIndex = chat.messages.length - 1;
    finalAssistantMessage = rows[rows.length - 1];
    advancePersistedAssistantBoundary();
    return finalAssistantMessage;
  };

  const discardPersistedAssistantBoundaries = () => {
    if (persistedAssistantBoundaries.length === 0) return;
    const boundaries = new Set(persistedAssistantBoundaries);
    const before = chat.messages.length;
    chat.messages = chat.messages.filter((message) => !boundaries.has(message));
    const removed = before - chat.messages.length;
    if (removed > 0) {
      console.log(
        `[${logPrefix}] discarded ${removed} temporary assistant boundary row${
          removed === 1 ? "" : "s"
        } before final persistence`,
      );
    }
    persistedAssistantBoundaries.length = 0;
    finalAssistantMessage = null;
    assistantMessageIndex = -1;
  };

  const applyPassiveMemoryRecall = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (!passiveRecall) return messages;
    const injection = passiveRecall.peekReady(iterations);
    if (!injection) return messages;

    // Persist the assistant/tool work that preceded this recall before adding
    // the hidden row. Replay will then reconstruct the same boundary the live
    // model sees: assistant work -> synthetic user memory context -> assistant.
    await persistAssistantSinceLastBoundary();

    const timestamp = Date.now();
    const rowBase: ChatMessage = {
      role: "system",
      content: injection.content,
      timestamp,
      _isSystemMessage: true,
      _isPassiveMemoryRecall: true,
      _recalledMemoryIds: injection.memoryIds,
    };
    const row = options.passiveMemoryRecall?.decorateMessage
      ? options.passiveMemoryRecall.decorateMessage(rowBase)
      : rowBase;
    const agentMessage = passiveRecall.toReplayUserMessage({
      ...injection,
      createdAt: timestamp,
    });
    if (!agentMessage) return messages;

    try {
      chat.messages.push(row);
      await saveChat(chat);
      messages.push(agentMessage);
      passiveRecall.markApplied(injection, iterations);
      console.log(
        `[${logPrefix}] passive memory injected ${injection.memoryIds.length} recalled memor${
          injection.memoryIds.length === 1 ? "y" : "ies"
        } before provider call at iteration ${iterations}`,
      );
    } catch (err) {
      const idx = chat.messages.indexOf(row);
      if (idx >= 0) chat.messages.splice(idx, 1);
      console.warn(`[${logPrefix}] failed to persist passive memory recall:`, err);
    }
    return messages;
  };

  const config = createAgentLoopConfig({
    model,
    keepAlive,
    transformContext: passiveRecall ? applyPassiveMemoryRecall : undefined,
    getFollowUpMessages: async () => {
      if (controller.signal.aborted || iterations >= maxIterations) return [];
      const followUp = await options.getFollowUp?.(currentState());
      if (!followUp) return [];
      if (options.persistIntermediateAssistantMessages) {
        await persistAssistantSinceLastBoundary();
      }
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
      streamFn: createSafeStreamFn(),
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
            images: await resultImages(event.result, event.toolCallId),
          };
          allToolResults.push(toolResult);
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

          passiveRecall?.schedule({
            iteration: iterations,
            stopReason,
            chatMessages: buildPassiveRecallSearchMessages(),
            chatType: options.passiveMemoryRecall?.chatType || "system",
            projectId: options.passiveMemoryRecall?.projectId ?? chat.projectId,
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
          } else if (
            options.maxIterationsPerAssistantSegment &&
            iterations - lastPersistedAssistantBoundary.iterations >= options.maxIterationsPerAssistantSegment
          ) {
            console.warn(
              `[${logPrefix}] hit segment iteration cap (${options.maxIterationsPerAssistantSegment}), aborting`,
            );
            emitter.emitWarning({
              type: "iteration_limit",
              message: `Stopped - reached ${options.maxIterationsPerAssistantSegment} iteration limit for this phase`,
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
  const finalBoundaryState = stateSinceLastPersistedBoundary();
  const finalBoundaryToolResults = allToolResults.slice(lastPersistedAssistantBoundary.toolResults);
  const summary = (options.summarize || defaultSummary)(state);
  let assistantMessage: ChatMessage;
  if (options.persistIntermediateAssistantMessages) {
    assistantMessage = await persistAssistantSinceLastBoundary() ?? finalAssistantMessage ??
      buildAssistantMessageForState(stateSinceLastPersistedBoundary(), [], {
        artifacts: [],
        visuals: [],
        generatedImages: [],
        segments: [],
      });
    const doneMessage = options.decorateAssistantMessage
      ? options.decorateAssistantMessage(emitter.buildAssistantMessage(state.thinking, summary), state)
      : emitter.buildAssistantMessage(state.thinking, summary);
    doneMessage._api = replayIdentity.api;
    doneMessage._provider = replayIdentity.provider;
    doneMessage._model = replayIdentity.model;
    emitter.emitDone(doneMessage, iterations);

    // Post-turn passive recall for persist path
    if (stopReason === "stop") {
      passiveRecall?.schedule({
        iteration: iterations,
        stopReason: "stop",
        chatMessages: chat.messages,
        chatType: options.passiveMemoryRecall?.chatType || chat.type,
        projectId: options.passiveMemoryRecall?.projectId || chat.projectId,
      });
    }
  } else {
    // Passive memory recall may temporarily persist assistant boundaries so the
    // live replay shape is assistant work -> hidden recall -> next provider
    // call. Single-phase callers still want one durable final assistant row,
    // so collapse those temporary rows before saving the complete message.
    discardPersistedAssistantBoundaries();
    const aggregateAssistantMessage = options.decorateAssistantMessage
      ? options.decorateAssistantMessage(emitter.buildAssistantMessage(state.thinking, summary), state)
      : emitter.buildAssistantMessage(state.thinking, summary);
    aggregateAssistantMessage._api = replayIdentity.api;
    aggregateAssistantMessage._provider = replayIdentity.provider;
    aggregateAssistantMessage._model = replayIdentity.model;
    const assistantRows = splitAssistantMessageIntoCanonicalToolLoopRows(aggregateAssistantMessage);
    chat.messages.push(...assistantRows);
    assistantMessage = assistantRows[assistantRows.length - 1];
    await saveChat(chat);
    assistantMessageIndex = chat.messages.length - 1;

    // Post-turn passive recall: for conversational stops, schedule an async
    // search now. The onReady callback (if provided) handles persistence after
    // the turn ends, injecting before the next follow-up.
    if (stopReason === "stop") {
      passiveRecall?.schedule({
        iteration: iterations,
        stopReason: "stop",
        chatMessages: chat.messages,
        chatType: options.passiveMemoryRecall?.chatType || chat.type,
        projectId: options.passiveMemoryRecall?.projectId || chat.projectId,
      });
    }

    emitter.emitDone(aggregateAssistantMessage, iterations);
  }

  const stopReasonText = String(stopReason);
  const failureState = options.persistIntermediateAssistantMessages ? finalBoundaryState : state;
  const producedNothing =
    (stopReasonText === "error" || stopReasonText === "aborted") &&
    failureState.textSummary.length === 0 &&
    failureState.thinking.length === 0 &&
    failureState.toolCalls.length === 0 &&
    (!options.persistIntermediateAssistantMessages || finalBoundaryToolResults.length === 0);

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
