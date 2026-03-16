import { Router } from "express";
import type { Request, Response } from "express";
import type { Message, ToolCall, ToolResultMessage, AssistantMessage } from "@mariozechner/pi-ai";
import { streamSimple, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";
import type { AgentContext, AgentLoopConfig, StreamFn } from "@mariozechner/pi-agent-core";
import { getChat, saveChat } from "../services/storage.js";
import { chatMessagesToPiMessages } from "../services/agent.js";
import { createPiModel, discoverOllamaModels } from "../services/models.js";
import { extractMemories, preCompactionFlush } from "../services/memory-extraction.js";
import { generateTitle } from "../services/title-generation.js";
import { truncateChatHistory, truncateBeforeSend } from "../services/compaction.js";
import { buildMemoryAugmentedPrompt, setCachedAugmentedPrompt } from "../services/memory-context.js";
import { getAgentTools } from "../services/agent-tools.js";
import type { ToolSideEffects } from "../services/agent-tools.js";
import { parseSkillInvocations, buildSkillAugmentedPrompt, discoverSkills } from "../services/skills.js";
import type { Skill } from "../services/skills.js";
import {
  loadPendingState,
  savePendingState,
} from "../services/agent-state.js";
import * as messageQueue from "../services/message-queue.js";
import type { Artifact, Chat, ChatMessage, ChatToolCall, ChatToolResult, GeneratedImage, ImageAttachment, InlineVisual } from "../types.js";
import { saveUserImage } from "../services/user-image-storage.js";

/** Truncate a string to maxChars graphemes, preserving emoji and multi-byte characters */
function truncateTitle(text: string, maxChars: number = 50): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = segmenter.segment(text);
  let result = "";
  let count = 0;
  for (const { segment } of segments) {
    if (count >= maxChars) return result + "...";
    result += segment;
    count++;
  }
  return result;
}

/** Build a pi-ai Message from user input (text and/or images) */
function buildUserPiMessage(message: string, images?: ImageAttachment[]): Message {
  if (images?.length) {
    const content: any[] = [];
    if (message) content.push({ type: "text", text: message });
    for (const img of images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    return { role: "user", content, timestamp: Date.now() };
  }
  return { role: "user", content: message, timestamp: Date.now() };
}

/** Persist images to disk and enrich attachments with id/url/thumbUrl (fire-and-forget safe) */
async function persistImages(images: ImageAttachment[]): Promise<ImageAttachment[]> {
  return Promise.all(
    images.map(async (img) => {
      if (img.id && img.url && img.thumbUrl) return img; // already persisted
      try {
        const buffer = Buffer.from(img.data, "base64");
        const id = crypto.randomUUID();
        const record = await saveUserImage(id, buffer, img.mimeType, img.name);
        return { ...img, id: record.id, url: record.url, thumbUrl: record.thumbUrl };
      } catch (e) {
        console.error("[user-images] Failed to persist image:", e);
        return img; // keep original base64-only attachment on failure
      }
    })
  );
}

/**
 * Create a stream function that handles pre-aborted signals gracefully.
 * When the signal is already aborted (e.g., ask_user triggered abort),
 * returns an event stream that immediately emits an abort error
 * instead of letting the fetch call throw.
 */
function createSafeStreamFn(): StreamFn {
  return (model, ctx, options) => {
    if (options?.signal?.aborted) {
      console.log(`[stream] signal already aborted, returning empty abort stream`);
      const stream = createAssistantMessageEventStream();
      const msg: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "aborted",
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "aborted", error: msg });
      return stream;
    }
    return streamSimple(model, ctx, options);
  };
}

const router = Router();

/**
 * Shared SSE streaming handler using pi-agent-core's agentLoop.
 * Both POST / (send) and POST /edit call this after their own setup.
 *
 * @param userPiMessage - the user's prompt message for agentLoop, or null for resume (agentLoopContinue)
 * @param contextMessages - conversation history (pi-ai Messages), excluding current user message for fresh, or full pending state for resume
 */
