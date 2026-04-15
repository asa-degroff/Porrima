import { Suspense, memo, lazy, useRef, useCallback, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import type { NotebookEntry, Artifact, NotebookLink, ImageAttachment, InlineVisual } from "../types";
import type { ChatListItem } from "../types";
import { ChatLinkPicker } from "./ChatLinkPicker";
import { NotebookLinkPicker } from "./NotebookLinkPicker";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ContextMenu";
import { ToolCallDisplay } from "./ToolCallDisplay";

const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);
const ArtifactPanel = lazy(() =>
  import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel }))
);
const InlineVisualComponent = lazy(() =>
  import("./InlineVisual").then((m) => ({ default: m.InlineVisual }))
);

interface Props {
  entry: NotebookEntry;
  onEdit?: (id: string, content: string) => void;
  onDelete?: (id: string) => void;
  onLinkClick?: (author: 'user' | 'agent', entryId: string) => void;
  onChatLinkClick?: (chatId: string) => void;
  onAddLink?: (type: 'chat' | 'notebook', anchorRect: DOMRect) => void;
  onRemoveLink?: (linkType: 'chat' | 'notebook' | 'url', index: number) => void;
}

export const NotebookEntryDisplay = memo(function NotebookEntryDisplay({
  entry,
  onEdit,
  onDelete,
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
    if (!onDelete) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, [onDelete]);

  const openContextMenu = useCallback((pos: { x: number; y: number }) => {
    if (onDelete) setContextMenu(pos);
  }, [onDelete]);
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
              className="text-white/30 hover:text-white/60 transition-colors p-1 rounded hover:bg-white/5"
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
              className="text-white/30 hover:text-white/60 transition-colors p-1 rounded hover:bg-white/5"
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
      <div className="p-4">
        {entry.images && entry.images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {entry.images.map((img, i) => (
              <img
                key={i}
                src={img.thumbUrl || img.url || `data:${img.mimeType};base64,${img.data}`}
                alt={img.name}
                className="max-h-40 max-w-full rounded-lg border border-white/10 object-cover cursor-pointer hover:opacity-90 transition-opacity"
                onClick={() => setLightboxImage(img)}
              />
            ))}
          </div>
        )}
        {entry.content && (
          <div className="text-sm leading-relaxed text-white/80">
            <Suspense fallback={<span className="whitespace-pre-wrap">{entry.content}</span>}>
              <MarkdownRenderer content={entry.content} />
            </Suspense>
          </div>
        )}

            {entry.links && (
              <div className="mt-3 flex flex-wrap gap-2">
                {entry.links.notebooks?.map((link, i) => (
                  <div
                    key={`notebook-${i}`}
                    className="group text-xs px-2 py-1 rounded bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-colors flex items-center gap-1"
                  >
                    <button
                      onClick={() => onLinkClick?.(link.author, link.entryId)}
                      className="flex items-center gap-1"
                    >
                      📓 {link.author}'s entry
                    </button>
                    {onRemoveLink && (
                      <button
                        onClick={() => onRemoveLink('notebook', i)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-1"
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
                      className="flex items-center gap-1.5 px-2 py-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                      </svg>
                      <span className="font-medium truncate max-w-[200px]">{link.title || 'Chat'}</span>
                    </button>
                    {onRemoveLink && (
                      <button
                        onClick={() => onRemoveLink('chat', i)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-1"
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
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-blue-400/60 hover:text-red-400 ml-1"
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

        {/* Tool calls — shown when the agent used tools while writing this entry */}
        {entry.toolCalls && entry.toolCalls.length > 0 && (
          <div className="mt-2">
            {entry.toolCalls.map((tc) => {
              const tr = entry.toolResults?.find((r) => r.toolCallId === tc.id);
              return <ToolCallDisplay key={tc.id} toolCall={tc} toolResult={tr} />;
            })}
          </div>
        )}

        {/* Artifacts */}
        {entry.artifacts?.map((artifact) => (
          <ArtifactPanel key={artifact.id} artifact={artifact} />
        ))}

        {/* Inline Visualizations */}
        {entry.visuals?.map((visual) => (
          <InlineVisualComponent key={visual.id} visual={visual} />
        ))}
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
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40 transition-all"
            >
              Delete
            </button>
            <button
              onClick={handleCancelDelete}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/15 transition-all"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && onDelete && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <ContextMenuItem
            destructive
            onClick={() => {
              setContextMenu(null);
              setConfirmDelete(true);
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            </svg>
            Delete
          </ContextMenuItem>
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
              className="absolute top-4 right-4 text-white/60 hover:text-white transition-colors p-2"
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
