import { useState, useCallback, useRef } from "react";

interface Props {
  onSubmit: (content: string) => Promise<void> | void;
  onCancel?: () => void;
  placeholder?: string;
  initialContent?: string;
  autoFocus?: boolean;
}

export function NotebookEntryComposer({ onSubmit, onCancel, placeholder, initialContent, autoFocus }: Props) {
  const [content, setContent] = useState(initialContent || '');
  const [submitting, setSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(async () => {
    if (content.trim() && !submitting) {
      setSubmitting(true);
      try {
        await onSubmit(content.trim());
        setContent('');
      } finally {
        setSubmitting(false);
      }
    }
  }, [content, onSubmit, submitting]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape' && onCancel) {
      onCancel();
    }
  }, [handleSubmit, onCancel]);

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
