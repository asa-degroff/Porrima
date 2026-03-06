import { useState, useCallback, useRef, useEffect } from "react";
import type { AnalyzedImage, VisionMessage } from "../api/client";
import { MarkdownRenderer } from "./MarkdownRenderer";

interface Props {
  image: AnalyzedImage;
  chatting: boolean;
  onChat: (message: string) => Promise<string>;
  onReanalyze: (preset: string) => Promise<void>;
  onClose: () => void;
}

export function VisionChat({ image, chatting, onChat, onReanalyze, onClose }: Props) {
  const [messages, setMessages] = useState<VisionMessage[]>(image.conversation);
  const [input, setInput] = useState("");
  const [presetSelectOpen, setPresetSelectOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages(image.conversation);
  }, [image.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || chatting) return;

    const userMessage = input.trim();
    setInput("");
    
    // Optimistically add user message
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
      // Remove the optimistic message on error
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
      setMessages([]); // Reset conversation on re-analyze
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
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-white/90">Chat about this image</h3>
          <span className="text-xs text-white/40">({image.preset} · {image.model})</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setPresetSelectOpen(!presetSelectOpen)}
              className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition-colors"
              title="Re-analyze with different style"
            >
              Re-analyze
            </button>
            {presetSelectOpen && (
              <div className="absolute right-0 top-full mt-1 bg-[#1a1a2e] border border-white/10 rounded-lg shadow-xl z-50 min-w-[160px]">
                {presets.map((preset) => (
                  <button
                    key={preset.key}
                    onClick={() => handlePresetSelect(preset.key)}
                    className={`
                      w-full text-left px-3 py-2 text-xs hover:bg-white/5 transition-colors
                      ${preset.key === image.preset ? "text-white/80" : "text-white/60"}
                    `}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors p-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Initial description */}
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-white/50 mb-2">Initial Description</div>
          <div className="text-sm text-white/80">
            <MarkdownRenderer content={image.description} />
          </div>
        </div>

        {/* Conversation */}
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
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/90 placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-white/20 resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || chatting}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 disabled:bg-white/5 disabled:text-white/20 text-white/80 rounded-lg text-sm font-medium transition-colors disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
