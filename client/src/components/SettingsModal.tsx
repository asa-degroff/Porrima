import { useState, useEffect, useCallback, useRef } from "react";
// @simplewebauthn/browser is dynamically imported in handleAddPasskey
import { fetchRegisterOptions, verifyRegistration } from "../api/auth";
import type { OllamaModel, Settings, SystemPromptPreset, Theme, TTSSettings, BackgroundEffect } from "../types";
import { getTTSVoices, getTTSSettings, updateTTSSettings } from "../api/tts";

function useClickOutside(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, ref, onClose]);
}

const chevronSvg = (open: boolean) => (
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
);

interface MemoryStatus {
  memoryCount: number;
  lastSynthesis: string | null;
  embeddingModelAvailable: boolean;
}

interface Props {
  settings: Settings;
  models: OllamaModel[];
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onLogout: () => void;
}

export function SettingsModal({ settings, models, onSave, onClose, onLogout }: Props) {
  const [defaultModelId, setDefaultModelId] = useState(settings.defaultModelId);
  const [defaultVisionModelId, setDefaultVisionModelId] = useState(settings.defaultVisionModelId || "");
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState(settings.defaultSystemPrompt);
  const [braveApiKey, setBraveApiKey] = useState(settings.braveApiKey || "");
  const [comfyuiUrl, setComfyuiUrl] = useState(settings.comfyuiUrl || "http://127.0.0.1:8188");
  const [comfyuiStatus, setComfyuiStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  const [theme, setTheme] = useState<Theme>(settings.theme || "default");
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>(settings.backgroundEffect || "static");
  const [presets, setPresets] = useState<SystemPromptPreset[]>(settings.systemPromptPresets || []);
  const [hapticsEnabled, setHapticsEnabled] = useState(settings.hapticsEnabled ?? true);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>(settings.modelContextWindows || {});
  const [ctxWindowsExpanded, setCtxWindowsExpanded] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [synthesisRunning, setSynthesisRunning] = useState(false);
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  const [ttsVoices, setTtsVoices] = useState<Array<{ label: string; voices: Array<{ id: string; name: string }> }>>([]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [visionModelDropdownOpen, setVisionModelDropdownOpen] = useState(false);
  const [voiceDropdownOpen, setVoiceDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const visionModelDropdownRef = useRef<HTMLDivElement>(null);
  const voiceDropdownRef = useRef<HTMLDivElement>(null);

  useClickOutside(modelDropdownRef, () => setModelDropdownOpen(false), modelDropdownOpen);
  useClickOutside(visionModelDropdownRef, () => setVisionModelDropdownOpen(false), visionModelDropdownOpen);
  useClickOutside(voiceDropdownRef, () => setVoiceDropdownOpen(false), voiceDropdownOpen);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Fetch memory status
  useEffect(() => {
    fetch("/api/memory/status", { credentials: "include" })
      .then((r) => r.json())
      .then(setMemoryStatus)
      .catch(() => {});
  }, []);

  // Fetch TTS settings and voices
  useEffect(() => {
    setTtsLoading(true);
    setTtsError(null);
    Promise.all([getTTSSettings(), getTTSVoices()])
      .then(([settings, voices]) => {
        setTtsSettings(settings);
        setTtsVoices(voices);
      })
      .catch((err) => {
        console.error("[TTS] Failed to load settings:", err);
        setTtsError("TTS service unavailable");
      })
      .finally(() => setTtsLoading(false));
  }, []);

  const handleSave = () => {
    const defaultPreset = presets.find((p) => p.isDefault);
    const effectivePrompt = defaultPreset ? defaultPreset.content.trim() : defaultSystemPrompt.trim();
    onSave({
      defaultModelId,
      defaultVisionModelId: defaultVisionModelId || undefined,
      defaultSystemPrompt: effectivePrompt,
      braveApiKey: braveApiKey.trim(),
      comfyuiUrl: comfyuiUrl.trim() || undefined,
      theme,
      backgroundEffect,
      systemPromptPresets: presets.length > 0 ? presets : undefined,
      hapticsEnabled,
      modelContextWindows: Object.keys(modelContextWindows).length > 0 ? modelContextWindows : undefined,
    });
  };

  const handleAddPreset = () => {
    const newPreset: SystemPromptPreset = {
      id: crypto.randomUUID(),
      name: "",
      content: "",
      isDefault: presets.length === 0,
    };
    setPresets((prev) => [...prev, newPreset]);
  };

  const handleUpdatePreset = (id: string, updates: Partial<SystemPromptPreset>) => {
    setPresets((prev) =>
      prev.map((p) => {
        if (p.id !== id) {
          // If we're setting a new default, unset others
          if (updates.isDefault) return { ...p, isDefault: false };
          return p;
        }
        return { ...p, ...updates };
      })
    );
  };

  const handleDeletePreset = (id: string) => {
    setPresets((prev) => {
      const remaining = prev.filter((p) => p.id !== id);
      // If deleted preset was the default, make first remaining one default
      const deleted = prev.find((p) => p.id === id);
      if (deleted?.isDefault && remaining.length > 0) {
        remaining[0] = { ...remaining[0], isDefault: true };
      }
      return remaining;
    });
  };

  const handleAddPasskey = useCallback(async () => {
    setPasskeyAdding(true);
    setPasskeyMessage(null);
    try {
      const options = await fetchRegisterOptions();
      const { startRegistration } = await import("@simplewebauthn/browser");
      const response = await startRegistration({ optionsJSON: options });
      const result = await verifyRegistration(response);
      if (result.verified) {
        setPasskeyMessage({ type: "ok", text: "Passkey added" });
      }
    } catch (err: any) {
      setPasskeyMessage({ type: "err", text: err.message || "Failed to add passkey" });
    }
    setPasskeyAdding(false);
  }, []);

  const handleTestComfyUI = useCallback(async () => {
    setComfyuiStatus("checking");
    try {
      const res = await fetch("/api/images/status", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setComfyuiStatus(data.available ? "connected" : "unavailable");
      } else {
        setComfyuiStatus("unavailable");
      }
    } catch {
      setComfyuiStatus("unavailable");
    }
  }, []);

  const handleRunSynthesis = useCallback(async () => {
    setSynthesisRunning(true);
    try {
      const res = await fetch("/api/memory/synthesis/run", { method: "POST", credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setMemoryStatus((prev) =>
          prev ? { ...prev, memoryCount: data.memoryCount, lastSynthesis: data.lastSynthesis } : prev
        );
      }
    } catch {}
    setSynthesisRunning(false);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg mx-4 backdrop-blur-xl bg-white/[0.08] border border-white/15 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
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
        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          {/* Default Model */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Default Model</label>
            <div className="relative" ref={modelDropdownRef}>
              <button
                onClick={() => setModelDropdownOpen((o) => !o)}
                className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
              >
                <span className="truncate flex-1 text-left">
                  {defaultModelId ? (models.find((m) => m.id === defaultModelId)?.name || defaultModelId) : "Auto (first available)"}
                </span>
                {chevronSvg(modelDropdownOpen)}
              </button>
              {modelDropdownOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                  style={{
                    backgroundColor: `rgba(var(--theme-primary), 0.1)`,
                    borderColor: `rgba(var(--theme-primary-border))`,
                  }}>
                  <button
                    onClick={() => { setDefaultModelId(""); setModelDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all ${
                      !defaultModelId ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                    style={{
                      backgroundColor: !defaultModelId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                      color: !defaultModelId ? `rgba(var(--theme-secondary-text))` : '',
                    }}
                  >
                    Auto (first available)
                  </button>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setDefaultModelId(m.id); setModelDropdownOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                        m.id === defaultModelId ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                      }`}
                      style={{
                        backgroundColor: m.id === defaultModelId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                        color: m.id === defaultModelId ? `rgba(var(--theme-secondary-text))` : '',
                      }}
                    >
                      <span className="truncate flex-1">{m.name}</span>
                      <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Default Vision Model */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Default Vision Model</label>
            <div className="relative" ref={visionModelDropdownRef}>
              <button
                onClick={() => setVisionModelDropdownOpen((o) => !o)}
                className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
              >
                <span className="truncate flex-1 text-left">
                  {defaultVisionModelId ? (models.find((m) => m.id === defaultVisionModelId)?.name || defaultVisionModelId) : "Auto (first vision model)"}
                </span>
                {chevronSvg(visionModelDropdownOpen)}
              </button>
              {visionModelDropdownOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                  style={{
                    backgroundColor: `rgba(var(--theme-primary), 0.1)`,
                    borderColor: `rgba(var(--theme-primary-border))`,
                  }}>
                  <button
                    onClick={() => { setDefaultVisionModelId(""); setVisionModelDropdownOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all ${
                      !defaultVisionModelId ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                    style={{
                      backgroundColor: !defaultVisionModelId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                      color: !defaultVisionModelId ? `rgba(var(--theme-secondary-text))` : '',
                    }}
                  >
                    Auto (first vision model)
                  </button>
                  {models.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => { setDefaultVisionModelId(m.id); setVisionModelDropdownOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center gap-2 ${
                        m.id === defaultVisionModelId ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                      }`}
                      style={{
                        backgroundColor: m.id === defaultVisionModelId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                        color: m.id === defaultVisionModelId ? `rgba(var(--theme-secondary-text))` : '',
                      }}
                    >
                      <span className="truncate flex-1">{m.name}</span>
                      <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="text-white/30 text-xs">
              Model used for image analysis in the Vision sandbox.
            </p>
          </div>

          {/* Model Context Windows */}
          {models.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setCtxWindowsExpanded(!ctxWindowsExpanded)}
                className="flex items-center gap-1.5 text-sm font-medium text-white/60 hover:text-white/80 transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={`transition-transform ${ctxWindowsExpanded ? "rotate-90" : ""}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                Model Context Windows
                {Object.keys(modelContextWindows).length > 0 && (
                  <span className="text-xs text-blue-300/60 font-normal">
                    ({Object.keys(modelContextWindows).length} override{Object.keys(modelContextWindows).length !== 1 ? "s" : ""})
                  </span>
                )}
              </button>
              {ctxWindowsExpanded && (
                <>
                  <p className="text-white/30 text-xs">Override the default context window per model. Applies to new chats.</p>
                  <div className="space-y-1.5">
                    {models.map((m) => {
                      const override = modelContextWindows[m.id];
                      const hasOverride = override !== undefined;
                      return (
                        <div key={m.id} className="flex items-center gap-2">
                          <span className="text-xs text-white/50 truncate flex-1 min-w-0" title={m.id}>{m.name}</span>
                          <input
                            type="number"
                            value={hasOverride ? override : ""}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === "") {
                                setModelContextWindows((prev) => {
                                  const next = { ...prev };
                                  delete next[m.id];
                                  return next;
                                });
                              } else {
                                setModelContextWindows((prev) => ({ ...prev, [m.id]: parseInt(val, 10) }));
                              }
                            }}
                            placeholder={m.contextWindow.toLocaleString()}
                            className="w-28 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-blue-400/30 transition-all text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          {hasOverride && (
                            <button
                              onClick={() =>
                                setModelContextWindows((prev) => {
                                  const next = { ...prev };
                                  delete next[m.id];
                                  return next;
                                })
                              }
                              className="text-white/20 hover:text-white/50 transition-colors p-0.5"
                              title="Reset to model default"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M18 6L6 18" />
                                <path d="M6 6l12 12" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Color Theme */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Color Theme</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: "default" as Theme, label: "Default", preview: "from-purple-900" },
                { value: "ocean" as Theme, label: "Ocean", preview: "from-sky-900" },
                { value: "forest" as Theme, label: "Forest", preview: "from-green-900" },
                { value: "crimson" as Theme, label: "Crimson", preview: "from-rose-900" },
                { value: "mono" as Theme, label: "Mono", preview: "from-gray-900" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`relative px-3 py-3 rounded-lg text-sm font-medium border transition-all overflow-hidden ${
                    theme === opt.value
                      ? "border-white/30"
                      : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <div className={`absolute inset-0 bg-gradient-to-br ${opt.preview} to-transparent opacity-20`} />
                  <span className="relative z-10">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Background Effect */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Background Effect</label>
            <div className="flex gap-2">
              {[
                { value: "static" as BackgroundEffect, label: "Static", icon: "□" },
                { value: "ripple-grid" as BackgroundEffect, label: "Ripple Grid", icon: "〃" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setBackgroundEffect(opt.value)}
                  className={`flex-1 px-3 py-3 rounded-lg text-sm font-medium border transition-all ${
                    backgroundEffect === opt.value
                      ? "border-white/30 bg-white/5"
                      : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <span className="mr-2 opacity-50">{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-white/30 text-xs">
              Ripple Grid adds an animated reactive background pattern.
            </p>
          </div>

          {/* Haptic Feedback */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-white/60">Haptic Feedback</label>
                <p className="text-xs text-white/30 mt-0.5">Vibration feedback for interactions (mobile only)</p>
              </div>
              <button
                onClick={() => setHapticsEnabled(!hapticsEnabled)}
                className={`relative w-12 h-6 rounded-full transition-colors ${
                  hapticsEnabled ? "bg-blue-500/30" : "bg-white/10"
                }`}
              >
                <div
                  className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                    hapticsEnabled ? "left-7" : "left-1"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* System Prompt Presets */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-white/60">System Prompt Presets</label>
              <button
                onClick={handleAddPreset}
                className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all"
              >
                + Add Preset
              </button>
            </div>

            {presets.length === 0 ? (
              <div className="space-y-2">
                <p className="text-white/30 text-xs">No presets. Using default prompt for new chats:</p>
                <textarea
                  value={defaultSystemPrompt}
                  onChange={(e) => setDefaultSystemPrompt(e.target.value)}
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all"
                  placeholder="You are a helpful assistant."
                />
              </div>
            ) : (
              <div className="space-y-3">
                {presets.map((preset) => (
                  <div
                    key={preset.id}
                    className={`rounded-lg border p-3 space-y-2 transition-all ${
                      preset.isDefault
                        ? "border-white/15"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                    style={{
                      backgroundColor: preset.isDefault ? `rgba(var(--theme-primary-muted), 0.05)` : '',
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={preset.name}
                        onChange={(e) => handleUpdatePreset(preset.id, { name: e.target.value })}
                        className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-blue-400/30 transition-all"
                        placeholder="Preset name..."
                      />
                      <button
                        onClick={() => handleUpdatePreset(preset.id, { isDefault: true })}
                        className={`text-xs px-2 py-1 rounded transition-all shrink-0 ${
                          preset.isDefault
                            ? "border"
                            : "text-white/30 hover:text-white/50 border border-transparent hover:border-white/10"
                        }`}
                        style={{
                          backgroundColor: preset.isDefault ? `rgba(var(--theme-primary-muted))` : '',
                          color: preset.isDefault ? `rgba(var(--theme-primary-text))` : '',
                          borderColor: preset.isDefault ? `rgba(var(--theme-primary-border))` : '',
                        }}
                        title={preset.isDefault ? "Default for new chats" : "Set as default"}
                      >
                        {preset.isDefault ? "Default" : "Set default"}
                      </button>
                      <button
                        onClick={() => handleDeletePreset(preset.id)}
                        className="text-white/20 hover:text-red-400/70 transition-colors p-0.5"
                        title="Delete preset"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6L6 18" />
                          <path d="M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                    <textarea
                      value={preset.content}
                      onChange={(e) => handleUpdatePreset(preset.id, { content: e.target.value })}
                      rows={2}
                      className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/70 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-blue-400/30 transition-all"
                      placeholder="Prompt content..."
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* API Keys Section */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">API Keys</h3>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">Brave Search API Key</label>
              <input
                type="password"
                value={braveApiKey}
                onChange={(e) => setBraveApiKey(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all"
                placeholder="BSA..."
                autoComplete="off"
              />
              <p className="text-white/30 text-xs">
                Required for the web_search agent tool. Get a key at{" "}
                <a href="https://brave.com/search/api/" target="_blank" rel="noopener noreferrer" className="text-blue-400/60 hover:text-blue-400/80">
                  brave.com/search/api
                </a>
              </p>
            </div>
          </div>

          {/* Image Generation (ComfyUI) */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Image Generation (ComfyUI)</h3>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">ComfyUI URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={comfyuiUrl}
                  onChange={(e) => setComfyuiUrl(e.target.value)}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-amber-400/30 focus:border-amber-400/30 transition-all"
                  placeholder="http://127.0.0.1:8188"
                />
                <button
                  onClick={handleTestComfyUI}
                  disabled={comfyuiStatus === "checking"}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-amber-500/15 border border-amber-400/20 text-amber-300 hover:bg-amber-500/25 transition-all disabled:opacity-40 shrink-0"
                >
                  {comfyuiStatus === "checking" ? "Testing..." : "Test"}
                </button>
              </div>
              {comfyuiStatus && comfyuiStatus !== "checking" && (
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${comfyuiStatus === "connected" ? "bg-green-400" : "bg-red-400"}`} />
                  <span className={`text-xs ${comfyuiStatus === "connected" ? "text-green-400/80" : "text-red-400/80"}`}>
                    {comfyuiStatus === "connected" ? "Connected" : "Not available"}
                  </span>
                </div>
              )}
              <p className="text-white/30 text-xs">
                Local ComfyUI instance for image generation. Used by the Image Sandbox and the generate_image agent tool.
              </p>
            </div>
          </div>

          {/* Memory Section */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Memory</h3>

            {memoryStatus ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/50">Stored memories</span>
                  <span className="text-white/80">{memoryStatus.memoryCount}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/50">Embedding model</span>
                  <span className={memoryStatus.embeddingModelAvailable ? "text-green-400/80" : "text-red-400/80"}>
                    {memoryStatus.embeddingModelAvailable ? "Available" : "Not found"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/50">Last synthesis</span>
                  <span className="text-white/80">
                    {memoryStatus.lastSynthesis
                      ? new Date(memoryStatus.lastSynthesis).toLocaleDateString()
                      : "Never"}
                  </span>
                </div>

                <button
                  onClick={handleRunSynthesis}
                  disabled={synthesisRunning || memoryStatus.memoryCount === 0}
                  className="w-full px-3 py-2 rounded-lg text-sm font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: `rgba(var(--theme-primary-muted), 0.15)`,
                    borderColor: `rgba(var(--theme-primary-border))`,
                    color: `rgba(var(--theme-primary-text))`,
                  }}
                >
                  {synthesisRunning ? "Running Synthesis..." : "Run Synthesis"}
                </button>
              </div>
            ) : (
              <p className="text-white/30 text-sm">Loading memory status...</p>
            )}
          </div>

          {/* TTS Section */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Text-to-Speech</h3>
            
            {ttsError ? (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-400/20">
                <p className="text-sm text-red-300">{ttsError}</p>
                <p className="text-xs text-red-400/60 mt-1">Make sure the TTS service is running on the server.</p>
              </div>
            ) : ttsLoading || !ttsSettings ? (
              <p className="text-white/30 text-sm">Loading TTS settings...</p>
            ) : (
              <div className="space-y-3">
                {/* Auto-read toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Auto-read responses</label>
                    <p className="text-xs text-white/30 mt-0.5">Automatically read new assistant messages aloud</p>
                  </div>
                  <button
                    onClick={async () => {
                      const updated = await updateTTSSettings({ autoReadEnabled: !ttsSettings.autoReadEnabled });
                      if (updated) setTtsSettings(updated);
                    }}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      ttsSettings.autoReadEnabled ? "bg-blue-500/30" : "bg-white/10"
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                        ttsSettings.autoReadEnabled ? "left-7" : "left-1"
                      }`}
                    />
                  </button>
                </div>

                {/* Test button */}
                <div className="pt-2">
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/tts/generate", {
                          method: "POST",
                          credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            text: "Hello! This is a test of the text-to-speech system.",
                            voice: ttsSettings.voice,
                            speed: ttsSettings.speed,
                          }),
                        });
                        if (res.ok) {
                          const data = await res.json();
                          const audio = new Audio(data.audioUrl);
                          audio.play();
                        }
                      } catch (err) {
                        console.error("Test failed:", err);
                      }
                    }}
                    className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-blue-500/15 border border-blue-400/20 text-blue-300 hover:bg-blue-500/25 transition-all"
                  >
                    Test Voice
                  </button>
                </div>

                {/* Voice selector */}
                <div className="space-y-1">
                  <label className="block text-sm text-white/50">Voice</label>
                  <div className="relative" ref={voiceDropdownRef}>
                    <button
                      onClick={() => setVoiceDropdownOpen((o) => !o)}
                      className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
                    >
                      <span className="truncate flex-1 text-left">
                        {(() => {
                          for (const cat of ttsVoices) {
                            const v = cat.voices.find((v) => v.id === ttsSettings.voice);
                            if (v) return `${v.name} (${v.id})`;
                          }
                          return ttsSettings.voice;
                        })()}
                      </span>
                      {chevronSvg(voiceDropdownOpen)}
                    </button>
                    {voiceDropdownOpen && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                        style={{
                          backgroundColor: `rgba(var(--theme-primary), 0.1)`,
                          borderColor: `rgba(var(--theme-primary-border))`,
                        }}>
                        {ttsVoices.map((category) => (
                          <div key={category.label}>
                            <div className="px-3 py-1.5 text-[10px] font-medium text-white/30 uppercase tracking-wider">
                              {category.label}
                            </div>
                            {category.voices.map((voice) => (
                              <button
                                key={voice.id}
                                onClick={async () => {
                                  const updated = await updateTTSSettings({ voice: voice.id });
                                  if (updated) setTtsSettings(updated);
                                  setVoiceDropdownOpen(false);
                                }}
                                className={`w-full text-left px-3 py-2 text-xs transition-all ${
                                  voice.id === ttsSettings.voice
                                    ? "text-white"
                                    : "text-white/60 hover:bg-white/10 hover:text-white/80"
                                }`}
                                style={{
                                  backgroundColor: voice.id === ttsSettings.voice ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                                  color: voice.id === ttsSettings.voice ? `rgba(var(--theme-secondary-text))` : '',
                                }}
                              >
                                {voice.name} ({voice.id})
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Speed control */}
                <div className="space-y-1">
                  <label className="block text-sm text-white/50">Speed: {ttsSettings.speed.toFixed(1)}x</label>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    value={ttsSettings.speed}
                    onChange={async (e) => {
                      const updated = await updateTTSSettings({ speed: parseFloat(e.target.value) });
                      if (updated) setTtsSettings(updated);
                    }}
                    className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-400"
                  />
                  <div className="flex justify-between text-xs text-white/30">
                    <span>0.5x</span>
                    <span>2.0x</span>
                  </div>
                </div>

                {/* Pitch control */}
                <div className="space-y-1">
                  <label className="block text-sm text-white/50">Pitch: {ttsSettings.pitch.toFixed(1)}x</label>
                  <input
                    type="range"
                    min="0.5"
                    max="2"
                    step="0.1"
                    value={ttsSettings.pitch}
                    onChange={async (e) => {
                      const updated = await updateTTSSettings({ pitch: parseFloat(e.target.value) });
                      if (updated) setTtsSettings(updated);
                    }}
                    className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-400"
                  />
                  <div className="flex justify-between text-xs text-white/30">
                    <span>0.5x</span>
                    <span>2.0x</span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Passkeys Section */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Passkeys</h3>
            {passkeyMessage && (
              <p className={`text-sm ${passkeyMessage.type === "ok" ? "text-green-400/80" : "text-red-400/80"}`}>
                {passkeyMessage.text}
              </p>
            )}
            <button
              onClick={handleAddPasskey}
              disabled={passkeyAdding}
              className="w-full px-3 py-2 rounded-lg text-sm font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{
                backgroundColor: `rgba(var(--theme-primary-muted), 0.15)`,
                borderColor: `rgba(var(--theme-primary-border))`,
                color: `rgba(var(--theme-primary-text))`,
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
                <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
              </svg>
              {passkeyAdding ? "Waiting for authenticator..." : "Add Passkey"}
            </button>
            <p className="text-white/30 text-xs">
              Register a security key or another device to sign in from anywhere.
            </p>
          </div>

          {/* Sign Out */}
          <div className="pt-2 border-t border-white/10">
            <button
              onClick={onLogout}
              className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-red-500/10 border border-red-400/15 text-red-300/80 hover:bg-red-500/20 transition-all flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sign Out
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-white/10 shrink-0">
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
