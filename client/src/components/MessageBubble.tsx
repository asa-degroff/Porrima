import type { ChatMessage } from "../types";
import { StreamingText } from "./StreamingText";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { ThinkingBlock } from "./ThinkingBlock";

interface Props {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  streamingThinking?: string;
  toolResults?: string[];
}

export function MessageBubble({
  message,
  isStreaming,
  isLast,
  streamingThinking,
  toolResults,
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
        {/* Tool result pills */}
        {!isUser && toolResults && toolResults.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {toolResults.map((label, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-500/15 border border-purple-400/20 text-purple-300"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {label}
              </span>
            ))}
          </div>
        )}
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
