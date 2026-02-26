import type { ChatMessage } from "../types";
import { StreamingText } from "./StreamingText";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThinkingBlock } from "./ThinkingBlock";

interface Props {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  streamingThinking?: string;
}

export function MessageBubble({
  message,
  isStreaming,
  isLast,
  streamingThinking,
}: Props) {
  const isUser = message.role === "user";
  const showStreaming = isStreaming && isLast && !isUser;

  // During streaming, use live thinking; after done, use saved thinking
  const thinkingText = showStreaming ? streamingThinking : message.thinking;
  const isThinkingStreaming = showStreaming && !message.content;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
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
            {showStreaming ? (
              <div className="text-sm leading-relaxed">
                <StreamingText
                  content={message.content}
                  isStreaming={!isThinkingStreaming}
                />
              </div>
            ) : (
              <div className="text-sm leading-relaxed">
                <MarkdownRenderer content={message.content} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
