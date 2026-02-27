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
}

export function MessageBubble({
  message,
  isStreaming,
  isLast,
  streamingThinking,
  activeTools,
  artifacts,
}: Props) {
  const isUser = message.role === "user";
  const showStreaming = isStreaming && isLast && !isUser;

  // During streaming, use live thinking; after done, use saved thinking
  const thinkingText = showStreaming ? streamingThinking : message.thinking;
  const isThinkingStreaming = showStreaming && !message.content;

  // Build tool call displays
  const hasToolCalls = !isUser && (
    (showStreaming && activeTools && activeTools.length > 0) ||
    (message.toolCalls && message.toolCalls.length > 0)
  );

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[92%] md:max-w-[80%] rounded-2xl px-3 md:px-4 py-3 ${
          isUser
            ? "bg-blue-500/20 border border-blue-400/20 text-white/95"
            : "bg-white/5 border border-white/10 text-white/90"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </p>
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
