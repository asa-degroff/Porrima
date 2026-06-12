import { useState, useCallback, useRef, useEffect } from "react";
import type { NotebookLink, ImageAttachment } from "../types";

const MAX_IMAGES = 5;

interface Props {
  onSubmit: (content: string, links?: NotebookLink, images?: ImageAttachment[]) => Promise<void> | void;
  onCancel?: () => void;
  placeholder?: string;
  initialContent?: string;
  initialLinks?: NotebookLink;
  initialImages?: ImageAttachment[];
  autoFocus?: boolean;
  onOpenLinkPicker?: (type: 'chat' | 'notebook', anchorRect: DOMRect) => void;
  pendingLinks?: NotebookLink;
  onRemovePendingLink?: (linkType: 'chat' | 'notebook', index: number) => void;
}

export function NotebookEntryComposer({ onSubmit, onCancel, placeholder, initialContent, initialLinks, initialImages, autoFocus, onOpenLinkPicker, pendingLinks, onRemovePendingLink }: Props) {
  const [content, setContent] = useState(initialContent || '');
  const [submitting, setSubmitting] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>(initialImages || []);
  const [processingImages, setProcessingImages] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  // Use pendingLinks from parent (controlled) or initialLinks (uncontrolled edit mode)
  const displayLinks = pendingLinks || initialLinks;
  const hasLinks = displayLinks && ((displayLinks.chats?.length || 0) + (displayLinks.notebooks?.length || 0) > 0);
  const hasImages = images.length > 0;

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const processFiles = async (files: FileList | File[], startIndex: number = 0): Promise<ImageAttachment[]> => {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    
    return Promise.all(
      imageFiles.map(async (file, idx) => {
        const globalIdx = startIndex + idx;
        // Mark as processing
        setProcessingImages(prev => new Set(prev).add(globalIdx));
        
        try {
          const base64 = await fileToBase64(file);
          const mimeType = file.type;
          
          // Compress if larger than 2MB
          if (file.size > 2 * 1024 * 1024) {
            try {
              const { compressImage } = await import("../utils/image");
              const compressed = await compressImage(base64, mimeType, 1200, 0.8);
              return { ...compressed, name: file.name };
            } catch (err) {
              console.warn("[NotebookEntryComposer] Compression failed, using original:", err);
            }
          }
          
          return { data: base64, mimeType, name: file.name };
        } finally {
          // Mark as done
          setProcessingImages(prev => {
            const next = new Set(prev);
            next.delete(globalIdx);
            return next;
          });
        }
      })
    );
  };

  const handleFileSelect = async (files: FileList) => {
    const startIndex = images.length;
    const processed = await processFiles(files, startIndex);
    setImages(prev => {
      const remaining = [...prev, ...processed].slice(0, MAX_IMAGES);
      return remaining;
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleRemoveImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Drag-and-drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    dragCounterRef.current = 0;
    
    const files = e.dataTransfer.files;
    if (files && files.length) {
      await handleFileSelect(files);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (content.trim() && !submitting) {
      setSubmitting(true);
      try {
        const linksToSend = hasLinks ? displayLinks : undefined;
        const imagesToSend = hasImages ? images : undefined;
        await onSubmit(content.trim(), linksToSend, imagesToSend);
        setContent('');
        setImages([]);
      } finally {
        setSubmitting(false);
      }
    }
  }, [content, onSubmit, submitting, displayLinks, hasLinks, images, hasImages]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape' && onCancel) {
      onCancel();
    }
  }, [handleSubmit, onCancel]);

  // Auto-resize textarea as content grows
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    
    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const maxHeight = 400; // Max height in pixels (about 20 rows)
    
    // Set height to scrollHeight, capped at maxHeight
    textarea.style.height = Math.min(scrollHeight, maxHeight) + 'px';
  }, []);

  // Size textarea to fit initial content on mount
  useEffect(() => {
    if (initialContent) autoResize();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleOpenLinkPicker = useCallback(() => {
    if (onOpenLinkPicker && linkButtonRef.current) {
      const rect = linkButtonRef.current.getBoundingClientRect();
      onOpenLinkPicker('chat', rect);
    }
  }, [onOpenLinkPicker]);

  return (
    <div
      ref={containerRef}
      className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          autoResize();
        }}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || "Write a note..."}
        autoFocus={autoFocus}
        rows={3}
        className="w-full px-4 py-3 bg-transparent text-sm text-white/80 placeholder-white/30 outline-none resize-none overflow-y-auto"
        style={{ minHeight: '80px', maxHeight: '400px' }}
      />
      {/* Drag overlay */}
      {dragging && (
        <div className="absolute inset-0 bg-purple-500/10 border-2 border-dashed border-purple-400/40 flex items-center justify-center pointer-events-none z-10">
          <div className="text-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-purple-400 mb-2">
              <path d="M12 5v14" /><path d="M5 12h14" />
            </svg>
            <span className="text-purple-300 text-sm">Drop images here</span>
          </div>
        </div>
      )}
      {/* Image previews */}
      {hasImages && (
        <div className="px-3 py-2 flex flex-wrap gap-2 border-t border-white/5">
          {images.map((img, i) => (
            <div key={i} className="group relative">
              {processingImages.has(i) ? (
                <div
                  className="w-16 h-16 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center"
                >
                  <div className="w-5 h-5 border-2 border-purple-400/30 border-t-purple-400 rounded-full animate-spin" />
                </div>
              ) : (
                <img
                  src={img.thumbUrl || img.url || (img.data ? `data:${img.mimeType};base64,${img.data}` : "")}
                  alt={img.name}
                  className="w-16 h-16 object-cover rounded-lg border border-white/10"
                />
              )}
              {!processingImages.has(i) && (
                <button
                  onClick={() => handleRemoveImage(i)}
                  className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pressable"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
          {images.length < MAX_IMAGES && (
            <label className="w-16 h-16 rounded-lg border border-dashed border-white/20 flex items-center justify-center text-white/30 hover:text-white/50 hover:border-white/40 transition-colors cursor-pointer">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => e.target.files && handleFileSelect(e.target.files!)}
                className="hidden"
              />
            </label>
          )}
        </div>
      )}
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
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-white/40 hover:text-red-400 ml-0.5 pressable"
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
          <span>Shift+Enter to post</span>
        </div>
        <div className="flex items-center gap-2">
          {onOpenLinkPicker && (
            <button
              ref={linkButtonRef}
              type="button"
              onClick={handleOpenLinkPicker}
              className="px-2 py-1 text-xs rounded-lg transition-colors text-white/40 hover:text-white/60 hover:bg-white/5 flex items-center gap-1 pressable"
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
              className="px-3 py-1.5 text-xs rounded-lg transition-colors text-white/50 hover:text-white/70 hover:bg-white/5 pressable"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={!content.trim() || submitting}
            data-haptic="manual"
            className="px-3 py-1.5 text-xs rounded-lg transition-colors bg-purple-500/15 border border-purple-400/25 text-purple-300 font-medium hover:bg-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5 pressable"
          >
            {submitting && (
              <div className="w-3 h-3 border-2 border-purple-400/30 border-t-purple-400 rounded-full animate-spin" />
            )}
            {submitting ? "Posting..." : "Post"}
          </button>
        </div>
      </div>
    </div>
  );
}
