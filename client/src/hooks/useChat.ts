import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendMessage, editMessage as apiEditMessage } from "../api/client";
import type { StreamCallbacks, ToolStatus, StreamWarning } from "../api/client";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment, MessageSegment, MessageUsage } from "../types";
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
  generatedImages: GeneratedImage[];
  messages: ChatMessage[];
  streaming: boolean;
  waitingForInput: boolean;
  error: string | null;
  warning: StreamWarning | null;
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

/** Check if a chat has an active or completed background stream */
export function hasBackgroundStream(chatId: string): boolean {
  return bgStreams.has(chatId);
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
    generatedImages: [],
    messages: [],
    streaming: true,
    waitingForInput: false,
    error: null,
    warning: null,
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
  const [compaction, setCompaction] = useState<{ removedCount: number; remainingCount: number } | null>(null);
  const [queueProcessing, setQueueProcessing] = useState(false);
  const [titleUpdate, setTitleUpdate] = useState<{ chatId: string; title: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);
  const streamingContentRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const activeChatRef = useRef<Chat | null>(null);

  /** Always reflects the currently displayed chatId */
  const activeChatIdRef = useRef<string | null>(chatId);
  activeChatIdRef.current = chatId;

  // Restore or reset streaming state when switching chats
  useEffect(() => {
    // Cancel any pending rAF flush from previous chat's stream
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const bg = chatId ? bgStreams.get(chatId) : undefined;
    if (bg) {
      // Restore streaming state from background
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
      setCompaction(bg.compaction);
      doneCalledRef.current = bg.doneCalled;
      abortRef.current = bg.abortController;

      if (!bg.streaming) {
        // Stream finished while in background — clean up entry
        bgStreams.delete(chatId!);
      }
    } else {
      // No background stream — fresh reset
      setStreaming(false);
      setStreamingThinking("");
      setActiveTools([]);
      setArtifacts([]);
      setGeneratedImages([]);
      setWaitingForInput(false);
      setError(null);
      setWarning(null);
      setCompaction(null);
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
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onDone: ({ thinking, usage, artifacts: doneArtifacts, generatedImages: doneImages, toolCalls, toolResults, segments, waitingForInput: wfi }) => {
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
        const existing = bg.tools.findIndex(
          (t) => t.name === status.name && t.status === "running"
        );
        if (existing >= 0 && status.status !== "running") {
          bg.tools[existing] = status;
        } else {
          bg.tools.push(status);
        }

        // Build streaming segments for tools
        if (status.status === "running") {
          bg.segments.push({ seq: bg.seqCounter++, type: "tool_call", liveStatus: { ...status } });
        } else {
          // Update the matching running tool segment
          for (let j = bg.segments.length - 1; j >= 0; j--) {
            const s = bg.segments[j];
            if (s.type === "tool_call" && s.liveStatus?.name === status.name && s.liveStatus?.status === "running") {
              s.liveStatus = { ...status };
              break;
            }
          }
        }

        if (activeChatIdRef.current === streamChatId) {
          setActiveTools([...bg.tools]);
          // Schedule segment flush
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
          // Schedule segment flush
          if (rafRef.current === null) {
            streamingContentRef.current = bg.content;
            rafRef.current = requestAnimationFrame(flushStreamingContent);
          }
        }
      },
      onIteration: (info) => {
        console.log(`[chat] iteration ${info.iteration}: stopReason=${info.stopReason} tools=${info.toolCount}`);
      },
      onWarning: (w) => {
        console.warn(`[chat] warning: ${w.type} — ${w.message}`);
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.warning = w;

        if (activeChatIdRef.current === streamChatId) {
          setWarning(w);
        }
      },
      onCompaction: (info) => {
        console.log(`[chat] compaction: removed ${info.removedCount} messages, ${info.remainingCount} remaining`);
        const bg = bgStreams.get(streamChatId);
        if (bg) bg.compaction = info;

        if (activeChatIdRef.current === streamChatId) {
          setCompaction(info);
        }
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
      if (!chatId || streaming) return;
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

  const abort = useCallback(() => {
    if (chatId) {
      const bg = bgStreams.get(chatId);
      if (bg) {
        bg.abortController?.abort();
        bg.streaming = false;
        bgStreams.delete(chatId);
      }
    }
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

  // Use the last assistant message's usage as the actual context fill
  const totalUsage: MessageUsage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].usage) return messages[i].usage!;
    }
    return { input: 0, output: 0, totalTokens: 0 };
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
    compaction,
    error,
    warning,
    send,
    editMessage,
    abort,
    loadMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
    titleUpdate,
  };
}
