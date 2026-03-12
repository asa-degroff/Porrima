import { useState, useRef, useEffect } from "react";
import type { SystemPromptPreset } from "../types";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  presets?: SystemPromptPreset[];
}

export function SystemPromptEditor({ value, onChange, disabled, presets }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [localValue, setLocalValue] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const prevValueRef = useRef(value);

  // Sync external value changes during render (no effect needed)
  if (prevValueRef.current !== value) {
    prevValueRef.current = value;
    setLocalValue(value);
  }

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  const handleBlur = () => {
    const trimmed = localValue.trim();
    if (trimmed !== value) {
      onChange(trimmed);
    }
  };

  // Determine which preset matches current value (if any)
  const matchingPreset = presets?.find((p) => p.content.trim() === localValue.trim());
  const hasPresets = presets && presets.length > 0;

  const handlePresetSelect = (presetId: string) => {
    const preset = presets?.find((p) => p.id === presetId);
    if (preset) {
      setLocalValue(preset.content);
      onChange(preset.content.trim());
    }
    setDropdownOpen(false);
  };

  return (
    <div className="border-b border-white/10">
      <div className="flex items-center">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 px-3 md:px-6 py-2 text-xs text-white/40 hover:text-white/60 transition-colors"
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
          {!expanded && !hasPresets && localValue !== "You are a helpful assistant." && (
            <span className="text-blue-400/50">(customized)</span>
          )}
        </button>
        {hasPresets && (
          <div className="relative ml-auto mr-3 md:mr-6" ref={dropdownRef}>
            <button
              onClick={() => !disabled && setDropdownOpen((o) => !o)}
              disabled={disabled}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-all disabled:opacity-40 ${
                matchingPreset
                  ? "hover:opacity-90"
                  : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white/70"
              }`}
              style={{
                backgroundColor: matchingPreset ? `rgba(var(--theme-primary), 0.1)` : '',
                borderColor: matchingPreset ? `rgba(var(--theme-primary-border))` : '',
                color: matchingPreset ? `rgba(var(--theme-primary-text))` : '',
              }}
            >
              {matchingPreset ? matchingPreset.name || "Untitled" : "Custom"}
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[180px] backdrop-blur-xl border rounded-xl shadow-2xl py-1 overflow-hidden"
                style={{
                  backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
                  borderColor: `rgba(var(--theme-primary-border))`,
                }}>
                {presets.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handlePresetSelect(p.id)}
                    className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                      matchingPreset?.id === p.id
                        ? "text-white"
                        : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                    style={{
                      backgroundColor: matchingPreset?.id === p.id ? `rgba(var(--theme-primary), 0.15)` : 'transparent',
                      color: matchingPreset?.id === p.id ? `rgba(var(--theme-primary-text))` : '',
                    }}
                  >
                    <span className="truncate flex-1">{p.name || "Untitled"}</span>
                    {p.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                        style={{
                          backgroundColor: `rgba(var(--theme-primary), 0.15)`,
                          color: `rgba(var(--theme-primary-text))`,
                          borderColor: `rgba(var(--theme-primary-border))`,
                        }}>
                        default
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
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
