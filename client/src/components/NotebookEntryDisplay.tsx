import { Suspense, memo, lazy, useRef, useCallback, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { NotebookEntry, Artifact, NotebookLink, ImageAttachment, InlineVisual } from "../types";
import type { ChatListItem } from "../types";
import { ChatLinkPicker } from "./ChatLinkPicker";
import { NotebookLinkPicker } from "./NotebookLinkPicker";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ui/ContextMenu";
import { ToolCallDisplay } from "./ToolCallDisplay";

const MarkdownRenderer = lazy(() =>
  import("./ui/MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);
const ArtifactPanel = lazy(() =>
  import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel }))
);
const InlineVisualComponent = lazy(() =>
  import("./InlineVisual").then((m) => ({ default: m.InlineVisual }))
);

interface Props {
  entry: NotebookEntry;
  expanded: boolean;
  preview?: string;
  onToggleExpand?: () => void;
  onEdit?: (id: string, content: string) => void;
  onDelete?: (id: string) => void;
  onReadAloud?: (text: string) => void;
  onLinkClick?: (author: 'user' | 'agent', entryId: string) => void;
  onChatLinkClick?: (chatId: string) => void;
  onAddLink?: (type: 'chat' | 'notebook', anchorRect: DOMRect) => void;
  onRemoveLink?: (linkType: 'chat' | 'notebook' | 'url', index: number) => void;
}

