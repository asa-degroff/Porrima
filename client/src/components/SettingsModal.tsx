import { useState, useEffect, useCallback } from "react";
// @simplewebauthn/browser is dynamically imported in handleAddPasskey
import { fetchRegisterOptions, verifyRegistration } from "../api/auth";
import type { OllamaModel, Settings, SystemPromptPreset, Theme, TTSSettings } from "../types";
import { getTTSVoices, getTTSSettings, updateTTSSettings } from "../api/tts";

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
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState(settings.defaultSystemPrompt);
  const [braveApiKey, setBraveApiKey] = useState(settings.braveApiKey || "");
  const [comfyuiUrl, setComfyuiUrl] = useState(settings.comfyuiUrl || "http://127.0.0.1:8188");
  const [comfyuiStatus, setComfyuiStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  const [theme, setTheme] = useState<Theme>(settings.theme || "default");
  const [presets, setPresets] = useState<SystemPromptPreset[]>(settings.systemPromptPresets || []);
  const [hapticsEnabled, setHapticsEnabled] = useState(settings.hapticsEnabled ?? true);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>(settings.modelContextWindows || {});
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [synthesisRunning, setSynthesisRunning] = useState(false);
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  const [ttsVoices, setTtsVoices] = useState<Array<{ label: string; voices: Array<{ id: string; name: string }> }>>([]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

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
      defaultSystemPrompt: effectivePrompt,
      braveApiKey: braveApiKey.trim(),
      comfyuiUrl: comfyuiUrl.trim() || undefined,
      theme,
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

          {/* Model Context Windows */}
          {models.length > 0 && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-white/60">Model Context Windows</label>
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
            </div>
          )}

          {/* Theme */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Theme</label>
            <div className="flex gap-2">
              {([
                { value: "default" as Theme, label: "Default" },
                { value: "ripple-grid" as Theme, label: "Ripple Grid" },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
                    theme === opt.value
                      ? "bg-purple-500/20 border-purple-400/30 text-purple-300"
                      : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10 hover:text-white/70"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
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
                        ? "border-purple-400/30 bg-purple-500/5"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
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
                            ? "bg-purple-500/20 text-purple-300 border border-purple-400/30"
                            : "text-white/30 hover:text-white/50 border border-transparent hover:border-white/10"
                        }`}
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
                  className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-purple-500/15 border border-purple-400/20 text-purple-300 hover:bg-purple-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
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
                  <select
                    value={ttsSettings.voice}
                    onChange={async (e) => {
                      const updated = await updateTTSSettings({ voice: e.target.value });
                      if (updated) setTtsSettings(updated);
                    }}
                    className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 outline-none focus:ring-2 focus:ring-blue-400/30 transition-all cursor-pointer appearance-none"
                    style={{ backgroundImage: "none" }}
                  >
                    {ttsVoices.map((category) => (
                      <optgroup key={category.label} label={category.label}>
                        {category.voices.map((voice) => (
                          <option key={voice.id} value={voice.id}>
                            {voice.name} ({voice.id})
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
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
              className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-purple-500/15 border border-purple-400/20 text-purple-300 hover:bg-purple-500/25 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
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
