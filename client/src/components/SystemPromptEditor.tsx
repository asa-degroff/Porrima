import { useState, useRef } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function SystemPromptEditor({ value, onChange, disabled }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevValueRef = useRef(value);

  // Sync external value changes during render (no effect needed)
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalValue(value);
  }

  const handleBlur = () => {
    const trimmed = localValue.trim();
    if (trimmed !== value) {
      onChange(trimmed);
    }
  };

  return (
    <div className="border-b border-white/10">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 md:px-6 py-2 text-xs text-white/40 hover:text-white/60 transition-colors"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
        System Prompt
        {!expanded && localValue !== "You are a helpful assistant." && (
          <span className="text-blue-400/50">(customized)</span>
        )}
      </button>
      {expanded && (
        <div className="px-3 md:px-6 pb-3">
          <textarea
            ref={textareaRef}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            disabled={disabled}
            rows={3}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all disabled:opacity-40"
            placeholder="You are a helpful assistant."
          />
        </div>
      )}
    </div>
  );
}
