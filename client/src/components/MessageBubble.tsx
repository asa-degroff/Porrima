import { useState, useRef, useEffect, useLayoutEffect, useCallback, lazy, Suspense, memo } from "react";
import { createPortal } from "react-dom";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment, InferenceActivityPhase } from "../types";
import type { ArtifactRuntimeErrorReport, ToolStatus } from "../api/client";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ArtifactPanel } from "./ArtifactPanel";
import { InlineVisual } from "./InlineVisual";
import { GeneratedImagePanel } from "./GeneratedImagePanel";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { UserImage } from "./UserImage";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ui/ContextMenu";
import { CompactionIndicator } from "./CompactionIndicator";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape } from "../hooks/useActivityStyle";
import { usePinnedItem } from "../contexts/PinnedItemContext";
import { useIsDesktop } from "../hooks/useIsDesktop";

const MarkdownRenderer = lazy(() =>
  import("./ui/MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);

// Hoisted static chip styles - avoids new objects on every render
const skillChipStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  margin: '0 4px',
  background: 'rgba(var(--theme-accent-muted))',
  border: '1px solid rgba(var(--theme-accent-border))',
  borderRadius: '12px',
  fontSize: '12px',
  color: 'rgba(var(--theme-accent-text))',
  fontWeight: 500,
  verticalAlign: 'middle',
};

const compactChipStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  margin: '0 4px',
  background: 'rgba(168, 85, 247, 0.12)',
  border: '1px solid rgba(168, 85, 247, 0.25)',
  borderRadius: '12px',
  fontSize: '12px',
  color: 'rgba(216, 180, 254, 0.9)',
  fontWeight: 500,
  verticalAlign: 'middle',
};

// Stable empty array for availableSkills default prop
const emptySkillsList: string[] = [];
const ACTION_BUTTON_SIZE = 28;
const ACTION_BUTTON_GAP = 4;
const ACTION_RAIL_GAP_TO_BUBBLE = 6;
const SHORT_USER_BUBBLE_MAX_HEIGHT = 78;

function ReadAloudButton({
  text,
  onReadAloud,
  isPlaying,
}: {
  text: string;
  onReadAloud?: (text: string) => void;
  isPlaying?: boolean;
}) {
  if (!text || !onReadAloud) return null;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onReadAloud(text);
      }}
      disabled={isPlaying}
      className={`flex h-7 w-7 items-center justify-center rounded-md opacity-0 transition-all duration-150 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 ${
        isPlaying
          ? "cursor-not-allowed bg-white/[0.04] text-white/35"
          : "text-white/35 hover:bg-white/10 hover:text-white/75"
      }`}
      title={isPlaying ? "Audio is playing" : "Read aloud"}
      aria-label={isPlaying ? "Audio is playing" : "Read aloud"}
    >
      {isPlaying ? (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="animate-pulse">
          <rect x="6" y="4" width="3" height="16" />
          <rect x="12" y="4" width="3" height="16" />
          <rect x="18" y="4" width="3" height="16" />
        </svg>
      ) : (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
    </button>
  );
}

function isPlaceholderEllipsis(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s/g, "").replace(/…/g, "...");
  return normalized.length > 0 && /^(\.{3})+$/.test(normalized);
}

/** Format a Unix-ms timestamp into a compact human-readable string */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}

interface Props {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  streamingThinking?: string;
  streamingThinkingActive?: boolean;
  streamingThinkingAccumulatedMs?: number;
  streamingThinkingLastStartRef?: React.RefObject<number>;
  activeTools?: ToolStatus[];
  artifacts?: Artifact[];
  generatedImages?: GeneratedImage[];
  onEditMessage?: (index: number, newText: string, images?: ImageAttachment[]) => void;
  onRetryMessage?: (index: number) => void;
  messageIndex?: number;
  editable?: boolean;
  onReadAloud?: (text: string) => void;
  isPlayingTts?: boolean;
  availableSkills?: string[];
  streamingSegmentIndex?: number | null;
  showStreamingIndicator?: boolean;
  inferenceActivityPhase?: InferenceActivityPhase | null;
  chatId?: string;
  onArtifactRuntimeError?: (report: ArtifactRuntimeErrorReport) => void;
}

