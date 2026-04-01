import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendMessage, editMessage as apiEditMessage, enqueueMessage as apiEnqueueMessage, stopChat as apiStopChat } from "../api/client";
import type { StreamCallbacks, ToolStatus, StreamWarning } from "../api/client";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment, InlineVisual, MessageSegment, MessageUsage } from "../types";
import { useStreamingTTS } from "./useStreamingTTS";
import {
  enqueueMessage,
  dequeueMessage,
  getQueuedMessagesForChat,
  setCachedChat,
} from "../lib/db";
import type { Chat } from "../types";

/** Per-chat streaming state stored when the chat is not actively displayed */
interface BackgroundStream {
  content: string;
  thinking: string;
  tools: ToolStatus[];
  artifacts: Artifact[];
  visuals: InlineVisual[];
  generatedImages: GeneratedImage[];
  messages: ChatMessage[];
  streaming: boolean;
  waitingForInput: boolean;
  error: string | null;
  warning: StreamWarning | null;
  compacting: boolean;
  compaction: { removedCount: number; remainingCount: number } | null;
  doneCalled: boolean;
  abortController: AbortController | null;
  chatRef: Chat | null;
  /** Client-side segments built during streaming for interleaved rendering */
  segments: MessageSegment[];
  seqCounter: number;
}

/** Module-level store — survives hook re-renders and chat switches */
const bgStreams = new Map<string, BackgroundStream>();

/** Per-chat draft state stored when user is typing a message */
interface Draft {
  text: string;
  images: ImageAttachment[];
}

const drafts = new Map<string, Draft>();

/** Check if a chat has an active or completed background stream */
export function hasBackgroundStream(chatId: string): boolean {
  return bgStreams.has(chatId);
}

/** Get draft for a chat */
export function getDraft(chatId: string): Draft | undefined {
  return drafts.get(chatId);
}

/** Set draft for a chat */
export function setDraft(chatId: string, text: string, images: ImageAttachment[]): void {
  drafts.set(chatId, { text, images });
}

/** Clear draft for a chat */
export function clearDraft(chatId: string): void {
  drafts.delete(chatId);
}

/** Get chat IDs with active (still streaming) background streams */
export function getStreamingChatIds(): string[] {
  return Array.from(bgStreams.entries())
    .filter(([, bg]) => bg.streaming)
    .map(([id]) => id);
}

function createBgStream(chatRef: Chat | null): BackgroundStream {
  return {
    content: "",
    thinking: "",
    tools: [],
    artifacts: [],
    visuals: [],
    generatedImages: [],
    messages: [],
    streaming: true,
    waitingForInput: false,
    error: null,
    warning: null,
    compacting: false,
    compaction: null,
    doneCalled: false,
    abortController: null,
    chatRef,
    segments: [],
    seqCounter: 0,
  };
}

