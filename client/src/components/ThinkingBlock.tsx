import { useState, useEffect, useRef } from "react";

interface Props {
  thinking: string;
  isStreaming: boolean;
}

export function ThinkingBlock({ thinking, isStreaming }: Props) {
  const [userToggled, setUserToggled] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const prevStreamingRef = useRef(isStreaming);

  // Reset user override when streaming state transitions
  if (prevStreamingRef.current !== isStreaming) {
    prevStreamingRef.current = isStreaming;
    setUserToggled(false);
  }

  const expanded = userToggled ? userExpanded : isStreaming;

  const handleToggle = () => {
    setUserToggled(true);
    setUserExpanded(!expanded);
  };

  // Auto-scroll thinking content during streaming
  useEffect(() => {
    if (isStreaming && expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [thinking, isStreaming, expanded]);

  if (!thinking) return null;

  return (
    <div className="mb-2 rounded-xl bg-purple-500/10 border border-purple-400/15 overflow-hidden">
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-purple-300/80 hover:text-purple-200 transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        {isStreaming ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            Thinking...
          </span>
        ) : (
          <span>Thought for a moment</span>
        )}
      </button>
      {expanded && (
        <div
          ref={contentRef}
          className="px-3 pb-3 max-h-64 overflow-y-auto"
        >
          <pre className="text-xs text-white/50 whitespace-pre-wrap font-[inherit] leading-relaxed">
            {thinking}
          </pre>
        </div>
      )}
    </div>
  );
}
