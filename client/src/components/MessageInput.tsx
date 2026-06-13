import { useState, useRef, useCallback, useLayoutEffect, useEffect, memo } from "react";
import type { ImageAttachment } from "../types";
import { getDraft, setDraft, clearDraft } from "../hooks/useChat";

interface Props {
  chatId: string | null;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  disabled: boolean;
  onAbort?: () => void;
  streaming?: boolean;
  waitingForInput?: boolean;
  isOnline?: boolean;
  placeholder?: string;
  onSlashTyping?: (filterText: string, cursorRect?: DOMRect) => void;
  onSlashDeleted?: () => void;
  inputRef?: React.RefObject<HTMLDivElement | null>;
  availableSkills?: string[];
  autoFocusInput?: boolean;
  variant?: "docked" | "centered";
}

/**
 * Converts a File to base64 string.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Processes and optionally compresses image files before upload.
 * Compresses images larger than 2MB to reduce upload bandwidth.
 */
async function processFiles(files: FileList | File[]): Promise<ImageAttachment[]> {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
  
  return Promise.all(
    imageFiles.map(async (file) => {
      const base64 = await fileToBase64(file);
      const mimeType = file.type;
      
      // Compress if larger than 2MB to reduce upload bandwidth
      if (file.size > 2 * 1024 * 1024) {
        try {
          const { compressImage } = await import("../utils/image");
          const compressed = await compressImage(base64, mimeType, 1200, 0.8);
          return { ...compressed, name: file.name };
        } catch (err) {
          console.warn("[MessageInput] Compression failed, using original:", err);
          // Fall through to return original
        }
      }
      
      return { data: base64, mimeType, name: file.name };
    })
  );
}

