import { useState, useCallback, useRef } from "react";
import { sendMessage } from "../api/client";
import type { ChatMessage } from "../types";

export function useChat(chatId: string | null) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
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
      setError(null);
      doneCalledRef.current = false;

      // Add a placeholder assistant message
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);

      abortRef.current = sendMessage(
        chatId,
        text,
        // onDelta
        (delta) => {
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
        // onDone
        () => {
          if (!doneCalledRef.current) {
            doneCalledRef.current = true;
            setStreaming(false);
          }
        },
        // onError
        (err) => {
          setError(err);
          setStreaming(false);
        }
      );
    },
    [chatId, streaming]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  return { messages, streaming, error, send, abort, loadMessages };
}
