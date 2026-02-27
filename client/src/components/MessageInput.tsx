import { useState, useRef, useCallback } from "react";

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
  onAbort?: () => void;
  streaming?: boolean;
  waitingForInput?: boolean;
}

export function MessageInput({ onSend, disabled, onAbort, streaming, waitingForInput }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, disabled, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  };

  return (
    <div className="p-3 md:p-4">
      <div className={`backdrop-blur-xl bg-white/5 border rounded-2xl p-2.5 md:p-3 focus-within:ring-2 focus-within:ring-blue-400/30 focus-within:border-blue-400/30 transition-all ${waitingForInput ? "border-amber-400/40 ring-1 ring-amber-400/20" : "border-white/15"}`}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={waitingForInput ? "Answer the agent's question..." : "Send a message..."}
          rows={1}
          className="w-full bg-transparent text-white/90 placeholder-white/30 text-sm resize-none outline-none"
        />
        <div className="flex justify-end mt-2">
          {streaming ? (
            <button
              onClick={onAbort}
              className="px-4 py-1.5 rounded-lg bg-red-500/20 border border-red-400/30 text-red-300 text-sm hover:bg-red-500/30 transition-colors"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={!text.trim() || disabled}
              className="px-4 py-1.5 rounded-lg bg-blue-500/20 border border-blue-400/30 text-blue-300 text-sm hover:bg-blue-500/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
