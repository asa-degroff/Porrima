import { Suspense, memo, lazy, useRef, useCallback, useState } from "react";
import type { NotebookEntry, Artifact, NotebookLink } from "../types";
import type { ChatListItem } from "../types";
import { ChatLinkPicker } from "./ChatLinkPicker";
import { NotebookLinkPicker } from "./NotebookLinkPicker";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ContextMenu";

const MarkdownRenderer = lazy(() =>
  import("./MarkdownRenderer").then((m) => ({ default: m.MarkdownRenderer }))
);
const ArtifactPanel = lazy(() =>
  import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel }))
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

  return (
    <div
      className={`rounded-xl border border-white/10 overflow-hidden ${isAgent ? 'bg-purple-500/[0.03]' : 'bg-white/[0.03]'}`}
      onContextMenu={handleContextMenu}
      {...longPressProps}
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
                className="max-h-40 rounded-lg border border-white/10 object-cover"
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

        {/* Add Link Button (user entries only) */}
        {onAddLink && (
          <div className="mt-3">
            <button
              ref={linkButtonRef}
              onClick={handleAddLink}
              className="text-xs px-2 py-1 rounded bg-white/5 border border-dashed border-white/20 text-white/40 hover:text-white/60 hover:bg-white/10 transition-colors flex items-center gap-1"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              Add link
            </button>
          </div>
        )}

        {/* Artifacts */}
        {entry.artifacts?.map((artifact) => (
          <ArtifactPanel key={artifact.id} artifact={artifact} />
        ))}
      </div>

      {/* Context menu */}
      {contextMenu && onDelete && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <ContextMenuItem
            destructive
            onClick={() => {
              setContextMenu(null);
              if (window.confirm("Delete this entry? This cannot be undone.")) {
                onDelete(entry.id);
              }
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
    </div>
  );
});
