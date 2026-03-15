import { useState, useCallback, useRef, useEffect } from "react";
import type { NotebookLink } from "../types";

interface Props {
  onSubmit: (content: string, links?: NotebookLink) => Promise<void> | void;
  onCancel?: () => void;
  placeholder?: string;
  initialContent?: string;
  initialLinks?: NotebookLink;
  autoFocus?: boolean;
  onOpenLinkPicker?: (type: 'chat' | 'notebook', anchorRect: DOMRect) => void;
  pendingLinks?: NotebookLink;
  onRemovePendingLink?: (linkType: 'chat' | 'notebook', index: number) => void;
}

export function NotebookEntryComposer({ onSubmit, onCancel, placeholder, initialContent, initialLinks, autoFocus, onOpenLinkPicker, pendingLinks, onRemovePendingLink }: Props) {
  const [content, setContent] = useState(initialContent || '');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);

  // Use pendingLinks from parent (controlled) or initialLinks (uncontrolled edit mode)
  const displayLinks = pendingLinks || initialLinks;
  const hasLinks = displayLinks && ((displayLinks.chats?.length || 0) + (displayLinks.notebooks?.length || 0) > 0);

  const handleSubmit = useCallback(async () => {
    if (content.trim() && !submitting) {
      setSubmitting(true);
      try {
        const linksToSend = hasLinks ? displayLinks : undefined;
        await onSubmit(content.trim(), linksToSend);
        setContent('');
      } finally {
        setSubmitting(false);
      }
    }
  }, [content, onSubmit, submitting, displayLinks, hasLinks]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape' && onCancel) {
      onCancel();
    }
  }, [handleSubmit, onCancel]);

  const handleOpenLinkPicker = useCallback(() => {
    if (onOpenLinkPicker && linkButtonRef.current) {
      const rect = linkButtonRef.current.getBoundingClientRect();
      onOpenLinkPicker('chat', rect);
    }
  }, [onOpenLinkPicker]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || "Write a note..."}
        autoFocus={autoFocus}
        rows={3}
        className="w-full px-4 py-3 bg-transparent text-sm text-white/80 placeholder-white/30 outline-none resize-none"
        style={{ minHeight: '80px' }}
      />
      {/* Pending links display */}
      {hasLinks && (
        <div className="px-3 py-2 flex flex-wrap gap-2 border-t border-white/5">
          {displayLinks!.chats?.map((link, i) => (
            <span key={`chat-${i}`} className="group text-xs px-2 py-1 rounded bg-white/5 border border-white/10 text-white/50 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {link.title || 'Chat'}
              {onRemovePendingLink && (
                <button
                  onClick={() => onRemovePendingLink('chat', i)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-0.5"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                  </svg>
                </button>
              )}
            </span>
          ))}
          {displayLinks!.notebooks?.map((link, i) => (
            <span key={`nb-${i}`} className="group text-xs px-2 py-1 rounded bg-white/5 border border-white/10 text-white/50 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
              </svg>
              {link.author}'s entry
              {onRemovePendingLink && (
                <button
                  onClick={() => onRemovePendingLink('notebook', i)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-0.5"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                  </svg>
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2 border-t border-white/10 bg-white/[0.02]">
        <div className="flex items-center gap-2 text-xs text-white/40">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          <span>Shift+Enter for new line</span>
        </div>
        <div className="flex items-center gap-2">
          {onOpenLinkPicker && (
            <button
              ref={linkButtonRef}
              type="button"
              onClick={handleOpenLinkPicker}
              className="px-2 py-1 text-xs rounded-lg transition-colors text-white/40 hover:text-white/60 hover:bg-white/5 flex items-center gap-1"
              title="Add link"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              Link
            </button>
          )}
          {onCancel && (
            <button
              onClick={onCancel}
              className="px-3 py-1.5 text-xs rounded-lg transition-colors text-white/50 hover:text-white/70 hover:bg-white/5"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={!content.trim() || submitting}
            className="px-3 py-1.5 text-xs rounded-lg transition-colors bg-purple-500/15 border border-purple-400/25 text-purple-300 font-medium hover:bg-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}
