import { useState, useRef, useCallback, memo } from "react";
import type { ImageAttachment } from "../types";

interface Props {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  disabled: boolean;
  onAbort?: () => void;
  streaming?: boolean;
  waitingForInput?: boolean;
  isOnline?: boolean;
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

export const MessageInput = memo(function MessageInput({ onSend, disabled, onAbort, streaming, waitingForInput, isOnline = true }: Props) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  const hasContent = text.trim() || images.length > 0;
  const canSend = hasContent && (!disabled || !isOnline);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || (disabled && isOnline)) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, images, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, []);

  const addFiles = async (files: FileList | File[]) => {
    const newImages = await processFiles(files);
    if (newImages.length > 0) {
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
      await addFiles(imageFiles);
    }
  };

  return (
    <div className="p-3 md:p-4">
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={`backdrop-blur-xl bg-white/5 border rounded-2xl p-2.5 md:p-3 focus-within:ring-2 focus-within:ring-blue-400/30 focus-within:border-blue-400/30 transition-colors ${
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

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          onPaste={handlePaste}
          placeholder={waitingForInput ? "Answer the agent's question..." : "Send a message..."}
          rows={1}
          enterKeyHint="send"
          className="w-full bg-transparent text-white/90 placeholder-white/30 text-base resize-none outline-none"
        />
        <div className="flex justify-end items-center gap-2 mt-2">
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
              onClick={onAbort}
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
      </div>
    </div>
  );
});
