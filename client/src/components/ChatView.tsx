import { useEffect, useRef, useState } from "react";
import type { Artifact, ChatMessage, MessageUsage, OllamaModel } from "../types";
import type { ToolStatus } from "../api/client";
import { MessageBubble } from "./MessageBubble";
import { MessageInput } from "./MessageInput";
import { ModelSelector } from "./ModelSelector";
import { TokenIndicator } from "./TokenIndicator";
import { SystemPromptEditor } from "./SystemPromptEditor";

function formatCtxWindow(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "K";
  return n.toString();
}

interface Props {
  chatId: string | null;
  chatTitle: string;
  messages: ChatMessage[];
  streaming: boolean;
  streamingThinking: string;
  activeTools: ToolStatus[];
  artifacts: Artifact[];
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
  onContextWindowChange: (value: number | null) => void;
  modelContextWindow: number;
  hasContextWindowOverride: boolean;
  waitingForInput: boolean;
}

export function ChatView({
  chatId,
  chatTitle,
  messages,
  streaming,
  streamingThinking,
  activeTools,
  artifacts,
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
  onContextWindowChange,
  modelContextWindow,
  hasContextWindowOverride,
  waitingForInput,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingCtx, setEditingCtx] = useState(false);
  const [ctxInput, setCtxInput] = useState("");

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
          {/* Context window editor */}
          {editingCtx ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                const val = parseInt(ctxInput, 10);
                if (val && val > 0) onContextWindowChange(val);
                setEditingCtx(false);
              }}
            >
              <input
                type="number"
                className="w-20 px-1.5 py-0.5 text-xs bg-white/10 border border-white/20 rounded text-white/80 outline-none focus:border-white/40"
                value={ctxInput}
                onChange={(e) => setCtxInput(e.target.value)}
                autoFocus
                onBlur={() => setEditingCtx(false)}
                min={1}
              />
              {hasContextWindowOverride && (
                <button
                  type="button"
                  className="text-xs text-white/30 hover:text-white/60 px-1"
                  title="Reset to model default"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onContextWindowChange(null);
                    setEditingCtx(false);
                  }}
                >
                  &#x21ba;
                </button>
              )}
            </form>
          ) : (
            <button
              className={`text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors ${
                hasContextWindowOverride ? "text-blue-300/70" : "text-white/30"
              }`}
              title={hasContextWindowOverride
                ? `Custom context window (model default: ${formatCtxWindow(modelContextWindow)})`
                : "Click to set custom context window"
              }
              onClick={() => {
                setCtxInput(String(contextWindow));
                setEditingCtx(true);
              }}
            >
              {formatCtxWindow(contextWindow)}
            </button>
          )}
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
            activeTools={
              i === messages.length - 1 ? activeTools : undefined
            }
            artifacts={
              i === messages.length - 1 ? artifacts : undefined
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
        waitingForInput={waitingForInput}
      />
    </div>
  );
}
