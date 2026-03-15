import { useState, useRef, useCallback, useLayoutEffect, useEffect, memo } from "react";
import type { ImageAttachment } from "../types";
import { useHaptics } from "../hooks/useHaptics";
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
  onSlashTyping?: () => void;
  onSlashDeleted?: () => void;
  inputRef?: React.RefObject<HTMLDivElement | null>;
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

export const MessageInput = memo(function MessageInput({ chatId, onSend, disabled, onAbort, streaming, waitingForInput, isOnline = true, placeholder, onSlashTyping, onSlashDeleted, inputRef }: Props) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const [dragging, setDragging] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);
  const dragCounterRef = useRef(0);
  const { medium, heavy, success } = useHaptics();

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
        editorRef.current.innerText = draft.text;
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
    medium();
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
  }, [images, disabled, isOnline, onSend, medium, updateLayout, chatId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "/" && textRef.current.trim() === "") {
      // Only trigger at start of message
      onSlashTyping?.();
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
    if (!el || !chatId) return;
    textRef.current = el.innerText;
    setHasContent(!!textRef.current.trim());
    // Save draft
    setDraft(chatId, textRef.current, images);
    updateLayout();
    // Check if / was deleted - close skill selector if no longer typing after /
    const hasSlashPrefix = textRef.current.trim().startsWith("/");
    if (!hasSlashPrefix && onSlashDeleted) {
      onSlashDeleted();
    }
  }, [updateLayout, chatId, images, onSlashDeleted]);

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
    // Process images asynchronously without blocking the input
    // Fire-and-forget - state updates when processing completes
    Promise.resolve(files).then(async (f) => {
      const newImages = await processFiles(f);
      if (newImages.length > 0) {
        success();
        setImages((prev) => [...prev, ...newImages]);
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
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) {
      document.execCommand("insertText", false, text);
    }
  };

  return (
    <div className="p-3 md:p-4 bg-white/3">
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`backdrop-blur-sm bg-white/5 border rounded-2xl p-2 md:p-2.5 focus-within:ring-2 focus-within:ring-blue-400/30 focus-within:border-blue-400/30 transition-colors ${
          dragging
            ? "border-blue-400/50 ring-2 ring-blue-400/30 bg-blue-500/10"
            : waitingForInput
              ? "border-amber-400/40 ring-1 ring-amber-400/20"
              : "border-white/15"
        }`}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
            {images.map((img, i) => (
              <div key={i} className="relative group/thumb">
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={img.name}
                  className="h-16 w-16 object-cover rounded-lg border border-white/15"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500/80 text-white text-xs flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-red-500"
                >
                  ×
                </button>
                <span className="absolute bottom-0 left-0 right-0 text-[9px] text-white/60 bg-black/50 rounded-b-lg px-1 truncate">
                  {img.name}
                </span>
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
              className="p-1.5 rounded-lg text-white/40 hover:text-white/70 hover:bg-white/10 transition-colors"
              title="Attach images"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileChange}
              className="hidden"
              tabIndex={-1}
            />

            {streaming && canSend ? (
              <button
                onClick={handleSubmit}
                className="px-4 py-1.5 rounded-lg bg-blue-500/20 border border-blue-400/30 text-blue-300 text-sm hover:bg-blue-500/30 transition-colors"
              >
                Send
              </button>
            ) : streaming ? (
              <button
                onClick={() => {
                  heavy();
                  onAbort?.();
                }}
                className="px-4 py-1.5 rounded-lg bg-red-500/20 border border-red-400/30 text-red-300 text-sm hover:bg-red-500/30 transition-colors"
              >
                Stop
              </button>
            ) : !isOnline ? (
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                className="px-4 py-1.5 rounded-lg bg-amber-500/20 border border-amber-400/30 text-amber-300 text-sm hover:bg-amber-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
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
                className="px-4 py-1.5 rounded-lg bg-blue-500/20 border border-blue-400/30 text-blue-300 text-sm hover:bg-blue-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
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
            className="min-h-8 py-1.5 outline-none text-white/90 text-sm md:text-base leading-snug break-words whitespace-pre-wrap"
            style={{ wordBreak: 'break-word' }}
          >
            {/* Skill chips are inserted dynamically */}
          </div>

          {!hasContent && images.length === 0 && (
            <div className="absolute top-1.5 left-0 pointer-events-none text-white/30 text-sm md:text-base leading-snug select-none">
              {placeholder || (waitingForInput ? "Answer the agent's question..." : "Send a message...")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
