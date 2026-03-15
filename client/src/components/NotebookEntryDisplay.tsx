import { Suspense, memo, lazy, useRef, useCallback } from "react";
import type { NotebookEntry, Artifact, NotebookLink } from "../types";
import type { ChatListItem } from "../types";
import { ChatLinkPicker } from "./ChatLinkPicker";
import { NotebookLinkPicker } from "./NotebookLinkPicker";

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
}

export const NotebookEntryDisplay = memo(function NotebookEntryDisplay({
  entry,
  onEdit,
  onDelete,
  onLinkClick,
  onChatLinkClick,
  onAddLink,
}: Props) {
  const isAgent = entry.author === 'agent';
  const timestamp = new Date(entry.createdAt).toLocaleString();
  const linkButtonRef = useRef<HTMLButtonElement>(null);

  const handleAddLink = useCallback(() => {
    if (onAddLink && linkButtonRef.current) {
      const rect = linkButtonRef.current.getBoundingClientRect();
      onAddLink('chat', rect);
    }
  }, [onAddLink]);

  return (
    <div className={`rounded-xl border border-white/10 overflow-hidden ${isAgent ? 'bg-purple-500/[0.03]' : 'bg-white/[0.03]'}`}>
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
          {onDelete && (
            <button
              onClick={() => {
                if (window.confirm("Delete this entry? This cannot be undone.")) {
                  onDelete(entry.id);
                }
              }}
              className="text-white/30 hover:text-red-400 transition-colors p-1 rounded hover:bg-white/5"
              title="Delete"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-4">
        {entry.content && (
          <div className="text-sm leading-relaxed text-white/80">
            <Suspense fallback={<span className="whitespace-pre-wrap">{entry.content}</span>}>
              <MarkdownRenderer content={entry.content} />
            </Suspense>
          </div>
        )}

        {/* Links */}
        {entry.links && (
          <div className="mt-3 flex flex-wrap gap-2">
            {entry.links.notebooks?.map((link, i) => (
              <button
                key={`notebook-${i}`}
                onClick={() => onLinkClick?.(link.author, link.entryId)}
                className="text-xs px-2 py-1 rounded bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-colors flex items-center gap-1"
              >
                📓 {link.author}'s entry
              </button>
            ))}
            {entry.links.chats?.map((link, i) => (
              <button
                key={`chat-${i}`}
                onClick={() => onChatLinkClick?.(link.chatId)}
                className="text-xs px-2 py-1 rounded bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-colors flex items-center gap-1"
              >
                💬 {link.title || 'Chat'}
              </button>
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
    </div>
  );
});
