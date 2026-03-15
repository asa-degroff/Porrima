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
import { ContextMenu, ContextMenuItem } from "./ContextMenu";

const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);

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
}: Props) {
  const isUser = message.role === "user";
  const showStreaming = isStreaming && isLast && !isUser;

  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [lightboxImage, setLightboxImage] = useState<ImageAttachment | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
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
        onContextMenu={isUser && editable && !editing ? (e: React.MouseEvent) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        } : undefined}
        className={`max-w-[92%] md:max-w-[80%] rounded-2xl px-3 md:px-4 py-3 ${
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
                  {message.content}
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

            {renderSegments ? (
              // Interleaved segments in chronological order (streaming + persisted)
              message.segments?.map((segment, i) => {
                switch (segment.type) {
                  case "text": {
                    // During streaming, show cursor only on the last segment if it's text
                    const isActivelyStreaming = showStreaming && i === message.segments!.length - 1;
                    return segment.content ? (
                      <div key={`${segment.seq}-${i}`} className="text-sm leading-relaxed">
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
                    // Look ahead for immediate tool_result and pair them
                    const nextSegment = message.segments?.[i + 1];
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
                    // Skipped - rendered inline with its tool_call above
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
              })
            ) : (
              // Legacy fallback (no segments — old messages or non-agent chats)
              <>
                {/* Tool calls - only show if we don't have segments (prevent duplicates) */}
                {message.toolCalls && message.toolCalls.map((tc, i) => {
                  const tr = message.toolResults?.find((r) => r.toolCallId === tc.id);
                  return (
                    <ToolCallDisplay
                      key={tc.id}
                      toolCall={tc}
                      toolResult={tr}
                    />
                  );
                })}

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

      {/* Speaker button for assistant messages */}
      {!isUser && message.content && onReadAloud && (
        <button
          onClick={() => onReadAloud(message.content)}
          disabled={isPlayingTts}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md mt-2.5 ml-1.5 shrink-0"
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
