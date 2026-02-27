import { useEffect, useRef } from "react";
import type { ChatMessage, MessageUsage, OllamaModel } from "../types";
import { MessageBubble } from "./MessageBubble";
import { MessageInput } from "./MessageInput";
import { ModelSelector } from "./ModelSelector";
import { TokenIndicator } from "./TokenIndicator";
import { SystemPromptEditor } from "./SystemPromptEditor";

interface Props {
  chatId: string | null;
  chatTitle: string;
  messages: ChatMessage[];
  streaming: boolean;
  streamingThinking: string;
  toolResults: string[];
  totalUsage: MessageUsage;
  contextWindow: number;
  error: string | null;
  models: OllamaModel[];
  selectedModelId: string;
  systemPrompt: string;
  onSend: (text: string) => void;
  onAbort: () => void;
  onModelChange: (modelId: string) => void;
  onSystemPromptChange: (value: string) => void;
}

export function ChatView({
  chatId,
  chatTitle,
  messages,
  streaming,
  streamingThinking,
  toolResults,
  totalUsage,
  contextWindow,
  error,
  models,
  selectedModelId,
  systemPrompt,
  onSend,
  onAbort,
  onModelChange,
  onSystemPromptChange,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingThinking]);

  if (!chatId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4 opacity-20">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mx-auto text-white/20"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <p className="text-white/30 text-lg">
            Select a chat or start a new one
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Chat Header */}
      <div className="px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3 backdrop-blur-sm bg-white/[0.03]">
        <h2 className="text-sm font-medium text-white/80 truncate">
          {chatTitle}
        </h2>
        <div className="flex items-center gap-3 shrink-0">
          <TokenIndicator usage={totalUsage} contextWindow={contextWindow} />
          <ModelSelector
            models={models}
            selectedId={selectedModelId}
            onChange={onModelChange}
            disabled={streaming}
          />
        </div>
      </div>

      {/* System Prompt */}
      <SystemPromptEditor
        value={systemPrompt}
        onChange={onSystemPromptChange}
        disabled={streaming}
      />

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-white/25 text-sm">
              Send a message to start the conversation
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={`${msg.timestamp}-${i}`}
            message={msg}
            isStreaming={streaming}
            isLast={i === messages.length - 1}
            streamingThinking={
              i === messages.length - 1 ? streamingThinking : undefined
            }
            toolResults={
              i === messages.length - 1 ? toolResults : undefined
            }
          />
        ))}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-400/20 text-red-300 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <MessageInput
        onSend={onSend}
        disabled={!chatId || streaming}
        onAbort={onAbort}
        streaming={streaming}
      />
    </div>
  );
}