export const NotebookEntryDisplay = memo(function NotebookEntryDisplay({
  entry,
  expanded,
  preview,
  onToggleExpand,
  onEdit,
  onDelete,
  onReadAloud,
  onLinkClick,
  onChatLinkClick,
  onAddLink,
  onRemoveLink,
}: Props) {
  const isAgent = entry.author === 'agent';
  const timestamp = new Date(entry.createdAt).toLocaleString();
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<ImageAttachment | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Close confirmation on Escape
  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setConfirmDelete(false);
  }, []);

  useEffect(() => {
    if (!confirmDelete) return;
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [confirmDelete, handleEscape]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onDelete && !onReadAloud) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [onDelete, onReadAloud]);

  const openContextMenu = useCallback((pos: { x: number; y: number }) => {
    if (onDelete || onReadAloud) setContextMenu(pos);
  }, [onDelete, onReadAloud]);
  const longPressProps = useLongPress(openContextMenu);

  const handleAddLink = useCallback(() => {
    if (onAddLink && linkButtonRef.current) {
      const rect = linkButtonRef.current.getBoundingClientRect();
      onAddLink('chat', rect);
    }
  }, [onAddLink]);

  const handleConfirmDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete(entry.id);
      setConfirmDelete(false);
    }
  }, [onDelete, entry.id]);

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxImage(null);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lightboxImage]);

  return (
    <div
      className={`rounded-xl border border-white/10 overflow-hidden ${isAgent ? 'bg-purple-500/[0.03]' : 'bg-white/[0.03]'}`}
      onContextMenu={handleContextMenu}
      {...longPressProps}
      style={{ position: 'relative', zIndex: 1 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isAgent ? 'bg-purple-400' : 'bg-white/40'}`} />
          <span className="text-xs font-medium text-white/60 uppercase tracking-wider">
            {isAgent ? 'Agent' : 'User'}
          </span>
          <span className="text-xs text-white/30">{timestamp}</span>
        </div>
        <div className="flex items-center gap-1">
          {onAddLink && (
            <button
              ref={linkButtonRef}
              type="button"
              onClick={handleAddLink}
              className="text-white/30 hover:text-white/60 transition-colors p-1 rounded hover:bg-white/5 pressable"
              title="Add link"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(entry.id, entry.content)}
              className="text-white/30 hover:text-white/60 transition-colors p-1 rounded hover:bg-white/5 pressable"
              title="Edit"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
            </button>
          )}

        </div>
      </div>

      {/* Content */}
      <div
        className={expanded ? 'p-4' : 'px-4 py-3 cursor-pointer'}
        onClick={expanded ? undefined : onToggleExpand}
        role={expanded ? undefined : 'button'}
        tabIndex={expanded ? undefined : 0}
        onKeyDown={expanded ? undefined : (e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand?.(); }}
      >
        {expanded && entry.images && entry.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {entry.images.map((img, i) => (
              <img
                key={i}
                src={img.thumbUrl || img.url || (img.data ? `data:${img.mimeType};base64,${img.data}` : "")}
                alt={img.name}
                className="max-h-40 max-w-full rounded-lg border border-white/10 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setLightboxImage(img)}
              />
            ))}
          </div>
        )}
        {expanded ? (
          // Full expanded view
          entry.content && (
            <div className="text-sm leading-relaxed text-white/80">
              <Suspense fallback={<span className="whitespace-pre-wrap">{entry.content}</span>}>
                <MarkdownRenderer content={entry.content} />
              </Suspense>
            </div>
          )
        ) : (
          // Collapsed preview
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-white/60 leading-relaxed line-clamp-3">
                {(preview || entry.content).slice(0, 200)}
              </p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onToggleExpand?.(); }}
              className="shrink-0 mt-0.5 text-white/30 hover:text-white/60 transition-colors p-1 rounded hover:bg-white/5 pressable"
              title="Expand entry"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>
        )}

        {expanded && entry.links && (
              <div className="mt-3 flex flex-wrap gap-2">
                {entry.links.notebooks?.map((link, i) => (
                  <div
                    key={`notebook-${i}`}
                    className="group text-xs px-2 py-1 rounded bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-colors flex items-center gap-1"
                  >
                    <button
                      onClick={() => onLinkClick?.(link.author, link.entryId)}
                      className="flex items-center gap-1 pressable"
                    >
                      📓 {link.author}'s entry
                    </button>
                    {onRemoveLink && (
                      <button
                        onClick={() => onRemoveLink('notebook', i)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-1 pressable"
                        title="Remove link"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                {entry.links.chats?.map((link, i) => (
                  <div
                    key={`chat-${i}`}
                    className="group text-xs rounded bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-colors flex items-center"
                  >
                    <button
                      onClick={() => onChatLinkClick?.(link.chatId)}
                      className="flex items-center gap-1.5 px-2 py-1 pressable"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      <span className="font-medium truncate max-w-[200px]">{link.title || 'Chat'}</span>
                    </button>
                    {onRemoveLink && (
                      <button
                        onClick={() => onRemoveLink('chat', i)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-1 pressable"
                        title="Remove link"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                {entry.links.urls?.map((urlLink, i) => (
                  <div
                    key={`url-${i}`}
                    className="group text-xs px-2 py-1 rounded bg-blue-500/10 border border-blue-400/20 text-blue-300 hover:bg-blue-500/20 transition-colors flex items-center gap-1"
                  >
                    <a
                      href={urlLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1"
                    >
                      🔗 {urlLink.title || urlLink.url.replace(/^https?:\/\//, '')}
                    </a>
                    {onRemoveLink && (
                      <button
                        onClick={() => onRemoveLink('url', i)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-400/60 hover:text-red-400 ml-1 pressable"
                        title="Remove link"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

        {/* Tool calls — shown when expanded and the agent used tools while writing this entry */}
        {expanded && entry.toolCalls && entry.toolCalls.length > 0 && (
          <div className="mt-2">
            {entry.toolCalls.map((tc) => {
              const tr = entry.toolResults?.find((r) => r.toolCallId === tc.id);
              return <ToolCallDisplay key={tc.id} toolCall={tc} toolResult={tr} />;
            })}
          </div>
        )}

        {/* Artifacts — only when expanded */}
        {expanded && entry.artifacts?.map((artifact) => (
          <ArtifactPanel key={artifact.id} artifact={artifact} />
        ))}

        {/* Inline Visualizations — only when expanded */}
        {expanded && entry.visuals?.map((visual) => (
          <InlineVisualComponent key={visual.id} visual={visual} />
        ))}

        {/* Collapse button — only when expanded */}
        {expanded && onToggleExpand && (
          <button
            onClick={onToggleExpand}
            className="mt-3 text-xs text-white/30 hover:text-white/50 transition-colors flex items-center gap-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
            Collapse
          </button>
        )}
      </div>

      {/* Delete confirmation overlay */}
      {confirmDelete && onDelete && (
        <div
          className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-2 z-20"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-xs text-white/80">Delete this entry?</p>
          <div className="flex gap-2">
            <button
              onClick={handleConfirmDelete}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40 transition-all pressable"
            >
              Delete
            </button>
            <button
              onClick={handleCancelDelete}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/15 transition-all pressable"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (onDelete || onReadAloud) && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          {onReadAloud && (
            <ContextMenuItem
              onClick={() => {
                setContextMenu(null);
                onReadAloud(entry.content);
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              </svg>
              Read aloud
            </ContextMenuItem>
          )}
          {onDelete && (
            <ContextMenuItem
              destructive
              onClick={() => {
                setContextMenu(null);
                setConfirmDelete(true);
              }}
            >
              <svg className="trash-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: 'visible' }}>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <g className="trash-lid">
                  <path d="M3 6h18" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </g>
              </svg>
              Delete
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}

      {/* Image lightbox */}
      {lightboxImage && createPortal(
        <div
          className="fixed inset-0 bg-black/95 z-[100] flex items-center justify-center p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div
            className="relative w-full h-full flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={lightboxImage.thumbUrl || lightboxImage.url || `data:${lightboxImage.mimeType};base64,${lightboxImage.data}`}
              alt={lightboxImage.name}
              className="max-h-[90vh] max-w-[90vw] w-auto h-auto object-contain rounded-lg shadow-2xl"
            />
            <button
              onClick={() => setLightboxImage(null)}
              className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors p-2 pressable"
              title="Close"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
            <div className="absolute bottom-4 left-0 right-0 text-center text-sm text-white/60">
              {lightboxImage.name}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});