/**
 * Render skill chips and command chips (/compact) in message content.
 * Only applies to user messages (assistant messages have skills stripped server-side).
 * Only formats recognized skill names from the availableSkills list.
 * /compact always gets styled as a command chip regardless of availableSkills.
 */
function renderSkillChips(text: string, availableSkills?: string[]): React.ReactNode {
  const skillPattern = /\/([a-zA-Z0-9\-_]+)/g;
  const parts = text.split(skillPattern);
  
  // parts array alternates: [text, skillName, text, skillName, ...]
  const result: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Text segment
      if (parts[i]) result.push(parts[i]);
    } else {
      // Skill/command name (odd indices)
      const name = parts[i];
      if (!name) continue;
      
      if (name === 'compact') {
        // /compact command chip - always styled
        result.push(
          <span
            key={`compact-${i}`}
            className="compact-chip"
            style={compactChipStyle}
          >
            /compact
          </span>
        );
      } else if (availableSkills?.includes(name)) {
        // Recognized skill chip
        result.push(
          <span
            key={`skill-${name}-${i}`}
            className="skill-chip"
            style={skillChipStyle}
          >
            /{name}
          </span>
        );
      } else {
        // Not a recognized skill or command - render as plain text
        result.push(`/${name}`);
      }
    }
  }
  
  return result.length > 0 ? result : text;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming,
  isLast,
  streamingThinking,
  streamingThinkingActive,
  streamingThinkingAccumulatedMs,
  streamingThinkingLastStartRef,
  activeTools,
  artifacts,
  generatedImages,
  onEditMessage,
  onRetryMessage,
  messageIndex,
  editable,
  onReadAloud,
  isPlayingTts,
  availableSkills = emptySkillsList,
  streamingSegmentIndex,
  showStreamingIndicator,
  inferenceActivityPhase,
  chatId,
  onArtifactRuntimeError,
}: Props) {
  const activityShape = useActivityShape();
  const isUser = message.role === "user";
  const showStreaming = isStreaming && isLast && !isUser;

  // Render compaction indicator for summary messages
  if (message._isCompactionSummary && message._compactedMessageCount) {
    return (
      <CompactionIndicator
        compaction={{
          removedCount: message._compactedMessageCount,
          summary: message.content,
          messageIndex: messageIndex ?? 0,
          timestamp: message.timestamp,
        }}
      />
    );
  }

  const { isPinned: isItemPinned, unpin: unpinItem } = usePinnedItem();
  const isDesktopView = useIsDesktop();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editImages, setEditImages] = useState<ImageAttachment[]>([]);
  const [editMinWidth, setEditMinWidth] = useState<number | undefined>(undefined);
  const [lightboxImage, setLightboxImage] = useState<ImageAttachment | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [useHorizontalUserActions, setUseHorizontalUserActions] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

  const canReadAloud = Boolean(message.content && onReadAloud && !editing);
  const canEditMessage = Boolean(isUser && editable && !editing);
  const canRetryMessage = Boolean(isUser && onRetryMessage && messageIndex != null && !editing);
  const canOpenContextMenu = canReadAloud || canEditMessage || canRetryMessage;

  const openContextMenu = useCallback((pos: { x: number; y: number }) => {
    if (canOpenContextMenu) setContextMenu(pos);
  }, [canOpenContextMenu]);
  const longPressProps = useLongPress(openContextMenu);

  const handleRetry = () => {
    if (messageIndex != null) {
      onRetryMessage?.(messageIndex);
    }
    setContextMenu(null);
  };

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
    if (bubbleRef.current) {
      setEditMinWidth(bubbleRef.current.offsetWidth);
    }
    setEditText(message.content);
    setEditImages(message.images || []);
    setEditing(true);
  };

  const handleSave = () => {
    const trimmed = editText.trim();
    if (messageIndex == null) return;
    
    const textChanged = trimmed !== message.content.trim();
    const imagesChanged = editImages.length !== (message.images?.length || 0);
    
    if (textChanged || imagesChanged) {
      onEditMessage?.(messageIndex, trimmed, editImages);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const removeEditImage = (index: number) => {
    setEditImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleReadAloud = useCallback(() => {
    if (!message.content || !onReadAloud || isPlayingTts) return;
    onReadAloud(message.content);
    setContextMenu(null);
  }, [isPlayingTts, message.content, onReadAloud]);

  const handleCopyTimestamp = useCallback(() => {
    const timestamp = formatTimestamp(message.timestamp);
    void navigator.clipboard?.writeText(timestamp).catch(() => {});
    setContextMenu(null);
  }, [message.timestamp]);

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
  const visibleThinkingText = isPlaceholderEllipsis(thinkingText) ? undefined : thinkingText;
  const isThinkingStreaming = showStreaming && !message.content;

  // Build output segments - use ordered segments if available, otherwise separate arrays
  const renderSegments = !isUser && message.segments && message.segments.length > 0;
  const showReadAloudButton = canReadAloud;
  const userActionCount =
    (canEditMessage ? 2 : 0) +
    (isUser && showReadAloudButton ? 1 : 0);
  const hasUserActions = isUser && userActionCount > 0;

  useLayoutEffect(() => {
    if (!hasUserActions) {
      setUseHorizontalUserActions(false);
      return;
    }

    const row = rowRef.current;
    const bubble = bubbleRef.current;
    if (!row || !bubble) return;

    let frame = 0;
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bubbleRect = bubble.getBoundingClientRect();
        const parentWidth = row.parentElement?.getBoundingClientRect().width || window.innerWidth;
        const rowMaxWidth = parentWidth * (window.matchMedia("(min-width: 768px)").matches ? 0.8 : 0.95);
        const actionWidth =
          userActionCount * ACTION_BUTTON_SIZE +
          Math.max(0, userActionCount - 1) * ACTION_BUTTON_GAP;
        const horizontalFits = bubbleRect.width + actionWidth + ACTION_RAIL_GAP_TO_BUBBLE <= rowMaxWidth;
        const shortBubble = !message.images?.length && bubbleRect.height <= SHORT_USER_BUBBLE_MAX_HEIGHT;

        setUseHorizontalUserActions(shortBubble && horizontalFits);
      });
    };

    scheduleMeasure();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(scheduleMeasure);
      resizeObserver.observe(bubble);
      if (row.parentElement) resizeObserver.observe(row.parentElement);
    }

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
    };
  }, [hasUserActions, message.content, message.images?.length, userActionCount]);

  return (
    <div className={`group ${isUser ? "flex justify-end" : "flex justify-start"} mb-4`}>
      <div ref={rowRef} className={`flex flex-row items-start max-w-[97%] md:max-w-[86%] min-w-0`}>
        {hasUserActions && (
          <div className={`mt-2.5 mr-1.5 flex shrink-0 gap-1 ${useHorizontalUserActions ? "flex-row items-center" : "flex-col"}`}>
            {canEditMessage && (
              <>
                <button
                  type="button"
                  onClick={handleStartEdit}
                  className="flex h-7 w-7 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-white/10 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                  title="Edit message"
                  aria-label="Edit message"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 hover:text-white/70">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                    <path d="m15 5 4 4" />
                  </svg>
                </button>
                <div className="relative opacity-0 transition-opacity group-hover:opacity-100 group/info">
                  <button
                    type="button"
                    className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30"
                    title={formatTimestamp(message.timestamp)}
                    aria-label="Message timestamp"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white/40 hover:text-white/70">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                  </button>
                  <div className="invisible group-hover/info:visible absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded-md text-[11px] whitespace-nowrap pointer-events-none z-50"
                    style={{
                      backgroundColor: 'rgba(30, 30, 40, 0.95)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      color: 'rgba(255, 255, 255, 0.8)',
                      backdropFilter: 'blur(8px)',
                    }}
                  >
                    {formatTimestamp(message.timestamp)}
                  </div>
                </div>
              </>
            )}
            {showReadAloudButton && (
              <ReadAloudButton
                text={message.content}
                onReadAloud={onReadAloud}
                isPlaying={isPlayingTts}
              />
            )}
          </div>
        )}
        <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} min-w-0 max-w-full`}>
          <div className="flex flex-row items-end max-w-full min-w-0">
          <div
            ref={bubbleRef}
            onContextMenu={canOpenContextMenu ? (e: React.MouseEvent) => {
              e.preventDefault();
              setContextMenu({ x: e.clientX, y: e.clientY });
            } : undefined}
            {...(canOpenContextMenu ? longPressProps : {})}
            className={`rounded-2xl px-3 md:px-4 py-3 max-w-full min-w-0 overflow-x-hidden ${
              isUser
                ? "text-white/95"
                : "text-white/90"
            } ${message.queued ? "opacity-60" : ""}`}
            style={{
              ...(isUser ? {
                backgroundColor: `rgba(var(--theme-secondary), 0.1)`,
                border: `1px solid rgba(var(--theme-secondary), 0.15)`,
              } : {
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }),
              ...(editing && editMinWidth ? { minWidth: editMinWidth } : {}),
            }}
          >
            {isUser && editing ? (
              <div className="space-y-2">
                {editImages.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {editImages.map((img, i) => (
                      <div key={i} className="relative group/thumb">
                        <img
                          src={`data:${img.mimeType};base64,${img.data}`}
                          alt={img.name}
                          className="h-16 w-16 object-cover rounded-lg border border-white/15"
                        />
                        <button
                          onClick={() => removeEditImage(i)}
                          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/80 text-white text-xs flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-red-500"
                        >
                          ×
                        </button>
                        <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white/60 bg-black/50 rounded-b-lg px-1 truncate">
                          {img.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  className="w-full rounded-lg px-3 py-2 text-sm text-white/95 outline-none resize-none leading-relaxed"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                  }}
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
                    className="px-3 py-1 text-xs rounded-lg transition-colors"
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      color: 'rgba(255, 255, 255, 0.5)',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    className="px-3 py-1 text-xs rounded-lg transition-colors"
                    style={{
                      backgroundColor: `rgba(var(--theme-secondary), 0.15)`,
                      border: `1px solid rgba(var(--theme-secondary), 0.2)`,
                      color: `rgba(var(--theme-secondary-text), 0.9)`,
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : isUser ? (
              <div>
                {message.images && message.images.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {message.images.map((img, i) => (
                      <UserImage
                        key={i}
                        image={img}
                        onClick={() => setLightboxImage(img)}
                      />
                    ))}
                  </div>
                )}
                {message.content && (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed break-words max-w-full">
                    {renderSkillChips(message.content, availableSkills)}
                  </p>
                )}
                {message.queued && (
                  <div className="flex items-center gap-1 mt-1.5 text-[11px]" style={{ color: `rgba(var(--theme-accent-text), 0.7)` }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    Queued
                  </div>
                )}
            </div>
            ) : (
              <>
                {visibleThinkingText && (
                  <ThinkingBlock
                    thinking={visibleThinkingText}
                    isStreaming={showStreaming}
                    thinkingDurationMs={message.thinkingDurationMs}
                    thinkingActive={showStreaming ? streamingThinkingActive : false}
                    thinkingAccumulatedMs={showStreaming ? (streamingThinkingAccumulatedMs ?? 0) : 0}
                    thinkingLastStartRef={streamingThinkingLastStartRef}
                  />
                )}

                {/* Fallback: if message has thinking but no content/segments, show thinking as visible text (backward compat for pre-fix messages) */}
                {!renderSegments && !message.content && visibleThinkingText && !showStreaming && (
                  <div className="text-sm leading-relaxed mt-2 text-white/70">
                    {visibleThinkingText}
                  </div>
                )}

                {renderSegments ? (
                  // Interleaved segments in chronological order (streaming + persisted)
                  <MessageSegments
                    segments={message.segments}
                    showStreaming={showStreaming}
                    isThinkingStreaming={isThinkingStreaming}
                    streamingSegmentIndex={streamingSegmentIndex ?? null}
                    chatId={chatId}
                    onArtifactRuntimeError={onArtifactRuntimeError}
                  />
                ) : (
                  // Legacy fallback (no segments — old messages or non-agent chats)
                  <>
                    {/* Tool calls - only show if we don't have segments (prevent duplicates) */}
                    {message.toolCalls && message.toolCalls.length > 0 && (
                      <ToolCallsList
                        toolCalls={message.toolCalls}
                        toolResults={message.toolResults || []}
                      />
                    )}

                    {message.content && (
                      <div className="text-sm leading-relaxed max-w-full min-w-0">
                        <Suspense fallback={<span className="whitespace-pre-wrap break-words">{message.content}</span>}>
                          <MarkdownRenderer content={message.content} />
                        </Suspense>
                      </div>
                    )}

                    {/* Inline artifacts - legacy fallback */}
                    {(artifacts || message.artifacts)?.map((artifact) =>
                      isDesktopView && isItemPinned("artifact", artifact.id) ? (
                        <PinnedPlaceholder key={artifact.id} title={artifact.title} onUnpin={unpinItem} />
                      ) : (
                        <ArtifactPanel
                          key={artifact.id}
                          artifact={artifact}
                          chatId={chatId}
                          onArtifactRuntimeError={onArtifactRuntimeError}
                        />
                      )
                    )}

                    {/* Inline generated images - legacy fallback */}
                    {(generatedImages || message.generatedImages)?.map((img) => (
                      <GeneratedImagePanel key={img.id} image={img} />
                    ))}
                  </>
                )}
              </>
            )}

          </div>
            {!isUser && showReadAloudButton && (
              <div className="ml-1.5 mb-1 shrink-0">
                <ReadAloudButton
                  text={message.content}
                  onReadAloud={onReadAloud}
                  isPlaying={isPlayingTts}
                />
              </div>
            )}
          </div>

          {/* Message recap - brief summary shown below long assistant messages */}
          {!isUser && message.recap && (
            <div
              className="mt-1.5 ml-1 mb-1 self-start text-[11px] italic break-words max-w-full"
              style={{ color: 'rgba(255, 255, 255, 0.3)' }}
            >
              <span className="mr-1 opacity-60">▸</span>
              {message.recap}
            </div>
          )}

          {/* Streaming indicator - shown below assistant message during active streaming */}
          {!isUser && showStreamingIndicator && (
            <div className="mt-2 ml-1 self-start">
              <div className="w-4 h-4">
                <PolyhedronLogo isActive={true} animation={inferenceActivityPhase ?? "decode"} shape={activityShape} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Message context menu */}
      {contextMenu && canOpenContextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          {canReadAloud && (
            <ContextMenuItem onClick={handleReadAloud} disabled={isPlayingTts}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
              {isPlayingTts ? "Audio is playing" : "Read aloud"}
            </ContextMenuItem>
          )}
          {canEditMessage && (
            <ContextMenuItem onClick={() => { setContextMenu(null); handleStartEdit(); }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
              Edit message
            </ContextMenuItem>
          )}
          {canRetryMessage && (
            <ContextMenuItem onClick={handleRetry}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                <path d="M8 16H3v5" />
              </svg>
              Retry message
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={handleCopyTimestamp}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[11px] text-white/40">{formatTimestamp(message.timestamp)}</span>
            </span>
          </ContextMenuItem>
        </ContextMenu>
      )}

      {/* Image lightbox */}
      {lightboxImage && createPortal(
        <ImageLightbox image={lightboxImage} onClose={() => setLightboxImage(null)} />,
        document.body
      )}
    </div>
  );
});

/**
 * Renders message segments with automatic scrollable container for long sequences of tool calls.
 * When more than 6 consecutive tool calls are detected, they are wrapped in a scrollable box.
 * Supports manual scroll override during streaming with "new output" button.
 */
function MessageSegments({
  segments,
  showStreaming,
  isThinkingStreaming,
  streamingSegmentIndex,
  chatId,
  onArtifactRuntimeError,
}: {
  segments: ChatMessage["segments"];
  showStreaming: boolean;
  isThinkingStreaming: boolean;
  streamingSegmentIndex: number | null;
  chatId?: string;
  onArtifactRuntimeError?: (report: ArtifactRuntimeErrorReport) => void;
}) {
  const MAX_CONSECUTIVE_TOOLS = 6;
  
  // Group segments into runs of consecutive tool calls
  const groups: Array<{
    type: "tools" | "other";
    segments: typeof segments;
  }> = [];
  
  let currentGroup: typeof segments = [];
  let currentGroupIsTools = false;
  
  for (const segment of segments || []) {
    const isTool = segment.type === "tool_call" || segment.type === "tool_result";
    
    if (isTool !== currentGroupIsTools && currentGroup.length > 0) {
      groups.push({
        type: currentGroupIsTools ? "tools" : "other",
        segments: [...currentGroup],
      });
      currentGroup = [];
    }
    
    currentGroupIsTools = isTool;
    currentGroup.push(segment);
  }
  
  if (currentGroup.length > 0) {
    groups.push({
      type: currentGroupIsTools ? "tools" : "other",
      segments: [...currentGroup],
    });
  }
  
  // Track global segment index across all groups
  let globalIndex = 0;
  
  return (
    <>
      {groups.map((group, groupIndex) => {
        if (group.type === "tools" && group.segments) {
          // Count actual tool_call segments (not tool_result which are skipped)
          const toolCallCount = group.segments.filter(s => s.type === "tool_call").length;
          const useScrollContainer = toolCallCount > MAX_CONSECUTIVE_TOOLS;
          
          if (useScrollContainer) {
            const groupStartIndex = globalIndex;
            globalIndex += group.segments.length;
            
            // Check if this tool group is actively streaming
            const isGroupStreaming = showStreaming && streamingSegmentIndex !== null;
            const groupEndIndex = groupStartIndex + group.segments.length - 1;
            const isActivelyStreaming = isGroupStreaming && streamingSegmentIndex >= groupStartIndex && streamingSegmentIndex <= groupEndIndex;
            
            return (
              <ScrollableToolContainer
                key={`group-${groupIndex}`}
                isStreaming={isActivelyStreaming}
                childCount={group.segments.length}
                header={
                  <div className="px-3 py-1.5 text-xs text-white/40 border-b border-white/5 flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                    </svg>
                    <span>{toolCallCount} tool calls</span>
                  </div>
                }
              >
                {group.segments.map((segment, i) => (
                  <SegmentRenderer
                    key={`${segment.type}-${segment.seq}-${i}`}
                    segment={segment}
                    index={groupStartIndex + i}
                    allSegments={segments || []}
                    showStreaming={showStreaming}
                    isThinkingStreaming={isThinkingStreaming}
                    streamingSegmentIndex={streamingSegmentIndex}
                    chatId={chatId}
                    onArtifactRuntimeError={onArtifactRuntimeError}
                  />
                ))}
              </ScrollableToolContainer>
            );
          }
        }
        
        // Render without scroll container
        if (!group.segments) return null;
        const groupStartIndex = globalIndex;
        globalIndex += group.segments.length;
        return group.segments.map((segment, i) => (
          <SegmentRenderer
            key={`${segment.type}-${segment.seq}-${i}`}
            segment={segment}
            index={groupStartIndex + i}
            allSegments={segments || []}
            showStreaming={showStreaming}
            isThinkingStreaming={isThinkingStreaming}
            streamingSegmentIndex={streamingSegmentIndex}
            chatId={chatId}
            onArtifactRuntimeError={onArtifactRuntimeError}
          />
        ));
      })}
    </>
  );
}

/**
 * Scrollable container for tool calls with manual scroll override during streaming.
 * Similar pattern to ChatView's scroll handling.
 */
function ScrollableToolContainer({
  isStreaming,
  childCount,
  header,
  children,
}: {
  isStreaming: boolean;
  childCount: number;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const manualScrollOverrideRef = useRef(false);
  const [scrollPaused, setScrollPaused] = useState(false);

  // Track whether user is scrolled near the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 40;
    const wasNearBottom = isNearBottomRef.current;
    isNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;

    // If we're streaming and user scrolls away from bottom, enable manual override
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

  // Auto-scroll when new children are added.
  // Runs regardless of streaming state — tool results can be added after
  // isActivelyStreaming becomes false (e.g. when the agent starts its response text).
  useEffect(() => {
    if (!scrollRef.current) return;
    if (manualScrollOverrideRef.current) return;

    const scroll = scrollRef.current;
    scroll.scrollTop = scroll.scrollHeight;
  }, [childCount]);

  // Reset scroll pause state when streaming stops AND user is at the bottom.
  // If the user scrolled up (manual override active), preserve that intention
  // even after streaming ends — don't yank them back.
  useEffect(() => {
    if (!isStreaming && scrollPaused) {
      const scroll = scrollRef.current;
      const atBottom = scroll
        ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40
        : false;
      if (atBottom) {
        setScrollPaused(false);
        manualScrollOverrideRef.current = false;
      }
    }
  }, [isStreaming, scrollPaused]);
  
  // Scroll to bottom handler
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      manualScrollOverrideRef.current = false;
      isNearBottomRef.current = true;
      setScrollPaused(false);
    }
  }, []);
  
  return (
    <div className="my-2 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden relative">
      {header}
      <div ref={scrollRef} onScroll={handleScroll} className="overflow-y-auto max-h-[300px]">
        {children}
      </div>
      {/* Scroll to bottom button - appears when user scrolls away during streaming */}
      {scrollPaused && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-2 right-2 z-10 flex items-center gap-1 px-2 py-1 rounded-full bg-white/10 border border-white/20 text-white/70 hover:text-white hover:bg-white/15 hover:border-white/30 transition-all shadow-lg backdrop-blur-sm"
          title="Scroll to bottom"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          <span className="text-[10px] font-medium">New</span>
        </button>
      )}
    </div>
  );
}

/**
 * Renders a list of tool calls with automatic scrollable container when there are more than 6.
 */
function ToolCallsList({
  toolCalls,
  toolResults,
}: {
  toolCalls: ChatMessage["toolCalls"];
  toolResults: ChatMessage["toolResults"];
}) {
  const MAX_TOOLS = 6;
  const useScrollContainer = (toolCalls?.length || 0) > MAX_TOOLS;
  
  const renderToolCalls = () =>
    (toolCalls || []).map((tc, i) => {
      const tr = toolResults?.find((r) => r.toolCallId === tc.id);
      return (
        <ToolCallDisplay
          key={tc.id}
          toolCall={tc}
          toolResult={tr}
        />
      );
    });
  
  if (useScrollContainer) {
    return (
      <div className="my-2 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
        <div className="px-3 py-1.5 text-xs text-white/40 border-b border-white/5 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 7 4 4 20 4 20 7" />
            <line x1="9" y1="20" x2="15" y2="20" />
            <line x1="12" y1="4" x2="12" y2="7" />
          </svg>
          <span>{toolCalls?.length} tool calls</span>
          <span className="text-white/20">•</span>
          <span className="text-[11px]">Scroll to view all</span>
        </div>
        <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
          {renderToolCalls()}
        </div>
      </div>
    );
  }
  
  return <>{renderToolCalls()}</>;
}

function PinnedPlaceholder({ title, onUnpin }: { title: string; onUnpin: () => void }) {
  return (
    <div className="mt-3 rounded-xl border border-blue-400/20 bg-blue-500/[0.06] px-3 py-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-blue-300 shrink-0"
        >
          <path d="M12 17v5" />
          <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
        </svg>
        <span className="text-xs text-white/70 truncate">{title}</span>
        <span className="text-[10px] text-blue-300/70 uppercase tracking-wider shrink-0">Pinned</span>
      </div>
      <button
        onClick={onUnpin}
        className="text-[10px] text-white/50 hover:text-white/80 px-2 py-0.5 rounded hover:bg-white/5 transition-colors shrink-0"
      >
        Unpin
      </button>
    </div>
  );
}

/**
 * Renders an individual segment, handling tool_call/tool_result pairing.
 */
function SegmentRenderer({
  segment,
  index,
  allSegments,
  showStreaming,
  isThinkingStreaming,
  streamingSegmentIndex,
  chatId,
  onArtifactRuntimeError,
}: {
  segment: NonNullable<ChatMessage["segments"]>[number];
  index: number;
  allSegments: NonNullable<ChatMessage["segments"]>;
  showStreaming: boolean;
  isThinkingStreaming: boolean;
  streamingSegmentIndex: number | null;
  chatId?: string;
  onArtifactRuntimeError?: (report: ArtifactRuntimeErrorReport) => void;
}) {
  const { isPinned, unpin } = usePinnedItem();
  const isDesktop = useIsDesktop();
  switch (segment.type) {
    case "text": {
      if (isPlaceholderEllipsis(segment.content)) return null;
      // Only show cursor on the actively streaming text segment
      const isActivelyStreaming = showStreaming && streamingSegmentIndex === index && segment.type === "text";
      return segment.content ? (
        <div className="text-sm leading-relaxed">
          {isActivelyStreaming ? (
            <StreamingText content={segment.content} isStreaming={!isThinkingStreaming} />
          ) : (
            <Suspense fallback={<span className="whitespace-pre-wrap">{segment.content}</span>}>
              <MarkdownRenderer content={segment.content} />
            </Suspense>
          )}
        </div>
      ) : null;
    }
    case "tool_call": {
      const nextSegment = allSegments[index + 1];
      const hasResult = nextSegment?.type === "tool_result" &&
                       nextSegment.toolResult?.toolName === segment.toolCall?.name;

      return segment.toolCall ? (
        <ToolCallDisplay
          key={`tool-${segment.toolCall.id}`}
          toolCall={segment.toolCall}
          toolResult={hasResult ? nextSegment.toolResult : undefined}
          liveStatus={segment.liveStatus}
        />
      ) : null;
    }
    case "tool_result":
      return null;
    case "artifact": {
      if (!segment.artifact) return null;
      if (isDesktop && isPinned("artifact", segment.artifact.id)) {
        return <PinnedPlaceholder title={segment.artifact.title} onUnpin={unpin} />;
      }
      return (
        <ArtifactPanel
          key={`artifact-${segment.artifact.id}`}
          artifact={segment.artifact}
          chatId={chatId}
          onArtifactRuntimeError={onArtifactRuntimeError}
        />
      );
    }
    case "visual": {
      if (!segment.visual) return null;
      if (isDesktop && isPinned("visual", segment.visual.id)) {
        return <PinnedPlaceholder title={segment.visual.title} onUnpin={unpin} />;
      }
      return <InlineVisual key={`visual-${segment.visual.id}`} visual={segment.visual} />;
    }
    case "generated_image":
      return segment.generatedImage ? (
        <GeneratedImagePanel key={`image-${segment.generatedImage.id}`} image={segment.generatedImage} />
      ) : null;
    case "compaction_marker":
      return (
        <div className="flex items-center gap-2 my-2 py-1.5">
          <div className="flex-1 border-t border-blue-400/20" />
          <span className="text-[10px] text-blue-300/50 uppercase tracking-wider font-medium whitespace-nowrap flex items-center gap-1.5">
            <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {segment.content || "Context compacted"}
          </span>
          <div className="flex-1 border-t border-blue-400/20" />
        </div>
      );
    default:
      return null;
  }
}

function ImageLightbox({ image, onClose }: { image: ImageAttachment; onClose: () => void }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    // Use server URL for full image if available
    if (image.url) {
      setObjectUrl(image.url);
      return;
    }

    // Fall back to object URL from base64
    const binaryString = atob(image.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: image.mimeType });
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [image.url, image.data, image.mimeType]);

  if (!objectUrl) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
        onClick={onClose}
      >
        <div className="w-8 h-8 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white text-2xl flex items-center justify-center transition-colors"
      >
        ×
      </button>
      <img
        src={objectUrl}
        alt={image.name}
        onClick={(e) => e.stopPropagation()}
        className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
      />
      <span className="absolute bottom-4 text-white/50 text-sm">{image.name}</span>
    </div>
  );
}
