import { useState, useEffect, useRef, useCallback } from "react";

interface Props {
  thinking: string;
  isStreaming: boolean;
  thinkingDurationMs?: number;
  thinkingActive?: boolean;
  thinkingAccumulatedMs?: number;
  thinkingLastStartRef?: React.RefObject<number>;
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 0.1) return "0.1 seconds";
  if (seconds < 10) return `${seconds.toFixed(1)} seconds`;
  return `${Math.round(seconds)} seconds`;
}

export function ThinkingBlock({
  thinking,
  isStreaming,
  thinkingDurationMs,
  thinkingActive,
  thinkingAccumulatedMs = 0,
  thinkingLastStartRef,
}: Props) {
  const [userToggled, setUserToggled] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const manualScrollOverrideRef = useRef(false);
  const prevStreamingRef = useRef(isStreaming);
  const [, setTick] = useState(0);
  const [scrollPaused, setScrollPaused] = useState(false);

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

  // Tick the timer every 100ms while thinking is active during streaming
  useEffect(() => {
    if (!isStreaming || !thinkingActive) return;
    const interval = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(interval);
  }, [isStreaming, thinkingActive]);

  // Reset scroll pause when streaming stops
  useEffect(() => {
    if (!isStreaming && scrollPaused) {
      setScrollPaused(false);
      manualScrollOverrideRef.current = false;
    }
  }, [isStreaming, scrollPaused]);

  // Track whether user is scrolled near the bottom of the thinking block
  const handleScroll = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const threshold = 40;
    const wasNearBottom = isNearBottomRef.current;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

    // If streaming and user scrolls away from bottom, enable manual override
    if (isStreaming && wasNearBottom && !isNearBottomRef.current) {
      manualScrollOverrideRef.current = true;
      setScrollPaused(true);
    }

    // If user scrolls back to bottom, disable override
    if (isNearBottomRef.current && manualScrollOverrideRef.current) {
      manualScrollOverrideRef.current = false;
      setScrollPaused(false);
    }
  }, [isStreaming]);

  // Scroll to bottom handler
  const scrollToBottom = useCallback(() => {
    const el = contentRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      manualScrollOverrideRef.current = false;
      isNearBottomRef.current = true;
      setScrollPaused(false);
    }
  }, []);

  // Auto-scroll thinking content during streaming
  useEffect(() => {
    if (isStreaming && expanded && contentRef.current && !manualScrollOverrideRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [thinking, isStreaming, expanded]);

  // Show header during streaming even if thinking content is empty
  if (!thinking && !isStreaming) return null;

  // Compute current elapsed thinking time
  let displayMs = 0;
  if (isStreaming) {
    displayMs = thinkingAccumulatedMs;
    if (thinkingActive && thinkingLastStartRef?.current) {
      displayMs += Date.now() - thinkingLastStartRef.current;
    }
  } else {
    displayMs = thinkingDurationMs ?? 0;
  }

  return (
    <div className="mb-2 rounded-xl border overflow-hidden"
      style={{
        backgroundColor: `rgba(var(--theme-primary), 0.1)`,
        borderColor: `rgba(var(--theme-primary-border))`,
      }}>
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors"
        style={{
          color: `rgba(var(--theme-primary-text), 0.8)`,
        }}
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
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
              style={{
                backgroundColor: `rgba(var(--theme-primary-text))`,
              }} />
            {displayMs > 0 ? `Thinking... ${formatDuration(displayMs)}` : "Thinking..."}
          </span>
        ) : (
          <span>{displayMs > 0 ? `Thought for ${formatDuration(displayMs)}` : "Thought for a moment"}</span>
        )}
      </button>
      {expanded && (
        <div className="relative">
          <div
            ref={contentRef}
            onScroll={handleScroll}
            className="px-3 pb-3 max-h-64 overflow-y-auto"
          >
            <pre className="text-xs text-white/50 whitespace-pre-wrap font-[inherit] leading-relaxed">
              {thinking}
            </pre>
          </div>
          {/* Scroll to bottom button - appears when user scrolls away during streaming */}
          {scrollPaused && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-full bg-black/40 border border-white/15 text-white/60 hover:text-white hover:bg-black/60 hover:border-white/25 transition-all shadow-lg backdrop-blur-sm text-[10px]"
              title="Scroll to bottom"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="m19 12-7 7-7-7" />
              </svg>
              <span className="font-medium">Bottom</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
