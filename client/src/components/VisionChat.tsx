import { useState, useCallback, useRef, useEffect } from "react";
import type { AnalyzedImage, VisionMessage } from "../api/client";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageInput } from "./MessageInput";
import { OctahedronLogo } from "./OctahedronLogo";

interface Props {
  image: AnalyzedImage;
  analyzing?: boolean;
  streamingDescription?: string | null;
  chatting: boolean;
  onChat: (message: string) => Promise<string>;
  onReanalyze: (preset: string) => Promise<void>;
  onCopyDescription?: () => void;
  onSendToGenerate?: (description: string) => void;
}

export function VisionChat({ image, analyzing, streamingDescription, chatting, onChat, onReanalyze, onCopyDescription, onSendToGenerate }: Props) {
  const [messages, setMessages] = useState<VisionMessage[]>(image.conversation);
  const [presetSelectOpen, setPresetSelectOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const presetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  useEffect(() => {
    setMessages(image.conversation);
  }, [image.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-scroll during streaming description (same pattern as ChatView)
  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !streamingDescription) return;
    
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        scroll.scrollTop = scroll.scrollHeight;
      }
    });
    if (content) observer.observe(content);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [streamingDescription]);

  // Close preset menu on outside click
  useEffect(() => {
    if (!presetSelectOpen) return;
    const handler = (e: MouseEvent) => {
      if (presetRef.current && !presetRef.current.contains(e.target as Node)) {
        setPresetSelectOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [presetSelectOpen]);

  const handleSend = useCallback((text: string) => {
    if (!text.trim() || chatting) return;

    const userMsg: VisionMessage = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    onChat(text).then((response) => {
      const assistantMsg: VisionMessage = {
        role: "assistant",
        content: response,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    }).catch((error) => {
      console.error("Chat failed:", error);
      setMessages((prev) => prev.slice(0, -1));
    });
  }, [chatting, onChat]);

  const handlePresetSelect = useCallback(async (preset: string) => {
    setPresetSelectOpen(false);
    try {
      await onReanalyze(preset);
      setMessages([]);
    } catch (error) {
      console.error("Re-analyze failed:", error);
    }
  }, [onReanalyze]);

  const presets = [
    { key: "simple", name: "Simple" },
    { key: "detailed", name: "Detailed" },
    { key: "tags", name: "Tags" },
    { key: "cinematic", name: "Cinematic" },
    { key: "style", name: "Style Focus" },
    { key: "z_image", name: "Z-Image" },
    { key: "sd", name: "Stable Diffusion" },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Scrollable content area */}
      <div 
        ref={scrollRef} 
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        <div ref={contentRef}>
        {/* Image + metadata */}
        <div className="flex flex-col items-start gap-3">
          <img
            src={image.url}
            alt={image.filename}
            className="max-w-sm max-h-80 rounded-lg object-contain shadow-lg shadow-black/30"
          />
          <div className="flex items-center gap-2 text-xs text-white/40">
            <span>{image.preset}</span>
            <span className="text-white/15">·</span>
            <span>{image.model}</span>
            <span className="text-white/15">·</span>
            <div className="relative" ref={presetRef}>
              <button
                onClick={() => setPresetSelectOpen(!presetSelectOpen)}
                className="text-white/50 hover:text-white/80 transition-colors underline underline-offset-2 decoration-white/20"
              >
                Re-analyze
              </button>
              {presetSelectOpen && (
                <div className="absolute left-0 top-full mt-1 z-30 min-w-[160px] backdrop-blur-xl bg-[#1a1a2e]/95 border border-white/15 rounded-xl shadow-2xl py-1">
                  {presets.map((preset) => (
                    <button
                      key={preset.key}
                      onClick={() => handlePresetSelect(preset.key)}
                      className={`w-full text-left px-3 py-2 text-xs transition-all ${
                        preset.key === image.preset
                          ? "bg-blue-500/15 text-blue-200"
                          : "text-white/60 hover:bg-white/10 hover:text-white/80"
                      }`}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Description with actions */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-medium text-white/40 uppercase tracking-wider">Description</label>
            {!analyzing && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(image.description);
                    onCopyDescription?.();
                  }}
                  className="text-[10px] text-white/50 hover:text-white/80 transition-colors flex items-center gap-1 px-2 py-1 rounded bg-white/5 hover:bg-white/10"
                  title="Copy markdown"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                  </svg>
                  Copy
                </button>
                <button
                  onClick={() => onSendToGenerate?.(image.description)}
                  className="text-[10px] text-amber-300 hover:text-amber-200 transition-colors flex items-center gap-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/20"
                  title="Send to generate"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 3 4 8.6725 8 10.344 12 8.6725 8 3Z" />
                    <path d="M12 13.3275 16 15 20 13.3275 12 3v10.3275Z" />
                    <path d="M8 14 4 19.553 8 21.224 12 19.553 8 14Z" />
                    <path d="M12 24.224 16 22.553 20 24.224 12 14v10.224Z" />
                  </svg>
                  Send to Generate
                </button>
              </div>
            )}
          </div>
          {analyzing ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2.5">
                <OctahedronLogo isActive={true} count={3} size={20} gap={2} speed={0.8} />
                <span className="text-xs text-white/40">Re-analyzing...</span>
              </div>
              {streamingDescription && (
                <div className="text-sm text-white/80 leading-relaxed markdown-body">
                  <MarkdownRenderer content={streamingDescription} />
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-white/80 leading-relaxed markdown-body">
              <MarkdownRenderer content={image.description} />
            </div>
          )}
        </div>

        {/* Conversation */}
        {messages.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-white/5">
            {messages.map((msg, idx) => (
              <div
                key={idx}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`
                    max-w-[85%] rounded-lg text-sm
                    ${msg.role === "user"
                      ? "bg-white/10 text-white/90 p-3"
                      : "bg-white/5 text-white/80"
                    }
                  `}
                >
                  <div className={msg.role === "assistant" ? "p-3" : ""}>
                    <MarkdownRenderer content={msg.content} />
                  </div>
                  {msg.role === "assistant" && (
                    <div className="flex items-center gap-1.5 px-3 pb-2 pt-1 border-t border-white/5">
                      <button
                        onClick={() => navigator.clipboard.writeText(msg.content)}
                        className="text-[10px] text-white/50 hover:text-white/80 transition-colors flex items-center gap-1 px-2 py-1 rounded bg-white/5 hover:bg-white/10"
                        title="Copy"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                        </svg>
                        Copy
                      </button>
                      <button
                        onClick={() => onSendToGenerate?.(msg.content)}
                        className="text-[10px] text-amber-300 hover:text-amber-200 transition-colors flex items-center gap-1 px-2 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-400/20"
                        title="Send to generate"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8 3 4 8.6725 8 10.344 12 8.6725 8 3Z" />
                          <path d="M12 13.3275 16 15 20 13.3275 12 3v10.3275Z" />
                          <path d="M8 14 4 19.553 8 21.224 12 19.553 8 14Z" />
                          <path d="M12 24.224 16 22.553 20 24.224 12 14v10.224Z" />
                        </svg>
                        Send to Generate
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {chatting && (
          <div className="flex justify-start">
            <div className="bg-white/5 rounded-lg p-3">
              <div className="flex items-center gap-2 text-white/40">
                <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                <span className="text-xs">Thinking...</span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0">
        <MessageInput
          onSend={handleSend}
          disabled={chatting}
          placeholder="Ask about this image..."
        />
      </div>
    </div>
  );
}
