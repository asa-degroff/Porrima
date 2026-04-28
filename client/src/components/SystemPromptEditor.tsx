import { useState, useRef } from "react";
import type { SystemPromptPreset } from "../types";
import { Dropdown } from "./ui/Dropdown";
import { useDropdown } from "../hooks/useDropdown";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  presets?: SystemPromptPreset[];
  isAgent?: boolean;
  hidden?: boolean;
}

export function SystemPromptEditor({ value, onChange, disabled, presets, isAgent, hidden }: Props) {
  if (hidden) return null;
  const [expanded, setExpanded] = useState(false);
  const dd = useDropdown();
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

  // Determine which preset matches current value (if any)
  const matchingPreset = presets?.find((p) => p.content.trim() === localValue.trim());
  const hasPresets = presets && presets.length > 0;

  // In agent mode, no matching preset means using persona only (the "None" state)
  const isNoneSelected = isAgent && !matchingPreset;

  const handlePresetSelect = (presetId: string | null) => {
    if (presetId === null) {
      // "None" selected — clear to default (persona will be used on server)
      setLocalValue("You are a helpful assistant.");
      onChange("You are a helpful assistant.");
    } else {
      const preset = presets?.find((p) => p.id === presetId);
      if (preset) {
        setLocalValue(preset.content);
        onChange(preset.content.trim());
      }
    }
    dd.close();
  };

  const triggerClass = `flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-all disabled:opacity-40 ${
    matchingPreset
      ? "hover:opacity-90"
      : isNoneSelected
      ? "bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:text-white/60"
      : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white/70"
  }`;

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
          <Dropdown
            state={dd}
            disabled={disabled}
            wrapperClassName="ml-auto mr-3 md:mr-6"
            triggerClassName={triggerClass}
            triggerStyle={matchingPreset ? {
              backgroundColor: `rgba(var(--theme-primary), 0.1)`,
              borderColor: `rgba(var(--theme-primary-border))`,
              color: `rgba(var(--theme-primary-text))`,
            } : undefined}
            panelClassName="right-0 top-full mt-1 min-w-[180px] overflow-hidden"
            trigger={matchingPreset ? (matchingPreset.name || "Untitled") : isNoneSelected ? "Add preset" : "Custom"}
          >
            {isAgent && (
              <button
                onClick={() => handlePresetSelect(null)}
                className={`w-full text-left px-3 py-2 text-xs transition-all ${
                  isNoneSelected
                    ? "text-white"
                    : "text-white/60 hover:bg-white/10 hover:text-white/80"
                }`}
                style={{
                  backgroundColor: isNoneSelected ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                  color: isNoneSelected ? `rgba(var(--theme-secondary-text))` : '',
                }}
              >
                None (persona only)
              </button>
            )}
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
          </Dropdown>
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
