import { useState, useRef, useCallback, useLayoutEffect, useEffect, memo } from "react";
import type { ImageAttachment } from "../types";
import { useHaptics } from "../hooks/useHaptics";

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  disabled: boolean;
  onAbort?: () => void;
  streaming?: boolean;
  waitingForInput?: boolean;
  isOnline?: boolean;
  placeholder?: string;
}

function processFiles(files: FileList | File[]): Promise<ImageAttachment[]> {
  const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
  return Promise.all(
    imageFiles.map(
      (file) =>
        new Promise<ImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            // "data:image/png;base64,AAAA..." -> split out base64 and mimeType
            const [header, data] = dataUrl.split(",");
            const mimeType = header.match(/data:(.*?);/)?.[1] || file.type;
            resolve({ data, mimeType, name: file.name });
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        })
    )
  );
}

export const MessageInput = memo(function MessageInput({ onSend, disabled, onAbort, streaming, waitingForInput, isOnline = true, placeholder }: Props) {
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

  const canSend = (hasContent || images.length > 0) && (!disabled || !isOnline);

  // Positions buttons at the bottom-right by adjusting the spacer height.
  // A zero-width spacer floated right pushes the buttons (also float-right, clear-right)
  // down so text wraps around buttons only at the bottom of the input.
  const updateLayout = useCallback(() => {
    const container = containerRef.current;
    const spacer = spacerRef.current;
    const buttons = buttonsRef.current;
    if (!container || !spacer || !buttons) return;

    // Pass 1: reset spacer, measure natural content height
    spacer.style.height = "0px";
    const h1 = container.scrollHeight;
    const bh = buttons.offsetHeight;

    // Pass 2: set spacer, re-measure after text reflow
    spacer.style.height = Math.max(0, h1 - bh) + "px";
    const h2 = container.scrollHeight;
    spacer.style.height = Math.max(0, h2 - bh) + "px";
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = textRef.current.trim();
    if ((!trimmed && images.length === 0) || (disabled && isOnline)) return;
    medium();
    onSend(trimmed, images.length > 0 ? images : undefined);
    textRef.current = "";
    setHasContent(false);
    setImages([]);
    if (editorRef.current) {
      editorRef.current.textContent = "";
      editorRef.current.focus();
    }
    updateLayout();
  }, [images, disabled, isOnline, onSend, medium, updateLayout]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    textRef.current = el.innerText;
    setHasContent(!!textRef.current.trim());
    updateLayout();
  }, [updateLayout]);

  // Update layout on mount and when hasContent/images change
  useLayoutEffect(() => {
    updateLayout();
  }, [hasContent, images.length, updateLayout]);

  // Re-layout on container resize (e.g. window resize)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => updateLayout());
    observer.observe(container);
    return () => observer.disconnect();
  }, [updateLayout]);

  const addFiles = async (files: FileList | File[]) => {
    const newImages = await processFiles(files);
    if (newImages.length > 0) {
      success();
      setImages((prev) => [...prev, ...newImages]);
    }
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

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length > 0) {
      await addFiles(e.dataTransfer.files);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await addFiles(e.target.files);
      e.target.value = "";
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
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
      await addFiles(imageFiles);
      return;
    }
    // Strip formatting: only paste plain text
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
        {/* Image preview strip */}
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

        {/* Input area — buttons float to bottom-right, text wraps around them */}
        <div
          ref={containerRef}
          className="relative max-h-[200px] overflow-y-auto overflow-x-hidden"
          onClick={(e) => {
            if (e.target === e.currentTarget) editorRef.current?.focus();
          }}
        >
          {/* Zero-width spacer pushes buttons to bottom via float */}
          <div ref={spacerRef} className="float-right w-0" />

          {/* Buttons float right, clearing the spacer so they sit below it */}
          <div ref={buttonsRef} className="float-right clear-right flex items-center gap-2 ml-2">
            {/* Image picker button */}
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

            {streaming ? (
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

          {/* Editable text area */}
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
          />

          {/* Placeholder */}
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
