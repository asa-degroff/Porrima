import { useState, useRef, useEffect, useCallback, lazy, Suspense, memo } from "react";
import { createPortal } from "react-dom";
import type { Artifact, ChatMessage, GeneratedImage, ImageAttachment } from "../types";
import type { ToolStatus } from "../api/client";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";
import { ArtifactPanel } from "./ArtifactPanel";
import { InlineVisual } from "./InlineVisual";
import { GeneratedImagePanel } from "./GeneratedImagePanel";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { SpeakerButton } from "./SpeakerButton";
import { UserImage } from "./UserImage";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ContextMenu";
import { CompactionIndicator } from "./CompactionIndicator";
import { OctahedronLogo } from "./OctahedronLogo";

const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);

// Hoisted static skill chip style - avoids new object on every render
const skillChipStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  margin: '0 4px',
  background: 'rgba(59,130,246,0.25)',
  border: '1px solid rgba(59,130,246,0.4)',
  borderRadius: '12px',
  fontSize: '12px',
  color: 'rgb(147,197,253)',
  fontWeight: 500,
  verticalAlign: 'middle',
};

// Stable empty array for availableSkills default prop
const emptySkillsList: string[] = [];

interface Props {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  streamingThinking?: string;
  activeTools?: ToolStatus[];
  artifacts?: Artifact[];
  generatedImages?: GeneratedImage[];
  onEditMessage?: (index: number, newText: string) => void;
  messageIndex?: number;
  editable?: boolean;
  onReadAloud?: (text: string) => void;
  isPlayingTts?: boolean;
  availableSkills?: string[];
  streamingSegmentIndex?: number | null;
  showStreamingIndicator?: boolean;
}

