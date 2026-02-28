import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendMessage, editMessage as apiEditMessage } from "../api/client";
import type { StreamCallbacks, ToolStatus } from "../api/client";
import type { Artifact, ChatMessage, ImageAttachment, MessageUsage } from "../types";

export function useChat(chatId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingThinking, setStreamingThinking] = useState("");
  const [activeTools, setActiveTools] = useState<ToolStatus[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [waitingForInput, setWaitingForInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);
  const streamingContentRef = useRef("");
  const rafRef = useRef<number | null>(null);

  // Reset all ephemeral state when switching chats
  useEffect(() => {
    setStreaming(false);
    setStreamingThinking("");
    setActiveTools([]);
    setArtifacts([]);
    setWaitingForInput(false);
    setError(null);
  }, [chatId]);

  const loadMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
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
  const makeStreamCallbacks = useCallback((): StreamCallbacks => ({
    onDelta: (delta) => {
      streamingContentRef.current += delta;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushStreamingContent);
      }
    },
    onThinkingDelta: (delta) => {
      setStreamingThinking((prev) => prev + delta);
    },
    onDone: ({ thinking, usage, artifacts: doneArtifacts, waitingForInput: wfi }) => {
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
            });
          }
          return updated;
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
    onError: (err) => {
      setError(err);
      setStreaming(false);
    },
  }), [flushStreamingContent]);

  // Shared pre-stream state reset
  const prepareStream = useCallback(() => {
    setStreaming(true);
    setStreamingThinking("");
    setActiveTools([]);
    setArtifacts([]);
    setWaitingForInput(false);
    setError(null);
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
      if (!chatId || streaming) return;

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
    waitingForInput,
    totalUsage,
    error,
    send,
    editMessage,
    abort,
    loadMessages,
  };
}