export function useChat(chatId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingThinking, setStreamingThinking] = useState("");
  const [activeTools, setActiveTools] = useState<ToolStatus[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [generatedImages, setGeneratedImages] = useState<GeneratedImage[]>([]);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<StreamWarning | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compaction, setCompaction] = useState<{ removedCount: number; remainingCount: number } | null>(null);
  const [queueProcessing, setQueueProcessing] = useState(false);
  const [titleUpdate, setTitleUpdate] = useState<{ chatId: string; title: string } | null>(null);
  const [streamingSegmentIndex, setStreamingSegmentIndex] = useState<number | null>(null);
  const [streamingUsage, setStreamingUsage] = useState<MessageUsage | null>(null);
  const [hasBackgroundActivity, setHasBackgroundActivity] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);
  const streamingContentRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const activeChatRef = useRef<Chat | null>(null);

  /** Always reflects the currently displayed chatId */
  const activeChatIdRef = useRef<string | null>(chatId);
  activeChatIdRef.current = chatId;

  // Restore or reset streaming state when switching chats
  // IMPORTANT: Only depends on chatId to avoid race conditions with stale messages state
  useEffect(() => {
    // Cancel any pending rAF flush from previous chat's stream
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const bg = chatId ? bgStreams.get(chatId) : undefined;
    if (bg) {
      // Restore streaming state from background (chat was switched away from mid-stream)
      setMessages([...bg.messages]);
      setStreaming(bg.streaming);
      streamingContentRef.current = bg.content;
      setStreamingThinking(bg.thinking);
      setActiveTools([...bg.tools]);
      setArtifacts([...bg.artifacts]);
      setGeneratedImages([...bg.generatedImages]);
      setWaitingForInput(bg.waitingForInput);
      setError(bg.error);
      setWarning(bg.warning);
      setCompacting(bg.compacting);
      setCompaction(bg.compaction);
      doneCalledRef.current = bg.doneCalled;
      abortRef.current = bg.abortController;

      if (!bg.streaming) {
        // Stream finished while in background — clean up entry
        bgStreams.delete(chatId!);
        setStreamingSegmentIndex(null);
      }
    } else {
      // No background stream — fresh reset for new chat
      // In-progress state from persistence is handled by App.tsx selectChat logic
      // which checks for _inProgress flag before calling loadMessages
      setStreaming(false);
      setStreamingThinking("");
      setActiveTools([]);
      setArtifacts([]);
      setGeneratedImages([]);
      setWaitingForInput(false);
      setError(null);
      setWarning(null);
      setCompacting(false);
      setCompaction(null);
      setStreamingSegmentIndex(null);
      setStreamingUsage(null);
    }
  }, [chatId]);

  const loadMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
  }, []);

  // Store active chat reference for IDB caching
  const setActiveChatData = useCallback((chat: Chat | null) => {
    activeChatRef.current = chat;
    // Keep bgStream's chatRef up-to-date with latest metadata
    if (chat && bgStreams.has(chat.id)) {
      bgStreams.get(chat.id)!.chatRef = chat;
    }
  }, []);

  // Flush accumulated streaming content + segments to React state (batched per frame)
  const flushStreamingContent = useCallback(() => {
    const content = streamingContentRef.current;
    const chatId = activeChatIdRef.current;
    const bg = chatId ? bgStreams.get(chatId) : undefined;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant") {
        const segments = bg && bg.segments.length > 0 ? bg.segments.map(s => ({ ...s })) : undefined;
        const updated = prev.slice(0, -1);
        updated.push({ ...last, content, segments });
        return updated;
      }
      return prev;
    });
    rafRef.current = null;
  }, []);

  // Create chat-aware SSE callbacks that route to the correct bgStream
  const makeStreamCallbacks = useCallback(
    (streamChatId: string, onDoneExtra?: (msgs: ChatMessage[]) => void): StreamCallbacks => ({
      onDelta: (delta) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.content += delta;

        // Build streaming segments: append to current text segment or start a new one
        const lastSeg = bg.segments[bg.segments.length - 1];
        if (lastSeg?.type === "text") {
          lastSeg.content = (lastSeg.content || "") + delta;
        } else {
          bg.segments.push({ seq: bg.seqCounter++, type: "text", content: delta });
        }

        // Update last message in bgStream
        const last = bg.messages[bg.messages.length - 1];
        if (last?.role === "assistant") {
          bg.messages[bg.messages.length - 1] = { ...last, content: bg.content };
        }

        // Sync to React state only if this stream is currently displayed
        if (activeChatIdRef.current === streamChatId) {
          streamingContentRef.current = bg.content;
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onThinkingDelta: (delta) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.thinking += delta;

        if (activeChatIdRef.current === streamChatId) {
          setStreamingThinking(bg.thinking);
        }
      },
      onGeneratedImage: (image) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.generatedImages.push(image);

        // Add generated image segment
        bg.segments.push({ seq: bg.seqCounter++, type: "generated_image", generatedImage: image });

        if (activeChatIdRef.current === streamChatId) {
          setGeneratedImages([...bg.generatedImages]);
          // Generated image segments indicate text is complete
          setStreamingSegmentIndex(null);
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onVisual: (visual) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.visuals.push(visual);

        // Add visual segment
        bg.segments.push({ seq: bg.seqCounter++, type: "visual", visual });

        if (activeChatIdRef.current === streamChatId) {
          // Visual segments indicate text is complete
          setStreamingSegmentIndex(null);
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onDone: ({ thinking, usage, artifacts: doneArtifacts, generatedImages: doneImages, visuals: doneVisuals, toolCalls, toolResults, segments, waitingForInput: wfi }) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg || bg.doneCalled) return;
        bg.doneCalled = true;
        bg.streaming = false;

        // Finalize last message with full metadata
        const last = bg.messages[bg.messages.length - 1];
        if (last?.role === "assistant") {
          bg.messages[bg.messages.length - 1] = {
            ...last,
            content: bg.content,
            thinking: thinking || undefined,
            usage: usage || undefined,
            artifacts: doneArtifacts || undefined,
            generatedImages: doneImages || undefined,
            visuals: doneVisuals || undefined,
            toolCalls: toolCalls || undefined,
            toolResults: toolResults || undefined,
            segments: segments || undefined,
          };
        }

        if (wfi) bg.waitingForInput = true;

        const isActive = activeChatIdRef.current === streamChatId;
        const finalMsgs = [...bg.messages];

        if (isActive) {
          // Active chat — sync to React state
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          setMessages(finalMsgs);
          setStreamingThinking("");
          setStreaming(false);
          setStreamingSegmentIndex(null);
          setStreamingUsage(null);
          if (wfi) setWaitingForInput(true);
          bgStreams.delete(streamChatId);
        }

        // Update IDB cache (both active and background)
        const chatObj = isActive ? activeChatRef.current : bg.chatRef;
        if (chatObj) {
          setCachedChat({ ...chatObj, messages: finalMsgs }).catch(() => {});
        }

        onDoneExtra?.(finalMsgs);
      },
      onToolStatus: (status) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        const existingIdx = bg.tools.findIndex(
          (t) => t.name === status.name && t.status === "running"
        );
        
        if (existingIdx >= 0 && status.status !== "running") {
          bg.tools[existingIdx] = status;
        } else if (status.status === "running") {
          bg.tools.push(status);
        }

        if (activeChatIdRef.current === streamChatId) {
          setActiveTools([...bg.tools]);
        }
      },
      onSegment: (segment) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        // For tool_result, insert immediately after its matching tool_call
        // so visual/artifact segments stay in the right position
        if (segment.type === "tool_result" && segment.toolResult) {
          const callIdx = bg.segments.findIndex(
            s => s.type === "tool_call" && s.toolCall?.id === segment.toolResult!.toolCallId
          );
          if (callIdx >= 0) {
            bg.segments.splice(callIdx + 1, 0, segment);
          } else {
            bg.segments.push(segment);
          }
        } else {
          bg.segments.push(segment);
        }

        if (activeChatIdRef.current === streamChatId) {
          // Track which segment is actively streaming (text segments only)
          if (segment.type === "text") {
            setStreamingSegmentIndex(bg.segments.length - 1);
          }
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onAskUser: (_question) => {
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.waitingForInput = true;

        if (activeChatIdRef.current === streamChatId) {
          setWaitingForInput(true);
        }
      },
      onArtifact: (artifact) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;
        bg.artifacts.push(artifact);

        // Add artifact segment
        bg.segments.push({ seq: bg.seqCounter++, type: "artifact", artifact });

        if (activeChatIdRef.current === streamChatId) {
          setArtifacts([...bg.artifacts]);
          // Artifact segments indicate text is complete
          setStreamingSegmentIndex(null);
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onIteration: (info) => {
        console.log(`[chat] iteration ${info.iteration}: stopReason=${info.stopReason} tools=${info.toolCount}`);
        // Update live usage from iteration events so token indicator stays current during tool loops
        if (info.usage && activeChatIdRef.current === streamChatId) {
          setStreamingUsage(info.usage);
        }
      },
      onWarning: (w) => {
        console.warn(`[chat] warning: ${w.type} — ${w.message}`);
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.warning = w;

        if (activeChatIdRef.current === streamChatId) {
          setWarning(w);
        }
      },
      onCompacting: () => {
        console.log(`[chat] compaction started`);
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.compacting = true;
        if (activeChatIdRef.current === streamChatId) {
          setCompacting(true);
        }
      },
      onCompaction: (info) => {
        console.log(`[chat] compaction: removed ${info.removedCount} messages, ${info.remainingCount} remaining`);
        const bg = bgStreams.get(streamChatId);
        if (bg) {
          bg.compacting = false;
          bg.compaction = info;
          
          // Insert the summary message into the messages array if provided
          if (info.summaryMessage) {
            const summaryMsg: ChatMessage = {
              ...info.summaryMessage,
              _isCompactionSummary: true,
              _compactedMessageCount: info.removedCount,
            };
            // Insert after first message (index 1) - this matches server behavior
            const newMessages = [...bg.messages];
            // Remove any existing compaction summary to avoid duplicates
            const existingSummaryIdx = newMessages.findIndex(m => m._isCompactionSummary);
            if (existingSummaryIdx >= 0) {
              newMessages.splice(existingSummaryIdx, 1);
            }
            // Insert at index 1 (after the first message)
            newMessages.splice(1, 0, summaryMsg);
            bg.messages = newMessages;
            
            // Sync to React state if this is the active chat
            if (activeChatIdRef.current === streamChatId) {
              setMessages(newMessages);
            }
          }
        }
        if (activeChatIdRef.current === streamChatId) {
          setCompacting(false);
          setCompaction(info);
        }
      },
      onMessageComplete: (message) => {
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        // Finalize the second-to-last assistant message with complete data from server
        const msgs = bg.messages;
        // Find the assistant message that just completed (second-to-last assistant)
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "assistant" && msgs[i].content === bg.content) {
            msgs[i] = { ...msgs[i], ...message };
            break;
          }
        }

        // Reset streaming accumulators for the next response
        bg.content = "";
        bg.thinking = "";
        bg.tools = [];
        bg.artifacts = [];
        bg.visuals = [];
        bg.generatedImages = [];
        bg.segments = [];
        bg.seqCounter = 0;

        if (activeChatIdRef.current === streamChatId) {
          streamingContentRef.current = "";
          setStreamingThinking("");
          setActiveTools([]);
          setArtifacts([]);
          setGeneratedImages([]);
          setMessages([...bg.messages]);
        }
      },
      onFollowUpStart: (_data) => {
        // The server has picked up a queued message — add assistant placeholder now
        const bg = bgStreams.get(streamChatId);
        if (!bg) return;

        const placeholder: ChatMessage = {
          role: "assistant",
          content: "",
          timestamp: Date.now(),
        };
        bg.messages = [...bg.messages, placeholder];

        if (activeChatIdRef.current === streamChatId) {
          setMessages([...bg.messages]);
        }

        console.log(`[chat] follow-up started for ${streamChatId}`);
      },
      onBackgroundActivity: (info) => {
        console.log(`[chat] background activity: ${info.type} for chat ${info.chatId}`);
        // Set background activity indicator for 5 seconds
        setHasBackgroundActivity(true);
        setTimeout(() => setHasBackgroundActivity(false), 5000);
      },
      onTitleUpdate: (chatId, title) => {
        setTitleUpdate({ chatId, title });
      },
      onError: (err) => {
        const bg = bgStreams.get(streamChatId);

        if (err.startsWith("__OFFLINE__:")) {
          const errorMsg = "Network unavailable — message queued";
          if (bg) {
            bg.streaming = false;
            bg.error = errorMsg;
            // Find and enqueue the last user message
            const lastUserIdx = bg.messages.map((m) => m.role).lastIndexOf("user");
            if (lastUserIdx >= 0) {
              const userMsg = bg.messages[lastUserIdx];
              enqueueMessage(streamChatId, userMsg.content, userMsg.images).catch(() => {});
              // Remove empty assistant placeholder
              const lastMsg = bg.messages[bg.messages.length - 1];
              if (lastMsg?.role === "assistant" && !lastMsg.content) {
                bg.messages = bg.messages.slice(0, -1);
              }
              bg.messages = bg.messages.map((m, i) =>
                i === lastUserIdx ? { ...m, queued: true } : m
              );
            }
          }

          if (activeChatIdRef.current === streamChatId) {
            setError(errorMsg);
            if (bg) setMessages([...bg.messages]);
            setStreaming(false);
            bgStreams.delete(streamChatId);
          }
        } else {
          if (bg) {
            bg.streaming = false;
            bg.error = err;
          }
          if (activeChatIdRef.current === streamChatId) {
            setError(err);
            setStreaming(false);
            bgStreams.delete(streamChatId);
          }
        }
      },
    }),
    [flushStreamingContent]
  );

  // Shared pre-stream state reset
  const prepareStream = useCallback(() => {
    setStreaming(true);
    setStreamingThinking("");
    setActiveTools([]);
    setArtifacts([]);
    setGeneratedImages([]);
    setWaitingForInput(false);
    setError(null);
    setWarning(null);
    setCompaction(null);
    doneCalledRef.current = false;
    streamingContentRef.current = "";
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const send = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      if (!chatId) return;
      const targetChatId = chatId;

      const userMsg: ChatMessage = {
        role: "user",
        content: text,
        images: images?.length ? images : undefined,
        timestamp: Date.now(),
      };

      // If offline, queue the message
      if (!navigator.onLine) {
        const queuedMsg: ChatMessage = { ...userMsg, queued: true };
        setMessages((prev) => [...prev, queuedMsg]);
        enqueueMessage(targetChatId, text, images).catch(() => {});
        return;
      }

      // If streaming, enqueue the message for follow-up
      if (streaming) {
        const bg = bgStreams.get(targetChatId);
        if (bg) {
          bg.messages = [...bg.messages, userMsg];
        }
        setMessages((prev) => [...prev, userMsg]);
        apiEnqueueMessage(targetChatId, text, images).catch((err) =>
          console.error("[chat] enqueue failed:", err)
        );
        return;
      }

      // Create bgStream entry for this chat's stream
      const bg = createBgStream(activeChatRef.current);
      bgStreams.set(targetChatId, bg);

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      // Update React state and bgStream messages together
      setMessages((prev) => {
        const next = [...prev, userMsg, assistantMsg];
        bg.messages = next;
        return next;
      });

      prepareStream();

      const callbacks = makeStreamCallbacks(targetChatId);
      const controller = sendMessage(targetChatId, text, callbacks, images);
      bg.abortController = controller;
      abortRef.current = controller;
    },
    [chatId, streaming, prepareStream, makeStreamCallbacks]
  );

  const editMessage = useCallback(
    (index: number, newText: string) => {
      if (!chatId || streaming || !navigator.onLine) return;
      const targetChatId = chatId;

      // Create bgStream entry
      const bg = createBgStream(activeChatRef.current);
      bgStreams.set(targetChatId, bg);

      // Truncate to edit point, add new user msg + placeholder assistant msg
      setMessages((prev) => {
        const truncated = prev.slice(0, index);
        const next = [
          ...truncated,
          { role: "user" as const, content: newText, timestamp: Date.now() },
          { role: "assistant" as const, content: "", timestamp: Date.now() },
        ];
        bg.messages = next;
        return next;
      });

      prepareStream();

      const callbacks = makeStreamCallbacks(targetChatId);
      const controller = apiEditMessage(targetChatId, index, newText, callbacks);
      bg.abortController = controller;
      abortRef.current = controller;
    },
    [chatId, streaming, prepareStream, makeStreamCallbacks]
  );

  const abort = useCallback(async () => {
    if (chatId) {
      const bg = bgStreams.get(chatId);
      if (bg) {
        // First, call the server-side stop endpoint to immediately abort the agent loop
        try {
          await apiStopChat(chatId);
        } catch (err) {
          console.error(`[chat] stop endpoint failed:`, err);
        }
        
        // Then abort the client-side SSE connection
        bg.abortController?.abort();
        bg.streaming = false;
        bgStreams.delete(chatId);
      }
    }
    // Also abort the local controller as a fallback
    abortRef.current?.abort();
    setStreaming(false);
  }, [chatId]);

  // Process queued messages for the current chat
  const processQueue = useCallback(async () => {
    if (!chatId || streaming || queueProcessing) return;
    const targetChatId = chatId;

    const queued = await getQueuedMessagesForChat(targetChatId);
    if (queued.length === 0) return;

    setQueueProcessing(true);

    for (const item of queued) {
      if (!navigator.onLine) break;

      // Remove "queued" flag from the user message in UI
      setMessages((prev) =>
        prev.map((m) =>
          m.queued && m.content === item.message ? { ...m, queued: false } : m
        )
      );

      // Send and wait for completion
      const sent = await new Promise<boolean>((resolve) => {
        // Create bgStream entry
        const bg = createBgStream(activeChatRef.current);
        bgStreams.set(targetChatId, bg);

        prepareStream();

        // Add placeholder assistant message
        setMessages((prev) => {
          const next = [
            ...prev,
            { role: "assistant" as const, content: "", timestamp: Date.now() },
          ];
          bg.messages = next;
          return next;
        });

        const callbacks = makeStreamCallbacks(targetChatId, () => {
          resolve(true);
        });
        // Override onError to detect further offline
        const origOnError = callbacks.onError;
        callbacks.onError = (err) => {
          if (err.startsWith("__OFFLINE__:")) {
            resolve(false);
          } else {
            origOnError(err);
            resolve(true); // still dequeue on non-offline errors
          }
        };

        const controller = sendMessage(targetChatId, item.message, callbacks, item.images);
        bg.abortController = controller;
        abortRef.current = controller;
      });

      await dequeueMessage(item.id!);

      if (!sent) break; // network dropped mid-processing
    }

    setQueueProcessing(false);
  }, [chatId, streaming, queueProcessing, prepareStream, makeStreamCallbacks]);

  // Use live streaming usage (from iteration events) when available,
  // otherwise fall back to the last assistant message's usage.
  // This keeps the token indicator accurate during multi-iteration tool loops.
  // IMPORTANT: Skips compaction summaries since they don't have real usage data.
  const totalUsage: MessageUsage = useMemo(() => {
    if (streamingUsage) return streamingUsage;
    // Find the last REAL assistant message with usage (not compaction summaries)
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && !msg._isCompactionSummary && msg.usage) {
        return msg.usage;
      }
    }
    return { input: 0, output: 0, totalTokens: 0 };
  }, [messages, streamingUsage]);

  // Check if the chat has a compaction summary (for UI state)
  const hasCompactionSummary = useMemo(() => {
    return messages.some(m => m._isCompactionSummary);
  }, [messages]);

  return {
    messages,
    streaming,
    streamingThinking,
    activeTools,
    artifacts,
    generatedImages,
    waitingForInput,
    totalUsage,
    compacting,
    compaction,
    error,
    warning,
    streamingSegmentIndex,
    hasBackgroundActivity,
    send,
    editMessage,
    abort,
    loadMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
    titleUpdate,
    hasCompactionSummary,
  };
}