/**
 * Render skill chips for /skill-name patterns in message content.
 * Only applies to user messages (assistant messages have skills stripped server-side).
 * Only formats recognized skill names from the availableSkills list.
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
      // Skill name (odd indices) - only format if it's a recognized skill
      const skillName = parts[i];
      if (skillName && availableSkills?.includes(skillName)) {
        result.push(
          <span
            key={`skill-${skillName}`}
            className="skill-chip"
            style={skillChipStyle}
          >
            /{skillName}
          </span>
        );
      } else if (skillName) {
        // Not a recognized skill - render as plain text
        result.push(`/${skillName}`);
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
  activeTools,
  artifacts,
  generatedImages,
  onEditMessage,
  messageIndex,
  editable,
  onReadAloud,
  isPlayingTts,
  availableSkills = emptySkillsList,
  streamingSegmentIndex,
  showStreamingIndicator,
}: Props) {
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

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [lightboxImage, setLightboxImage] = useState<ImageAttachment | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const openContextMenu = useCallback((pos: { x: number; y: number }) => {
    if (isUser && editable && !editing) setContextMenu(pos);
  }, [isUser, editable, editing]);
  const longPressProps = useLongPress(openContextMenu);

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
    if (trimmed && trimmed !== message.content && messageIndex != null) {
      onEditMessage?.(messageIndex, trimmed);
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

  // Build output segments - use ordered segments if available, otherwise separate arrays
  const renderSegments = !isUser && message.segments && message.segments.length > 0;

  return (
    <div className={`group ${isUser ? "flex justify-end" : "flex justify-start"} mb-4`}>
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
      <div className="flex flex-col items-start max-w-[92%] md:max-w-[80%]">
        <div
          onContextMenu={isUser && editable && !editing ? (e: React.MouseEvent) => {
            e.preventDefault();
            setContextMenu({ x: e.clientX, y: e.clientY });
          } : undefined}
          {...(isUser && editable && !editing ? longPressProps : {})}
          className={`rounded-2xl px-3 md:px-4 py-3 ${
            isUser
              ? "text-white/95"
              : "text-white/90"
          } ${message.queued ? "opacity-60" : ""} ${editing ? "w-full" : ""}`}
          style={isUser ? {
            backgroundColor: `rgba(var(--theme-secondary), 0.1)`,
            border: `1px solid rgba(var(--theme-secondary), 0.15)`,
          } : {
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          {isUser ? (
          editing ? (
            <div className="space-y-2">
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
          ) : (
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
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
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
          )
        ) : (
          <>
            {thinkingText && (
              <ThinkingBlock
                thinking={thinkingText}
                isStreaming={showStreaming}
              />
            )}

            {/* Fallback: if message has thinking but no content/segments, show thinking as visible text (backward compat for pre-fix messages) */}
            {!renderSegments && !message.content && thinkingText && !showStreaming && (
              <div className="text-sm leading-relaxed mt-2 text-white/70">
                {thinkingText}
              </div>
            )}

            {renderSegments ? (
              // Interleaved segments in chronological order (streaming + persisted)
              <MessageSegments
                segments={message.segments}
                showStreaming={showStreaming}
                isThinkingStreaming={isThinkingStreaming}
                streamingSegmentIndex={streamingSegmentIndex ?? null}
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
                  <div className="text-sm leading-relaxed">
                    <Suspense fallback={<span className="whitespace-pre-wrap">{message.content}</span>}>
                      <MarkdownRenderer content={message.content} />
                    </Suspense>
                  </div>
                )}

                {/* Inline artifacts - legacy fallback */}
                {(artifacts || message.artifacts)?.map((artifact) => (
                  <ArtifactPanel key={artifact.id} artifact={artifact} />
                ))}

                {/* Inline generated images - legacy fallback */}
                {(generatedImages || message.generatedImages)?.map((img) => (
                  <GeneratedImagePanel key={img.id} image={img} />
                ))}
              </>
            )}
          </>
        )}
        </div>

        {/* Speaker button for assistant messages - positioned below bubble content */}
        {!isUser && message.content && onReadAloud && (
          <button
            onClick={() => onReadAloud(message.content)}
            disabled={isPlayingTts}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md mt-2 ml-1 shrink-0 self-start"
            style={{
              backgroundColor: isPlayingTts ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
              color: isPlayingTts ? `rgba(var(--theme-secondary-text), 0.9)` : 'rgba(255, 255, 255, 0.4)',
            }}
            onMouseEnter={(e) => {
              if (!isPlayingTts) e.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)';
              if (!isPlayingTts) e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            }}
            onMouseLeave={(e) => {
              if (!isPlayingTts) e.currentTarget.style.color = 'rgba(255, 255, 255, 0.4)';
              if (!isPlayingTts) e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title={isPlayingTts ? "Playing..." : "Read aloud"}
          >
            {isPlayingTts ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="animate-pulse">
                <rect x="6" y="4" width="3" height="16" />
                <rect x="12" y="4" width="3" height="16" />
                <rect x="18" y="4" width="3" height="16" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
            )}
          </button>
        )}

        {/* Streaming indicator - shown below assistant message during active streaming */}
        {!isUser && showStreamingIndicator && (
          <div className="mt-2 ml-1">
            <div className="w-4 h-4">
              <OctahedronLogo isActive={true} />
            </div>
          </div>
        )}
      </div>

      {/* User message context menu */}
      {contextMenu && isUser && editable && !editing && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <ContextMenuItem onClick={() => { setContextMenu(null); handleStartEdit(); }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              <path d="m15 5 4 4" />
            </svg>
            Edit message
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
 */
function MessageSegments({
  segments,
  showStreaming,
  isThinkingStreaming,
  streamingSegmentIndex,
}: {
  segments: ChatMessage["segments"];
  showStreaming: boolean;
  isThinkingStreaming: boolean;
  streamingSegmentIndex: number | null;
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
            
            return (
              <div
                key={`group-${groupIndex}`}
                className="my-2 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden"
              >
                <div className="px-3 py-1.5 text-xs text-white/40 border-b border-white/5 flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 7 4 4 20 4 20 7" />
                    <line x1="9" y1="20" x2="15" y2="20" />
                    <line x1="12" y1="4" x2="12" y2="7" />
                  </svg>
                  <span>{toolCallCount} tool calls</span>
                </div>
                <div className="max-h-[300px] overflow-y-auto custom-scrollbar">
                  {group.segments.map((segment, i) => (
                    <SegmentRenderer
                      key={`${segment.type}-${segment.seq}-${i}`}
                      segment={segment}
                      index={groupStartIndex + i}
                      allSegments={segments || []}
                      showStreaming={showStreaming}
                      isThinkingStreaming={isThinkingStreaming}
                      streamingSegmentIndex={streamingSegmentIndex}
                    />
                  ))}
                </div>
              </div>
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
          />
        ));
      })}
    </>
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
}: {
  segment: NonNullable<ChatMessage["segments"]>[number];
  index: number;
  allSegments: NonNullable<ChatMessage["segments"]>;
  showStreaming: boolean;
  isThinkingStreaming: boolean;
  streamingSegmentIndex: number | null;
}) {
  switch (segment.type) {
    case "text": {
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
        />
      ) : null;
    }
    case "tool_result":
      return null;
    case "artifact":
      return segment.artifact ? (
        <ArtifactPanel key={`artifact-${segment.artifact.id}`} artifact={segment.artifact} />
      ) : null;
    case "visual":
      return segment.visual ? (
        <InlineVisual key={`visual-${segment.visual.id}`} visual={segment.visual} />
      ) : null;
    case "generated_image":
      return segment.generatedImage ? (
        <GeneratedImagePanel key={`image-${segment.generatedImage.id}`} image={segment.generatedImage} />
      ) : null;
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