async function handleChatStream(
  chat: Chat,
  userMessage: string,
  contextMessages: Message[],
  systemPrompt: string,
  userPiMessage: Message | null,
  req: Request,
  res: Response
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Disable Nagle's algorithm so each res.write() sends immediately
  // instead of batching small SSE events into fewer TCP packets
  res.socket?.setNoDelay(true);

  const connectionAbortController = new AbortController();
  req.on("close", () => connectionAbortController.abort());

  const MAX_ITERATIONS = 500;

  // Track ordering for interleaved display
  interface OutputSegment {
    seq: number;
    type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual";
    content?: string;
    toolCall?: ChatToolCall;
    toolResult?: ChatToolResult;
    artifact?: Artifact;
    generatedImage?: GeneratedImage;
    visual?: InlineVisual;
  }

  // Mutable accumulator state — reset between follow-up turns
  const state = {
    fullText: "",
    thinkingText: "",
    allToolCalls: [] as ChatToolCall[],
    allToolResults: [] as ChatToolResult[],
    allArtifacts: [] as Artifact[],
    allVisuals: [] as InlineVisual[],
    allGeneratedImages: [] as GeneratedImage[],
    segments: [] as OutputSegment[],
    seqCounter: 0,
    pendingText: "",
    finalUsage: undefined as ChatMessage["usage"],
    // Track if last turn ended with toolUse but no final text
    incompleteToolTurn: false,
  };

  function resetAccumulators() {
    state.fullText = "";
    state.thinkingText = "";
    state.allToolCalls = [];
    state.allToolResults = [];
    state.allArtifacts = [];
    state.allVisuals = [];
    state.allGeneratedImages = [];
    state.segments = [];
    state.seqCounter = 0;
    state.pendingText = "";
    state.finalUsage = undefined;
    state.incompleteToolTurn = false;
  }

  function buildCurrentAssistantMessage(): ChatMessage {
    // Flush any remaining text
    if (state.pendingText.trim()) {
      state.segments.push({ seq: ++state.seqCounter, type: "text", content: state.pendingText });
    }
    state.pendingText = "";

    return {
      role: "assistant",
      content: state.fullText,
      thinking: state.thinkingText || undefined,
      usage: state.finalUsage,
      toolCalls: state.allToolCalls.length > 0 ? state.allToolCalls : undefined,
      toolResults: state.allToolResults.length > 0 ? state.allToolResults : undefined,
      artifacts: state.allArtifacts.length > 0 ? state.allArtifacts : undefined,
      visuals: state.allVisuals.length > 0 ? state.allVisuals : undefined,
      generatedImages: state.allGeneratedImages.length > 0 ? state.allGeneratedImages : undefined,
      segments: state.segments.length > 0 ? state.segments : undefined,
      timestamp: Date.now(),
    };
  }

  /** Flush any accumulated text into a text segment */
  function flushTextSegment() {
    if (state.pendingText.trim()) {
      state.segments.push({ seq: ++state.seqCounter, type: "text", content: state.pendingText });
    }
    state.pendingText = "";
  }

  // Create a turn-level abort controller to prevent signal bleeding across iterations
  // This is separate from connectionAbortController which handles SSE disconnect
  const turnAbortController = new AbortController();

  // ask_user state — owned by the route, set via callback.
  // Uses a ref object so TypeScript can track mutations through closures.
  const askUserRef: { current: { question: string; toolCallId: string } | null } = { current: null };

  // Side-effects bridge between tool execution and SSE output
  const effects: ToolSideEffects = {
    onArtifact: (artifact) => {
      state.allArtifacts.push(artifact);
      state.segments.push({ seq: ++state.seqCounter, type: "artifact", artifact });
      res.write(`event: artifact\ndata: ${JSON.stringify(artifact)}\n\n`);
    },
    onVisual: (visual) => {
      state.allVisuals.push(visual);
      state.segments.push({ seq: ++state.seqCounter, type: "visual", visual });
      res.write(`event: visual\ndata: ${JSON.stringify(visual)}\n\n`);
    },
    onGeneratedImage: (image) => {
      state.allGeneratedImages.push(image);
      state.segments.push({ seq: ++state.seqCounter, type: "generated_image", generatedImage: image });
      res.write(`event: generated_image\ndata: ${JSON.stringify(image)}\n\n`);
    },
    onAskUser: (question, toolCallId) => {
      askUserRef.current = { question, toolCallId };
      turnAbortController.abort(); // Only abort the current turn, not the SSE connection
    },
  };

  const isAgent = chat.type === "agent";
  const agentTools = isAgent ? getAgentTools(chat.id, effects) : undefined;

  let iterations = 0;
  let waitingForInput = false;
  let hitContextLimit = false;
  let lastUserMessage = userMessage; // tracks the current user message text for title gen / memory

  console.log(`[chat] type=${chat.type} tools=${agentTools ? agentTools.map(t => t.name).join(",") : "none"}`);

  try {
    // Discover model
    const ollamaModels = await discoverOllamaModels();
    const ollamaModel = ollamaModels.find(m => m.id === chat.modelId);
    if (!ollamaModel) throw new Error(`Model not found: ${chat.modelId}`);
    const piModel = createPiModel(ollamaModel);

    // Build agent context
    const context: AgentContext = {
      systemPrompt,
      messages: [...contextMessages],
      tools: agentTools,
    };

    const config: AgentLoopConfig = {
      model: piModel,
      apiKey: "ollama",
      reasoning: piModel.reasoning ? "medium" : undefined,
      convertToLlm: (msgs) => msgs as Message[],
      // When ask_user fires, skip remaining tools in the batch cleanly
      // (instead of letting them execute with an aborted signal).
      // The message content doesn't reach the LLM — the abort stops
      // the loop before the next streaming call.
      getSteeringMessages: async () => {
        if (askUserRef.current) {
          return [{ role: "user" as const, content: "[paused for user input]", timestamp: Date.now() }];
        }
        return [];
      },
      getFollowUpMessages: async () => {
        const queued = await messageQueue.drainOne(chat.id);
        if (!queued) return [];

        // Save the completed assistant message and the queued user message
        const assistantMsg = buildCurrentAssistantMessage();
        chat.messages.push(assistantMsg);
        const queuedUserMsg: ChatMessage = {
          role: "user",
          content: queued.message,
          images: queued.images?.length ? queued.images : undefined,
          timestamp: queued.timestamp,
        };
        chat.messages.push(queuedUserMsg);
        await saveChat(chat);

        // Emit events so client can finalize current response and start next
        res.write(`event: message_complete\ndata: ${JSON.stringify({ message: assistantMsg })}\n\n`);
        res.write(`event: follow_up_start\ndata: ${JSON.stringify({ queuedMessageId: queued.id })}\n\n`);

        // Fire-and-forget memory extraction for the just-completed response
        if (chat.type === "agent") {
          extractMemories(chat.modelId, chat.id, lastUserMessage, assistantMsg.content)
            .catch(err => console.error("[memory] extraction failed:", err));
        }

        // Title generation for first exchange
        if (chat.messages.length === 2) {
          generateTitle(lastUserMessage, assistantMsg.content)
            .then(title => {
              if (title) {
                chat.title = title;
                saveChat(chat).catch(() => {});
                res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
              }
            })
            .catch(err => console.warn("[title] generation failed:", err));
        }

        // Reset accumulators for the new response
        resetAccumulators();
        lastUserMessage = queued.message;

        console.log(`[chat] follow-up: draining queued message ${queued.id}`);

        return [{ role: "user" as const, content: queued.message, timestamp: queued.timestamp }];
      },
    };

    const safeStreamFn = createSafeStreamFn();

    // Start the agent loop (uses turnAbortController declared earlier)
    const eventStream = userPiMessage
      ? agentLoop([userPiMessage], context, config, turnAbortController.signal, safeStreamFn)
      : agentLoopContinue(context, config, turnAbortController.signal, safeStreamFn);

    // Process events → SSE
    for await (const event of eventStream) {
      switch (event.type) {
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            state.fullText += ame.delta;
            state.pendingText += ame.delta;
            res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          } else if (ame.type === "thinking_delta") {
            state.thinkingText += ame.delta;
            res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          }
          break;
        }

        case "tool_execution_start": {
          flushTextSegment();
          const toolCall: ChatToolCall = {
            id: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
          };
          state.allToolCalls.push(toolCall);
          if (event.toolName !== "ask_user") {
            console.log(`[tool] Executing ${event.toolName}:`, event.args);
            const segment: OutputSegment = { seq: ++state.seqCounter, type: "tool_call", toolCall };
            state.segments.push(segment);
            res.write(`event: segment\ndata: ${JSON.stringify(segment)}\n\n`);
            res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: "running" })}\n\n`);
          }
          break;
        }

        case "tool_execution_end": {
          // ask_user gets a dedicated SSE event, not tool_status
          if (event.toolName !== "ask_user") {
            const resultText = event.result?.content?.[0]?.text || "";
            const toolResult: ChatToolResult = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              content: resultText,
              isError: event.isError,
            };
            state.allToolResults.push(toolResult);
            // Insert tool_result immediately after its tool_call segment (not at the end),
            // so that visual/artifact segments emitted during tool execution stay after the pair.
            const callIdx = state.segments.findIndex(
              s => s.type === "tool_call" && s.toolCall?.id === event.toolCallId
            );
            const resultSegment: OutputSegment = { seq: ++state.seqCounter, type: "tool_result", toolResult };
            if (callIdx >= 0) {
              state.segments.splice(callIdx + 1, 0, resultSegment);
            } else {
              state.segments.push(resultSegment);
            }
            res.write(`event: segment\ndata: ${JSON.stringify(resultSegment)}\n\n`);
            res.write(`event: tool_status\ndata: ${JSON.stringify({
              name: event.toolName,
              status: event.isError ? "error" : "done",
              result: resultText,
            })}\n\n`);
          }
          break;
        }

        case "turn_end": {
          const msg = event.message as AssistantMessage;
          const stopReason = msg.stopReason || "stop";

          // Handle aborted turns gracefully - they're expected from ask_user
          if (stopReason === "aborted") {
            console.log(`[chat] turn aborted (expected from ask_user or disconnect)`);
            break;
          }

          iterations++;
          
          // Track incomplete tool turns: if stopReason is "toolUse" but no text content followed
          const hasToolCalls = event.toolResults && event.toolResults.length > 0;
          const hasTextContent = state.fullText.trim().length > 0;
          if (stopReason === "toolUse" && hasToolCalls && !hasTextContent) {
            state.incompleteToolTurn = true;
            console.log(`[chat] turn ended with toolUse but no final text - marking incomplete`);
          } else {
            state.incompleteToolTurn = false;
          }
          
          console.log(
            `[chat] iter=${iterations} stop=${stopReason} tools=${event.toolResults?.length || 0}` +
            ` content=${state.fullText.length}ch thinking=${state.thinkingText.length}ch` +
            ` tokens=${msg.usage?.totalTokens || "?"} incomplete=${state.incompleteToolTurn}`,
          );

          res.write(`event: iteration\ndata: ${JSON.stringify({
            iteration: iterations,
            stopReason,
            toolCount: event.toolResults?.length || 0,
          })}\n\n`);

          if (msg.usage) {
            state.finalUsage = {
              input: msg.usage.input,
              output: msg.usage.output,
              totalTokens: msg.usage.totalTokens,
            };
          }

          if (stopReason === "length") {
            hitContextLimit = true;
            console.warn(`[chat] stopped due to context length at iteration ${iterations}`);
            res.write(`event: warning\ndata: ${JSON.stringify({
              type: "context_length",
              message: "Response stopped — context window full",
            })}\n\n`);
          }

          // Guard against runaway tool loops
          if (iterations >= MAX_ITERATIONS) {
            console.warn(`[chat] hit iteration limit (${MAX_ITERATIONS}), aborting`);
            res.write(`event: warning\ndata: ${JSON.stringify({
              type: "iteration_limit",
              message: `Stopped — reached ${MAX_ITERATIONS} iteration limit`,
            })}\n\n`);
            turnAbortController.abort();
          }

          break;
        }
      }
    }

    // --- Post-loop: handle incomplete tool turns, ask_user, build message, compaction ---

    // If the last turn ended with toolUse but no final text, continue the loop
    // This handles cases where the LLM signaled tool use but didn't produce the final text response
    if (state.incompleteToolTurn && !askUserRef.current && iterations < MAX_ITERATIONS) {
      console.log(`[chat] incomplete tool turn detected - continuing loop for final text`);
      
      // Continue the agent loop from current context (no new user message, just resume)
      const continueAbortController = new AbortController();
      const continueEventStream = agentLoopContinue(context, config, continueAbortController.signal, safeStreamFn);
      
      // Process the continuation events
      for await (const event of continueEventStream) {
        if (event.type === "message_update") {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            state.fullText += ame.delta;
            state.pendingText += ame.delta;
            res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          } else if (ame.type === "thinking_delta") {
            state.thinkingText += ame.delta;
            res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          }
        } else if (event.type === "turn_end") {
          const msg = event.message as AssistantMessage;
          const stopReason = msg.stopReason || "stop";
          console.log(`[chat] continuation turn_end: stop=${stopReason} content=${state.fullText.length}ch`);
          if (stopReason !== "toolUse") {
            break; // Got final text, exit continuation loop
          }
        }
      }
      
      continueAbortController.abort(); // Clean up
    }

    // Check for queued follow-up messages even if loop exited early (e.g., due to abort)
    // This ensures messages aren't lost when agent-loop.js returns early on abort/error
    const queuedFollowUp = await messageQueue.drainOne(chat.id);
    if (queuedFollowUp && !askUserRef.current && !waitingForInput) {
      console.log(`[chat] post-loop: found queued follow-up message ${queuedFollowUp.id}, processing`);
      
      // Build current message first
      const currentAssistantMsg = buildCurrentAssistantMessage();
      chat.messages.push(currentAssistantMsg);
      
      // Add queued user message
      const queuedUserMsg: ChatMessage = {
        role: "user",
        content: queuedFollowUp.message,
        images: queuedFollowUp.images?.length ? queuedFollowUp.images : undefined,
        timestamp: queuedFollowUp.timestamp,
      };
      chat.messages.push(queuedUserMsg);
      await saveChat(chat);

      // Emit events to finalize current and start follow-up
      res.write(`event: message_complete\ndata: ${JSON.stringify({ message: currentAssistantMsg })}\n\n`);
      res.write(`event: follow_up_start\ndata: ${JSON.stringify({ queuedMessageId: queuedFollowUp.id })}\n\n`);

      // Fire-and-forget memory extraction
      if (chat.type === "agent") {
        extractMemories(chat.modelId, chat.id, lastUserMessage, currentAssistantMsg.content)
          .catch(err => console.error("[memory] extraction failed:", err));
      }

      // Title generation for first exchange
      if (chat.messages.length === 2) {
        generateTitle(lastUserMessage, currentAssistantMsg.content)
          .then(title => {
            if (title) {
              chat.title = title;
              saveChat(chat).catch(() => {});
              res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
            }
          })
          .catch(err => console.warn("[title] generation failed:", err));
      }

      // Continue processing the follow-up by recursively calling handleChatStream
      // Reset accumulators and update state
      resetAccumulators();
      lastUserMessage = queuedFollowUp.message;
      
      // Build new context for follow-up (all messages including the queued one)
      const followUpContextMessages = chatMessagesToPiMessages(chat.messages, chat.modelId);
      const followUpSystemPrompt = chat.type === "agent"
        ? await buildMemoryAugmentedPrompt(chat.systemPrompt || "You are a helpful assistant.", chat.messages)
        : chat.systemPrompt || "You are a helpful assistant.";
      
      // Recursively handle the follow-up with a fresh turn abort controller
      await handleChatStream(chat, queuedFollowUp.message, followUpContextMessages, followUpSystemPrompt, null, req, res);
      return; // Exit early since we've recursively handled the follow-up
    }

    if (askUserRef.current) {
      waitingForInput = true;

      // Save pending state for resume. Trim context.messages to keep
      // everything through the assistant message with ask_user, but drop
      // the placeholder tool result and any aborted assistant message.
      const savedMessages = [...context.messages];
      while (savedMessages.length > 0) {
        const last = savedMessages[savedMessages.length - 1] as any;
        if (
          last.role === "assistant" &&
          last.content?.some?.((c: any) => c.type === "toolCall" && c.name === "ask_user")
        ) {
          break; // Keep this assistant message
        }
        savedMessages.pop();
      }

      await savePendingState(chat.id, {
        agentMessages: savedMessages,
        systemPrompt,
        askToolCallId: askUserRef.current.toolCallId,
      });

      res.write(`event: ask_user\ndata: ${JSON.stringify({ question: askUserRef.current.question })}\n\n`);
    }

    // Build the final assistant message
    const assistantMsg = buildCurrentAssistantMessage();

    chat.messages.push(assistantMsg);
    await saveChat(chat);

    console.log(`[chat] finished: iterations=${iterations} waitingForInput=${waitingForInput}`);

    if (waitingForInput) {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true, iterations })}\n\n`
      );
    } else {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, iterations })}\n\n`
      );

      // Generate LLM title after the first exchange (2 messages = 1 user + 1 assistant)
      if (chat.messages.length === 2) {
        try {
          const title = await generateTitle(lastUserMessage, assistantMsg.content);
          if (title) {
            chat.title = title;
            await saveChat(chat);
            res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
          }
        } catch (err) {
          console.warn("[title] post-stream generation failed:", err);
        }
      }

      // Fire-and-forget memory extraction for agent chats
      if (chat.type === "agent") {
        extractMemories(chat.modelId, chat.id, lastUserMessage, assistantMsg.content)
          .catch((err) => console.error("[memory] extraction failed:", err));
      }

      // Post-response compaction: truncate if usage > 75% OR if we hit the context limit
      try {
        const model = ollamaModels.find((m) => m.id === chat.modelId);
        if (model) {
          const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
          const lastUsage = assistantMsg.usage?.totalTokens ?? 0;
          const usageRatio = lastUsage / effectiveContextWindow;
          if (hitContextLimit || usageRatio > 0.75) {
            const compaction = await truncateChatHistory(chat, effectiveContextWindow, hitContextLimit);
            if (compaction.truncated) {
              // Extract memories from removed messages (agent chats only)
              if (chat.type === "agent" && compaction.removedMessages?.length) {
                await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages);
              }
              await saveChat(chat);
              res.write(`event: compaction\ndata: ${JSON.stringify({
                removedCount: compaction.removedCount,
                remainingCount: chat.messages.length,
              })}\n\n`);
            }
          }
        }
      } catch (err) {
        console.error("[compaction] failed:", err);
      }
    }
  } catch (e: any) {
    // ask_user abort is expected — handle it gracefully
    if (askUserRef.current) {
      waitingForInput = true;

      // Best-effort save of pending state
      try {
        const savedMessages = [...(contextMessages as any[])];
        // On error path, context may not have been fully populated.
        // Save what we have — the assistant message with ask_user should be present.
        await savePendingState(chat.id, {
          agentMessages: savedMessages,
          systemPrompt,
          askToolCallId: askUserRef.current.toolCallId,
        });
      } catch (saveErr) {
        console.error("[ask_user] failed to save pending state:", saveErr);
      }

      res.write(`event: ask_user\ndata: ${JSON.stringify({ question: askUserRef.current.question })}\n\n`);

      // Build partial assistant message
      const assistantMsg = buildCurrentAssistantMessage();
      chat.messages.push(assistantMsg);
      await saveChat(chat);

      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true, iterations })}\n\n`
      );
    } else if (e.name !== "AbortError") {
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`
      );
    }
  } finally {
    res.end();
  }
}

// Send message and stream response via SSE
router.post("/", async (req, res) => {
  const { chatId, message: messageText, images } = req.body as {
    chatId: string;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || (!messageText && (!images || images.length === 0))) {
    return res.status(400).json({ error: "chatId and message (or images) are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  // Restore any queued messages from a previous SSE drop
  await messageQueue.loadFromDisk(chatId);

  // Persist images to disk and enrich with thumbnail URLs
  const persistedImages = images?.length ? await persistImages(images) : undefined;

  let message = messageText;

  // Check for skill invocations anywhere in the message
  const invokedSkills = parseSkillInvocations(message);
  const activatedSkillNames: string[] = [];
  
  if (invokedSkills.length > 0) {
    const allSkills = await discoverSkills();
    
    for (const invokedSkill of invokedSkills) {
      const skill = allSkills.find(s => s.name.toLowerCase() === invokedSkill.toLowerCase());
      
      if (skill) {
        // Add skill to active skills if not already present
        if (!chat.activeSkills) {
          chat.activeSkills = [];
        }
        if (!chat.activeSkills.includes(skill.name)) {
          chat.activeSkills.push(skill.name);
          activatedSkillNames.push(skill.name);
          console.log(`[skills] Activated skill "${skill.name}" for chat ${chatId}`);
        }
      }
    }
    
    // Keep skill invocations in the message for display (they're already activated)
    // No need to strip them - they serve as visual indicators of activated skills
  }
  
  // Check for pending agent state (ask_user resume flow)
  const pendingState = await loadPendingState(chatId);

  if (pendingState) {
    // RESUME: the user's message is the answer to ask_user
    let systemPrompt = pendingState.systemPrompt;
    
    // Check for new skill invocations in resume message
    const invokedSkills = parseSkillInvocations(message);
    if (invokedSkills.length > 0) {
      const allSkills = await discoverSkills();
      for (const invokedSkill of invokedSkills) {
        const skill = allSkills.find(s => s.name.toLowerCase() === invokedSkill.toLowerCase());
        if (skill && chat.activeSkills && !chat.activeSkills.includes(skill.name)) {
          chat.activeSkills.push(skill.name);
          console.log(`[skills] Activated skill "${skill.name}" for chat ${chatId} (resume)`);
        }
      }
      // Keep skill invocations in the message for display
    }
    
    // Inject active skills into the resumed system prompt
    if (chat.activeSkills?.length) {
      const skillsCache = new Map<string, Skill>();
      const allSkills = await discoverSkills();
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
    }
    
    const contextMessages = pendingState.agentMessages as Message[];

    // Inject the user's answer as a ToolResultMessage for the pending ask_user call
    const toolResultMsg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: pendingState.askToolCallId,
      toolName: "ask_user",
      content: [{ type: "text", text: message }],
      isError: false,
      timestamp: Date.now(),
    };
    contextMessages.push(toolResultMsg);

    // Show the answer in the UI as a user message
    chat.messages.push({
      role: "user",
      content: message,
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
    });
    await saveChat(chat);

    // Discover model for pre-send truncation
    const ollamaModels = await discoverOllamaModels();
    const model = ollamaModels.find((m) => m.id === chat.modelId);
    
    // Pre-send context protection for resume path
    if (model) {
      try {
        const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
        const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt);
        if (compaction && compaction.truncated) {
          await saveChat(chat);
          // Rebuild system prompt after truncation
          if (chat.type === "agent") {
            systemPrompt = await buildMemoryAugmentedPrompt(
              chat.systemPrompt || "You are a helpful assistant.",
              chat.messages
            );
          }
          // Emit compaction event for UI indicator
          res.write(`event: compaction\ndata: ${JSON.stringify({
            removedCount: compaction.removedCount,
            remainingCount: chat.messages.length,
          })}\n\n`);
        }
      } catch (err) {
        console.error("[compaction] pre-send truncation failed (resume):", err);
      }
    }

    // Resume: userPiMessage=null triggers agentLoopContinue
    await handleChatStream(chat, message, contextMessages, systemPrompt, null, req, res);
  } else {
    // NORMAL: add user message and build fresh context
    const userMsg: ChatMessage = {
      role: "user",
      content: message,
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
    };
    chat.messages.push(userMsg);

    // Auto-generate title from first message
    if (chat.messages.length === 1) {
      chat.title = truncateTitle(message);
    }

    await saveChat(chat);

    // Build system prompt with memories and active skills
    let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    if (chat.type === "agent") {
      systemPrompt = await buildMemoryAugmentedPrompt(
        systemPrompt,
        chat.messages
      );
    }
    
    // Inject active skills into system prompt
    if (chat.activeSkills?.length) {
      const skillsCache = new Map<string, Skill>();
      const allSkills = await discoverSkills();
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
    }
    
    // Discover model for pre-send truncation
    const ollamaModels = await discoverOllamaModels();
    const model = ollamaModels.find((m) => m.id === chat.modelId);
    
    // Pre-send context protection: truncate BEFORE sending if >75% of context window
    if (model) {
      try {
        const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
        const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt);
        if (compaction && compaction.truncated) {
          await saveChat(chat);
          // Rebuild system prompt after truncation (memories may have changed)
          if (chat.type === "agent") {
            systemPrompt = await buildMemoryAugmentedPrompt(
              chat.systemPrompt || "You are a helpful assistant.",
              chat.messages
            );
          }
          // Emit compaction event for UI indicator
          res.write(`event: compaction\ndata: ${JSON.stringify({
            removedCount: compaction.removedCount,
            remainingCount: chat.messages.length,
          })}\n\n`);
        }
      } catch (err) {
        console.error("[compaction] pre-send truncation failed:", err);
      }
    }
    
    setCachedAugmentedPrompt(chat.id, systemPrompt);

    // Context = all messages EXCEPT the one we just added (agentLoop adds it as prompt)
    const contextMessages = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
    const userPiMessage = buildUserPiMessage(message, images);

    await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
  }
});

// Enqueue a message while the agent is streaming
router.post("/enqueue", async (req, res) => {
  const { chatId, message, images } = req.body as {
    chatId: string;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || !message) {
    return res.status(400).json({ error: "chatId and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  // Persist images to disk
  const persistedImages = images?.length ? await persistImages(images) : undefined;

  // Enqueue for the streaming handler to pick up.
  // Don't add to chat.messages here — getFollowUpMessages does that
  // when it drains the queue, avoiding duplication on SSE reconnect.
  try {
    await messageQueue.enqueue(chatId, message, persistedImages);
  } catch (e: any) {
    return res.status(429).json({ error: e.message });
  }

  console.log(`[chat] enqueued message for chat ${chatId}`);
  res.json({ queued: true });
});

// Edit message at index and regenerate response via SSE
router.post("/edit", async (req, res) => {
  const { chatId, messageIndex, message } = req.body as {
    chatId: string;
    messageIndex: number;
    message: string;
  };

  if (!chatId || messageIndex == null || !message) {
    return res.status(400).json({ error: "chatId, messageIndex, and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  if (messageIndex < 0 || messageIndex >= chat.messages.length) {
    return res.status(400).json({ error: "messageIndex out of bounds" });
  }

  if (chat.messages[messageIndex].role !== "user") {
    return res.status(400).json({ error: "messageIndex must point to a user message" });
  }

  // Truncate everything from messageIndex onwards
  chat.messages = chat.messages.slice(0, messageIndex);

  // Add edited user message
  const userMsg: ChatMessage = {
    role: "user",
    content: message,
    timestamp: Date.now(),
  };
  chat.messages.push(userMsg);

  // Update title if editing the first message
  if (messageIndex === 0) {
    chat.title = truncateTitle(message);
  }

  await saveChat(chat);

  // Build context with skills
  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
  if (chat.type === "agent") {
    systemPrompt = await buildMemoryAugmentedPrompt(systemPrompt, chat.messages);
  }
  
  // Inject active skills into system prompt
  if (chat.activeSkills?.length) {
    const skillsCache = new Map<string, Skill>();
    const allSkills = await discoverSkills();
    for (const s of allSkills) {
      skillsCache.set(s.name, s);
    }
    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
  }
  
  // Discover model for pre-send truncation
  const ollamaModels = await discoverOllamaModels();
  const model = ollamaModels.find((m) => m.id === chat.modelId);
  
  // Pre-send context protection for edit path
  if (model) {
    try {
      const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
      const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt);
      if (compaction && compaction.truncated) {
        await saveChat(chat);
        // Rebuild system prompt after truncation
        if (chat.type === "agent") {
          systemPrompt = await buildMemoryAugmentedPrompt(
            chat.systemPrompt || "You are a helpful assistant.",
            chat.messages
          );
        }
        // Emit compaction event for UI indicator
        res.write(`event: compaction\ndata: ${JSON.stringify({
          removedCount: compaction.removedCount,
          remainingCount: chat.messages.length,
        })}\n\n`);
      }
    } catch (err) {
      console.error("[compaction] pre-send truncation failed (edit):", err);
    }
  }
  
  setCachedAugmentedPrompt(chat.id, systemPrompt);

  // Context = all messages EXCEPT the one we just added
  const contextMessages = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
  const userPiMessage = buildUserPiMessage(message);

  await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
});

export default router;