export const MessageInput = memo(function MessageInput({ chatId, onSend, disabled, onAbort, streaming, waitingForInput, isOnline = true, placeholder, onSlashTyping, onSlashDeleted, inputRef, availableSkills, autoFocusInput, variant = "docked" }: Props) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [processingImages, setProcessingImages] = useState<Set<number>>(new Set());
  const [hasContent, setHasContent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);

  /**
   * Insert skill chips for /skill-name patterns in text.
   * Only creates chips for recognized skills from the skills list.
   * Returns HTML string with skill spans and updated textRef.
   */
  const insertSkillChips = (text: string, container: HTMLElement, skillsList: string[]): { html: string } => {
    const skillPattern = /\/([a-zA-Z0-9\-_]+)/g;
    let html = text;
    const matches = [...text.matchAll(skillPattern)];
    
    // Replace each /skill with a chip span only if it's a recognized skill
    html = text.replace(skillPattern, (match, skillName) => {
      if (!skillsList.includes(skillName)) {
        // Not a recognized skill - leave as plain text
        return match;
      }
      
      const chip = document.createElement('span');
      chip.className = 'skill-chip';
      chip.style.cssText = 'display:inline-block;padding:2px 8px;margin:0 4px;background:rgba(var(--theme-accent-muted));border:1px solid rgba(var(--theme-accent-border));border-radius:12px;font-size:12px;color:rgba(var(--theme-accent-text));font-weight:500;vertical-align:middle;';
      chip.textContent = `/${skillName}`;
      chip.setAttribute('data-skill', skillName);
      chip.setAttribute('contenteditable', 'false');
      return chip.outerHTML;
    });
    
    return { html };
  };

  const prevChatIdRef = useRef<string | null>(null);

  // Expose editor ref to parent if provided
  useEffect(() => {
    if (inputRef && inputRef.current !== editorRef.current) {
      (inputRef as React.RefObject<HTMLDivElement | null>).current = editorRef.current;
    }
  }, [inputRef]);

  // Save current draft when switching chats, then load the new chat's draft
  useEffect(() => {
    const prevChatId = prevChatIdRef.current;
    prevChatIdRef.current = chatId;
    
    if (!chatId) {
      // Switching to no-chat state — nothing to do
      return;
    }
    
    // Save draft for the previous chat if it exists
    if (prevChatId && prevChatId !== chatId && editorRef.current) {
      const text = editorRef.current.innerText;
      if (text.trim() || images.length > 0) {
        setDraft(prevChatId, text, images);
      }
    }
    
    // Load draft for the new chat
    const draft = getDraft(chatId);
    if (draft) {
      textRef.current = draft.text;
      setImages(draft.images);
      setHasContent(!!draft.text.trim());
      if (editorRef.current) {
        // Recreate skill chips from draft text
        editorRef.current.innerHTML = "";
        const textWithSkills = insertSkillChips(draft.text, editorRef.current, availableSkills || []);
        editorRef.current.innerHTML = textWithSkills.html;
        // Position cursor at end
        const range = document.createRange();
        range.selectNodeContents(editorRef.current);
        range.collapse(false);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
    } else {
      // No draft for this chat — clear the input
      textRef.current = "";
      setImages([]);
      setHasContent(false);
      if (editorRef.current) {
        editorRef.current.innerText = "";
      }
    }
  }, [chatId]);

  // Auto-focus the editor when a new chat is created
  useEffect(() => {
    if (autoFocusInput && chatId && editorRef.current) {
      editorRef.current.focus();
    }
  }, [autoFocusInput, chatId]);

  const canSend = (hasContent || images.length > 0) && (!disabled || streaming || !isOnline);

  const updateLayout = useCallback(() => {
    const container = containerRef.current;
    const spacer = spacerRef.current;
    const buttons = buttonsRef.current;
    if (!container || !spacer || !buttons) return;

    spacer.style.height = "0px";
    const h1 = container.scrollHeight;
    const bh = buttons.offsetHeight;

    spacer.style.height = Math.max(0, h1 - bh) + "px";
    const h2 = container.scrollHeight;
    spacer.style.height = Math.max(0, h2 - bh) + "px";
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = textRef.current.trim();
    if ((!trimmed && images.length === 0) || (disabled && !streaming && isOnline)) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    textRef.current = "";
    setHasContent(false);
    setImages([]);
    if (editorRef.current) {
      editorRef.current.textContent = "";
      editorRef.current.focus();
    }
    // Clear draft for this chat
    if (chatId) clearDraft(chatId);
    updateLayout();
  }, [images, disabled, isOnline, onSend, updateLayout, chatId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "/") {
      // Trigger skill selector from any position
      // Note: keydown fires before the character is inserted, so we pass empty filter
      // The handleInput callback will update it once the / is in the text
      const el = editorRef.current;
      if (el) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const rect = range.getClientRects()[0];
          onSlashTyping?.("", rect);
        }
      }
    } else if (e.key === "Backspace") {
      // Allow deleting skill chips with backspace
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node instanceof Element && node.hasAttribute?.('data-skill')) {
          // Remove the skill chip
          node.remove();
          textRef.current = editorRef.current?.innerText || "";
          setHasContent(!!textRef.current.trim());
        }
      }
    }
  };

  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    textRef.current = el.innerText;
    setHasContent(!!textRef.current.trim());
    
    // Save draft only if chatId exists
    if (chatId) {
      setDraft(chatId, textRef.current, images);
    }
    
    updateLayout();
    // Check if / was deleted - close skill selector if no longer typing after /
    const lastSlashIndex = textRef.current.lastIndexOf("/");
    if (lastSlashIndex === -1) {
      // No slash at all - close selector
      if (onSlashDeleted) {
        onSlashDeleted();
      }
    } else {
      // Check if cursor is after the last slash
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        // Get text from start to cursor position
        const preCaretRange = range.cloneRange();
        preCaretRange.selectNodeContents(el);
        preCaretRange.setEnd(range.startContainer, range.startOffset);
        const caretText = preCaretRange.toString();
        const caretSlashIndex = caretText.lastIndexOf("/");
        
        // Only show selector if cursor is after a slash
        if (caretSlashIndex >= 0) {
          const filterText = caretText.slice(caretSlashIndex + 1);
          const rect = range.getClientRects()[0];
          onSlashTyping?.(filterText, rect);
        } else if (onSlashDeleted) {
          // Cursor is before all slashes - close selector
          onSlashDeleted();
        }
      }
    }
  }, [updateLayout, chatId, images, onSlashDeleted, onSlashTyping]);

  useLayoutEffect(() => {
    updateLayout();
  }, [hasContent, images.length, updateLayout]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => updateLayout());
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateLayout]);

  const addFiles = (files: FileList | File[]) => {
    // Snapshot into a plain array immediately — iOS Safari's FileList is a live
    // reference that becomes empty once the input's value is cleared.
    const fileArray = Array.from(files);
    // Process images asynchronously with progress feedback
    const startIndex = images.length;
    Promise.resolve(fileArray).then(async (f) => {
      const imageFiles = f.filter((file) => file.type.startsWith("image/"));
      
      // Mark all as processing
      setProcessingImages(prev => {
        const next = new Set(prev);
        imageFiles.forEach((_, idx) => next.add(startIndex + idx));
        return next;
      });
      
      try {
        const newImages = await processFiles(f);
        if (newImages.length > 0) {
          setImages((prev) => [...prev, ...newImages]);
        }
      } finally {
        // Clear processing state
        setProcessingImages(prev => {
          const next = new Set(prev);
          imageFiles.forEach((_, idx) => next.delete(startIndex + idx));
          return next;
        });
      }
    });
  };

  const removeImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) {
      setDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
      return;
    }
    
    // Handle text paste
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    
    e.preventDefault();
    
    // Use Selection/Range API instead of deprecated execCommand (iOS Safari compatible)
    const el = editorRef.current;
    if (!el) return;
    
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    
    const range = sel.getRangeAt(0);
    range.deleteContents();
    
    // Insert text node at cursor position
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    
    // Move cursor to end of inserted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    sel.removeAllRanges();
    sel.addRange(range);
    
    // Trigger input handler to update state
    textRef.current = el.innerText;
    setHasContent(!!textRef.current.trim());
    if (chatId) setDraft(chatId, textRef.current, images);
    updateLayout();
  };

  return (
    <div className={variant === "centered" ? "bg-transparent" : "p-2 md:p-3 bg-white/3"}>
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`backdrop-blur-xs bg-white/5 border rounded-2xl p-2 md:p-2.5 theme-accent-focus transition-colors relative ${
          dragging
            ? "theme-accent-drag ring-0"
            : waitingForInput
              ? "border-amber-400/40 ring-1 ring-amber-400/20"
              : "border-white/15"
        } ${variant === "centered" ? "shadow-2xl shadow-black/20" : ""}`}
      >
        {/* Vignette overlay — soft inset shadow for depth */}
        <div
          className="absolute inset-0 rounded-2xl pointer-events-none shadow-[inset_0_3px_8px_-4px_rgba(0,0,0,0.25),inset_0_-3px_8px_-4px_rgba(0,0,0,0.2)]"
          aria-hidden="true"
        />
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <div key={i} className="relative group/thumb">
                {processingImages.has(i) ? (
                  <div className="h-16 w-16 rounded-lg border border-white/15 bg-white/5 flex items-center justify-center">
                    <div className="w-5 h-5 border-2 rounded-full animate-spin" style={{ borderColor: 'rgba(var(--theme-accent-border))', borderTopColor: 'rgba(var(--theme-accent-text))' }} />
                  </div>
                ) : (
                  <img
                    src={img.data ? `data:${img.mimeType};base64,${img.data}` : ""}
                    alt={img.name}
                    className="h-16 w-16 object-cover rounded-lg border border-white/15"
                  />
                )}
                {!processingImages.has(i) && (
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/80 text-white text-xs flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-red-500"
                  >
                    ×
                  </button>
                )}
                {!processingImages.has(i) && (
                  <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white/60 bg-black/50 rounded-b-lg px-1 truncate">
                    {img.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div
          ref={containerRef}
          className="relative max-h-[200px] overflow-y-auto overflow-x-hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) editorRef.current?.focus();
          }}
        >
          <div ref={spacerRef} className="float-right w-0" />

          <div ref={buttonsRef} className="float-right clear-right flex items-center gap-2 ml-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors pressable"
              title="Attach images"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2ZM5 5v14h14V5H5ZM9 7a2 2 0 110 4 2 2 0 010-4ZM5 19l3.5-4.5 3 3 4-5.5L19 15v4H5Z" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileChange}
              // Mobile Safari requires file inputs to be in the render tree (not display:none)
              // Use visual hiding with absolute positioning instead
              style={{
                position: 'absolute',
                width: '1px',
                height: '1px',
                padding: '0',
                margin: '-1px',
                overflow: 'hidden',
                clip: 'rect(0, 0, 0, 0)',
                whiteSpace: 'nowrap',
                border: '0',
              }}
              tabIndex={0}
            />

            {streaming && canSend ? (
              <button
                onClick={handleSubmit}
                data-haptic="manual"
                className="px-4 py-1.5 rounded-lg text-sm theme-accent-btn pressable"
              >
                Send
              </button>
            ) : streaming ? (
              <button
                onClick={() => {
                  onAbort?.();
                }}
                data-haptic="manual"
                className="px-4 py-1.5 rounded-lg bg-red-500/20 border border-red-400/30 text-red-300 text-sm hover:bg-red-500/30 transition-colors pressable"
              >
                Stop
              </button>
            ) : !isOnline ? (
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                data-haptic="manual"
                className="px-4 py-1.5 rounded-lg bg-amber-500/20 border border-amber-400/30 text-amber-300 text-sm hover:bg-amber-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5 pressable"
                title="Message will be sent when back online"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                Queue
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                data-haptic="manual"
                className="px-4 py-1.5 rounded-lg text-sm theme-accent-btn pressable"
              >
                Send
              </button>
            )}
          </div>

          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            enterKeyHint="send"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            className="min-h-8 py-1.5 outline-none text-white/90 text-sm md:text-base leading-5 md:leading-6 break-words whitespace-pre-wrap"
            style={{ wordBreak: 'break-word' }}
          >
            {/* Skill chips are inserted dynamically */}
          </div>

          {!hasContent && images.length === 0 && (
            <div className="absolute top-1.5 left-0 pointer-events-none text-white/30 text-sm md:text-base leading-5 md:leading-6 select-none">
              {placeholder || (waitingForInput ? "Answer the agent's question..." : "Send a message...")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
