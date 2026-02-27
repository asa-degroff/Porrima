import { useState, useCallback, useRef } from "react";
import { sendMessage } from "../api/client";
import type { ChatMessage, MessageUsage } from "../types";

export function useChat(chatId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingThinking, setStreamingThinking] = useState("");
  const [lastToolResults, setLastToolResults] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const doneCalledRef = useRef(false);

  const loadMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
  }, []);

  const send = useCallback(
    (text: string) => {
      if (!chatId || streaming) return;

      const userMsg: ChatMessage = {
        role: "user",
        content: text,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);
      setStreamingThinking("");
      setLastToolResults([]);
      setError(null);
      doneCalledRef.current = false;

      // Add a placeholder assistant message
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      abortRef.current = sendMessage(chatId, text, {
        onDelta: (delta) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last.role === "assistant") {
              updated[updated.length - 1] = {
                ...last,
                content: last.content + delta,
              };
            }
            return updated;
          });
        },
        onThinkingDelta: (delta) => {
          setStreamingThinking((prev) => prev + delta);
        },
        onDone: ({ thinking, usage }) => {
          if (!doneCalledRef.current) {
            doneCalledRef.current = true;
            // Save thinking and usage into the last assistant message
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === "assistant") {
                updated[updated.length - 1] = {
                  ...last,
                  thinking: thinking || undefined,
                  usage: usage || undefined,
                };
              }
              return updated;
            });
            setStreamingThinking("");
            setStreaming(false);
          }
        },
        onToolResult: (result) => {
          const label = result.success
            ? `${result.name.replace("_", " ")}`
            : `${result.name} failed`;
          setLastToolResults((prev) => [...prev, label]);
        },
        onError: (err) => {
          setError(err);
          setStreaming(false);
        },
      });
    },
    [chatId, streaming]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  // Compute total usage across all messages
  const totalUsage: MessageUsage = messages.reduce(
    (acc, msg) => {
      if (msg.usage) {
        acc.input += msg.usage.input;
        acc.output += msg.usage.output;
        acc.totalTokens += msg.usage.totalTokens;
      }
      return acc;
    },
    { input: 0, output: 0, totalTokens: 0 }
  );

  return {
    messages,
    streaming,
    streamingThinking,
    lastToolResults,
    totalUsage,
    error,
    send,
    abort,
    loadMessages,
  };
}
