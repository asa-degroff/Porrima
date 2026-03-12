import { useState, useRef, useEffect } from "react";
import type { OllamaModel } from "../types";

interface Props {
  models: OllamaModel[];
  selectedId: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ models, selectedId, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = models.find((m) => m.id === selectedId);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-2 md:px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer max-w-[120px] md:max-w-none"
      >
        <span className="truncate">{selected?.name || selectedId}</span>
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
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 min-w-[200px] max-h-[320px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
          style={{
            backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
            borderColor: `rgba(var(--theme-primary-border))`,
          }}>
          {models.map((m) => (
            <button
              key={m.id}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                m.id === selectedId
                  ? "text-white"
                  : "text-white/60 hover:bg-white/10 hover:text-white/80"
              }`}
              style={{
                backgroundColor: m.id === selectedId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                color: m.id === selectedId ? `rgba(var(--theme-secondary-text))` : '',
              }}
            >
              <span className="truncate flex-1">{m.name}</span>
              <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
