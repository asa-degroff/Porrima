import { useState, useCallback, useRef, useEffect } from "react";
import type { AnalyzedImage, VisionMessage } from "../api/client";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface Props {
  image: AnalyzedImage;
  chatting: boolean;
  onChat: (message: string) => Promise<string>;
  onReanalyze: (preset: string) => Promise<void>;
}

export function VisionChat({ image, chatting, onChat, onReanalyze }: Props) {
  const [messages, setMessages] = useState<VisionMessage[]>(image.conversation);
  const [input, setInput] = useState("");
  const [presetSelectOpen, setPresetSelectOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const presetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(image.conversation);
  }, [image.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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

  const handleSend = useCallback(async () => {
    if (!input.trim() || chatting) return;
    const userMessage = input.trim();
    setInput("");

    const userMsg: VisionMessage = {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const response = await onChat(userMessage);
      const assistantMsg: VisionMessage = {
        role: "assistant",
        content: response,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (error) {
      console.error("Chat failed:", error);
      setMessages((prev) => prev.slice(0, -1));
    }
  }, [input, chatting, onChat]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

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
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
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

        {/* Description */}
        <div className="text-sm text-white/80 leading-relaxed">
          <MarkdownRenderer content={image.description} />
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
                    max-w-[85%] rounded-lg p-3 text-sm
                    ${msg.role === "user"
                      ? "bg-white/10 text-white/90"
                      : "bg-white/5 text-white/80"
                    }
                  `}
                >
                  <MarkdownRenderer content={msg.content} />
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

      {/* Input */}
      <div className="shrink-0 p-4 border-t border-white/10">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this image..."
            disabled={chatting}
            rows={2}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-white/20 resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || chatting}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 disabled:bg-white/5 disabled:text-white/20 text-white/80 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed self-end"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
