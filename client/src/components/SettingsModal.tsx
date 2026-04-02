import { useState, useEffect, useCallback, useRef } from "react";
// @simplewebauthn/browser is dynamically imported in handleAddPasskey
import { fetchRegisterOptions, verifyRegistration } from "../api/auth";
import { searchMemories, fetchAllMemories, deleteMemory, fetchMemoryLineage } from "../api/client";
import { getPersona, updatePersona, getPersonaHistory, getPersonaVersion } from "../api/persona";
import { getUserDocument, updateUserDocument, deleteUserDocument } from "../api/user";
import type { OllamaModel, Settings, SystemPromptPreset, Theme, TTSSettings, BackgroundEffect, MemorySummary, MemoryLineage, CreativeDirectionSettings, BlueskySettings, PersonaStore, UserDocument } from "../types";
import { getTTSVoices, getTTSSettings, updateTTSSettings } from "../api/tts";
import { SkillsBrowser } from "./SkillsBrowser";

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
  const [defaultSystemPromptExpanded, setDefaultSystemPromptExpanded] = useState(false);
  const [persona, setPersona] = useState<PersonaStore | null>(null);
  const [personaExpanded, setPersonaExpanded] = useState(false);
  const [personaEditing, setPersonaEditing] = useState(false);
  const [personaContent, setPersonaContent] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaMessage, setPersonaMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [userDoc, setUserDoc] = useState<UserDocument | null>(null);
  const [userDocExpanded, setUserDocExpanded] = useState(false);
  const [userDocEditing, setUserDocEditing] = useState(false);
  const [userDocContent, setUserDocContent] = useState("");
  const [userDocSaving, setUserDocSaving] = useState(false);
  const [userDocMessage, setUserDocMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [braveApiKey, setBraveApiKey] = useState(settings.braveApiKey || "");
  const [comfyuiUrl, setComfyuiUrl] = useState(settings.comfyuiUrl || "http://127.0.0.1:8188");
  const [comfyuiStatus, setComfyuiStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  const [theme, setTheme] = useState<Theme>(settings.theme || "default");
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>(settings.backgroundEffect || "static");
  const [flatBackground, setFlatBackground] = useState(settings.flatBackground ?? false);
  const [presets, setPresets] = useState<SystemPromptPreset[]>(settings.systemPromptPresets || []);
  const [expandedPresetIds, setExpandedPresetIds] = useState<Set<string>>(new Set());
  const [hapticsEnabled, setHapticsEnabled] = useState(settings.hapticsEnabled ?? true);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>(settings.modelContextWindows || {});
  const [ctxWindowsExpanded, setCtxWindowsExpanded] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [synthesisRunning, setSynthesisRunning] = useState(false);
  const [memoryBrowserOpen, setMemoryBrowserOpen] = useState(false);
  const [skillsBrowserOpen, setSkillsBrowserOpen] = useState(false);
  // Delayed extraction settings
  const [delayedExtractionEnabled, setDelayedExtractionEnabled] = useState(settings.delayedExtractionEnabled ?? true);
  const [delayedExtractionThreshold, setDelayedExtractionThreshold] = useState(settings.delayedExtractionThresholdMinutes ?? 30);
  const [delayedExtractionCap, setDelayedExtractionCap] = useState(settings.delayedExtractionMessageCap ?? 50);
  const [enrichmentBatchSize, setEnrichmentBatchSize] = useState(settings.enrichmentBatchSize ?? 5);
  const [extractionModelId, setExtractionModelId] = useState(settings.extractionModelId || settings.defaultModelId);
  const [extractionFallbackEnabled, setExtractionFallbackEnabled] = useState(settings.extractionFallbackEnabled ?? true);
  const [memorySearchQuery, setMemorySearchQuery] = useState("");
  const [memoryResults, setMemoryResults] = useState<(MemorySummary & { score?: number })[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryDeleting, setMemoryDeleting] = useState<string | null>(null);
  const [memoryCategoryFilter, setMemoryCategoryFilter] = useState<string>("all");
  const [memorySortBy, setMemorySortBy] = useState<string>("created_at_desc");
  const [expandedLineage, setExpandedLineage] = useState<string | null>(null);
  const [lineageData, setLineageData] = useState<Record<string, MemoryLineage>>({});
  const [lineageLoading, setLineageLoading] = useState<string | null>(null);
  const memorySearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  const [ttsVoices, setTtsVoices] = useState<Array<{ label: string; voices: Array<{ id: string; name: string }> }>>([]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  // Creative direction settings
  const cdDefaults = settings.creativeDirections ?? {};
  const [cdEnabled, setCdEnabled] = useState(cdDefaults.enabled ?? true);
  const [cdModelId, setCdModelId] = useState(cdDefaults.modelId || "");
  const [cdLimit, setCdLimit] = useState(cdDefaults.limit ?? 5);
  const [cdMinNovelty, setCdMinNovelty] = useState(cdDefaults.minNovelty ?? 0.15);
  const [cdMaxExecutions, setCdMaxExecutions] = useState(cdDefaults.maxExecutions ?? 4);
  const [cdMaxReviewIterations, setCdMaxReviewIterations] = useState(cdDefaults.maxReviewIterations ?? 3);
  const [cdSteps, setCdSteps] = useState(cdDefaults.steps ?? 35);
  const [cdCfgScale, setCdCfgScale] = useState(cdDefaults.cfgScale ?? 4.0);
  const [cdModelDropdownOpen, setCdModelDropdownOpen] = useState(false);

  // Bluesky settings
  const blueskyDefaults = settings.bluesky ?? ({} as Partial<BlueskySettings>);
  const [blueskyEnabled, setBlueskyEnabled] = useState(blueskyDefaults.enabled ?? false);
  const [blueskyUsername, setBlueskyUsername] = useState(blueskyDefaults.username ?? "");
  const [blueskyAppPassword, setBlueskyAppPassword] = useState("");
  const [blueskyPollingInterval, setBlueskyPollingInterval] = useState(blueskyDefaults.pollingIntervalMinutes ?? 10);
  const [blueskyAutoSendToAgent, setBlueskyAutoSendToAgent] = useState(blueskyDefaults.autoSendToAgent ?? false);
  const [blueskyConnecting, setBlueskyConnecting] = useState(false);
  const [blueskyMessage, setBlueskyMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [blueskyAuthenticated, setBlueskyAuthenticated] = useState(false);
  const [blueskyHandle, setBlueskyHandle] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [visionModelDropdownOpen, setVisionModelDropdownOpen] = useState(false);
  const [voiceDropdownOpen, setVoiceDropdownOpen] = useState(false);
  const [backendDropdownOpen, setBackendDropdownOpen] = useState(false);
  const [boundaryTierDropdownOpen, setBoundaryTierDropdownOpen] = useState(false);
  const [extractionModelDropdownOpen, setExtractionModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const visionModelDropdownRef = useRef<HTMLDivElement>(null);
  const voiceDropdownRef = useRef<HTMLDivElement>(null);
  const backendDropdownRef = useRef<HTMLDivElement>(null);
  const boundaryTierDropdownRef = useRef<HTMLDivElement>(null);
  const extractionModelDropdownRef = useRef<HTMLDivElement>(null);
  const cdModelDropdownRef = useRef<HTMLDivElement>(null);

  useClickOutside(modelDropdownRef, () => setModelDropdownOpen(false), modelDropdownOpen);
  useClickOutside(visionModelDropdownRef, () => setVisionModelDropdownOpen(false), visionModelDropdownOpen);
  useClickOutside(voiceDropdownRef, () => setVoiceDropdownOpen(false), voiceDropdownOpen);
  useClickOutside(backendDropdownRef, () => setBackendDropdownOpen(false), backendDropdownOpen);
  useClickOutside(boundaryTierDropdownRef, () => setBoundaryTierDropdownOpen(false), boundaryTierDropdownOpen);
  useClickOutside(extractionModelDropdownRef, () => setExtractionModelDropdownOpen(false), extractionModelDropdownOpen);
  useClickOutside(cdModelDropdownRef, () => setCdModelDropdownOpen(false), cdModelDropdownOpen);

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

  // Fetch persona
  useEffect(() => {
    getPersona()
      .then((data) => {
        setPersona(data);
        setPersonaContent(data.content);
      })
      .catch(() => {});
  }, []);

  // Fetch user document
  useEffect(() => {
    getUserDocument()
      .then((data) => {
        setUserDoc(data);
        setUserDocContent(data?.content || "");
      })
      .catch(() => {});
  }, []);

  // Fetch TTS settings and voices
  useEffect(() => {
    setTtsLoading(true);
    setTtsError(null);
    Promise.all([getTTSSettings(), getTTSVoices(ttsSettings?.backend || "kokoro")])
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

  // Fetch voices when backend changes
  useEffect(() => {
    if (ttsSettings?.backend) {
      getTTSVoices(ttsSettings.backend)
        .then(setTtsVoices)
        .catch((err) => {
          console.error("[TTS] Failed to load voices:", err);
        });
      
      // Auto-switch voice if current voice is not valid for the new backend
      const validVoices = ttsVoices.flatMap(cat => cat.voices.map(v => v.id));
      if (ttsSettings.voice && !validVoices.includes(ttsSettings.voice)) {
        // Switch to first available voice for this backend
        const firstVoice = ttsVoices[0]?.voices[0]?.id;
        if (firstVoice) {
          updateTTSSettings({ voice: firstVoice }).then(setTtsSettings);
        }
      }
    }
  }, [ttsSettings?.backend]);

  // Fetch Bluesky status
  useEffect(() => {
    fetch("/api/bluesky/status", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setBlueskyAuthenticated(data.authenticated ?? false);
        setBlueskyHandle(data.currentHandle ?? null);
      })
      .catch(() => {});
  }, []);

  const handleSave = () => {
    const defaultPreset = presets.find((p) => p.isDefault);
    const effectivePrompt = defaultPreset ? defaultPreset.content.trim() : defaultSystemPrompt.trim();
    onSave({
      ...settings,
      defaultModelId,
      defaultVisionModelId: defaultVisionModelId || undefined,
      defaultSystemPrompt: effectivePrompt,
      braveApiKey: braveApiKey.trim(),
      comfyuiUrl: comfyuiUrl.trim() || undefined,
      theme,
      backgroundEffect,
      flatBackground,
      systemPromptPresets: presets.length > 0 ? presets : undefined,
      hapticsEnabled,
      modelContextWindows: Object.keys(modelContextWindows).length > 0 ? modelContextWindows : undefined,
      delayedExtractionEnabled,
      delayedExtractionThresholdMinutes: delayedExtractionThreshold,
      delayedExtractionMessageCap: delayedExtractionCap,
      enrichmentBatchSize,
      extractionModelId,
      extractionFallbackEnabled,
      creativeDirections: {
        enabled: cdEnabled,
        modelId: cdModelId || undefined,
        limit: cdLimit,
        minNovelty: cdMinNovelty,
        maxExecutions: cdMaxExecutions,
        maxReviewIterations: cdMaxReviewIterations,
        steps: cdSteps,
        cfgScale: cdCfgScale,
      },
      bluesky: {
        ...settings.bluesky,
        enabled: blueskyEnabled,
        username: blueskyAuthenticated ? blueskyUsername : undefined,
        pollingIntervalMinutes: blueskyPollingInterval,
        autoSendToAgent: blueskyAutoSendToAgent,
      },
    });
    
    // Emit TTS settings update event for useTTS hook
    if (ttsSettings) {
      window.dispatchEvent(new CustomEvent('tts-settings-updated', { detail: ttsSettings }));
      console.log("[SettingsModal] Emitted tts-settings-updated:", ttsSettings);
    }
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

  const handleTogglePresetExpand = (id: string) => {
    setExpandedPresetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
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

  const handleMemoryBrowserToggle = useCallback(async () => {
    const opening = !memoryBrowserOpen;
    setMemoryBrowserOpen(opening);
    if (opening && memoryResults.length === 0) {
      setMemoryLoading(true);
      try {
        const all = await fetchAllMemories(memorySortBy);
        setMemoryResults(all);
      } catch {}
      setMemoryLoading(false);
    }
  }, [memoryBrowserOpen, memoryResults.length, memorySortBy]);

  const handleMemorySortChange = useCallback((sort: string) => {
    setMemorySortBy(sort);
    setMemoryLoading(true);
    fetchAllMemories(sort)
      .then(setMemoryResults)
      .catch(() => {})
      .finally(() => setMemoryLoading(false));
  }, []);

  const handleMemorySearch = useCallback((query: string) => {
    setMemorySearchQuery(query);
    if (memorySearchTimer.current) clearTimeout(memorySearchTimer.current);
    if (!query.trim()) {
      // Empty query: show all
      setMemoryLoading(true);
      fetchAllMemories(memorySortBy)
        .then(setMemoryResults)
        .catch(() => {})
        .finally(() => setMemoryLoading(false));
      return;
    }
    memorySearchTimer.current = setTimeout(async () => {
      setMemoryLoading(true);
      try {
        const results = await searchMemories(query, 20);
        setMemoryResults(results);
      } catch {}
      setMemoryLoading(false);
    }, 300);
  }, [memorySortBy]);

  const handleDeleteMemory = useCallback(async (id: string) => {
    setMemoryDeleting(id);
    try {
      await deleteMemory(id);
      setMemoryResults((prev) => prev.filter((m) => m.id !== id));
      setMemoryStatus((prev) => prev ? { ...prev, memoryCount: prev.memoryCount - 1 } : prev);
    } catch {}
    setMemoryDeleting(null);
  }, []);

  const handleToggleLineage = useCallback(async (id: string) => {
    if (expandedLineage === id) {
      setExpandedLineage(null);
      return;
    }
    setExpandedLineage(id);
    if (!lineageData[id]) {
      setLineageLoading(id);
      try {
        const lineage = await fetchMemoryLineage(id);
        setLineageData((prev) => ({ ...prev, [id]: lineage }));
      } catch {
        setLineageData((prev) => ({ ...prev, [id]: { older: [], newer: [] } }));
      }
      setLineageLoading(null);
    }
  }, [expandedLineage, lineageData]);

  const handleBlueskyConnect = useCallback(async () => {
    if (!blueskyUsername || !blueskyAppPassword) {
      setBlueskyMessage({ type: "err", text: "Please enter both username and app password" });
      return;
    }
    setBlueskyConnecting(true);
    setBlueskyMessage(null);
    try {
      const res = await fetch("/api/bluesky/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: blueskyUsername, password: blueskyAppPassword }),
      });
      const data = await res.json();
      if (res.ok) {
        setBlueskyMessage({ type: "ok", text: `Connected as @${data.handle}` });
        setBlueskyAuthenticated(true);
        setBlueskyHandle(data.handle);
        setBlueskyAppPassword("");
        window.dispatchEvent(new Event('bluesky-updated'));
      } else {
        setBlueskyMessage({ type: "err", text: data.error || "Failed to connect" });
      }
    } catch (err: any) {
      setBlueskyMessage({ type: "err", text: err.message || "Failed to connect" });
    }
    setBlueskyConnecting(false);
  }, [blueskyUsername, blueskyAppPassword]);

  const handleBlueskyDisconnect = useCallback(async () => {
    try {
      await fetch("/api/bluesky/logout", { method: "POST" });
      setBlueskyAuthenticated(false);
      setBlueskyHandle(null);
      setBlueskyMessage({ type: "ok", text: "Disconnected from Bluesky" });
      window.dispatchEvent(new Event('bluesky-updated'));
    } catch (err: any) {
      setBlueskyMessage({ type: "err", text: err.message || "Failed to disconnect" });
    }
  }, []);

  const handleSavePersona = useCallback(async () => {
    setPersonaSaving(true);
    setPersonaMessage(null);
    try {
      const updated = await updatePersona(personaContent, "Manual edit via Settings");
      setPersona(updated);
      setPersonaMessage({ type: "ok", text: "Persona updated successfully" });
      setPersonaEditing(false);
    } catch (err: any) {
      setPersonaMessage({ type: "err", text: err.message || "Failed to save persona" });
    }
    setPersonaSaving(false);
  }, [personaContent]);

  const handleCancelPersonaEdit = useCallback(() => {
    setPersonaContent(persona?.content || "");
    setPersonaEditing(false);
    setPersonaMessage(null);
  }, [persona]);

  const handleSaveUserDoc = useCallback(async () => {
    setUserDocSaving(true);
    setUserDocMessage(null);
    try {
      const updated = await updateUserDocument(userDocContent);
      setUserDoc(updated);
      setUserDocMessage({ type: "ok", text: "User document saved" });
      setUserDocEditing(false);
    } catch (err: any) {
      setUserDocMessage({ type: "err", text: err.message || "Failed to save" });
    }
    setUserDocSaving(false);
  }, [userDocContent]);

  const handleCancelUserDocEdit = useCallback(() => {
    setUserDocContent(userDoc?.content || "");
    setUserDocEditing(false);
    setUserDocMessage(null);
  }, [userDoc]);

  const handleDeleteUserDoc = useCallback(async () => {
    setUserDocSaving(true);
    setUserDocMessage(null);
    try {
      await deleteUserDocument();
      setUserDoc(null);
      setUserDocContent("");
      setUserDocEditing(false);
      setUserDocMessage({ type: "ok", text: "User document deleted" });
    } catch (err: any) {
      setUserDocMessage({ type: "err", text: err.message || "Failed to delete" });
    }
    setUserDocSaving(false);
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
                    backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
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
                    backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
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
                { value: "default" as Theme, label: "Lapis", preview: "from-purple-900" },
                { value: "ocean" as Theme, label: "Ocean", preview: "from-sky-900" },
                { value: "forest" as Theme, label: "Forest", preview: "from-green-900" },
                { value: "crimson" as Theme, label: "Crimson", preview: "from-rose-900" },
                { value: "mono" as Theme, label: "Asphalt", preview: "from-gray-900" },
                { value: "strawberry" as Theme, label: "Strawberry", preview: "from-pink-700" },
                { value: "coffee" as Theme, label: "Coffee", preview: "from-amber-950" },
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

          {/* Flat Background */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-white/60">Flat Background</label>
                <p className="text-white/30 text-xs mt-0.5">
                  {flatBackground
                    ? "Solid background color without gradient."
                    : "Diagonal gradient background is active."}
                </p>
              </div>
              <button
                onClick={() => setFlatBackground(!flatBackground)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  flatBackground ? "bg-white/20" : "bg-white/10"
                }`}
              >
                <div
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white/80 transition-transform ${
                    flatBackground ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Background Effect */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Background Effect</label>
            <div className="flex gap-2">
              {[
                { value: "static" as BackgroundEffect, label: "Static", icon: "□" },
                { value: "ripple-grid" as BackgroundEffect, label: "Ripple Grid", icon: "〃" },
                { value: "scan-lines" as BackgroundEffect, label: "Scan Lines", icon: "≡" },
                { value: "ripple-dots" as BackgroundEffect, label: "Ripple Dots", icon: "∴" },
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
              {backgroundEffect === "ripple-grid"
                ? "Ripple Grid adds an animated reactive background pattern."
                : backgroundEffect === "scan-lines"
                ? "Scan Lines adds a CRT-style horizontal line texture."
                : backgroundEffect === "ripple-dots"
                ? "Ripple Dots adds an animated field of dots with wave distortion."
                : "Plain static background with gradient overlay."}
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

          {/* Agent Persona */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <button
              onClick={() => setPersonaExpanded(!personaExpanded)}
              className="flex items-center gap-1.5 text-sm font-medium text-white/60 hover:text-white/80 transition-colors w-full text-left"
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
                className={`transition-transform ${personaExpanded ? "rotate-90" : ""}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              Agent Persona
            </button>
            <p className="text-white/30 text-xs -mt-2">
              The agent's core identity, voice, and values. Loaded from <code className="text-white/40">~/.quje-agent/persona.md</code>.
            </p>

            {personaExpanded && (
              <div className="space-y-2 pl-1">
                {personaMessage && (
                  <p className={`text-xs ${personaMessage.type === "ok" ? "text-green-400/80" : "text-red-400/80"}`}>
                    {personaMessage.text}
                  </p>
                )}

                {personaEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={personaContent}
                      onChange={(e) => setPersonaContent(e.target.value)}
                      rows={12}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all font-mono"
                      placeholder="# Who I Am..."
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleSavePersona}
                        disabled={personaSaving}
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all disabled:opacity-40"
                        style={{
                          backgroundColor: `rgba(var(--theme-primary-muted), 0.15)`,
                          borderColor: `rgba(var(--theme-primary-border))`,
                          color: `rgba(var(--theme-primary-text))`,
                        }}
                      >
                        {personaSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={handleCancelPersonaEdit}
                        disabled={personaSaving}
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-medium border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/5 transition-all disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : persona ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white/50 truncate">
                        {persona.content.split("\n")[0]?.replace(/^#+\s*/, "") || "Persona document"}
                      </p>
                      <p className="text-[10px] text-white/30">
                        {persona.lastModified ? `Last modified: ${new Date(persona.lastModified).toLocaleDateString()}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setPersonaEditing(true);
                        setPersonaContent(persona.content);
                      }}
                      className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all shrink-0"
                    >
                      Edit
                    </button>
                  </div>
                ) : (
                  <p className="text-white/30 text-xs">Loading persona...</p>
                )}
              </div>
            )}
          </div>

          {/* User Document */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <button
              onClick={() => setUserDocExpanded(!userDocExpanded)}
              className="flex items-center gap-1.5 text-sm font-medium text-white/60 hover:text-white/80 transition-colors w-full text-left"
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
                className={`transition-transform ${userDocExpanded ? "rotate-90" : ""}`}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
              About You
            </button>
            <p className="text-white/30 text-xs -mt-2">
              Optional. Share your name, preferences, and context. Helps me understand you better.
            </p>

            {userDocExpanded && (
              <div className="space-y-2 pl-1">
                {userDocMessage && (
                  <p className={`text-xs ${userDocMessage.type === "ok" ? "text-green-400/80" : "text-red-400/80"}`}>
                    {userDocMessage.text}
                  </p>
                )}

                {userDocEditing ? (
                  <div className="space-y-2">
                    <textarea
                      value={userDocContent}
                      onChange={(e) => setUserDocContent(e.target.value)}
                      rows={10}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all font-mono"
                      placeholder="# About Me&#10;&#10;**Name:** &#10;&#10;**Preferences:** "
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={handleSaveUserDoc}
                        disabled={userDocSaving}
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all disabled:opacity-40"
                        style={{
                          backgroundColor: `rgba(16, 185, 129, 0.15)`,
                          borderColor: `rgba(16, 185, 129, 0.3)`,
                          color: `rgb(110, 231, 183)`,
                        }}
                      >
                        {userDocSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={handleCancelUserDocEdit}
                        disabled={userDocSaving}
                        className="flex-1 px-3 py-2 rounded-lg text-xs font-medium border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/5 transition-all disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    </div>
                    {userDoc && (
                      <button
                        onClick={handleDeleteUserDoc}
                        disabled={userDocSaving}
                        className="w-full px-3 py-2 rounded-lg text-xs font-medium border border-red-400/20 text-red-300/70 hover:bg-red-500/10 transition-all disabled:opacity-40"
                      >
                        Delete document
                      </button>
                    )}
                  </div>
                ) : userDoc ? (
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white/50 truncate">
                        {userDoc.content.split("\n")[0]?.replace(/^#+\s*/, "") || "User document"}
                      </p>
                      <p className="text-[10px] text-white/30">
                        {userDoc.lastModified ? `Last modified: ${new Date(userDoc.lastModified).toLocaleDateString()}` : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setUserDocEditing(true);
                        setUserDocContent(userDoc.content);
                      }}
                      className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all shrink-0"
                    >
                      Edit
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setUserDocEditing(true);
                      setUserDocContent("# About Me\n\n**Name:** \n\n**Communication style:** \n\n**Technical background:** \n\n**Preferences:** \n\n---\n\n*Feel free to share as much or as little as you want.*\n");
                    }}
                    className="text-xs px-3 py-2 rounded-lg border border-emerald-400/20 text-emerald-300/70 hover:bg-emerald-500/10 transition-all"
                  >
                    + Create document
                  </button>
                )}
              </div>
            )}
          </div>

          {/* System Prompt Presets */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium text-white/60">System Prompt Presets</label>
              <button
                onClick={handleAddPreset}
                className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all"
              >
                + Add Preset
              </button>
            </div>
            <p className="text-white/30 text-xs -mt-2">
              Mode-specific prompts that append to the base agent prompt.
            </p>

            {presets.length === 0 ? (
              <p className="text-white/30 text-xs italic">No presets configured. Add a preset to use mode-specific prompts.</p>
            ) : (
              <div className="space-y-2">
                {presets.map((preset) => {
                  const isExpanded = expandedPresetIds.has(preset.id);
                  return (
                    <div
                      key={preset.id}
                      className={`rounded-lg border transition-all ${
                        preset.isDefault
                          ? "border-white/15"
                          : "border-white/10 bg-white/[0.02]"
                      }`}
                      style={{
                        backgroundColor: preset.isDefault ? `rgba(var(--theme-primary-muted), 0.05)` : '',
                      }}
                    >
                      <div className="flex items-center gap-2 p-3">
                        <button
                          onClick={() => handleTogglePresetExpand(preset.id)}
                          className="text-white/40 hover:text-white/70 transition-colors p-0.5"
                          title={isExpanded ? "Collapse" : "Expand"}
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
                            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </button>
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
                      {isExpanded && (
                        <div className="px-3 pb-3">
                          <textarea
                            value={preset.content}
                            onChange={(e) => handleUpdatePreset(preset.id, { content: e.target.value })}
                            rows={4}
                            className="w-full bg-white/5 border border-white/10 rounded px-2 py-1.5 text-xs text-white/70 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-blue-400/30 transition-all"
                            placeholder="Mode-specific instructions (appended to base prompt)..."
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
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

                <div className="flex gap-2">
                  <button
                    onClick={handleRunSynthesis}
                    disabled={synthesisRunning || memoryStatus.memoryCount === 0}
                    className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{
                      backgroundColor: `rgba(var(--theme-primary-muted), 0.15)`,
                      borderColor: `rgba(var(--theme-primary-border))`,
                      color: `rgba(var(--theme-primary-text))`,
                    }}
                  >
                    {synthesisRunning ? "Running..." : "Run Synthesis"}
                  </button>
                  <button
                    onClick={handleMemoryBrowserToggle}
                    className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-all"
                    style={{
                      backgroundColor: memoryBrowserOpen
                        ? `rgba(var(--theme-secondary), 0.2)`
                        : `rgba(var(--theme-secondary), 0.1)`,
                      borderColor: `rgba(var(--theme-secondary), 0.3)`,
                      color: `rgba(var(--theme-secondary-text))`,
                    }}
                  >
                    {memoryBrowserOpen ? "Close Browser" : "Browse Memories"}
                  </button>
                </div>

                {/* Memory Browser */}
                {memoryBrowserOpen && (
                  <div className="space-y-2 pt-2">
                    {/* Search input */}
                    <div className="relative">
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
                        className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30"
                      >
                        <circle cx="11" cy="11" r="8" />
                        <path d="M21 21l-4.35-4.35" />
                      </svg>
                      <input
                        type="text"
                        value={memorySearchQuery}
                        onChange={(e) => handleMemorySearch(e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all"
                        placeholder="Search memories..."
                        autoFocus
                      />
                    </div>

                    {/* Category filter + sort controls */}
                    <div className="flex items-center justify-between gap-2">
                      {(() => {
                        const categories = [...new Set(memoryResults.map((m) => m.category))].sort();
                        if (categories.length <= 1) return <div />;
                        return (
                          <div className="flex gap-1 flex-wrap">
                            {["all", ...categories].map((cat) => (
                              <button
                                key={cat}
                                onClick={() => setMemoryCategoryFilter(cat)}
                                className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all ${
                                  memoryCategoryFilter === cat
                                    ? "bg-purple-500/30 text-purple-200 border border-purple-400/30"
                                    : "bg-white/5 text-white/40 border border-white/10 hover:bg-white/10"
                                }`}
                              >
                                {cat === "all" ? "All" : cat}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                      <select
                        value={memorySortBy}
                        onChange={(e) => handleMemorySortChange(e.target.value)}
                        className="bg-white/5 border border-white/10 rounded-lg px-2 py-0.5 text-[10px] text-white/60 outline-none focus:ring-1 focus:ring-purple-400/30 shrink-0"
                      >
                        <option value="created_at_desc">Newest</option>
                        <option value="created_at_asc">Oldest</option>
                        <option value="last_accessed_desc">Recently used</option>
                        <option value="importance_desc">Importance</option>
                      </select>
                    </div>

                    {/* Results */}
                    <div className="max-h-[280px] overflow-x-hidden overflow-y-auto space-y-1.5 pr-1">
                      {memoryLoading ? (
                        <p className="text-white/30 text-xs text-center py-4">Searching...</p>
                      ) : memoryResults.length === 0 ? (
                        <p className="text-white/30 text-xs text-center py-4">No memories found</p>
                      ) : (
                        memoryResults
                          .filter((m) => memoryCategoryFilter === "all" || m.category === memoryCategoryFilter)
                          .map((memory) => {
                            const isSuperseded = !!memory.supersededBy;
                            const hasLineage = !!(memory.supersededBy || memory.supersedes);
                            const lineage = lineageData[memory.id];
                            const isExpanded = expandedLineage === memory.id;

                            return (
                            <div
                              key={memory.id}
                              className={`group p-2.5 rounded-lg border transition-all ${
                                isSuperseded
                                  ? "bg-white/[0.02] border-white/[0.04] opacity-60"
                                  : "bg-white/[0.04] border-white/[0.06] hover:bg-white/[0.07]"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs text-white/70 leading-relaxed flex-1">
                                  {isSuperseded && (
                                    <span className="text-amber-400/70 text-[9px] font-medium mr-1.5" title="This memory has been superseded by a newer version">SUPERSEDED</span>
                                  )}
                                  {memory.text}
                                </p>
                                <button
                                  onClick={() => handleDeleteMemory(memory.id)}
                                  disabled={memoryDeleting === memory.id}
                                  className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-white/30 hover:text-red-400 transition-all disabled:opacity-50"
                                  title="Delete memory"
                                >
                                  {memoryDeleting === memory.id ? (
                                    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                                    </svg>
                                  ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                              <div className="flex items-center gap-2 mt-1.5">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                                  memory.category === "fact" ? "bg-blue-500/20 text-blue-300" :
                                  memory.category === "preference" ? "bg-purple-500/20 text-purple-300" :
                                  memory.category === "behavior" ? "bg-amber-500/20 text-amber-300" :
                                  memory.category === "context" ? "bg-cyan-500/20 text-cyan-300" :
                                  memory.category === "decision" ? "bg-rose-500/20 text-rose-300" :
                                  memory.category === "note" ? "bg-slate-500/20 text-slate-300" :
                                  memory.category === "reflection" ? "bg-indigo-500/20 text-indigo-300" :
                                  "bg-emerald-500/20 text-emerald-300"
                                }`}>
                                  {memory.category}
                                </span>
                                <span className="text-[9px] text-white/25">
                                  importance: {memory.importance}/10
                                </span>
                                {memory.score !== undefined && (
                                  <span className="text-[9px] text-white/25">
                                    relevance: {(memory.score * 100).toFixed(0)}%
                                  </span>
                                )}
                                {hasLineage && (
                                  <button
                                    onClick={() => handleToggleLineage(memory.id)}
                                    className="text-[9px] text-purple-400/60 hover:text-purple-300 transition-colors"
                                    title="View memory lineage"
                                  >
                                    {isExpanded ? "hide lineage" : "lineage"}
                                  </button>
                                )}
                                <span className="text-[9px] text-white/25 ml-auto">
                                  {new Date(memory.createdAt).toLocaleDateString()}
                                </span>
                              </div>

                              {/* Lineage panel */}
                              {isExpanded && (
                                <div className="mt-2 pt-2 border-t border-white/[0.06]">
                                  {lineageLoading === memory.id ? (
                                    <p className="text-[10px] text-white/30">Loading lineage...</p>
                                  ) : lineage && (lineage.older.length > 0 || lineage.newer.length > 0) ? (
                                    <div className="space-y-1">
                                      {lineage.newer.map((entry) => (
                                        <div key={entry.id} className="flex items-start gap-1.5 text-[10px]">
                                          <span className="text-green-400/60 shrink-0 mt-px" title="Newer version">&#x25B2;</span>
                                          <span className="text-white/50">{entry.text}</span>
                                          <span className="text-white/20 shrink-0 ml-auto">{new Date(entry.createdAt).toLocaleDateString()}</span>
                                        </div>
                                      ))}
                                      <div className="flex items-start gap-1.5 text-[10px]">
                                        <span className="text-purple-400/80 shrink-0 mt-px">&#x25CF;</span>
                                        <span className="text-white/70 font-medium">Current</span>
                                      </div>
                                      {lineage.older.map((entry) => (
                                        <div key={entry.id} className="flex items-start gap-1.5 text-[10px]">
                                          <span className="text-amber-400/60 shrink-0 mt-px" title="Older version">&#x25BC;</span>
                                          <span className="text-white/40">{entry.text}</span>
                                          <span className="text-white/20 shrink-0 ml-auto">{new Date(entry.createdAt).toLocaleDateString()}</span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-[10px] text-white/30">No lineage chain found</p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                          })
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-white/30 text-sm">Loading memory status...</p>
            )}
          </div>

          {/* Skills Section */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Skills</h3>
            <p className="text-white/30 text-xs">
              Download and manage skills that extend the agent's capabilities. Skills are stored as SKILL.md files with frontmatter metadata.
            </p>
            
            <div className="flex gap-2">
              <button
                onClick={() => setSkillsBrowserOpen(!skillsBrowserOpen)}
                className="flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-all"
                style={{
                  backgroundColor: skillsBrowserOpen
                    ? `rgba(var(--theme-secondary), 0.2)`
                    : `rgba(var(--theme-secondary), 0.1)`,
                  borderColor: `rgba(var(--theme-secondary-border))`,
                  color: `rgba(var(--theme-secondary-text))`,
                }}
              >
                {skillsBrowserOpen ? "Close Browser" : "Browse Skills"}
              </button>
            </div>

            {skillsBrowserOpen && <SkillsBrowser onClose={() => setSkillsBrowserOpen(false)} projectId={undefined} />}
          </div>

          {/* Delayed Extraction Settings */}
          <div className="border-t border-white/10 pt-6">
            <h3 className="text-sm font-semibold text-white/80 mb-4">Delayed Memory Extraction</h3>
            
            <div className="space-y-4">
              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-white/60">Enable delayed extraction</label>
                  <p className="text-xs text-white/30 mt-0.5">Extract memories from chats after inactivity</p>
                </div>
                <button
                  onClick={() => setDelayedExtractionEnabled(!delayedExtractionEnabled)}
                  className={`relative w-12 h-6 rounded-full transition-colors ${
                    delayedExtractionEnabled ? "bg-purple-500/30" : "bg-white/10"
                  }`}
                >
                  <div
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                      delayedExtractionEnabled ? "left-7" : "left-1"
                    }`}
                  />
                </button>
              </div>

              {/* Inactivity threshold slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-white/60">Inactivity threshold</label>
                  <span className="text-xs text-white/40">{delayedExtractionThreshold} minutes</span>
                </div>
                <input
                  type="range"
                  min={15}
                  max={60}
                  step={5}
                  value={delayedExtractionThreshold}
                  onChange={(e) => setDelayedExtractionThreshold(Number(e.target.value))}
                  disabled={!delayedExtractionEnabled}
                  className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer disabled:opacity-50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                />
                <p className="text-xs text-white/30">How long to wait after chat inactivity before extracting</p>
              </div>

              {/* Message cap slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-white/60">Message cap</label>
                  <span className="text-xs text-white/40">{delayedExtractionCap} messages</span>
                </div>
                <input
                  type="range"
                  min={20}
                  max={100}
                  step={5}
                  value={delayedExtractionCap}
                  onChange={(e) => setDelayedExtractionCap(Number(e.target.value))}
                  disabled={!delayedExtractionEnabled}
                  className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer disabled:opacity-50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                />
                <p className="text-xs text-white/30">Maximum messages to include in extraction context</p>
              </div>

              {/* Enrichment batch size */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-white/60">Enrichment batch size</label>
                  <span className="text-xs text-white/40">{enrichmentBatchSize} entries</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={20}
                  step={1}
                  value={enrichmentBatchSize}
                  onChange={(e) => setEnrichmentBatchSize(Number(e.target.value))}
                  className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                />
                <p className="text-xs text-white/30">How many unenriched images to process every 10 minutes</p>
              </div>

              {/* Extraction model configuration */}
              <div className="border-t border-white/5 pt-4 mt-4">
                <h4 className="text-xs font-medium text-white/60 uppercase tracking-wider mb-3">Extraction Model</h4>
                
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-white/70 mb-1.5">Model</label>
                    <div className="relative" ref={extractionModelDropdownRef}>
                      <button
                        onClick={() => setExtractionModelDropdownOpen((o) => !o)}
                        disabled={!delayedExtractionEnabled}
                        className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <span className="truncate flex-1 text-left">
                          {(() => {
                            const selected = models.find((m) => m.id === extractionModelId);
                            if (!selected) return extractionModelId;
                            return selected.parameterSize ? `${selected.name} (${selected.parameterSize})` : selected.name;
                          })()}
                        </span>
                        {chevronSvg(extractionModelDropdownOpen)}
                      </button>
                      {extractionModelDropdownOpen && (
                        <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                          style={{
                            backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
                            borderColor: `rgba(var(--theme-primary-border))`,
                          }}>
                          {models.map((model) => (
                            <button
                              key={model.id}
                              onClick={() => {
                                setExtractionModelId(model.id);
                                setExtractionModelDropdownOpen(false);
                              }}
                              disabled={!delayedExtractionEnabled}
                              className={`w-full text-left px-3 py-2 text-xs transition-all disabled:opacity-50 ${
                                model.id === extractionModelId
                                  ? "text-white"
                                  : "text-white/60 hover:bg-white/10 hover:text-white/80"
                              }`}
                              style={{
                                backgroundColor: model.id === extractionModelId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                                color: model.id === extractionModelId ? `rgba(var(--theme-secondary-text))` : '',
                              }}
                            >
                              {model.parameterSize ? `${model.name} (${model.parameterSize})` : model.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="text-xs text-white/40 mt-1.5">
                      Model used for memory extraction. Defaults to chat model if not set.
                    </p>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div>
                      <label className="block text-sm font-medium text-white/60">Fallback to available model</label>
                      <p className="text-xs text-white/30 mt-0.5">Use first available model if selected model is not loaded</p>
                    </div>
                    <button
                      onClick={() => setExtractionFallbackEnabled(!extractionFallbackEnabled)}
                      className={`relative w-12 h-6 rounded-full transition-colors ${
                        extractionFallbackEnabled ? "bg-purple-500/30" : "bg-white/10"
                      }`}
                      disabled={!delayedExtractionEnabled}
                    >
                      <div
                        className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                          extractionFallbackEnabled ? "left-7" : "left-1"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bluesky Section */}
          <div className="border-t border-white/10 pt-6">
            <h3 className="text-sm font-semibold text-white/80 mb-4">Bluesky</h3>
            
            {blueskyMessage && (
              <p className={`text-sm mb-3 ${blueskyMessage.type === "ok" ? "text-green-400/80" : "text-red-400/80"}`}>
                {blueskyMessage.text}
              </p>
            )}

            {blueskyAuthenticated ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10 border border-emerald-400/20">
                  <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-emerald-300 text-sm">Connected as @{blueskyHandle}</span>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Enable Bluesky integration</label>
                    <p className="text-xs text-white/30 mt-0.5">Poll for notifications and send to agent</p>
                  </div>
                  <button
                    onClick={() => setBlueskyEnabled(!blueskyEnabled)}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      blueskyEnabled ? "bg-emerald-500/30" : "bg-white/10"
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                        blueskyEnabled ? "left-7" : "left-1"
                      }`}
                    />
                  </button>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-white/60">Polling interval</label>
                    <span className="text-xs text-white/40">{blueskyPollingInterval} minutes</span>
                  </div>
                  <input
                    type="range"
                    min={5}
                    max={30}
                    step={5}
                    value={blueskyPollingInterval}
                    onChange={(e) => setBlueskyPollingInterval(Number(e.target.value))}
                    disabled={!blueskyEnabled}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer disabled:opacity-50 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-emerald-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                  />
                  <p className="text-xs text-white/30">How often to check for new notifications</p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Auto-send to agent</label>
                    <p className="text-xs text-white/30 mt-0.5">Automatically send notifications to Bluesky chat</p>
                  </div>
                  <button
                    onClick={() => setBlueskyAutoSendToAgent(!blueskyAutoSendToAgent)}
                    className={`relative w-12 h-6 rounded-full transition-colors ${
                      blueskyAutoSendToAgent ? "bg-emerald-500/30" : "bg-white/10"
                    }`}
                  >
                    <div
                      className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                        blueskyAutoSendToAgent ? "left-7" : "left-1"
                      }`}
                    />
                  </button>
                </div>

                <button
                  onClick={handleBlueskyDisconnect}
                  className="w-full px-3 py-2 rounded-lg text-sm font-medium bg-red-500/10 border border-red-400/15 text-red-300/80 hover:bg-red-500/20 transition-all flex items-center justify-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-white/40">
                  Connect your Bluesky account to receive notifications and interact with the platform.
                  You'll need to create an app password in your Bluesky settings.
                </p>
                
                <div className="space-y-2">
                  <label className="block text-sm text-white/50">Username (handle)</label>
                  <input
                    type="text"
                    value={blueskyUsername}
                    onChange={(e) => setBlueskyUsername(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
                    placeholder="user.bsky.social"
                    autoComplete="off"
                  />
                </div>

                <div className="space-y-2">
                  <label className="block text-sm text-white/50">App Password</label>
                  <input
                    type="password"
                    value={blueskyAppPassword}
                    onChange={(e) => setBlueskyAppPassword(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
                    placeholder="xxxx-xxxx-xxxx-xxxx"
                    autoComplete="off"
                  />
                  <p className="text-xs text-white/30">
                    Create one at{" "}
                    <a href="https://bsky.app/settings/app-passwords" target="_blank" rel="noopener noreferrer" className="text-emerald-400/60 hover:text-emerald-400/80">
                      bsky.app/settings/app-passwords
                    </a>
                  </p>
                </div>

                <button
                  onClick={handleBlueskyConnect}
                  disabled={blueskyConnecting}
                  className="w-full px-3 py-2 rounded-lg text-sm font-medium border transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  style={{
                    backgroundColor: `rgba(var(--theme-secondary), 0.15)`,
                    borderColor: `rgba(var(--theme-secondary-border))`,
                    color: `rgba(var(--theme-secondary-text))`,
                  }}
                >
                  {blueskyConnecting ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
                      </svg>
                      Connecting...
                    </>
                  ) : (
                    <>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
                        <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
                      </svg>
                      Connect to Bluesky
                    </>
                  )}
                </button>
              </div>
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
                {/* Backend selector */}
                <div className="space-y-1">
                  <label className="block text-sm text-white/50">TTS Backend</label>
                  <div className="relative">
                    <button
                      onClick={() => setBackendDropdownOpen((o) => !o)}
                      className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
                    >
                      <span className="truncate flex-1 text-left">
                        {ttsSettings.backend === "kokoro" ? "Kokoro (Standard)" : "Qwen3-TTS (Streaming)"}
                      </span>
                      {chevronSvg(backendDropdownOpen)}
                    </button>
                    {backendDropdownOpen && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                        style={{
                          backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
                          borderColor: `rgba(var(--theme-primary-border))`,
                        }}>
                        <button
                          onClick={async () => {
                            const updated = await updateTTSSettings({ backend: "kokoro", voice: "af_heart" });
                            if (updated) setTtsSettings(updated);
                            setBackendDropdownOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-xs transition-all ${
                            ttsSettings.backend === "kokoro" ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                          }`}
                          style={{
                            backgroundColor: ttsSettings.backend === "kokoro" ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                            color: ttsSettings.backend === "kokoro" ? `rgba(var(--theme-secondary-text))` : '',
                          }}
                        >
                          Kokoro (Standard)
                        </button>
                        <button
                          onClick={async () => {
                            const updated = await updateTTSSettings({ backend: "qwen3-tts", voice: "Ryan" });
                            if (updated) setTtsSettings(updated);
                            setBackendDropdownOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-xs transition-all ${
                            ttsSettings.backend === "qwen3-tts" ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                          }`}
                          style={{
                            backgroundColor: ttsSettings.backend === "qwen3-tts" ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                            color: ttsSettings.backend === "qwen3-tts" ? `rgba(var(--theme-secondary-text))` : '',
                          }}
                        >
                          Qwen3-TTS (Streaming)
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="text-white/30 text-xs">
                    {ttsSettings.backend === "kokoro" 
                      ? "Lightweight (~100MB), mature ecosystem"
                      : "Advanced model with streaming support (~2GB)"}
                  </p>
                </div>

                {/* Streaming toggle (Qwen3-TTS only) */}
                {ttsSettings.backend === "qwen3-tts" && (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <label className="block text-sm font-medium text-white/60">Streaming Mode</label>
                        <p className="text-xs text-white/30 mt-0.5">Speak while generating (lower latency)</p>
                      </div>
                      <button
                        onClick={async () => {
                          const updated = await updateTTSSettings({ streamingEnabled: !ttsSettings.streamingEnabled });
                          if (updated) setTtsSettings(updated);
                        }}
                        className={`relative w-12 h-6 rounded-full transition-colors ${
                          ttsSettings.streamingEnabled ? "bg-purple-500/30" : "bg-white/10"
                        }`}
                      >
                        <div
                          className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 transition-transform ${
                            ttsSettings.streamingEnabled ? "left-7" : "left-1"
                          }`}
                        />
                      </button>
                    </div>

                    {/* Streaming chunk size */}
                    <div className="space-y-1">
                      <label className="block text-sm text-white/50">Chunk Size: {ttsSettings.streamingChunkSize} tokens</label>
                      <input
                        type="range"
                        min="30"
                        max="80"
                        step="5"
                        value={ttsSettings.streamingChunkSize}
                        onChange={async (e) => {
                          const updated = await updateTTSSettings({ streamingChunkSize: parseInt(e.target.value, 10) });
                          if (updated) setTtsSettings(updated);
                        }}
                        className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-purple-400"
                      />
                      <div className="flex justify-between text-xs text-white/30">
                        <span>30 (low latency)</span>
                        <span>80 (smoother)</span>
                      </div>
                    </div>

                    {/* Boundary tier */}
                    <div className="space-y-1">
                      <label className="block text-sm text-white/50">Boundary Detection</label>
                      <div className="relative" ref={boundaryTierDropdownRef}>
                        <button
                          onClick={() => setBoundaryTierDropdownOpen((o) => !o)}
                          className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
                        >
                          <span className="truncate flex-1 text-left">
                            {ttsSettings.streamingBoundaryTier === "clause" 
                              ? "Clause (faster, ~1ms)" 
                              : "Sentence (better prosody, ~5ms)"}
                          </span>
                          {chevronSvg(boundaryTierDropdownOpen)}
                        </button>
                        {boundaryTierDropdownOpen && (
                          <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                            style={{
                              backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
                              borderColor: `rgba(var(--theme-primary-border))`,
                            }}>
                            <button
                              onClick={async () => {
                                const updated = await updateTTSSettings({ streamingBoundaryTier: "clause" });
                                if (updated) setTtsSettings(updated);
                                setBoundaryTierDropdownOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2 text-xs transition-all ${
                                ttsSettings.streamingBoundaryTier === "clause" ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                              }`}
                              style={{
                                backgroundColor: ttsSettings.streamingBoundaryTier === "clause" ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                                color: ttsSettings.streamingBoundaryTier === "clause" ? `rgba(var(--theme-secondary-text))` : '',
                              }}
                            >
                              Clause (faster, ~1ms)
                            </button>
                            <button
                              onClick={async () => {
                                const updated = await updateTTSSettings({ streamingBoundaryTier: "sentence" });
                                if (updated) setTtsSettings(updated);
                                setBoundaryTierDropdownOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2 text-xs transition-all ${
                                ttsSettings.streamingBoundaryTier === "sentence" ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                              }`}
                              style={{
                                backgroundColor: ttsSettings.streamingBoundaryTier === "sentence" ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                                color: ttsSettings.streamingBoundaryTier === "sentence" ? `rgba(var(--theme-secondary-text))` : '',
                              }}
                            >
                              Sentence (better prosody, ~5ms)
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}

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
                          backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
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

          {/* Creative Directions Section */}
          <div className="space-y-3 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-white/70">Creative Directions</h3>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={cdEnabled}
                  onChange={(e) => setCdEnabled(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white/60 after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-500/40" />
              </label>
            </div>
            <p className="text-white/30 text-xs">
              Autonomous creative direction generation and image creation during daily synthesis.
            </p>

            {cdEnabled && (
              <div className="space-y-3 pl-1">
                {/* Direction Model */}
                <div>
                  <label className="block text-sm text-white/50 mb-1">Direction Model</label>
                  <div className="relative" ref={cdModelDropdownRef}>
                    <button
                      onClick={() => setCdModelDropdownOpen((o) => !o)}
                      className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
                    >
                      <span className="truncate flex-1 text-left">
                        {(() => {
                          const selected = models.find((m) => m.id === cdModelId);
                          if (!selected) return cdModelId || "Default (qwen3.5:9b)";
                          return selected.parameterSize ? `${selected.name} (${selected.parameterSize})` : selected.name;
                        })()}
                      </span>
                      {chevronSvg(cdModelDropdownOpen)}
                    </button>
                    {cdModelDropdownOpen && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-[280px] overflow-y-auto backdrop-blur-xl border rounded-xl shadow-2xl py-1"
                        style={{
                          backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
                          borderColor: `rgba(var(--theme-primary-border))`,
                        }}>
                        {models.map((model) => (
                          <button
                            key={model.id}
                            onClick={() => {
                              setCdModelId(model.id);
                              setCdModelDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs transition-all ${
                              model.id === cdModelId
                                ? "text-white"
                                : "text-white/60 hover:bg-white/10 hover:text-white/80"
                            }`}
                            style={{
                              backgroundColor: model.id === cdModelId ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                              color: model.id === cdModelId ? `rgba(var(--theme-secondary-text))` : '',
                            }}
                          >
                            {model.parameterSize ? `${model.name} (${model.parameterSize})` : model.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-white/25 text-xs mt-0.5">Ollama model used to generate direction prompts</p>
                </div>

                {/* Min Novelty */}
                <div>
                  <label className="block text-sm text-white/50">Min Novelty: {cdMinNovelty.toFixed(2)}</label>
                  <input
                    type="range"
                    min="0"
                    max="0.5"
                    step="0.01"
                    value={cdMinNovelty}
                    onChange={(e) => setCdMinNovelty(parseFloat(e.target.value))}
                    className="w-full accent-purple-400"
                  />
                  <div className="flex justify-between text-[10px] text-white/25">
                    <span>0 (all)</span>
                    <span>0.5 (strict)</span>
                  </div>
                </div>

                {/* Direction Limit */}
                <div>
                  <label className="block text-sm text-white/50">Directions per cycle: {cdLimit}</label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    step="1"
                    value={cdLimit}
                    onChange={(e) => setCdLimit(parseInt(e.target.value))}
                    className="w-full accent-purple-400"
                  />
                  <div className="flex justify-between text-[10px] text-white/25">
                    <span>1</span>
                    <span>10</span>
                  </div>
                </div>

                {/* Max Executions */}
                <div>
                  <label className="block text-sm text-white/50">Max auto-generated images: {cdMaxExecutions}</label>
                  <input
                    type="range"
                    min="0"
                    max="10"
                    step="1"
                    value={cdMaxExecutions}
                    onChange={(e) => setCdMaxExecutions(parseInt(e.target.value))}
                    className="w-full accent-purple-400"
                  />
                  <div className="flex justify-between text-[10px] text-white/25">
                    <span>0 (none)</span>
                    <span>10</span>
                  </div>
                </div>

                {/* Max Review Iterations */}
                <div>
                  <label className="block text-sm text-white/50">Review iterations per image: {cdMaxReviewIterations}</label>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    step="1"
                    value={cdMaxReviewIterations}
                    onChange={(e) => setCdMaxReviewIterations(parseInt(e.target.value))}
                    className="w-full accent-purple-400"
                  />
                  <div className="flex justify-between text-[10px] text-white/25">
                    <span>1 (fast)</span>
                    <span>5 (thorough)</span>
                  </div>
                  <p className="text-xs text-white/40 mt-1">
                    Higher values allow more refinement but use more GPU time per image.
                  </p>
                </div>

                {/* Generation params */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm text-white/50">Steps: {cdSteps}</label>
                    <input
                      type="range"
                      min="10"
                      max="60"
                      step="5"
                      value={cdSteps}
                      onChange={(e) => setCdSteps(parseInt(e.target.value))}
                      className="w-full accent-purple-400"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-white/50">CFG: {cdCfgScale.toFixed(1)}</label>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      step="0.5"
                      value={cdCfgScale}
                      onChange={(e) => setCdCfgScale(parseFloat(e.target.value))}
                      className="w-full accent-purple-400"
                    />
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
