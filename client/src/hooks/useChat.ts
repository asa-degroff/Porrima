import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendMessage, editMessage as apiEditMessage } from "../api/client";
import type { StreamCallbacks, ToolStatus, StreamWarning } from "../api/client";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment, MessageUsage } from "../types";
import {
  enqueueMessage,
  dequeueMessage,
  getQueuedMessagesForChat,
  setCachedChat,
} from "../lib/db";
import type { Chat } from "../types";

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
  const [queueProcessing, setQueueProcessing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);
  const streamingContentRef = useRef("");
  const rafRef = useRef<number | null>(null);
  const activeChatRef = useRef<Chat | null>(null);

  // Reset all ephemeral state when switching chats
  useEffect(() => {
    setStreaming(false);
    setStreamingThinking("");
    setActiveTools([]);
    setArtifacts([]);
    setGeneratedImages([]);
    setWaitingForInput(false);
    setError(null);
    setWarning(null);
  }, [chatId]);

  const loadMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
  }, []);

  // Store active chat reference for IDB caching
  const setActiveChatData = useCallback((chat: Chat | null) => {
    activeChatRef.current = chat;
  }, []);

  // Update IDB cache with current messages
  const updateChatCache = useCallback((msgs: ChatMessage[]) => {
    const chat = activeChatRef.current;
    if (chat) {
      setCachedChat({ ...chat, messages: msgs }).catch(() => {});
    }
  }, []);

  // Flush accumulated streaming content to React state (batched per frame)
  const flushStreamingContent = useCallback(() => {
    const content = streamingContentRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === "assistant" && last.content !== content) {
        const updated = prev.slice(0, -1);
        updated.push({ ...last, content });
        return updated;
      }
      return prev;
    });
    rafRef.current = null;
  }, []);

  // Shared SSE callbacks for both send and edit
  const makeStreamCallbacks = useCallback((onDoneExtra?: (msgs: ChatMessage[]) => void): StreamCallbacks => ({
    onDelta: (delta) => {
      streamingContentRef.current += delta;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushStreamingContent);
      }
    },
    onThinkingDelta: (delta) => {
      setStreamingThinking((prev) => prev + delta);
    },
    onGeneratedImage: (image) => {
      setGeneratedImages((prev) => [...prev, image]);
    },
    onDone: ({ thinking, usage, artifacts: doneArtifacts, generatedImages: doneImages, waitingForInput: wfi }) => {
      if (!doneCalledRef.current) {
        doneCalledRef.current = true;
        // Cancel any pending rAF and do a final flush with metadata
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const finalContent = streamingContentRef.current;
        setMessages((prev) => {
          const updated = prev.slice(0, -1);
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            updated.push({
              ...last,
              content: finalContent,
              thinking: thinking || undefined,
              usage: usage || undefined,
              artifacts: doneArtifacts || undefined,
              generatedImages: doneImages || undefined,
            });
          }
          const finalMsgs = updated;
          updateChatCache(finalMsgs);
          onDoneExtra?.(finalMsgs);
          return finalMsgs;
        });
        setStreamingThinking("");
        setStreaming(false);
        if (wfi) {
          setWaitingForInput(true);
        }
      }
    },
    onToolStatus: (status) => {
      setActiveTools((prev) => {
        // If this tool is done/error, update existing entry
        const existing = prev.findIndex(
          (t) => t.name === status.name && t.status === "running"
        );
        if (existing >= 0 && status.status !== "running") {
          const updated = [...prev];
          updated[existing] = status;
          return updated;
        }
        // Otherwise add new entry
        return [...prev, status];
      });
    },
    onAskUser: (_question) => {
      setWaitingForInput(true);
    },
    onArtifact: (artifact) => {
      setArtifacts((prev) => [...prev, artifact]);
    },
    onIteration: (info) => {
      console.log(`[chat] iteration ${info.iteration}: stopReason=${info.stopReason} tools=${info.toolCount}`);
    },
    onWarning: (w) => {
      console.warn(`[chat] warning: ${w.type} — ${w.message}`);
      setWarning(w);
    },
    onError: (err) => {
      // Detect offline sentinel from streamSSE
      if (err.startsWith("__OFFLINE__:")) {
        setError("Network unavailable — message queued");
        // Queue the last user message
        if (chatId) {
          setMessages((prev) => {
            // Find the last user message and mark it as queued
            const lastUserIdx = prev.map((m) => m.role).lastIndexOf("user");
            if (lastUserIdx >= 0) {
              const userMsg = prev[lastUserIdx];
              enqueueMessage(chatId, userMsg.content, userMsg.images).catch(() => {});
              // Remove the empty assistant placeholder, mark user msg queued
              const updated = prev.filter((_, i) => i !== prev.length - 1 || prev[prev.length - 1].role !== "assistant");
              return updated.map((m, i) =>
                i === lastUserIdx ? { ...m, queued: true } : m
              );
            }
            return prev;
          });
        }
      } else {
        setError(err);
      }
      setStreaming(false);
    },
  }), [chatId, flushStreamingContent, updateChatCache]);

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
        enqueueMessage(chatId, text, images).catch(() => {});
        return;
      }

      setMessages((prev) => [...prev, userMsg]);
      prepareStream();

      // Add a placeholder assistant message
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      abortRef.current = sendMessage(chatId, text, makeStreamCallbacks(), images);
    },
    [chatId, streaming, prepareStream, makeStreamCallbacks]
  );

  const editMessage = useCallback(
    (index: number, newText: string) => {
      if (!chatId || streaming || !navigator.onLine) return;

      // Truncate to edit point, add new user msg + placeholder assistant msg
      setMessages((prev) => {
        const truncated = prev.slice(0, index);
        return [
          ...truncated,
          { role: "user" as const, content: newText, timestamp: Date.now() },
          { role: "assistant" as const, content: "", timestamp: Date.now() },
        ];
      });

      prepareStream();

      abortRef.current = apiEditMessage(chatId, index, newText, makeStreamCallbacks());
    },
    [chatId, streaming, prepareStream, makeStreamCallbacks]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  // Process queued messages for the current chat
  const processQueue = useCallback(async () => {
    if (!chatId || streaming || queueProcessing) return;

    const queued = await getQueuedMessagesForChat(chatId);
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
        prepareStream();

        // Add placeholder assistant message
        setMessages((prev) => [
          ...prev,
          { role: "assistant" as const, content: "", timestamp: Date.now() },
        ]);

        const callbacks = makeStreamCallbacks(() => {
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

        abortRef.current = sendMessage(chatId, item.message, callbacks, item.images);
      });

      await dequeueMessage(item.id!);

      if (!sent) break; // network dropped mid-processing
    }

    setQueueProcessing(false);
  }, [chatId, streaming, queueProcessing, prepareStream, makeStreamCallbacks]);

  // Compute total usage across all messages
  const totalUsage: MessageUsage = useMemo(
    () =>
      messages.reduce(
        (acc, msg) => {
          if (msg.usage) {
            acc.input += msg.usage.input;
            acc.output += msg.usage.output;
            acc.totalTokens += msg.usage.totalTokens;
          }
          return acc;
        },
        { input: 0, output: 0, totalTokens: 0 }
      ),
    [messages]
  );

  return {
    messages,
    streaming,
    streamingThinking,
    activeTools,
    artifacts,
    generatedImages,
    waitingForInput,
    totalUsage,
    error,
    warning,
    send,
    editMessage,
    abort,
    loadMessages,
    setActiveChatData,
    processQueue,
    queueProcessing,
  };
}
