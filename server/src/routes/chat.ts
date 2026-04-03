import { Router } from "express";
import type { Request, Response } from "express";
import type { Message, ToolCall, ToolResultMessage, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { streamSimple, createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";
import type { AgentContext, AgentLoopConfig, StreamFn } from "@mariozechner/pi-agent-core";
import { getChat, saveChat, getSettings, loadPendingState, savePendingState, clearPendingState } from "../services/chat-storage.js";
import { chatMessagesToPiMessages } from "../services/agent.js";
import { createPiModelFromProvider, discoverAllModels, getEffectiveContextWindow } from "../services/models.js";
import type { OllamaModel } from "../types.js";
import { extractMemories, preCompactionFlush } from "../services/memory-extraction.js";
import { generateTitle } from "../services/title-generation.js";
import { truncateChatHistory, truncateBeforeSend } from "../services/compaction.js";
import { buildMemoryAugmentedPrompt, setCachedAugmentedPrompt } from "../services/memory-context.js";
import { getAgentTools } from "../services/agent-tools.js";
import type { ToolSideEffects } from "../services/agent-tools.js";
import { parseSkillInvocations, buildSkillAugmentedPrompt, discoverSkills } from "../services/skills.js";
import type { Skill } from "../services/skills.js";
import * as messageQueue from "../services/message-queue.js";
import type { Artifact, Chat, ChatMessage, ChatToolCall, ChatToolResult, GeneratedImage, ImageAttachment, InlineVisual } from "../types.js";
import { saveUserImage } from "../services/user-image-storage.js";
import { streamTTS, isStreamingCapable } from "../services/tts-streaming.js";
import type { TTSSettings } from "../types/tts.js";

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
/**
 * Inactivity timeouts for LLM streaming.
 *
 * Local models:  15 min — complex tool chains (bash, python, file ops) can take
 *                several minutes. SSE keepalive pings (every 30s) run throughout
 *                the entire agent turn to prevent client-side timeout.
 * Cloud models:  The cloud provider may buffer large tool-call arguments (not
 *                streaming deltas token-by-token) or take a long time to begin
 *                generating after processing a large context.  Use a much more
 *                generous timeout so that a single 200-line tool call doesn't
 *                get killed mid-generation.
 *
 * "Pre-first-event" timeout: before ANY event arrives the model might be
 * loading / processing context.  We allow extra time here, then switch to the
 * shorter "ongoing" timeout once streaming has started.
 */
const LOCAL_INACTIVITY_TIMEOUT_MS  = 900_000;  // 15 minutes for local
const CLOUD_INACTIVITY_TIMEOUT_MS  = 300_000;  // 5 min between events (cloud)
const CLOUD_FIRST_EVENT_TIMEOUT_MS = 300_000;  // 5 min for first event (cloud)
const SSE_KEEPALIVE_INTERVAL_MS    = 30_000;   // 30s keepalive pings to prevent client timeout

function isCloudModel(modelId: string): boolean {
  return modelId.includes(":cloud");
}

function createSafeStreamFn(chatOllamaOptions?: { keepAlive?: string | number; numGpu?: number; numPredict?: number }): StreamFn {
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

    // Merge per-chat Ollama options into the stream options
    const mergedOptions = chatOllamaOptions
      ? { ...options, keepAlive: chatOllamaOptions.keepAlive, numGpu: chatOllamaOptions.numGpu, numPredict: chatOllamaOptions.numPredict }
      : options;

    // Wrap the raw stream with an inactivity timeout.
    // If Ollama is stuck loading a model, the stream hangs indefinitely —
    // this detects that and aborts with a clear error.
    const rawStream = streamSimple(model, ctx, mergedOptions);
    const wrappedStream = createAssistantMessageEventStream();

    const cloud = isCloudModel(model.id);
    const ongoingTimeout = cloud ? CLOUD_INACTIVITY_TIMEOUT_MS : LOCAL_INACTIVITY_TIMEOUT_MS;
    const firstEventTimeout = cloud ? CLOUD_FIRST_EVENT_TIMEOUT_MS : LOCAL_INACTIVITY_TIMEOUT_MS;

    (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let ended = false;
      let receivedFirstEvent = false;

      const endStream = () => {
        if (!ended) {
          ended = true;
          wrappedStream.end();
        }
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        const timeout = receivedFirstEvent ? ongoingTimeout : firstEventTimeout;
        timer = setTimeout(() => {
          console.error(`[stream] inactivity timeout (${timeout}ms, cloud=${cloud}, firstEvent=${receivedFirstEvent}) — model may be stuck: ${model.id}`);
          const errorMsg: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: `Model unresponsive for ${timeout / 1000}s — it may be stuck loading. Try again or use a different model.`,
            timestamp: Date.now(),
          };
          wrappedStream.push({
            type: "error",
            reason: "error",
            error: errorMsg,
          } as any);
          endStream();
        }, timeout);
      };

      resetTimer();

      try {
        for await (const event of rawStream) {
          if (ended) break;
          receivedFirstEvent = true;
          resetTimer();
          wrappedStream.push(event);
        }
      } catch (err) {
        console.error(`[stream] error from LLM stream:`, err);
        const errorMsg: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: errorMsg,
        } as any);
      } finally {
        if (timer) clearTimeout(timer);
        endStream();
      }
    })();

    return wrappedStream;
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
  // Safety check: log if context is unexpectedly empty for non-first messages
  if (contextMessages.length === 0 && chat.messages.length > 1) {
    console.error(`[chat] CRITICAL: context is empty but chat has ${chat.messages.length} messages - agent will respond without conversation history`);
  }
  
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
  let connectionClosed = false;
  
  // Store the abort controller in a map so it can be accessed by the stop endpoint
  const activeStreams = (globalThis as any)._activeChatStreams || new Map<string, AbortController>();
  (globalThis as any)._activeChatStreams = activeStreams;
  activeStreams.set(chat.id, connectionAbortController);
  
  req.on("close", () => {
    connectionClosed = true;
    connectionAbortController.abort();
    activeStreams.delete(chat.id);
  });

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
    // Track if thinking was promoted to content (not useful for previews)
    thinkingPromoted: false,
    // Track thinking duration
    thinkingStartTime: null as number | null,
    thinkingDurationMs: 0,
    // Mid-turn compaction: set when usage > 85% during tool loop
    needsMidTurnCompaction: false,
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
    state.thinkingPromoted = false;
    state.thinkingStartTime = null;
    state.thinkingDurationMs = 0;
    state.needsMidTurnCompaction = false;
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
      thinkingDurationMs: state.thinkingDurationMs > 0 ? state.thinkingDurationMs : undefined,
      usage: state.finalUsage,
      toolCalls: state.allToolCalls.length > 0 ? state.allToolCalls : undefined,
      toolResults: state.allToolResults.length > 0 ? state.allToolResults : undefined,
      artifacts: state.allArtifacts.length > 0 ? state.allArtifacts : undefined,
      visuals: state.allVisuals.length > 0 ? state.allVisuals : undefined,
      generatedImages: state.allGeneratedImages.length > 0 ? state.allGeneratedImages : undefined,
      segments: state.segments.length > 0 ? state.segments : undefined,
      timestamp: Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
    };
  }

  /** Flush any active thinking timer into accumulated duration */
  function flushThinkingTimer() {
    if (state.thinkingStartTime !== null) {
      state.thinkingDurationMs += Date.now() - state.thinkingStartTime;
      state.thinkingStartTime = null;
    }
  }

  /** Flush any accumulated text into a text segment */
  function flushTextSegment() {
    if (state.pendingText.trim()) {
      state.segments.push({ seq: ++state.seqCounter, type: "text", content: state.pendingText });
    }
    state.pendingText = "";
  }

  // Create a turn-level abort controller to prevent signal bleeding across iterations
  // Also abort the turn when the client disconnects (SSE close)
  const turnAbortController = new AbortController();
  connectionAbortController.signal.addEventListener("abort", () => {
    turnAbortController.abort();
  });

  // ask_user state — owned by the route, set via callback.
  // Uses a ref object so TypeScript can track mutations through closures.
  const askUserRef: { current: { question: string; toolCallId: string } | null } = { current: null };
  
  // SSE keepalive interval — prevents client timeout during gaps in SSE output
  // (model loading, long tool execution, between tool results and next LLM call).
  // Any real SSE event (text_delta, tool_status, etc.) also resets the client timer,
  // so this only fires during silent gaps.
  let sseKeepaliveInterval: ReturnType<typeof setInterval> | null = null;

  const startSSEKeepalive = () => {
    if (sseKeepaliveInterval) return;
    sseKeepaliveInterval = setInterval(() => {
      if (!connectionClosed) {
        res.write(`: keepalive\n\n`);
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
  };

  const stopSSEKeepalive = () => {
    if (sseKeepaliveInterval) {
      clearInterval(sseKeepaliveInterval);
      sseKeepaliveInterval = null;
    }
  };

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
    onPendingReviewImage: () => {
      // No-op: native Ollama API handles images in tool results directly
    },
    onAskUser: (question, toolCallId) => {
      askUserRef.current = { question, toolCallId };
      turnAbortController.abort(); // Only abort the current turn, not the SSE connection
    },
  };

  const isAgent = chat.type === "agent" || chat.type === "bluesky";

  // Load TTS settings
  const settings = await getSettings();
  const ttsSettings: TTSSettings = (settings as any).tts || { enabled: false, backend: "kokoro" };
  const ttsEnabled = ttsSettings.enabled && ttsSettings.streamingEnabled && isStreamingCapable(ttsSettings.backend);
  
  // TTS pause controller - aborts TTS stream on tool execution
  let ttsPauseController: AbortController | null = null;

  let iterations = 0;
  let waitingForInput = false;
  let hitContextLimit = false;
  let lastUserMessage = userMessage; // tracks the current user message text for title gen / memory

  console.log(`[chat] type=${chat.type} isAgent=${isAgent} tts=${ttsEnabled}`);

  try {
    // Discover model with timeout protection
    let allModels: OllamaModel[];
    let ollamaModel: OllamaModel | undefined;
    let piModel: Model<string>;

    try {
      allModels = await discoverAllModels();
      ollamaModel = allModels.find(m => m.id === chat.modelId);
      if (!ollamaModel) throw new Error(`Model not found: ${chat.modelId}`);
      piModel = await createPiModelFromProvider(ollamaModel);
      // Override contextWindow with effective value so num_ctx sent to Ollama
      // respects per-chat and per-model settings. Without this, Ollama receives
      // the full detected context window (e.g. 128k) and may overflow VRAM.
      piModel.contextWindow = getEffectiveContextWindow(chat, ollamaModel, settings);
    } catch (modelError: any) {
      console.error("[chat] model discovery failed:", modelError.message);
      // Send error event and end response cleanly
      res.write(`event: error\ndata: ${JSON.stringify({ error: `Model unavailable: ${modelError.message}` })}\n\n`);
      res.end();
      return;
    }

    // Create tools AFTER model discovery so we can pass the effective context window
    const agentTools = isAgent ? getAgentTools(chat.id, effects, piModel.contextWindow) : undefined;

    // Build agent context
    const context: AgentContext = {
      systemPrompt,
      messages: [...contextMessages],
      tools: agentTools,
    };

    // Pass per-chat Ollama runtime options to the stream function
    const safeStreamFn = createSafeStreamFn(chat.ollamaOptions);

    // Build config
    const config: AgentLoopConfig = {
      model: piModel,
      apiKey: "ollama",
      reasoning: piModel.reasoning ? "medium" : undefined,
      convertToLlm: (msgs) => msgs as Message[],
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
        const lastMsg = chat.messages[chat.messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
          chat.messages[chat.messages.length - 1] = assistantMsg;
        } else {
          chat.messages.push(assistantMsg);
        }
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
          // Emit background activity event so client can show indicator
          res.write(`event: background_activity\ndata: ${JSON.stringify({ type: "memory_extraction", chatId: chat.id })}\n\n`);
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

    // Start the agent loop (uses turnAbortController declared earlier)
    console.log(`[chat] Starting agent loop: userPiMessage=${!!userPiMessage}, context.messages.length=${context.messages.length}, tools=${context.tools?.length || 0}`);
    console.log(`[chat] Context messages: ${context.messages.map(m => `${m.role}:${m.content?.length || 0}ch`).join(", ")}`);
    const eventStream = userPiMessage
      ? agentLoop([userPiMessage], context, config, turnAbortController.signal, safeStreamFn)
      : agentLoopContinue(context, config, turnAbortController.signal, safeStreamFn);
    console.log(`[chat] Agent loop started, waiting for events...`);

    // Extract token stream for TTS (if enabled)
    async function* extractTokenStream() {
      for await (const event of eventStream) {
        if (event.type === "message_update") {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            yield ame.delta;
          }
        }
      }
    }

    // Create TTS audio stream if enabled
    const audioStream = ttsEnabled ? streamTTS(extractTokenStream(), {
      ...ttsSettings,
      chunkSize: ttsSettings.streamingChunkSize ?? 50,
      boundaryTier: ttsSettings.streamingBoundaryTier ?? 'clause',
    }) : null;

    // Start SSE keepalive to prevent client timeout during model loading,
    // tool execution, or any other gap in SSE output
    startSSEKeepalive();

    // Process LLM events → SSE (main loop)
    for await (const event of eventStream) {
      switch (event.type) {
        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            flushThinkingTimer();
            state.fullText += ame.delta;
            state.pendingText += ame.delta;
            res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          } else if (ame.type === "thinking_delta") {
            if (state.thinkingStartTime === null) {
              state.thinkingStartTime = Date.now();
            }
            state.thinkingText += ame.delta;
            res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
          }
          break;
        }

        case "tool_execution_start": {
          flushThinkingTimer();
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
            
            // Pause TTS on tool execution
            if (ttsEnabled) {
              ttsPauseController?.abort();
              ttsPauseController = new AbortController();
            }
            
            // CRITICAL: Pre-execution checkpoint for tools that can restart the server
            // If the agent modifies its own source code, tsx watch will restart the server
            // We must flush accumulators to disk BEFORE execution to survive the restart
            const isSelfModifyingTool = 
              event.toolName === "write_file" || 
              event.toolName === "edit_file" ||
              (event.toolName === "bash" && typeof event.args?.command === "string" && (
                event.args.command.includes("npm run") || 
                event.args.command.includes("tsx") ||
                event.args.command.includes("node") ||
                event.args.command.includes("/server/")
              ));
            
            if (isSelfModifyingTool) {
              console.log(`[tool] Pre-execution checkpoint for self-modifying tool: ${event.toolName}`);
              try {
                const partialMsg = buildCurrentAssistantMessage();
                await saveChat(chat);
                await savePendingState(chat.id, {
                  agentMessages: context.messages as any[],
                  systemPrompt,
                  askToolCallId: askUserRef.current?.toolCallId || "",
                  fullText: state.fullText,
                  thinkingText: state.thinkingText,
                  toolCalls: state.allToolCalls,
                  toolResults: state.allToolResults,
                  iterations,
                  lastUserMessage,
                });
                console.log(`[tool] Checkpoint saved: ${partialMsg.toolCalls?.length || 0} tools, ${partialMsg.content.length}ch`);
              } catch (saveErr) {
                console.error(`[tool] Failed to save pre-execution checkpoint:`, saveErr);
                // Continue anyway - better to execute the tool than to block
              }
            }
          }
          break;
        }

        case "tool_execution_end": {
          console.log(`[chat] tool_execution_end: ${event.toolName} (toolCallId: ${event.toolCallId}, isError: ${event.isError})`);

          // ask_user gets a dedicated SSE event, not tool_status
          if (event.toolName !== "ask_user") {
            const resultText = event.result?.content?.[0]?.text || "";

            const images: ImageAttachment[] | undefined = event.result?.content
                ?.filter((c: any) => c.type === "image")
                .map((c: any) => ({ data: c.data, mimeType: c.mimeType, name: `generated-${event.toolCallId}.jxl` }));
            
            if (images?.length) {
              console.log(`[chat] Extracted ${images.length} image(s) from tool result ${event.toolCallId} (${event.toolName})`);
              console.log(`[chat] Image sizes: ${images.map(img => `${(img.data.length / 1024).toFixed(1)}KB`).join(", ")}`);
            }
            
            const toolResult: ChatToolResult = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              content: resultText,
              isError: event.isError,
              images: images?.length ? images : undefined,
            };
            state.allToolResults.push(toolResult);
            console.log(`[chat] Tool result accumulated: ${state.allToolResults.length} total`);
            
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
            console.log(`[chat] Tool result segment emitted, waiting for next agent turn...`);
          }
          break;
        }

        case "turn_end": {
          const msg = event.message as AssistantMessage;
          const stopReason = msg.stopReason || "stop";

          console.log(`[chat] turn_end: stopReason=${stopReason}, toolResults=${event.toolResults?.length || 0}, content=${state.fullText.length}ch`);
          if (stopReason === "error") {
            console.error(`[chat] LLM error: ${msg.errorMessage || "(no error message)"}`);
          }
          console.log(`[chat] turn_end event details:`, {
            stopReason,
            toolResults: event.toolResults?.length || 0,
            hasToolCalls: !!event.toolResults?.length,
          });

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
            console.log(`[chat] Agent loop should continue to next iteration with tool results...`);
            console.log(`[chat] Accumulated state before continuation: ${state.allToolCalls.length} calls, ${state.allToolResults.length} results`);
            console.log(`[chat] Tool results:`, state.allToolResults.map(tr => ({
              toolName: tr.toolName,
              hasImages: !!tr.images?.length,
              contentLength: tr.content.length,
            })));
          } else {
            state.incompleteToolTurn = false;
          }
          
          // Handle thinking-only outputs: if turn ended with stop reason but only thinking was produced
          // This happens when reasoning models output via thinking stream without text stream
          if (stopReason === "stop" && !hasTextContent && state.thinkingText.trim().length > 0) {
            state.fullText = state.thinkingText;
            state.thinkingText = "";
            state.thinkingPromoted = true;
            console.log(`[chat] promoted thinking to content (${state.fullText.length}ch) - model output thinking only`);
          }

          console.log(
            `[chat] iter=${iterations} stop=${stopReason} tools=${event.toolResults?.length || 0}` +
            ` content=${state.fullText.length}ch thinking=${state.thinkingText.length}ch` +
            ` tokens=${msg.usage?.totalTokens || "?"} incomplete=${state.incompleteToolTurn}`,
          );
          
          // Debug: log tool results if present
          if (event.toolResults?.length) {
            console.log(`[chat] Tool results in turn_end:`, event.toolResults.map(tr => ({
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              hasImage: tr.content?.some((c: any) => c.type === "image"),
            })));
          }
          
          // If stopReason is toolUse, the agent loop should automatically continue
          if (stopReason === "toolUse") {
            console.log(`[chat] stopReason is toolUse - agent loop will continue to next iteration automatically`);
            console.log(`[chat] Accumulated state: ${state.allToolCalls.length} tool calls, ${state.allToolResults.length} tool results`);
          }

          if (msg.usage) {
            state.finalUsage = {
              input: msg.usage.input,
              output: msg.usage.output,
              totalTokens: msg.usage.totalTokens,
            };
          }

          // Send iteration event with usage data so client can update token indicators mid-loop
          res.write(`event: iteration\ndata: ${JSON.stringify({
            iteration: iterations,
            stopReason,
            toolCount: event.toolResults?.length || 0,
            usage: state.finalUsage || undefined,
          })}\n\n`);

          if (stopReason === "length") {
            hitContextLimit = true;
            console.warn(`[chat] stopped due to context length at iteration ${iterations}`);
            res.write(`event: warning\ndata: ${JSON.stringify({
              type: "context_length",
              message: "Response stopped — context window full",
            })}\n\n`);
          }

          // Detect implicit context overflow: model errored without usage data.
          // Ollama often returns a stream error (not "length") when the context is exhausted.
          // If we have prior usage near the limit or high iteration count with no usage, treat as context limit.
          if (!hitContextLimit && !msg.usage && (stopReason as string) !== "stop" && (stopReason as string) !== "toolUse" && (stopReason as string) !== "length") {
            // Check if the last known usage was already high
            const lastKnown = state.finalUsage?.totalTokens ?? 0;
            const effectiveCW = getEffectiveContextWindow(chat, ollamaModel, settings);
            if (effectiveCW > 0 && (lastKnown / effectiveCW > 0.8 || iterations > 3)) {
              hitContextLimit = true;
              console.warn(`[chat] model error with no usage data at iteration ${iterations} (last known: ${lastKnown}/${effectiveCW}) — treating as context overflow`);
              res.write(`event: warning\ndata: ${JSON.stringify({
                type: "context_length",
                message: "Response may have been cut short — context window likely full",
              })}\n\n`);
            }
          }

          // Mid-turn context protection: if usage > 85% during tool loop, break for compaction
          if (stopReason === "toolUse" && !hitContextLimit) {
            const effectiveCW = getEffectiveContextWindow(chat, ollamaModel, settings);
            let currentTokens = state.finalUsage?.totalTokens ?? 0;
            // Fallback to character estimation if usage not reported
            if (!currentTokens && chat.messages.length > 0) {
              const { estimateContextTokens } = await import("../services/compaction.js");
              currentTokens = estimateContextTokens(chat.messages, systemPrompt);
            }
            if (effectiveCW > 0 && currentTokens > 0) {
              const usageRatio = currentTokens / effectiveCW;
              if (usageRatio > 0.85) {
                console.warn(`[chat] Mid-turn context overflow: ${currentTokens}/${effectiveCW} (${(usageRatio * 100).toFixed(0)}%) at iteration ${iterations} — breaking for compaction`);
                turnAbortController.abort();
                state.needsMidTurnCompaction = true;
              }
            }
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

          // Incremental persistence: save progress after each iteration
          // This ensures tool calls and partial responses survive server restarts
          // and are visible in the UI after a page refresh during a long tool loop.
          try {
            const partialMsg = buildCurrentAssistantMessage();
            // Update chat.messages with the in-progress assistant message so it
            // survives crashes and is visible on page refresh. We push on first
            // iteration, then replace in subsequent iterations.
            const lastMsg = chat.messages[chat.messages.length - 1];
            if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
              chat.messages[chat.messages.length - 1] = { ...partialMsg, _inProgress: true };
            } else {
              chat.messages.push({ ...partialMsg, _inProgress: true });
            }
            await saveChat(chat);
            
            // ALSO save in-flight accumulators to pending_states for crash recovery
            // This allows resume from mid-turn, not just ask_user
            await savePendingState(chat.id, {
              agentMessages: context.messages as any[],
              systemPrompt,
              askToolCallId: askUserRef.current?.toolCallId || "",
              fullText: state.fullText,
              thinkingText: state.thinkingText,
              toolCalls: state.allToolCalls,
              toolResults: state.allToolResults,
              iterations,
              lastUserMessage,
            });
            
            console.log(`[chat] iteration ${iterations}: saved progress (${partialMsg.toolCalls?.length || 0} tools, ${partialMsg.content.length}ch)`);
          } catch (saveErr) {
            console.error(`[chat] failed to save iteration ${iterations}:`, saveErr);
          }

          break;
        }
      }
    }

    // Parallel: Stream audio chunks if TTS enabled
    if (audioStream) {
      console.log("[TTS] Starting audio stream");
      (async () => {
        try {
          for await (const wavChunk of audioStream) {
            // Check if connection is still open
            if (res.writableEnded) break;
            
            res.write(`event: audio_chunk\ndata: ${JSON.stringify({
              chunkId: crypto.randomUUID(),
              data: wavChunk.toString('base64'),
              mimeType: 'audio/wav',
              sampleRate: 24000,
            })}\n\n`);
          }
          console.log("[TTS] Audio stream completed");
        } catch (err) {
          console.error("[TTS] Streaming error:", err);
        }
      })();
    }

    // --- Post-loop: handle incomplete tool turns, ask_user, build message, compaction ---

    // If the last turn ended with toolUse but no final text, continue the loop
    // This handles cases where the LLM signaled tool use but didn't produce the final text response
    if (state.incompleteToolTurn && !askUserRef.current && iterations < MAX_ITERATIONS) {
      console.log(`[chat] incomplete tool turn detected - continuing loop for final text`);

      // Continue the agent loop from current context (no new user message, just resume)
      const continueAbortController = new AbortController();

      // Track if continuation produces any content
      let continuationProducedContent = false;

      try {
        const continueEventStream = agentLoopContinue(context, config, continueAbortController.signal, safeStreamFn);

        // Process the continuation events
        for await (const event of continueEventStream) {
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              continuationProducedContent = true;
              state.fullText += ame.delta;
              state.pendingText += ame.delta;
              res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
            } else if (ame.type === "thinking_delta") {
              continuationProducedContent = true;
              state.thinkingText += ame.delta;
              res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
            }
          } else if (event.type === "turn_end") {
            const msg = event.message as AssistantMessage;
            const stopReason = msg.stopReason || "stop";
            console.log(`[chat] continuation turn_end: stop=${stopReason} content=${state.fullText.length}ch`);

            // Also handle thinking-only in continuation
            if (stopReason === "stop" && !state.fullText.trim() && state.thinkingText.trim().length > 0) {
              state.fullText = state.thinkingText;
              state.thinkingText = "";
              state.thinkingPromoted = true;
              continuationProducedContent = true;
              console.log(`[chat] continuation: promoted thinking to content (${state.fullText.length}ch)`);
            }

            // Incremental persistence in continuation loop
            try {
              const partialMsg = buildCurrentAssistantMessage();
              await saveChat(chat);
              console.log(`[chat] continuation: saved progress (${partialMsg.content.length}ch)`);
            } catch (saveErr) {
              console.error(`[chat] continuation save failed:`, saveErr);
            }

            if (stopReason !== "toolUse") {
              break; // Got final text, exit continuation loop
            }
          }
        }
      } catch (contErr: any) {
        console.error(`[chat] continuation loop crashed: ${contErr.message}`);
        // Don't let a crash in the continuation loop take down the server.
        // The partial state from the main loop is still valid — we'll persist
        // whatever was accumulated before the crash.
      }

      continueAbortController.abort(); // Clean up

      // If continuation produced nothing, log a warning and don't persist empty message
      if (!continuationProducedContent && !state.fullText.trim() && !state.thinkingText.trim()) {
        console.error(`[chat] continuation produced NO CONTENT - model may have failed silently. Not persisting empty message.`);
        // Don't continue to message persistence - we'll handle this below
        state.finalUsage = { input: 0, output: 0, totalTokens: 0 }; // Mark as failed
      }
    }

    // Mid-turn compaction: if we broke out of the tool loop due to context pressure,
    // save progress, compact, rebuild context, and resume the agent loop
    if (state.needsMidTurnCompaction && !askUserRef.current && !waitingForInput) {
      console.log(`[chat] Mid-turn compaction: saving progress and compacting`);

      // 1. Save current progress as an in-progress assistant message
      flushThinkingTimer();
      const partialAssistant = buildCurrentAssistantMessage();
      partialAssistant._inProgress = true;
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
        chat.messages[chat.messages.length - 1] = partialAssistant;
      } else {
        chat.messages.push(partialAssistant);
      }
      await saveChat(chat);

      // 2. Run compaction to free context space
      const effectiveCW = getEffectiveContextWindow(chat, ollamaModel, settings);
      const emitCompacting = () => res.write(`event: compaction\ndata: ${JSON.stringify({ type: "mid_turn" })}\n\n`);
      const emitKeepalive = () => res.write(`: keepalive\n\n`);
      try {
        const compaction = await truncateChatHistory(chat, effectiveCW, true, emitCompacting, emitKeepalive);
        if (compaction?.truncated) {
          await saveChat(chat);
          console.log(`[chat] Mid-turn compaction: removed ${compaction.removedCount} messages, estimated ${compaction.estimatedTokenCount} tokens remaining`);

          // Extract memories from removed messages before they're lost
          if (isAgent && compaction.removedMessages?.length) {
            preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages)
              .catch(err => console.error("[compaction] pre-flush failed:", err));
          }
        }
      } catch (compErr) {
        console.error(`[chat] Mid-turn compaction failed:`, compErr);
      }

      // 3. Rebuild system prompt and context
      if (isAgent) {
        systemPrompt = await buildMemoryAugmentedPrompt(
          chat.systemPrompt || "You are a helpful assistant.",
          chat.messages, chat.id, chat.projectId
        );
      }
      const resumeMessages = chatMessagesToPiMessages(chat.messages, chat.modelId);

      // 4. Resume the agent loop with compacted context
      const resumeContext: AgentContext = {
        systemPrompt,
        messages: resumeMessages,
        tools: agentTools,
      };
      const resumeAbortController = new AbortController();
      connectionAbortController.signal.addEventListener("abort", () => resumeAbortController.abort());

      console.log(`[chat] Mid-turn compaction: resuming agent loop with ${resumeMessages.length} messages`);
      res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: "\n\n*[Context compacted — continuing...]*\n\n" })}\n\n`);
      state.fullText += "\n\n*[Context compacted — continuing...]*\n\n";

      try {
        const resumeStream = agentLoopContinue(resumeContext, config, resumeAbortController.signal, safeStreamFn);

        for await (const event of resumeStream) {
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              flushThinkingTimer();
              state.fullText += ame.delta;
              state.pendingText += ame.delta;
              res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
            } else if (ame.type === "thinking_delta") {
              if (state.thinkingStartTime === null) {
                state.thinkingStartTime = Date.now();
              }
              state.thinkingText += ame.delta;
              res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta: ame.delta })}\n\n`);
            }
          } else if (event.type === "tool_execution_start") {
            flushThinkingTimer();
            flushTextSegment();
            const toolCall: ChatToolCall = {
              id: event.toolCallId,
              name: event.toolName,
              arguments: event.args,
            };
            state.allToolCalls.push(toolCall);
            state.segments.push({ seq: ++state.seqCounter, type: "tool_call", toolCall });
            if (event.toolName !== "ask_user") {
              res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: "running" })}\n\n`);
            }
          } else if (event.type === "tool_execution_end") {
            if (event.toolName !== "ask_user") {
              const resultText = event.result?.content?.[0]?.text || "";
              const toolResult: ChatToolResult = {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                content: resultText,
                isError: event.isError,
              };
              state.allToolResults.push(toolResult);
              const resultSegment: OutputSegment = { seq: ++state.seqCounter, type: "tool_result", toolResult };
              state.segments.push(resultSegment);
              res.write(`event: segment\ndata: ${JSON.stringify(resultSegment)}\n\n`);
              res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: event.isError ? "error" : "done", result: resultText })}\n\n`);
            }
          } else if (event.type === "turn_end") {
            const msg = event.message as AssistantMessage;
            const sr = msg.stopReason || "stop";
            if (msg.usage) {
              state.finalUsage = { input: msg.usage.input, output: msg.usage.output, totalTokens: msg.usage.totalTokens };
            }
            console.log(`[chat] resume turn_end: stop=${sr} content=${state.fullText.length}ch tokens=${msg.usage?.totalTokens || "?"}`);
            if (sr !== "toolUse") break;
          }
        }
      } catch (resumeErr: any) {
        console.error(`[chat] resume loop failed: ${resumeErr.message}`);
      }

      // Update the in-progress message with resumed content
      const updatedMsg = buildCurrentAssistantMessage();
      const lastAssistant = chat.messages[chat.messages.length - 1];
      if (lastAssistant?.role === "assistant") {
        chat.messages[chat.messages.length - 1] = updatedMsg;
      }
      state.needsMidTurnCompaction = false;
    }

    // Check for queued follow-up messages even if loop exited early (e.g., due to abort)
    // This ensures messages aren't lost when agent-loop.js returns early on abort/error
    const queuedFollowUp = await messageQueue.drainOne(chat.id);
    if (queuedFollowUp && !askUserRef.current && !waitingForInput) {
      console.log(`[chat] post-loop: found queued follow-up message ${queuedFollowUp.id}, processing`);
      
      // Build current message first
      const currentAssistantMsg = buildCurrentAssistantMessage();
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
        chat.messages[chat.messages.length - 1] = currentAssistantMsg;
      } else {
        chat.messages.push(currentAssistantMsg);
      }
      
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
        // Emit background activity event so client can show indicator
        res.write(`event: background_activity\ndata: ${JSON.stringify({ type: "memory_extraction", chatId: chat.id })}\n\n`);
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
      
      // Safety check: ensure context is not empty
      if (followUpContextMessages.length === 0 && chat.messages.length > 1) {
        console.error(`[chat] follow-up context is empty despite ${chat.messages.length} messages - this indicates a conversion bug`);
      }
      
      const followUpSystemPrompt = (chat.type === "agent" || chat.type === "bluesky")
        ? await buildMemoryAugmentedPrompt(chat.systemPrompt || "You are a helpful assistant.", chat.messages, chat.id, chat.projectId)
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
      let foundAskUser = false;
      while (savedMessages.length > 0) {
        const last = savedMessages[savedMessages.length - 1] as any;
        if (
          last.role === "assistant" &&
          last.content?.some?.((c: any) => c.type === "toolCall" && c.name === "ask_user")
        ) {
          foundAskUser = true;
          break; // Keep this assistant message
        }
        savedMessages.pop();
      }
      
      // Safety: if no ask_user message was found, keep the original context
      // to avoid losing all conversation history due to malformed message structure
      if (!foundAskUser && context.messages.length > 0) {
        console.warn(`[chat] ask_user message not found in context, preserving full context (${context.messages.length} messages)`);
        savedMessages.push(...context.messages);
      }

      await savePendingState(chat.id, {
        agentMessages: savedMessages,
        systemPrompt,
        askToolCallId: askUserRef.current.toolCallId,
      });

      res.write(`event: ask_user\ndata: ${JSON.stringify({ question: askUserRef.current.question })}\n\n`);
    }

    // Flush any remaining thinking timer before building the final message
    flushThinkingTimer();

    // Build the final assistant message
    const assistantMsg = buildCurrentAssistantMessage();
    
    // Check if the message has any actual content
    const hasContent = assistantMsg.content.trim() || assistantMsg.thinking || assistantMsg.toolCalls?.length;
    
    if (hasContent) {
      // Replace the in-progress message if present, otherwise push
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
        chat.messages[chat.messages.length - 1] = assistantMsg;
      } else {
        chat.messages.push(assistantMsg);
      }
      await saveChat(chat);
      console.log(`[chat] finished: iterations=${iterations} waitingForInput=${waitingForInput} content=${assistantMsg.content.length}ch`);
    } else {
      // Remove the in-progress placeholder if present
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
        chat.messages.pop();
        await saveChat(chat);
      }
      console.error(`[chat] NO CONTENT produced after ${iterations} iterations - model failure or context issue. Not persisting empty message.`);
      // Clean up stale pending state so the next message doesn't trigger a spurious resume
      await clearPendingState(chat.id);
    }

    if (waitingForInput) {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true, iterations })}\n\n`
      );
    } else {
      // Clean up pending state — turn completed normally, no need for crash recovery
      await clearPendingState(chat.id);

      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, iterations })}\n\n`
      );

      // Generate LLM title after the first exchange (2 messages = 1 user + 1 assistant)
      // Only generate title if we have actual content
      if (chat.messages.length === 2 && hasContent) {
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
      // Only extract if we have actual content
      if ((chat.type === "agent" || chat.type === "bluesky") && hasContent) {
        extractMemories(chat.modelId, chat.id, lastUserMessage, assistantMsg.content)
          .catch((err) => console.error("[memory] extraction failed:", err));
      }

      // Post-response compaction: truncate if usage > 75% OR if we hit the context limit
      try {
        const model = allModels.find((m: OllamaModel) => m.id === chat.modelId);
        if (model) {
          const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
          const lastUsage = assistantMsg.usage?.totalTokens ?? 0;
          const usageRatio = lastUsage > 0 ? lastUsage / effectiveContextWindow : 0;

          // If usage data is missing (tokens=?), fall back to character-based estimation.
          // This commonly happens when Ollama errors out at context limits without reporting usage.
          let needsCompaction = hitContextLimit || usageRatio > 0.75;
          if (!needsCompaction && lastUsage === 0 && chat.messages.length > 4) {
            const { estimateContextTokens } = await import("../services/compaction.js");
            const estimatedTokens = estimateContextTokens(chat.messages, systemPrompt);
            const estimatedRatio = estimatedTokens / effectiveContextWindow;
            if (estimatedRatio > 0.75) {
              console.log(`[compaction] Usage missing but char estimation shows ${estimatedTokens} tokens (${(estimatedRatio * 100).toFixed(0)}% of ${effectiveContextWindow}) — forcing compaction`);
              needsCompaction = true;
            }
          }

          if (needsCompaction) {
            const emitCompacting = () => res.write(`event: compacting\ndata: {}\n\n`);
            const emitKeepalive = () => res.write(`: keepalive\n\n`);
            const compaction = await truncateChatHistory(chat, effectiveContextWindow, hitContextLimit || (lastUsage === 0 && needsCompaction), emitCompacting, emitKeepalive);
            if (compaction.truncated) {
              // Extract memories from removed messages (agent chats only)
              if ((chat.type === "agent" || chat.type === "bluesky") && compaction.removedMessages?.length) {
                await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages);
              }
              await saveChat(chat);
              
              // Find the summary message that was inserted
              const summaryMsg = chat.messages.find(m => m._isCompactionSummary);
              res.write(`event: compaction\ndata: ${JSON.stringify({
                removedCount: compaction.removedCount,
                remainingCount: chat.messages.length,
                summaryMessage: summaryMsg || null,
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

      // Build partial assistant message with whatever we accumulated
      const assistantMsg = buildCurrentAssistantMessage();
      // Replace in-progress message if present, otherwise push
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
        chat.messages[chat.messages.length - 1] = assistantMsg;
      } else {
        chat.messages.push(assistantMsg);
      }

      // Save immediately - this is critical for durability
      try {
        await saveChat(chat);
        console.log(`[chat] error path: saved partial message before ask_user`);
      } catch (saveErr) {
        console.error(`[chat] failed to save on ask_user error path:`, saveErr);
      }

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
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true, iterations })}\n\n`
      );
    } else if (e.name === "AbortError") {
      // AbortError from client disconnect or inactivity timeout
      // Save whatever we've accumulated before the connection dropped
      if (state.fullText.trim() || state.allToolCalls.length > 0) {
        const assistantMsg = buildCurrentAssistantMessage();
        const lastMsg = chat.messages[chat.messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
          chat.messages[chat.messages.length - 1] = assistantMsg;
        } else {
          chat.messages.push(assistantMsg);
        }
        try {
          await saveChat(chat);
          console.log(`[chat] abort: saved partial response (${assistantMsg.content.length}ch, ${assistantMsg.toolCalls?.length || 0} tools)`);
        } catch (saveErr) {
          console.error(`[chat] abort: failed to save partial response:`, saveErr);
        }
      }
      console.log(`[chat] stream aborted: ${connectionClosed ? "client disconnected" : "signal aborted"}`);
    } else {
      // Unexpected error - save what we have before reporting
      if (state.fullText.trim() || state.allToolCalls.length > 0 || state.allToolResults.length > 0) {
        const assistantMsg = buildCurrentAssistantMessage();
        const lastMsg = chat.messages[chat.messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
          chat.messages[chat.messages.length - 1] = assistantMsg;
        } else {
          chat.messages.push(assistantMsg);
        }
        try {
          await saveChat(chat);
          console.log(`[chat] error: saved partial state before error (${assistantMsg.content.length}ch)`);
        } catch (saveErr) {
          console.error(`[chat] error: failed to save partial state:`, saveErr);
        }
      }
      
      // Only write error if the connection is still open
      if (!connectionClosed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`
        );
      }
    }
  } finally {
    stopSSEKeepalive();
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
  
  // Always discover skills (global + project if applicable)
  const allSkills = await discoverSkills(chat.projectId);
  console.log(`[skills] Chat ${chatId} (type=${chat.type}, projectId=${chat.projectId}): discovered ${allSkills.length} skills: ${allSkills.map(s => s.name).join(", ")}`);
  
  if (invokedSkills.length > 0) {
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
        } else {
          console.log(`[skills] Skill "${skill.name}" already active in chat ${chatId}`);
        }
      } else {
        console.warn(`[skills] Invoked skill "${invokedSkill}" not found in discovered skills`);
      }
    }
    
    // Keep skill invocations in the message for display (they're already activated)
    // No need to strip them - they serve as visual indicators of activated skills
  }
  
  // Check for pending state (ask_user OR mid-turn crash recovery)
  const pendingState = await loadPendingState(chatId);

  // Check if this is a mid-turn crash recovery (has accumulators but no ask_user)
  const isMidTurnRecovery = pendingState && !pendingState.askToolCallId && pendingState.fullText !== undefined;

  if (isMidTurnRecovery) {
    // MID-TURN CRASH RECOVERY: The agent was mid-tool-loop when the process died.
    // The in-progress assistant message (with tool calls and partial text) should
    // already be in chat.messages from incremental persistence. If not, reconstruct
    // it from the pending state accumulators. Then fall through to the normal path
    // so the user's new message is sent as a fresh prompt with full context.
    console.log(`[chat] mid-turn crash recovery: ${pendingState!.iterations} iterations, ${pendingState!.fullText?.length || 0}ch text, ${pendingState!.toolCalls?.length || 0} tools`);

    const lastMsg = chat.messages[chat.messages.length - 1];
    const hasInProgressMsg = lastMsg?.role === "assistant" && (lastMsg._inProgress || lastMsg.toolCalls?.length);

    if (!hasInProgressMsg && pendingState!.toolCalls?.length) {
      // No in-progress message saved (pre-fix crash) — reconstruct from accumulators
      const partialMsg: ChatMessage = {
        role: "assistant",
        content: pendingState!.fullText || "",
        thinking: pendingState!.thinkingText || undefined,
        toolCalls: pendingState!.toolCalls?.length ? pendingState!.toolCalls : undefined,
        toolResults: pendingState!.toolResults?.length ? pendingState!.toolResults : undefined,
        timestamp: Date.now(),
      };
      if (lastMsg?.role === "assistant") {
        chat.messages[chat.messages.length - 1] = partialMsg;
      } else {
        chat.messages.push(partialMsg);
      }
      await saveChat(chat);
      console.log(`[chat] reconstructed in-progress message from pending state accumulators`);
    } else if (hasInProgressMsg) {
      // Strip _inProgress flag — the message is now finalized (partial)
      delete lastMsg._inProgress;
      await saveChat(chat);
    }

    // Fall through to the normal path below — the in-progress assistant message
    // is now part of chat.messages, so context will include it.
    // pendingState is already consumed (deleted) by loadPendingState.
  }

  if (pendingState && !isMidTurnRecovery) {
    // ASK_USER RESUME: the user's message is the answer to ask_user
    let systemPrompt = pendingState.systemPrompt;
    
    // Load settings for context window resolution
    const settings = await getSettings();

    // Check for new skill invocations in resume message
    const invokedSkills = parseSkillInvocations(message);
    if (invokedSkills.length > 0) {
      const allSkills = await discoverSkills(chat.projectId);
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
      const allSkills = await discoverSkills(chat.projectId);
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
    }

    const contextMessages = pendingState.agentMessages as Message[];

    // Safety check: if context is empty, rebuild from chat.messages to avoid
    // losing conversation history due to corrupted or empty pending state
    if (contextMessages.length === 0 && chat.messages.length > 0) {
      console.warn(`[chat] pending state has empty context, rebuilding from chat.messages (${chat.messages.length} messages)`);
      // Exclude the last message (current user message) from context
      const rebuiltContext = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
      contextMessages.push(...rebuiltContext);
    }

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
    let model: OllamaModel | undefined;
    try {
      const allModels = await discoverAllModels();
      model = allModels.find((m) => m.id === chat.modelId);
    } catch (err: any) {
      console.error("[compaction] model discovery failed (resume):", err.message);
      model = undefined; // Skip truncation if providers are unreachable
    }

    // Pre-send context protection for resume path
    if (model) {
      try {
        const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
        const emitKeepalive = () => res.write(`: keepalive\n\n`);
        const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt, () => res.write(`event: compacting\ndata: {}\n\n`), emitKeepalive);
        if (compaction && compaction.truncated) {
          await saveChat(chat);
          // Rebuild system prompt after truncation
          if (chat.type === "agent") {
            systemPrompt = await buildMemoryAugmentedPrompt(
              chat.systemPrompt || "You are a helpful assistant.",
              chat.messages,
              chat.id,
              chat.projectId
            );
          }
          // Find the summary message that was inserted
          const summaryMsg = chat.messages.find(m => m._isCompactionSummary);
          // Emit compaction event for UI indicator
          res.write(`event: compaction\ndata: ${JSON.stringify({
            removedCount: compaction.removedCount,
            remainingCount: chat.messages.length,
            summaryMessage: summaryMsg || null,
          })}\n\n`);
        }
      } catch (err) {
        console.error("[compaction] pre-send truncation failed (resume):", err);
      }
    }

    // Safety check: warn if context is empty for resume
    if (contextMessages.length === 0 && chat.messages.length > 1) {
      console.error(`[chat] CRITICAL: resume context is empty despite ${chat.messages.length} messages in chat`);
    }

    // Safety check: detect catastrophic context loss from compaction
    if (chat.messages.length <= 3 && chat.messages.length > 1) {
      console.warn(`[chat] WARNING: resume chat has only ${chat.messages.length} messages after compaction - possible catastrophic context loss`);
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

    // Load settings for context window resolution
    const settings = await getSettings();

    // Build system prompt with memories and active skills
    let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    if (chat.type === "agent" || chat.type === "bluesky") {
      systemPrompt = await buildMemoryAugmentedPrompt(
        systemPrompt,
        chat.messages,
        chat.id,
        chat.projectId
      );
    }
    
    // Inject active skills into system prompt
    if (chat.activeSkills?.length) {
      const skillsCache = new Map<string, Skill>();
      const allSkills = await discoverSkills(chat.projectId);
      console.log(`[skills] Chat ${chatId}: projectId=${chat.projectId}, discovered ${allSkills.length} skills, activeSkills=${chat.activeSkills.join(",")}`);
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
      console.log(`[skills] Injected ${chat.activeSkills.length} skills into system prompt`);
    } else {
      console.log(`[skills] Chat ${chatId}: no activeSkills set (projectId=${chat.projectId})`);
    }
    
    // Discover model for pre-send truncation
    let model: OllamaModel | undefined;
    try {
      const allModels = await discoverAllModels();
      model = allModels.find((m) => m.id === chat.modelId);
    } catch (err: any) {
      console.error("[compaction] model discovery failed:", err.message);
      model = undefined; // Skip truncation if providers are unreachable
    }
    
    // Pre-send context protection: truncate BEFORE sending if >75% of context window
    if (model) {
      try {
        const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
        const emitKeepalive = () => res.write(`: keepalive\n\n`);
        const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt, () => res.write(`event: compacting\ndata: {}\n\n`), emitKeepalive);
        if (compaction && compaction.truncated) {
          await saveChat(chat);
          // Rebuild system prompt after truncation (memories may have changed)
          if (chat.type === "agent") {
            systemPrompt = await buildMemoryAugmentedPrompt(
              chat.systemPrompt || "You are a helpful assistant.",
              chat.messages,
              chat.id,
              chat.projectId
            );
          }
          // Find the summary message that was inserted
          const summaryMsg = chat.messages.find(m => m._isCompactionSummary);
          // Emit compaction event for UI indicator
          res.write(`event: compaction\ndata: ${JSON.stringify({
            removedCount: compaction.removedCount,
            remainingCount: chat.messages.length,
            summaryMessage: summaryMsg || null,
          })}\n\n`);
        }
      } catch (err) {
        console.error("[compaction] pre-send truncation failed:", err);
      }
    }

    setCachedAugmentedPrompt(chat.id, systemPrompt);

    // Context = all messages EXCEPT the one we just added (agentLoop adds it as prompt)
    const contextMessages = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);

    // Safety check: warn if context is empty for non-first messages
    if (contextMessages.length === 0 && chat.messages.length > 1) {
      console.error(`[chat] CRITICAL: context conversion produced empty array for chat with ${chat.messages.length} messages`);
    }

    // Safety check: detect catastrophic context loss from compaction
    if (chat.messages.length <= 3 && chat.messages.length > 1) {
      console.warn(`[chat] WARNING: chat has only ${chat.messages.length} messages after compaction - possible catastrophic context loss`);
    }
    
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

// Stop an in-progress chat stream
router.post("/stop", async (req, res) => {
  const { chatId } = req.body as { chatId: string };
  
  if (!chatId) {
    return res.status(400).json({ error: "chatId is required" });
  }
  
  const activeStreams = (globalThis as any)._activeChatStreams as Map<string, AbortController> | undefined;
  const controller = activeStreams?.get(chatId);
  
  if (controller) {
    controller.abort();
    console.log(`[chat] stop: aborted stream for chat ${chatId}`);
    res.json({ stopped: true });
  } else {
    console.log(`[chat] stop: no active stream found for chat ${chatId}`);
    res.json({ stopped: false, reason: "no_active_stream" });
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

  // Get the original message to preserve images BEFORE truncating
  const originalMessage = chat.messages[messageIndex];
  
  // Truncate everything from messageIndex onwards
  chat.messages = chat.messages.slice(0, messageIndex);

  // Add edited user message, preserving images from the original
  const userMsg: ChatMessage = {
    role: "user",
    content: message,
    images: originalMessage.images?.length ? originalMessage.images : undefined,
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
    systemPrompt = await buildMemoryAugmentedPrompt(systemPrompt, chat.messages, chat.id, chat.projectId);
  }
  
  // Load settings for context window resolution
  const settings = await getSettings();
  
  // Inject active skills into system prompt
  if (chat.activeSkills?.length) {
    const skillsCache = new Map<string, Skill>();
    const allSkills = await discoverSkills(chat.projectId);
    for (const s of allSkills) {
      skillsCache.set(s.name, s);
    }
    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
  }
  
  // Discover model for pre-send truncation
  let model: OllamaModel | undefined;
  try {
    const allModels = await discoverAllModels();
    model = allModels.find((m) => m.id === chat.modelId);
  } catch (err: any) {
    console.error("[compaction] model discovery failed (edit):", err.message);
    model = undefined; // Skip truncation if providers are unreachable
  }
  
  // Pre-send context protection for edit path
  if (model) {
    try {
      const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
      const emitKeepalive = () => res.write(`: keepalive\n\n`);
      const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt, () => res.write(`event: compacting\ndata: {}\n\n`), emitKeepalive);
      if (compaction && compaction.truncated) {
        await saveChat(chat);
        // Rebuild system prompt after truncation
        if (chat.type === "agent") {
          systemPrompt = await buildMemoryAugmentedPrompt(
            chat.systemPrompt || "You are a helpful assistant.",
            chat.messages,
            chat.id,
            chat.projectId
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
  
  // Safety check: warn if context is empty for non-first messages
  if (contextMessages.length === 0 && chat.messages.length > 1) {
    console.error(`[chat] CRITICAL: context conversion produced empty array for edit with ${chat.messages.length} messages`);
  }
  
  // Safety check: detect catastrophic context loss from compaction
  if (chat.messages.length <= 3 && chat.messages.length > 1) {
    console.warn(`[chat] WARNING: edit chat has only ${chat.messages.length} messages after compaction - possible catastrophic context loss`);
  }
  
  const userPiMessage = buildUserPiMessage(message);

  await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
});

export default router;
