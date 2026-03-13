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
import { truncateChatHistory } from "../services/compaction.js";
import { buildMemoryAugmentedPrompt, setCachedAugmentedPrompt } from "../services/memory-context.js";
import { getAgentTools } from "../services/agent-tools.js";
import type { ToolSideEffects } from "../services/agent-tools.js";
import { parseSkillInvocations, stripSkillInvocations, buildSkillAugmentedPrompt, discoverSkills } from "../services/skills.js";
import type { Skill } from "../services/skills.js";
import {
  loadPendingState,
  savePendingState,
} from "../services/agent-state.js";
import type { Artifact, Chat, ChatMessage, ChatToolCall, ChatToolResult, GeneratedImage, ImageAttachment } from "../types.js";

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

/**
 * Create a stream function that handles pre-aborted signals gracefully.
 * When the signal is already aborted (e.g., ask_user triggered abort),
 * returns an event stream that immediately emits an abort error
 * instead of letting the fetch call throw.
 */
function createSafeStreamFn(): StreamFn {
  return (model, ctx, options) => {
    if (options?.signal?.aborted) {
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

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  const MAX_ITERATIONS = 500;

  // Accumulators for the final ChatMessage
  const allToolCalls: ChatToolCall[] = [];
  const allToolResults: ChatToolResult[] = [];
  const allArtifacts: Artifact[] = [];
  const allGeneratedImages: GeneratedImage[] = [];
  
  // Track ordering for interleaved display
  interface OutputSegment {
    seq: number;
    type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image";
    content?: string;
    toolCall?: ChatToolCall;
    toolResult?: ChatToolResult;
    artifact?: Artifact;
    generatedImage?: GeneratedImage;
  }
  const segments: OutputSegment[] = [];
  let seqCounter = 0;
  let pendingText = ""; // text accumulated since the last segment flush

  /** Flush any accumulated text into a text segment */
  function flushTextSegment() {
    if (pendingText.trim()) {
      segments.push({ seq: ++seqCounter, type: "text", content: pendingText });
    }
    pendingText = "";
  }

  // ask_user state — owned by the route, set via callback.
  // Uses a ref object so TypeScript can track mutations through closures.
  const askUserRef: { current: { question: string; toolCallId: string } | null } = { current: null };

  // Side-effects bridge between tool execution and SSE output
  const effects: ToolSideEffects = {
    onArtifact: (artifact) => {
      allArtifacts.push(artifact);
      segments.push({ seq: ++seqCounter, type: "artifact", artifact });
      res.write(`event: artifact\ndata: ${JSON.stringify(artifact)}\n\n`);
    },
    onGeneratedImage: (image) => {
      allGeneratedImages.push(image);
      segments.push({ seq: ++seqCounter, type: "generated_image", generatedImage: image });
      res.write(`event: generated_image\ndata: ${JSON.stringify(image)}\n\n`);
    },
    onAskUser: (question, toolCallId) => {
      askUserRef.current = { question, toolCallId };
      abortController.abort();
    },
  };

  const isAgent = chat.type === "agent";
  const agentTools = isAgent ? getAgentTools(chat.id, effects) : undefined;

  let fullText = "";
  let thinkingText = "";
  let finalUsage: ChatMessage["usage"];
  let iterations = 0;
  let waitingForInput = false;

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
    };

    const safeStreamFn = createSafeStreamFn();

    // Start the agent loop
    const eventStream = userPiMessage
      ? agentLoop([userPiMessage], context, config, abortController.signal, safeStreamFn)
      : agentLoopContinue(context, config, abortController.signal, safeStreamFn);

    // Process events → SSE
    for await (const event of eventStream) {
      switch (event.type) {
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            fullText += ame.delta;
            pendingText += ame.delta;
            res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          } else if (ame.type === "thinking_delta") {
            thinkingText += ame.delta;
            res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          } else if (ame.type === "toolcall_start") {
            const partial = ame.partial.content[ame.contentIndex] as ToolCall | undefined;
            if (partial) {
              res.write(`event: tool_status\ndata: ${JSON.stringify({ name: partial.name || "...", status: "running" })}\n\n`);
            }
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
          allToolCalls.push(toolCall);
          if (event.toolName !== "ask_user") {
            console.log(`[tool] Executing ${event.toolName}:`, event.args);
            segments.push({ seq: ++seqCounter, type: "tool_call", toolCall });
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
            allToolResults.push(toolResult);
            segments.push({ seq: ++seqCounter, type: "tool_result", toolResult });
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

          // Skip the synthetic aborted turn (from ask_user abort)
          if (stopReason === "aborted") break;

          iterations++;
          console.log(
            `[chat] iter=${iterations} stop=${stopReason} tools=${event.toolResults?.length || 0}` +
            ` content=${fullText.length}ch thinking=${thinkingText.length}ch` +
            ` tokens=${msg.usage?.totalTokens || "?"}`,
          );

          res.write(`event: iteration\ndata: ${JSON.stringify({
            iteration: iterations,
            stopReason,
            toolCount: event.toolResults?.length || 0,
          })}\n\n`);

          if (msg.usage) {
            finalUsage = {
              input: msg.usage.input,
              output: msg.usage.output,
              totalTokens: msg.usage.totalTokens,
            };
          }

          if (stopReason === "length") {
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
            abortController.abort();
          }
          break;
        }
      }
    }

    // --- Post-loop: handle ask_user, build message, compaction ---

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

    // Flush any remaining text into segments
    flushTextSegment();

    // Build the final assistant message
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: fullText,
      thinking: thinkingText || undefined,
      usage: finalUsage,
      toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
      toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      artifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
      generatedImages: allGeneratedImages.length > 0 ? allGeneratedImages : undefined,
      segments: segments.length > 0 ? segments : undefined,
      timestamp: Date.now(),
    };

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

      // Fire-and-forget memory extraction for agent chats
      if (chat.type === "agent") {
        extractMemories(chat.modelId, chat.id, userMessage, assistantMsg.content)
          .catch((err) => console.error("[memory] extraction failed:", err));

        // Check for compaction: extract memories then truncate when nearing context limit
        try {
          const model = ollamaModels.find((m) => m.id === chat.modelId);
          if (model) {
            const effectiveContextWindow = chat.contextWindow ?? model.contextWindow;
            const lastUsage = assistantMsg.usage?.totalTokens ?? 0;
            const usageRatio = lastUsage / effectiveContextWindow;
            if (usageRatio > 0.75) {
              await preCompactionFlush(chat.modelId, chat.id, chat.messages);
              const compaction = await truncateChatHistory(chat, effectiveContextWindow);
              if (compaction.truncated) {
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
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: fullText,
        thinking: thinkingText || undefined,
        usage: finalUsage,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
        artifacts: allArtifacts.length > 0 ? allArtifacts : undefined,
        generatedImages: allGeneratedImages.length > 0 ? allGeneratedImages : undefined,
        timestamp: Date.now(),
      };
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
    
    // Strip skill invocations from the message
    const strippedMessage = stripSkillInvocations(message);
    if (strippedMessage) {
      message = strippedMessage;
    } else if (activatedSkillNames.length > 0) {
      // Message contained only skill activations
      message = activatedSkillNames.length === 1
        ? `I've activated the ${activatedSkillNames[0]} skill.`
        : `I've activated ${activatedSkillNames.length} skills: ${activatedSkillNames.join(', ')}.`;
    }
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
      message = stripSkillInvocations(message);
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
    
    setCachedAugmentedPrompt(chat.id, systemPrompt);
    
    setCachedAugmentedPrompt(chat.id, systemPrompt);

    // Context = all messages EXCEPT the one we just added (agentLoop adds it as prompt)
    const contextMessages = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
    const userPiMessage = buildUserPiMessage(message, images);

    await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
  }
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
  
  setCachedAugmentedPrompt(chat.id, systemPrompt);

  // Context = all messages EXCEPT the one we just added
  const contextMessages = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
  const userPiMessage = buildUserPiMessage(message);

  await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
});

export default router;
