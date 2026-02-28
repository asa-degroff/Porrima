import { useEffect, useRef, useState, useCallback } from "react";
import type { Artifact, ChatMessage, MessageUsage, OllamaModel } from "../types";
import type { ToolStatus } from "../api/client";
import { fetchRenderedPrompt } from "../api/client";
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
  onSend: (text: string, images?: import("../types").ImageAttachment[]) => void;
  onEditMessage: (index: number, newText: string) => void;
  onAbort: () => void;
  onModelChange: (modelId: string) => void;
  onSystemPromptChange: (value: string) => void;
  onContextWindowChange: (value: number | null) => void;
  modelContextWindow: number;
  hasContextWindowOverride: boolean;
  waitingForInput: boolean;
  onOpenSidebar: () => void;
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
  onEditMessage,
  onAbort,
  onModelChange,
  onSystemPromptChange,
  onContextWindowChange,
  modelContextWindow,
  hasContextWindowOverride,
  waitingForInput,
  onOpenSidebar,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editingCtx, setEditingCtx] = useState(false);
  const [ctxInput, setCtxInput] = useState("");
  const [promptModal, setPromptModal] = useState<{ systemPrompt: string; tools: { name: string; description: string }[] } | null>(null);

  const openPromptViewer = useCallback(async () => {
    if (!chatId) return;
    try {
      const data = await fetchRenderedPrompt(chatId);
      setPromptModal(data);
    } catch {
      setPromptModal({ systemPrompt: "(Failed to load)", tools: [] });
    }
  }, [chatId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingThinking]);

  if (!chatId) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="px-3 py-3 md:hidden">
          <button
            onClick={onOpenSidebar}
            className="text-white/50 hover:text-white/80 transition-colors p-1.5 rounded-lg hover:bg-white/5"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        </div>
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
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Chat Header */}
      <div className="px-3 md:px-6 py-3 border-b border-white/10 flex items-center justify-between gap-3 backdrop-blur-sm bg-white/[0.03]">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onOpenSidebar}
            className="md:hidden text-white/50 hover:text-white/80 transition-colors p-1 rounded-lg hover:bg-white/5 shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <h2 className="text-sm font-medium text-white/80 truncate">
            {chatTitle}
          </h2>
        </div>
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
          <button
            className="hidden md:inline-block text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors text-white/30 hover:text-white/50"
            title="View rendered system prompt and tools"
            onClick={openPromptViewer}
          >
            Prompt
          </button>
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 md:px-6 py-3 md:py-4">
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
              i === messages.length - 1 && streaming ? artifacts : undefined
            }
            editable={msg.role === "user" && !streaming}
            onEdit={msg.role === "user" ? (newText) => onEditMessage(i, newText) : undefined}
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

      {/* Rendered Prompt Viewer Modal */}
      {promptModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setPromptModal(null)}
        >
          <div
            className="bg-[#1a1a2e] border border-white/10 rounded-2xl w-full max-w-[640px] mx-4 max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
              <h3 className="text-sm font-medium text-white/80">Rendered Agent Context</h3>
              <button
                className="text-white/30 hover:text-white/60 text-lg leading-none"
                onClick={() => setPromptModal(null)}
              >
                &times;
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div>
                <h4 className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">System Prompt</h4>
                <pre className="text-xs text-white/70 font-mono whitespace-pre-wrap bg-white/5 rounded-lg p-3 border border-white/5 max-h-[40vh] overflow-y-auto">
                  {promptModal.systemPrompt}
                </pre>
              </div>
              {promptModal.tools.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-white/50 uppercase tracking-wider mb-2">
                    Tools ({promptModal.tools.length})
                  </h4>
                  <div className="space-y-1.5">
                    {promptModal.tools.map((t) => (
                      <div key={t.name} className="text-xs bg-white/5 rounded-lg px-3 py-2 border border-white/5">
                        <span className="text-blue-300/70 font-mono">{t.name}</span>
                        <span className="text-white/40 ml-2">{t.description}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
