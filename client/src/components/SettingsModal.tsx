import { useState, useEffect } from "react";
import type { OllamaModel, Settings } from "../types";

interface Props {
  settings: Settings;
  models: OllamaModel[];
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export function SettingsModal({ settings, models, onSave, onClose }: Props) {
  const [defaultModelId, setDefaultModelId] = useState(settings.defaultModelId);
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState(settings.defaultSystemPrompt);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleSave = () => {
    onSave({ defaultModelId, defaultSystemPrompt: defaultSystemPrompt.trim() });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg mx-4 backdrop-blur-xl bg-white/[0.08] border border-white/15 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white/90">Settings</h2>
          <button
            onClick={onClose}
            className="text-white/40 hover:text-white/70 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {/* Default Model */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Default Model</label>
            <select
              value={defaultModelId}
              onChange={(e) => setDefaultModelId(e.target.value)}
              className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 outline-none hover:bg-white/10 focus:ring-2 focus:ring-blue-400/30 transition-all cursor-pointer appearance-none"
              style={{ backgroundImage: "none" }}
            >
              <option value="" className="bg-slate-900 text-white">
                Auto (first available)
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id} className="bg-slate-900 text-white">
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Default System Prompt */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Default System Prompt</label>
            <textarea
              value={defaultSystemPrompt}
              onChange={(e) => setDefaultSystemPrompt(e.target.value)}
              rows={4}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all"
              placeholder="You are a helpful assistant."
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-white/60 hover:text-white/80 hover:bg-white/5 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-500/20 border border-blue-400/25 text-blue-300 hover:bg-blue-500/30 transition-all"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
