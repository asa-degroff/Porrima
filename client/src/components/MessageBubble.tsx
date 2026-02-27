import { useState, useRef, useEffect } from "react";
import type { Artifact, ChatMessage } from "../types";
import type { ToolStatus } from "../api/client";
import { StreamingText } from "./StreamingText";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThinkingBlock } from "./ThinkingBlock";
import { ArtifactPanel } from "./ArtifactPanel";
import { ToolCallDisplay } from "./ToolCallDisplay";

interface Props {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  streamingThinking?: string;
  activeTools?: ToolStatus[];
  artifacts?: Artifact[];
  onEdit?: (newText: string) => void;
  editable?: boolean;
}

export function MessageBubble({
  message,
  isStreaming,
  isLast,
  streamingThinking,
  activeTools,
  artifacts,
  onEdit,
  editable,
}: Props) {
  const isUser = message.role === "user";
  const showStreaming = isStreaming && isLast && !isUser;

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    }
  }, [editing]);

  const handleStartEdit = () => {
    setEditText(message.content);
    setEditing(true);
  };

  const handleSave = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== message.content) {
      onEdit?.(trimmed);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  // During streaming, use live thinking; after done, use saved thinking
  const thinkingText = showStreaming ? streamingThinking : message.thinking;
  const isThinkingStreaming = showStreaming && !message.content;

  // Build tool call displays
  const hasToolCalls = !isUser && (
    (showStreaming && activeTools && activeTools.length > 0) ||
    (message.toolCalls && message.toolCalls.length > 0)
  );

  return (
    <div className={`group flex items-start ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      {isUser && editable && !editing && (
        <button
          onClick={handleStartEdit}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-white/10 mt-2.5 mr-1.5 shrink-0"
          title="Edit message"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 hover:text-white/70">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
      )}
      <div
        className={`max-w-[92%] md:max-w-[80%] rounded-2xl px-3 md:px-4 py-3 ${
          isUser
            ? "bg-blue-500/20 border border-blue-400/20 text-white/95"
            : "bg-white/5 border border-white/10 text-white/90"
        }`}
      >
        {isUser ? (
          editing ? (
            <div className="space-y-2">
              <textarea
                ref={textareaRef}
                className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-sm text-white/95 outline-none focus:border-blue-400/40 resize-none leading-relaxed"
                value={editText}
                onChange={(e) => {
                  setEditText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                onKeyDown={handleKeyDown}
                rows={1}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleCancel}
                  className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  className="px-3 py-1 text-xs rounded-lg bg-blue-500/20 border border-blue-400/20 text-blue-300 hover:bg-blue-500/30 transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {message.content}
            </p>
          )
        ) : (
          <>
            {thinkingText && (
              <ThinkingBlock
                thinking={thinkingText}
                isStreaming={showStreaming}
              />
            )}

            {/* Tool calls - streaming (live status) */}
            {showStreaming && activeTools && activeTools.map((tool, i) => (
              <ToolCallDisplay
                key={`live-${i}`}
                liveStatus={tool}
              />
            ))}

            {/* Tool calls - persisted (from chat history) */}
            {!showStreaming && message.toolCalls && message.toolCalls.map((tc, i) => {
              const tr = message.toolResults?.find((r) => r.toolCallId === tc.id);
              return (
                <ToolCallDisplay
                  key={tc.id}
                  toolCall={tc}
                  toolResult={tr}
                />
              );
            })}

            {showStreaming ? (
              <div className="text-sm leading-relaxed">
                <StreamingText
                  content={message.content}
                  isStreaming={!isThinkingStreaming}
                />
              </div>
            ) : (
              message.content && (
                <div className="text-sm leading-relaxed">
                  <MarkdownRenderer content={message.content} />
                </div>
              )
            )}

            {/* Inline artifacts - streaming (live) or persisted (from message) */}
            {(artifacts || message.artifacts)?.map((artifact) => (
              <ArtifactPanel key={artifact.id} artifact={artifact} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
