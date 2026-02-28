import { useState, useEffect, useCallback } from "react";
// @simplewebauthn/browser is dynamically imported in handleAddPasskey
import { fetchRegisterOptions, verifyRegistration } from "../api/auth";
import type { OllamaModel, Settings, Theme } from "../types";

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
  const [theme, setTheme] = useState<Theme>(settings.theme || "default");
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [synthesisRunning, setSynthesisRunning] = useState(false);
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

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

  const handleSave = () => {
    onSave({ defaultModelId, defaultSystemPrompt: defaultSystemPrompt.trim(), braveApiKey: braveApiKey.trim(), theme });
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
