import { useState, useEffect, useCallback, useRef } from "react";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}
// @simplewebauthn/browser is dynamically imported in handleAddPasskey
import { fetchRegisterOptions, verifyRegistration } from "../api/auth";
import { getLlamaPath, updateLlamaPathApi, validateLlamaPathApi, listEmbeddingBackups, createEmbeddingBackup, deleteEmbeddingBackup, restoreEmbeddingBackup, runEmbeddingMigration, discoverModels, getAllServerHealth, getLlamaServers, controlLlamaServer, getLlamaServerLogs, updateLlamaServerSettings } from "../api/client";
import type { EmbeddingBackup, MigrationProgressEvent, DiscoveredModel, ServerHealthMap, LlamaServerAction, LlamaServerId, LlamaServerStatus } from "../api/client";
import { getPersona, updatePersona, getPersonaHistory, getPersonaVersion } from "../api/persona";
import { getUserDocument, updateUserDocument, deleteUserDocument } from "../api/user";
import type { OllamaModel, Settings, SystemPromptPreset, Theme, TTSSettings, BackgroundEffect, CornerShape, CornerRadius, ActivityShape, BlueskySettings, PersonaStore, UserDocument, LlamaPathInfo, LlamaPathUpdateResult } from "../types";
import { getTTSVoices, getTTSSettings, updateTTSSettings } from "../api/tts";
import { SkillsBrowser } from "./SkillsBrowser";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { ProviderIcon } from "./ProviderIcon";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { sendPushTest } from "../api/push";

// Reusable toggle switch with spring animation
const ACCENT_COLORS: Record<string, { on: string; off: string }> = {
  purple:  { on: "bg-purple-500/30", off: "bg-white/10" },
  blue:    { on: "bg-blue-500/30",   off: "bg-white/10" },
  emerald: { on: "bg-emerald-500/30", off: "bg-white/10" },
  violet:  { on: "bg-violet-500/30", off: "bg-white/10" },
};

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  accentColor: "purple" | "blue" | "emerald" | "violet";
  disabled?: boolean;
}

function ToggleSwitch({ checked, onChange, accentColor, disabled }: ToggleSwitchProps) {
  const colors = ACCENT_COLORS[accentColor];
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`group relative shrink-0 w-12 h-6 rounded-full
        transition-[background-color] ease-[cubic-bezier(0.4,0,0.2,1)] duration-200
        ${checked ? colors.on : colors.off}
        ${disabled ? "opacity-40 cursor-not-allowed pointer-events-none" : "cursor-pointer"}`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-1 w-4 h-4 rounded-full bg-white/80 
          transition-[left,transform] duration-200 
          ease-[cubic-bezier(0.34,1.56,0.64,1)]
          ${checked ? "left-7" : "left-1"} 
          group-active:scale-90`}
      />
    </button>
  );
}

// Dropdown panel — owns the visual chrome (backdrop, border, shadow) and the
// slide-down reveal animation. Callers pass positioning/sizing classes via
// `className` (e.g. "left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto").
export function DropdownPanel({ open, className = "", children }: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      className={`absolute z-30 backdrop-blur-xl border rounded-xl shadow-2xl py-1 animate-dropdown-enter ${className}`}
      style={{
        backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
        borderColor: `rgba(var(--theme-primary-border))`,
      }}
    >
      {children}
    </div>
  );
}

const SECTIONS = [
  { id: 'models', label: 'Models' },
  { id: 'inference', label: 'Inference Servers' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'vision', label: 'Vision' },
  { id: 'context', label: 'Context' },
  { id: 'theme', label: 'Appearance' },
  { id: 'background', label: 'Background' },
  { id: 'haptics', label: 'Haptics' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'persona', label: 'Persona' },
  { id: 'user-doc', label: 'About You' },
  { id: 'presets', label: 'Presets' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'images', label: 'Images' },
  { id: 'skills', label: 'Skills' },
  { id: 'extraction', label: 'Extraction' },
  { id: 'tools', label: 'Tool Options' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'tts', label: 'TTS' },
  { id: 'passkeys', label: 'Security' },
] as const;

function useActiveSection(sectionIds: readonly string[], root: Element | null) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { root, rootMargin: '0px 0px -70% 0px' }
    );

    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [sectionIds, root]);

  return activeId;
}

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

type WebSearchProvider = NonNullable<Settings["defaultWebSearchProvider"]>;

const WEB_SEARCH_PROVIDER_OPTIONS: Array<{ id: WebSearchProvider; label: string; description: string }> = [
  { id: "brave", label: "Brave Search", description: "Fast snippets from Brave Search API." },
  { id: "exa", label: "Exa", description: "Richer search with highlights, summaries, and deep modes." },
  { id: "tavily", label: "Tavily", description: "Ranked web results with optional answers and date filters." },
];

function coerceWebSearchProvider(provider: Settings["defaultWebSearchProvider"]): WebSearchProvider {
  return WEB_SEARCH_PROVIDER_OPTIONS.some((option) => option.id === provider) ? provider! : "brave";
}

function llamaSystemdTone(status: LlamaServerStatus["systemd"]["activeState"]): string {
  if (status === "active") return "bg-green-500/15 text-green-300 border-green-400/25";
  if (status === "activating" || status === "deactivating") return "bg-amber-500/15 text-amber-300 border-amber-400/25";
  if (status === "failed") return "bg-red-500/15 text-red-300 border-red-400/25";
  return "bg-white/5 text-white/45 border-white/10";
}

function llamaHealthTone(status: LlamaServerStatus["http"]["status"]): string {
  if (status === "ok") return "bg-green-500/15 text-green-300 border-green-400/25";
  if (status === "unavailable") return "bg-red-500/15 text-red-300 border-red-400/25";
  return "bg-white/5 text-white/45 border-white/10";
}

function formatSystemdTimestamp(value: string): string {
  if (!value || value === "n/a") return "n/a";
  return value.replace(/\s+UTC$/, "");
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
  const [personaEditing, setPersonaEditing] = useState(false);
  const [personaContent, setPersonaContent] = useState("");
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaMessage, setPersonaMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [userDoc, setUserDoc] = useState<UserDocument | null>(null);
  const [userDocEditing, setUserDocEditing] = useState(false);
  const [userDocContent, setUserDocContent] = useState("");
  const [userDocSaving, setUserDocSaving] = useState(false);
  const [userDocMessage, setUserDocMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [braveApiKey, setBraveApiKey] = useState(settings.braveApiKey || "");
  const [exaApiKey, setExaApiKey] = useState(settings.exaApiKey || "");
  const [tavilyApiKey, setTavilyApiKey] = useState(settings.tavilyApiKey || "");
  const [defaultWebSearchProvider, setDefaultWebSearchProvider] = useState<WebSearchProvider>(coerceWebSearchProvider(settings.defaultWebSearchProvider));
  const [comfyuiUrl, setComfyuiUrl] = useState(settings.comfyuiUrl || "http://127.0.0.1:8188");
  const [comfyuiStatus, setComfyuiStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  const [imageBackend, setImageBackend] = useState<"comfyui" | "sdcpp">(settings.imageBackend ?? "comfyui");
  const [sdcppUrl, setSdcppUrl] = useState(settings.sdcppUrl || "http://127.0.0.1:1234");
  const [sdcppStatus, setSdcppStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  // Ollama server settings
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollamaUrl || "http://localhost:11434");
  // llama.cpp server settings
  const [llamacppEnabled, setLlamacppEnabled] = useState(settings.llamacppEnabled ?? false);
  const [llamacppUrl, setLlamacppUrl] = useState(settings.llamacppUrl || "http://localhost:8080");
  const [llamacppSharesGpu, setLlamacppSharesGpu] = useState(settings.llamacppSharesGpu ?? true);
  const [llamacppStatus, setLlamacppStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  // Extraction server settings
  const [extractionCtxSize, setExtractionCtxSize] = useState(settings.extractionCtxSize ?? 16384);
  // Reranker server settings
  const [rerankerEnabled, setRerankerEnabled] = useState(settings.rerankerEnabled ?? true);
  const [rerankerUrl, setRerankerUrl] = useState(settings.rerankerUrl || "http://localhost:8082");
  const [rerankerModelId, setRerankerModelId] = useState(settings.rerankerModelId || "qwen3-reranker");
  const [rerankerStatus, setRerankerStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  const [rerankerModels, setRerankerModels] = useState<DiscoveredModel[]>([]);
  const [rerankerModelsLoading, setRerankerModelsLoading] = useState(false);
  const [rerankerUseCustom, setRerankerUseCustom] = useState(false);
  // Title generation server settings
  const [titleGenerationEnabled, setTitleGenerationEnabled] = useState(settings.titleGenerationEnabled !== false);
  const [titleGenerationUrl, setTitleGenerationUrl] = useState(settings.titleGenerationUrl || "http://localhost:8085");
  const [titleGenerationModelId, setTitleGenerationModelId] = useState(settings.titleGenerationModelId || "qwen3.5-0.8b");
  const [titleGenerationModels, setTitleGenerationModels] = useState<DiscoveredModel[]>([]);
  const [titleGenerationModelsLoading, setTitleGenerationModelsLoading] = useState(false);
  const [titleGenerationUseCustom, setTitleGenerationUseCustom] = useState(false);
  // Embedding server settings
  const savedEmbeddingProvider: "ollama" | "llamacpp" = settings.embeddingProvider ?? "ollama";
  const savedEmbeddingUrl =
    settings.embeddingUrl ||
    (savedEmbeddingProvider === "llamacpp" ? "http://localhost:8084" : "http://localhost:11434");
  const savedEmbeddingModel = settings.embeddingModel || "qwen3-embedding:0.6b";
  const [embeddingProvider, setEmbeddingProvider] = useState<"ollama" | "llamacpp">(savedEmbeddingProvider);
  const [embeddingUrl, setEmbeddingUrl] = useState(savedEmbeddingUrl);
  const [embeddingModel, setEmbeddingModel] = useState(savedEmbeddingModel);
  const [embeddingModels, setEmbeddingModels] = useState<DiscoveredModel[]>([]);
  const [embeddingModelsLoading, setEmbeddingModelsLoading] = useState(false);
  const [embeddingUseCustom, setEmbeddingUseCustom] = useState(false);
  const storedEmbeddingDimension = settings.embeddingDimension;
  const embeddingConfigChanged =
    embeddingProvider !== savedEmbeddingProvider ||
    embeddingUrl.trim() !== savedEmbeddingUrl.trim() ||
    embeddingModel.trim() !== savedEmbeddingModel.trim();
  // Embedding migration state
  const [backups, setBackups] = useState<EmbeddingBackup[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backupMessage, setBackupMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [backupLabel, setBackupLabel] = useState("");
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgressEvent | null>(null);
  const [migrationRunning, setMigrationRunning] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] = useState<{ memories: number; corpus: number; dimension: number } | null>(null);
  const [confirmMigrate, setConfirmMigrate] = useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const migrationAbortRef = useRef<null | (() => void)>(null);
  // Llama.cpp binary path management
  const [llamaPathInfo, setLlamaPathInfo] = useState<LlamaPathInfo | null>(null);
  // Aggregate HTTP-ping health for all five configured servers
  const [serverHealth, setServerHealth] = useState<ServerHealthMap | null>(null);
  const [llamaPathInput, setLlamaPathInput] = useState("");
  const [llamaPathValidation, setLlamaPathValidation] = useState<{ valid: boolean; error?: string } | null>(null);
  const [llamaPathValidating, setLlamaPathValidating] = useState(false);
  const [llamaPathUpdating, setLlamaPathUpdating] = useState(false);
  const [llamaPathMessage, setLlamaPathMessage] = useState<{ type: "ok" | "err" | "warn"; text: string } | null>(null);
  const [llamaPathUpdateResult, setLlamaPathUpdateResult] = useState<LlamaPathUpdateResult | null>(null);
  const [llamaServers, setLlamaServers] = useState<LlamaServerStatus[]>([]);
  const [llamaServersLoading, setLlamaServersLoading] = useState(false);
  const [llamaServerActionInFlight, setLlamaServerActionInFlight] = useState<string | null>(null);
  const [llamaServerMessage, setLlamaServerMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [expandedLlamaServerId, setExpandedLlamaServerId] = useState<LlamaServerId | null>(null);
  const [llamaServerLogs, setLlamaServerLogs] = useState<{
    id: LlamaServerId;
    unitName: string;
    logs: string;
    loading: boolean;
    error?: string;
  } | null>(null);
  const [favoriteModels, setFavoriteModels] = useState<Set<string>>(new Set(settings.favoriteModels || []));
  const [showOnlyFavorites, setShowOnlyFavorites] = useState(settings.showOnlyFavorites ?? false);
  const [theme, setTheme] = useState<Theme>(settings.theme || "default");
  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>(settings.backgroundEffect || "static");
  const [flatBackground, setFlatBackground] = useState(settings.flatBackground ?? false);
  const [chromaticAberration, setChromaticAberration] = useState(settings.chromaticAberration ?? true);
  const [mouseWarp, setMouseWarp] = useState(settings.mouseWarp ?? true);
  const [cornerShape, setCornerShape] = useState<CornerShape>(settings.cornerShape || "round");
  const [cornerRadius, setCornerRadius] = useState<CornerRadius>(settings.cornerRadius || "default");
  const [activityShape, setActivityShape] = useState<ActivityShape>(settings.activityShape || "octahedron");
  const [activityHue, setActivityHue] = useState<number>(settings.activityHue ?? 38);
  const [presets, setPresets] = useState<SystemPromptPreset[]>(settings.systemPromptPresets || []);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetContent, setEditingPresetContent] = useState<string>("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetMessage, setPresetMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [hapticsEnabled, setHapticsEnabled] = useState(settings.hapticsEnabled ?? true);
  const push = usePushNotifications();
  const [pushTestState, setPushTestState] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [modelContextWindows, setModelContextWindows] = useState<Record<string, number>>(settings.modelContextWindows || {});
  const [modelPreserveThinking, setModelPreserveThinking] = useState<Record<string, boolean>>(settings.modelPreserveThinking || {});
  const [ctxWindowsExpanded, setCtxWindowsExpanded] = useState(false);
  const [skillsBrowserOpen, setSkillsBrowserOpen] = useState(false);
  // Delayed extraction settings
  const [delayedExtractionEnabled, setDelayedExtractionEnabled] = useState(settings.delayedExtractionEnabled ?? true);
  const [delayedExtractionThreshold, setDelayedExtractionThreshold] = useState(settings.delayedExtractionThresholdMinutes ?? 30);
  const [delayedExtractionCap, setDelayedExtractionCap] = useState(settings.delayedExtractionMessageCap ?? 50);
  const [enrichmentBatchSize, setEnrichmentBatchSize] = useState(settings.enrichmentBatchSize ?? 5);
  // Sleep cycle & wake cycle settings
  const [sleepCycleThreshold, setSleepCycleThreshold] = useState(settings.sleepCycleThresholdMinutes ?? 60);
  const [wakeCycleEnabled, setWakeCycleEnabled] = useState(settings.wakeCycleEnabled ?? false);
  const [wakeCycleInterval, setWakeCycleInterval] = useState(settings.wakeCycleIntervalHours ?? 6);
  const [extractionModelId, setExtractionModelId] = useState(settings.extractionModelId || settings.defaultModelId);
  const [extractionModelUrl, setExtractionModelUrl] = useState(settings.extractionModelUrl || "");
  const [extractionModelStatus, setExtractionModelStatus] = useState<"checking" | "connected" | "unavailable" | null>(null);
  const [extractionServerModels, setExtractionServerModels] = useState<DiscoveredModel[]>([]);
  const [extractionServerModelsLoading, setExtractionServerModelsLoading] = useState(false);
  const [extractionUseCustom, setExtractionUseCustom] = useState(false);
  const [extractionFallbackEnabled, setExtractionFallbackEnabled] = useState(settings.extractionFallbackEnabled ?? true);
  // Tool options — read_file truncation
  const [readFileDefaultLines, setReadFileDefaultLines] = useState(settings.readFileDefaultLines ?? 1000);
  const [readFileMaxBytes, setReadFileMaxBytes] = useState(settings.readFileMaxBytes ?? 256 * 1024);
  const [passkeyAdding, setPasskeyAdding] = useState(false);
  const [passkeyMessage, setPasskeyMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [ttsSettings, setTtsSettings] = useState<TTSSettings | null>(null);
  const [ttsVoices, setTtsVoices] = useState<Array<{ label: string; voices: Array<{ id: string; name: string }> }>>([]);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  // Bluesky settings
  const blueskyDefaults = settings.bluesky ?? ({} as Partial<BlueskySettings>);
  const [blueskyEnabled, setBlueskyEnabled] = useState(blueskyDefaults.enabled ?? false);
  const [blueskyUsername, setBlueskyUsername] = useState(blueskyDefaults.username ?? "");
  const [blueskyAppPassword, setBlueskyAppPassword] = useState("");
  const [blueskyPollingInterval, setBlueskyPollingInterval] = useState(blueskyDefaults.pollingIntervalMinutes ?? 10);
  const [blueskyAutoSendToAgent, setBlueskyAutoSendToAgent] = useState(blueskyDefaults.autoSendToAgent ?? false);
  const [blueskyAutoRespond, setBlueskyAutoRespond] = useState(blueskyDefaults.autoRespondToNotifications ?? false);
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
  const [embeddingModelDropdownOpen, setEmbeddingModelDropdownOpen] = useState(false);
  const [rerankerModelDropdownOpen, setRerankerModelDropdownOpen] = useState(false);
  const [titleGenerationModelDropdownOpen, setTitleGenerationModelDropdownOpen] = useState(false);
  const [favoritesDropdownOpen, setFavoritesDropdownOpen] = useState(false);
  const [imageBackendDropdownOpen, setImageBackendDropdownOpen] = useState(false);
  const [webSearchProviderDropdownOpen, setWebSearchProviderDropdownOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const tocRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const visionModelDropdownRef = useRef<HTMLDivElement>(null);
  const voiceDropdownRef = useRef<HTMLDivElement>(null);
  const backendDropdownRef = useRef<HTMLDivElement>(null);
  const boundaryTierDropdownRef = useRef<HTMLDivElement>(null);
  const extractionModelDropdownRef = useRef<HTMLDivElement>(null);
  const embeddingModelDropdownRef = useRef<HTMLDivElement>(null);
  const rerankerModelDropdownRef = useRef<HTMLDivElement>(null);
  const titleGenerationModelDropdownRef = useRef<HTMLDivElement>(null);
  const favoritesDropdownRef = useRef<HTMLDivElement>(null);
  const imageBackendDropdownRef = useRef<HTMLDivElement>(null);
  const webSearchProviderDropdownRef = useRef<HTMLDivElement>(null);


  useClickOutside(modelDropdownRef, () => setModelDropdownOpen(false), modelDropdownOpen);
  useClickOutside(visionModelDropdownRef, () => setVisionModelDropdownOpen(false), visionModelDropdownOpen);
  useClickOutside(voiceDropdownRef, () => setVoiceDropdownOpen(false), voiceDropdownOpen);
  useClickOutside(backendDropdownRef, () => setBackendDropdownOpen(false), backendDropdownOpen);
  useClickOutside(boundaryTierDropdownRef, () => setBoundaryTierDropdownOpen(false), boundaryTierDropdownOpen);
  useClickOutside(extractionModelDropdownRef, () => setExtractionModelDropdownOpen(false), extractionModelDropdownOpen);
  useClickOutside(embeddingModelDropdownRef, () => setEmbeddingModelDropdownOpen(false), embeddingModelDropdownOpen);
  useClickOutside(rerankerModelDropdownRef, () => setRerankerModelDropdownOpen(false), rerankerModelDropdownOpen);
  useClickOutside(titleGenerationModelDropdownRef, () => setTitleGenerationModelDropdownOpen(false), titleGenerationModelDropdownOpen);
  useClickOutside(imageBackendDropdownRef, () => setImageBackendDropdownOpen(false), imageBackendDropdownOpen);
  useClickOutside(webSearchProviderDropdownRef, () => setWebSearchProviderDropdownOpen(false), webSearchProviderDropdownOpen);
  useClickOutside(tocRef, () => setTocOpen(false), tocOpen);
  useClickOutside(favoritesDropdownRef, () => setFavoritesDropdownOpen(false), favoritesDropdownOpen);

  const refreshLlamaServers = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLlamaServersLoading(true);
    try {
      const data = await getLlamaServers();
      setLlamaServers(data.servers);
    } catch (e: any) {
      setLlamaServerMessage({ type: "err", text: e?.message || "Failed to load llama.cpp server status" });
    } finally {
      if (showSpinner) setLlamaServersLoading(false);
    }
  }, []);

  const handleLlamaServerAction = useCallback(async (id: LlamaServerId, action: LlamaServerAction) => {
    setLlamaServerActionInFlight(`${id}:${action}`);
    setLlamaServerMessage(null);
    try {
      const result = await controlLlamaServer(id, action);
      setLlamaServers((prev) => prev.map((server) => server.id === id ? result.server : server));
      setLlamaServerMessage({ type: "ok", text: `${result.server.label} ${action === "restart" ? "restarted" : action === "start" ? "started" : "stopped"}.` });
      await refreshLlamaServers();
    } catch (e: any) {
      setLlamaServerMessage({ type: "err", text: e?.message || `Failed to ${action} server` });
    } finally {
      setLlamaServerActionInFlight(null);
    }
  }, [refreshLlamaServers]);

  const handleLlamaServerLogs = useCallback(async (id: LlamaServerId) => {
    const server = llamaServers.find((item) => item.id === id);
    setLlamaServerLogs({ id, unitName: server?.unitName || "", logs: "", loading: true });
    try {
      const result = await getLlamaServerLogs(id, 200);
      setLlamaServerLogs({ id, unitName: result.unitName, logs: result.logs || "(no recent log output)", loading: false });
    } catch (e: any) {
      setLlamaServerLogs({ id, unitName: server?.unitName || "", logs: "", loading: false, error: e?.message || "Failed to load logs" });
    }
  }, [llamaServers]);

  // Track which server card has its config section expanded
  const [llamaConfigExpanded, setLlamaConfigExpanded] = useState<LlamaServerId | null>(null);

  // Inline setting update for a specific server — saves immediately via PATCH
  const handleLlamaServerSettings = useCallback(async (id: LlamaServerId, updates: Record<string, unknown>) => {
    setLlamaServerMessage(null);
    try {
      const result = await updateLlamaServerSettings(id, updates as import("../api/client").LlamaServerUpdate);
      // Sync local state from the updated server status
      const s = result.server;
      if (s.id === "inference") {
        setLlamacppUrl(s.url);
        if (s.expectedModel) setDefaultModelId(s.expectedModel);
      }
      if (s.id === "extraction") {
        setExtractionModelUrl(s.url);
        if (s.expectedModel) setExtractionModelId(s.expectedModel);
      }
      if (s.id === "reranker") {
        setRerankerUrl(s.url);
        if (s.expectedModel) setRerankerModelId(s.expectedModel);
      }
      if (s.id === "embedding") {
        setEmbeddingUrl(s.url);
        if (s.expectedModel) setEmbeddingModel(s.expectedModel);
      }
      if (s.id === "title-generation") {
        setTitleGenerationUrl(s.url);
        if (s.expectedModel) setTitleGenerationModelId(s.expectedModel);
      }
      // Refresh the server statuses to pick up new health
      await refreshLlamaServers();
    } catch (e: any) {
      setLlamaServerMessage({ type: "err", text: e?.message || "Failed to update settings" });
    }
  }, [refreshLlamaServers]);


  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

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

  // Fetch llama.cpp binary path info
  useEffect(() => {
    getLlamaPath()
      .then((data) => setLlamaPathInfo(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshLlamaServers(true);
    const interval = window.setInterval(() => refreshLlamaServers(), 5000);
    return () => window.clearInterval(interval);
  }, [refreshLlamaServers]);

  // Aggregate health pings for all five configured servers. Re-runs when URL
  // fields change so the dots update as the user edits settings.
  useEffect(() => {
    let cancelled = false;
    getAllServerHealth()
      .then((h) => { if (!cancelled) setServerHealth(h); })
      .catch(() => { if (!cancelled) setServerHealth(null); });
    return () => { cancelled = true; };
  }, [ollamaUrl, llamacppUrl, rerankerUrl, embeddingUrl, embeddingProvider, extractionModelUrl, titleGenerationUrl]);

  // Discover embedding models for the dropdown. Re-runs when provider/url change.
  useEffect(() => {
    let cancelled = false;
    const url = embeddingUrl.trim();
    if (!url) {
      setEmbeddingModels([]);
      return;
    }
    setEmbeddingModelsLoading(true);
    const handle = setTimeout(() => {
      discoverModels({ provider: embeddingProvider, kind: "embedding", url })
        .then((r) => { if (!cancelled) setEmbeddingModels(r.models); })
        .catch(() => { if (!cancelled) setEmbeddingModels([]); })
        .finally(() => { if (!cancelled) setEmbeddingModelsLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [embeddingProvider, embeddingUrl]);

  // Discover models on the dedicated extraction server. Re-runs when URL changes.
  // When the URL is empty, fall back to the chat-router models list (the prop).
  useEffect(() => {
    let cancelled = false;
    const url = extractionModelUrl.trim();
    if (!url) {
      setExtractionServerModels([]);
      return;
    }
    setExtractionServerModelsLoading(true);
    const handle = setTimeout(() => {
      discoverModels({ provider: "llamacpp", kind: "chat", url })
        .then((r) => { if (!cancelled) setExtractionServerModels(r.models); })
        .catch(() => { if (!cancelled) setExtractionServerModels([]); })
        .finally(() => { if (!cancelled) setExtractionServerModelsLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [extractionModelUrl]);

  // Discover reranker models for the dropdown. Re-runs when URL changes.
  useEffect(() => {
    if (!rerankerEnabled) return;
    let cancelled = false;
    const url = rerankerUrl.trim();
    if (!url) {
      setRerankerModels([]);
      return;
    }
    setRerankerModelsLoading(true);
    const handle = setTimeout(() => {
      discoverModels({ provider: "llamacpp", kind: "rerank", url })
        .then((r) => { if (!cancelled) setRerankerModels(r.models); })
        .catch(() => { if (!cancelled) setRerankerModels([]); })
        .finally(() => { if (!cancelled) setRerankerModelsLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [rerankerEnabled, rerankerUrl]);

  // Discover title-generation models for the dropdown. Re-runs when URL changes.
  useEffect(() => {
    if (!titleGenerationEnabled) return;
    let cancelled = false;
    const url = titleGenerationUrl.trim();
    if (!url) {
      setTitleGenerationModels([]);
      return;
    }
    setTitleGenerationModelsLoading(true);
    const handle = setTimeout(() => {
      discoverModels({ provider: "llamacpp", kind: "chat", url })
        .then((r) => { if (!cancelled) setTitleGenerationModels(r.models); })
        .catch(() => { if (!cancelled) setTitleGenerationModels([]); })
        .finally(() => { if (!cancelled) setTitleGenerationModelsLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [titleGenerationEnabled, titleGenerationUrl]);

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
      exaApiKey: exaApiKey.trim(),
      tavilyApiKey: tavilyApiKey.trim(),
      defaultWebSearchProvider,
      comfyuiUrl: comfyuiUrl.trim() || undefined,
      sdcppUrl: sdcppUrl.trim() || undefined,
      imageBackend,
      ollamaUrl: ollamaUrl.trim() || undefined,
      llamacppEnabled,
      llamacppUrl: llamacppUrl.trim() || undefined,
      llamacppSharesGpu,
      extractionCtxSize,
      rerankerEnabled,
      rerankerUrl: rerankerUrl.trim() || undefined,
      rerankerModelId: rerankerModelId.trim() || undefined,
      titleGenerationEnabled,
      titleGenerationUrl: titleGenerationUrl.trim() || undefined,
      titleGenerationModelId: titleGenerationModelId.trim() || undefined,
      embeddingProvider,
      embeddingUrl: embeddingUrl.trim() || undefined,
      embeddingModel: embeddingModel.trim() || undefined,
      favoriteModels: favoriteModels.size > 0 ? [...favoriteModels] : undefined,
      showOnlyFavorites,
      theme,
      backgroundEffect,
      flatBackground,
      chromaticAberration,
      mouseWarp,
      cornerShape,
      cornerRadius,
      activityShape,
      activityHue,
      systemPromptPresets: presets.length > 0 ? presets : undefined,
      hapticsEnabled,
      modelContextWindows: Object.keys(modelContextWindows).length > 0 ? modelContextWindows : undefined,
      modelPreserveThinking: Object.keys(modelPreserveThinking).length > 0 ? modelPreserveThinking : undefined,
      delayedExtractionEnabled,
      delayedExtractionThresholdMinutes: delayedExtractionThreshold,
      delayedExtractionMessageCap: delayedExtractionCap,
      enrichmentBatchSize,
      sleepCycleThresholdMinutes: sleepCycleThreshold,
      wakeCycleEnabled,
      wakeCycleIntervalHours: wakeCycleInterval,
      extractionModelId,
      extractionModelUrl: extractionModelUrl.trim() || undefined,
      extractionFallbackEnabled,
      readFileDefaultLines,
      readFileMaxBytes,
      bluesky: {
        ...settings.bluesky,
        enabled: blueskyEnabled,
        username: blueskyAuthenticated ? blueskyUsername : undefined,
        pollingIntervalMinutes: blueskyPollingInterval,
        autoSendToAgent: blueskyAutoSendToAgent,
        autoRespondToNotifications: blueskyAutoRespond,
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

  const handleSavePreset = useCallback(async () => {
    if (!editingPresetId) return;
    setPresetSaving(true);
    setPresetMessage(null);
    try {
      handleUpdatePreset(editingPresetId, { content: editingPresetContent });
      setPresetMessage({ type: "ok", text: "Preset updated successfully" });
      setEditingPresetId(null);
      setEditingPresetContent("");
    } catch (err: any) {
      setPresetMessage({ type: "err", text: err.message || "Failed to save preset" });
    }
    setPresetSaving(false);
  }, [editingPresetId, editingPresetContent, handleUpdatePreset]);

  const handleCancelPresetEdit = useCallback(() => {
    setEditingPresetId(null);
    setEditingPresetContent("");
    setPresetMessage(null);
  }, []);


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
      const res = await fetch("/api/images/status?backend=comfyui", { credentials: "include" });
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

  const handleTestSdcpp = useCallback(async () => {
    setSdcppStatus("checking");
    try {
      const res = await fetch("/api/images/status?backend=sdcpp", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setSdcppStatus(data.available ? "connected" : "unavailable");
      } else {
        setSdcppStatus("unavailable");
      }
    } catch {
      setSdcppStatus("unavailable");
    }
  }, []);

  const handleTestLlamaCpp = useCallback(async () => {
    setLlamacppStatus("checking");
    try {
      const res = await fetch("/api/models/llamacpp/health", { credentials: "include" });
      if (res.ok) {
        setLlamacppStatus("connected");
      } else {
        setLlamacppStatus("unavailable");
      }
    } catch {
      setLlamacppStatus("unavailable");
    }
  }, []);

  const handleTestExtractionModel = useCallback(async () => {
    if (!extractionModelUrl) return;
    setExtractionModelStatus("checking");
    try {
      const res = await fetch(`/api/models/llamacpp/health?url=${encodeURIComponent(extractionModelUrl)}`, { credentials: "include" });
      if (res.ok) {
        setExtractionModelStatus("connected");
      } else {
        setExtractionModelStatus("unavailable");
      }
    } catch {
      setExtractionModelStatus("unavailable");
    }
  }, [extractionModelUrl]);

  const handleTestReranker = useCallback(async () => {
    if (!rerankerUrl) return;
    setRerankerStatus("checking");
    try {
      const res = await fetch(`/api/models/llamacpp/health?url=${encodeURIComponent(rerankerUrl)}`, { credentials: "include" });
      if (res.ok) {
        setRerankerStatus("connected");
      } else {
        setRerankerStatus("unavailable");
      }
    } catch {
      setRerankerStatus("unavailable");
    }
  }, [rerankerUrl]);

  // --- Embedding migration ---

  const refreshBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      const list = await listEmbeddingBackups();
      setBackups(list);
    } catch (e: any) {
      setBackupMessage({ type: "err", text: e?.message || "Failed to load backups" });
    } finally {
      setBackupsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshBackups();
  }, [refreshBackups]);

  const handleCreateBackup = useCallback(async () => {
    setBackupMessage(null);
    try {
      await createEmbeddingBackup(backupLabel.trim() || undefined);
      setBackupLabel("");
      setBackupMessage({ type: "ok", text: "Backup created" });
      await refreshBackups();
    } catch (e: any) {
      setBackupMessage({ type: "err", text: e?.message || "Backup failed" });
    }
  }, [backupLabel, refreshBackups]);

  const handleDeleteBackup = useCallback(async (id: string) => {
    setBackupMessage(null);
    try {
      await deleteEmbeddingBackup(id);
      await refreshBackups();
    } catch (e: any) {
      setBackupMessage({ type: "err", text: e?.message || "Delete failed" });
    }
  }, [refreshBackups]);

  const handleRestoreBackup = useCallback(async (id: string) => {
    setBackupMessage(null);
    setConfirmRestoreId(null);
    try {
      await restoreEmbeddingBackup(id);
      setBackupMessage({ type: "ok", text: "Restore complete — reload to pick up restored settings" });
      await refreshBackups();
    } catch (e: any) {
      setBackupMessage({ type: "err", text: e?.message || "Restore failed" });
    }
  }, [refreshBackups]);

  const handleRunMigration = useCallback(() => {
    setConfirmMigrate(false);
    setMigrationRunning(true);
    setMigrationError(null);
    setMigrationResult(null);
    setMigrationProgress({ phase: "probe", message: "Starting…" });
    migrationAbortRef.current = runEmbeddingMigration({
      onProgress: (ev) => setMigrationProgress(ev),
      onComplete: (result) => {
        setMigrationResult(result);
        setMigrationRunning(false);
        setMigrationProgress({ phase: "done", message: "Done" });
      },
      onError: (message) => {
        setMigrationError(message);
        setMigrationRunning(false);
      },
    });
  }, []);

  const handleCancelMigration = useCallback(() => {
    migrationAbortRef.current?.();
    migrationAbortRef.current = null;
    setMigrationRunning(false);
    setMigrationError("Cancelled");
  }, []);

  useEffect(() => {
    return () => {
      migrationAbortRef.current?.();
    };
  }, []);

  const handleValidateLlamaPath = useCallback(async () => {
    const path = llamaPathInput.trim();
    if (!path) return;
    setLlamaPathValidating(true);
    setLlamaPathValidation(null);
    try {
      const result = await validateLlamaPathApi(path);
      setLlamaPathValidation(result);
    } catch (err: any) {
      setLlamaPathValidation({ valid: false, error: err.message });
    }
    setLlamaPathValidating(false);
  }, [llamaPathInput]);

  const handleUpdateLlamaPath = useCallback(async () => {
    const path = llamaPathInput.trim();
    if (!path) return;
    setLlamaPathUpdating(true);
    setLlamaPathMessage(null);
    setLlamaPathUpdateResult(null);
    try {
      const result = await updateLlamaPathApi(path);
      setLlamaPathUpdateResult(result);
      if (result.rolledBack) {
        setLlamaPathMessage({ type: "warn", text: `Services failed with v${result.version}. Rolled back to previous build.` });
      } else {
        setLlamaPathMessage({ type: "ok", text: `Updated to build v${result.version}. All services restarted.` });
      }
      setLlamaPathInput("");
      setLlamaPathValidation(null);
      // Refresh the path info
      getLlamaPath().then(setLlamaPathInfo).catch(() => {});
    } catch (err: any) {
      setLlamaPathMessage({ type: "err", text: err.message || "Failed to update binary path" });
    }
    setLlamaPathUpdating(false);
  }, [llamaPathInput]);

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

   const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const isDesktop = useMediaQuery("(min-width: 768px)");

  // Sync scrollRoot when the media query changes (ref callbacks don't fire on resize)
  useEffect(() => {
    setScrollRoot(scrollContainerRef.current);
  }, [isDesktop]);

  const activeSection = useActiveSection(SECTIONS.map(s => s.id), scrollRoot);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id);
    const container = scrollRoot;
    if (!el || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const paddingFromTop = 20; // Match container's py-5 top padding
    const targetScroll = container.scrollTop + (elRect.top - containerRect.top) - paddingFromTop;

    container.scrollTo({
      top: targetScroll,
      behavior: 'smooth'
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl mx-4 backdrop-blur-xl bg-white/[0.08] border border-white/15 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col">
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

        {/* Mobile body — single column with collapsible ToC dropdown */}
        <div className="flex flex-1 overflow-hidden flex-col">
          {/* Collapsible ToC bar — mobile only */}
          <div className="shrink-0 md:hidden border-b border-white/10">
            <div ref={tocRef} className="relative">
              <button
                onClick={() => setTocOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-2 text-xs text-white/40 hover:text-white/60 hover:bg-white/[0.03] transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="3" y1="6" x2="21" y2="6"/>
                    <line x1="3" y1="12" x2="21" y2="12"/>
                    <line x1="3" y1="18" x2="21" y2="18"/>
                  </svg>
                  Navigate to section
                </span>
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
                  className={`shrink-0 transition-transform ${tocOpen ? "rotate-180" : ""}`}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <div
                className={`absolute z-40 left-0 right-0 top-full overflow-hidden transition-all ${
                  tocOpen ? 'max-h-[60vh]' : 'max-h-0'
                }`}
                style={{
                  backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
                  borderColor: `rgba(var(--theme-primary-border))`,
                }}
              >
                <nav className="max-h-[60vh] overflow-y-auto p-3 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-1">
                  {SECTIONS.map((section) => (
                    <button
                      key={section.id}
                      onClick={() => { scrollToSection(section.id); setTocOpen(false); }}
                      className={`block w-full text-left px-3 py-2 text-xs rounded-lg transition-all ${
                        activeSection === section.id
                          ? 'bg-white/15 text-white font-medium'
                          : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                      }`}
                    >
                      {section.label}
                    </button>
                  ))}
                </nav>
              </div>
            </div>
          </div>

         {/* Shared content area — sidebar on desktop, no sidebar on mobile */}
          <div className="flex flex-1 min-h-0">
            {/* Left sidebar - Table of Contents — desktop only */}
            <div className="w-48 shrink-0 border-r border-white/10 overflow-y-auto py-4 hidden md:block">
              <nav className="px-3 space-y-1">
                {SECTIONS.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => scrollToSection(section.id)}
                    className={`block w-full text-left px-3 py-2 text-xs rounded-lg transition-all ${
                      activeSection === section.id
                        ? 'bg-white/15 text-white font-medium'
                        : 'text-white/50 hover:text-white/80 hover:bg-white/5'
                    }`}
                  >
                    {section.label}
                  </button>
                ))}
              </nav>
            </div>

            {/* Right - Settings content — shared scroll container */}
            <div
              ref={scrollContainerRef}
              className="flex-1 overflow-x-hidden overflow-y-auto settings-content-scroll px-6 py-5 space-y-5"
            >
          {/* Default Model */}
          <div id="models" className="space-y-2">
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
              <DropdownPanel
                open={modelDropdownOpen}
                className="left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto"
              >
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
                    <ProviderIcon
                      provider={m.provider}
                      className={m.provider === "llamacpp" ? "text-[#ff8236] shrink-0" : "text-white/40 shrink-0"}
                    />
                  </button>
                ))}
              </DropdownPanel>
            </div>
          </div>

          {/* Inference Servers */}
          <div id="inference" className="space-y-4">
            <h3 className="text-sm font-semibold text-white/80">Inference Servers</h3>
            <p className="text-xs text-white/40 -mt-2">
              Five llama.cpp model roles (main chat inference, memory extraction, cross-encoder reranker, embedding, title generation) plus the Ollama server (model discovery, vision). Each URL can point at a separate instance.
            </p>

            {/* Server health (HTTP pings against each configured URL) */}
            <div className="space-y-2">
              <h4 className="text-sm text-white/80">Server health</h4>
              <div className="ml-2 flex items-center gap-3 text-xs">
                {([
                  ["inference", "Inference"],
                  ["extraction", "Extraction"],
                  ["reranker", "Reranker"],
                  ["embedding", "Embedding"],
                  ["titleGeneration", "Titles"],
                  ["ollama", "Ollama"],
                ] as const).map(([key, label]) => {
                  const status = serverHealth?.[key];
                  const dotClass =
                    status === "ok" ? "bg-green-400" :
                    status === "unavailable" ? "bg-red-400" :
                    "bg-white/20";
                  const title = status ? `${label}: ${status}` : `${label}: checking…`;
                  return (
                    <div key={key} className="flex items-center gap-1" title={title}>
                      <div className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
                      <span className="text-[10px] text-white/50">{label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Ollama server URL */}
            <div className="space-y-2">
              <h4 className="text-sm text-white/80">Ollama server</h4>
              <div className="space-y-2 ml-2">
                <input
                  type="text"
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all font-mono"
                  placeholder="http://localhost:11434"
                />
                <p className="text-xs text-white/30">
                  Used for Ollama model discovery, chat-title generation, vision analysis, and GPU coordination. Also the default embedding URL when embedding provider is Ollama.
                </p>
              </div>
            </div>

            {/* Binary Path (symlink management) */}
            <div className="space-y-2">
              <h4 className="text-sm text-white/80">Binary path</h4>
              <div className="space-y-2 ml-2">
                {/* Current version display */}
                {llamaPathInfo && llamaPathInfo.valid && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-white/40">Current:</span>
                    <span className="text-white/70 font-mono truncate" title={llamaPathInfo.currentPath}>
                      {llamaPathInfo.currentPath.split("/").pop()}
                    </span>
                    {llamaPathInfo.version && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-400/20 text-[10px] font-medium">
                        v{llamaPathInfo.version}
                      </span>
                    )}
                  </div>
                )}

                {/* Update input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={llamaPathInput}
                    onChange={(e) => { setLlamaPathInput(e.target.value); setLlamaPathValidation(null); setLlamaPathMessage(null); }}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all font-mono"
                    placeholder="/home/asa/bin/llama-b8790"
                    disabled={llamaPathUpdating}
                  />
                  <button
                    onClick={handleValidateLlamaPath}
                    disabled={!llamaPathInput.trim() || llamaPathValidating}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all disabled:opacity-40 shrink-0"
                  >
                    {llamaPathValidating ? "Checking..." : "Validate"}
                  </button>
                  <button
                    onClick={handleUpdateLlamaPath}
                    disabled={!llamaPathInput.trim() || llamaPathUpdating || (llamaPathValidation !== null && !llamaPathValidation.valid)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/15 border border-purple-400/20 text-purple-300 hover:bg-purple-500/25 transition-all disabled:opacity-40 shrink-0"
                  >
                    {llamaPathUpdating ? "Applying..." : "Apply & Restart"}
                  </button>
                </div>

                {/* Validation result */}
                {llamaPathValidation && (
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${llamaPathValidation.valid ? "bg-green-400" : "bg-red-400"}`} />
                    <span className={`text-xs ${llamaPathValidation.valid ? "text-green-400/80" : "text-red-400/80"}`}>
                      {llamaPathValidation.valid ? "Valid — llama-server binary found" : llamaPathValidation.error || "Invalid path"}
                    </span>
                  </div>
                )}

                {/* Update status / messages */}
                {llamaPathMessage && (
                  <div className={`p-2 rounded-lg text-xs ${llamaPathMessage.type === "ok" ? "bg-green-500/10 border border-green-400/15 text-green-400/80" : llamaPathMessage.type === "warn" ? "bg-amber-500/10 border border-amber-400/15 text-amber-400/80" : "bg-red-500/10 border border-red-400/15 text-red-400/80"}`}>
                    <p>{llamaPathMessage.text}</p>
                    {llamaPathUpdateResult && llamaPathUpdateResult.services && (
                      <div className="flex items-center gap-2 mt-1.5">
                        {Object.entries(llamaPathUpdateResult.services).map(([name, status]) => {
                          const shortName = name.replace(".service", "").replace("llama-server", "inference").replace("extraction-model", "extraction");
                          return (
                            <div key={name} className="flex items-center gap-0.5">
                              <div className={`w-1.5 h-1.5 rounded-full ${
                                status === "active" ? "bg-green-400" : status === "failed" ? "bg-red-400" : "bg-amber-400"
                              }`} />
                              <span className="text-[9px] text-white/40">{shortName}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {llamaPathUpdateResult?.rolledBack && (
                      <p className="text-amber-400/70 mt-1">Rolled back to previous version.</p>
                    )}
                  </div>
                )}

	                <p className="text-xs text-white/30">
	                  Path to the llama.cpp build directory. All llama.cpp services share this binary via the <code className="text-white/50">~/bin/llama-current</code> symlink.
	                </p>
	              </div>
	            </div>

	            {/* Managed llama.cpp instances — unified status + config */}
	            <div className="space-y-2 border-t border-white/5 pt-3">
	              <div className="flex items-center justify-between gap-3">
	                <div>
	                  <h4 className="text-sm text-white/80">Managed llama.cpp instances</h4>
	                  <p className="text-xs text-white/30 mt-0.5">
	                    Systemd status, HTTP health, configuration, and logs for each server role.
	                  </p>
	                </div>
	                <button
	                  type="button"
	                  onClick={() => refreshLlamaServers(true)}
	                  disabled={llamaServersLoading}
	                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/5 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all disabled:opacity-40 shrink-0"
	                >
	                  {llamaServersLoading ? "Refreshing..." : "Refresh"}
	                </button>
	              </div>

	              {llamaServerMessage && (
	                <div className={`p-2 rounded-lg text-xs ${llamaServerMessage.type === "ok" ? "bg-green-500/10 border border-green-400/15 text-green-400/80" : "bg-red-500/10 border border-red-400/15 text-red-400/80"}`}>
	                  {llamaServerMessage.text}
	                </div>
	              )}

	              <div className="space-y-2">
	                {llamaServers.length === 0 && (
	                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-white/35">
	                    {llamaServersLoading ? "Loading llama.cpp server status..." : "No llama.cpp server status available."}
	                  </div>
	                )}
	                {llamaServers.map((server) => {
	                  const busy = Boolean(llamaServerActionInFlight?.startsWith(`${server.id}:`));
	                  const missingUnit = server.systemd.loadState === "not-found";
	                  const detailsExpanded = expandedLlamaServerId === server.id;
	                  const configExpanded = llamaConfigExpanded === server.id;
	                  const modelsPreview = server.http.modelIds.length > 0
	                    ? server.http.modelIds.slice(0, 3).join(", ") + (server.http.modelIds.length > 3 ? ` +${server.http.modelIds.length - 3}` : "")
	                    : "none reported";
	                  return (
	                    <div key={server.id} className="rounded-lg border border-white/10 bg-white/[0.025]">
	                      {/* Card header */}
	                      <div className="p-3 space-y-3">
	                        <div className="flex items-start justify-between gap-3">
	                          <div className="min-w-0">
	                            <div className="flex items-center gap-2 flex-wrap">
	                              <span className="text-sm text-white/80 font-medium">{server.label}</span>
	                              <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-white/45 font-mono">
	                                {server.unitName}
	                              </span>
	                              {!server.appEnabled && (
	                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-white/35">
	                                  not selected by app
	                                </span>
	                              )}
	                            </div>
	                            <p className="text-xs text-white/35 mt-1">{server.description}</p>
	                          </div>
	                          <div className="flex items-center gap-1.5 shrink-0">
	                            <span className={`px-2 py-1 rounded-full border text-[10px] font-medium ${llamaSystemdTone(server.systemd.activeState)}`}>
	                              {missingUnit ? "missing unit" : server.systemd.activeState}
	                            </span>
	                            <span className={`px-2 py-1 rounded-full border text-[10px] font-medium ${llamaHealthTone(server.http.status)}`} title={server.http.error}>
	                              HTTP {server.http.status}
	                            </span>
	                          </div>
	                        </div>

	                        {/* Action buttons */}
	                        <div className="flex items-center gap-2 flex-wrap">
	                          <button
	                            type="button"
	                            onClick={() => handleLlamaServerAction(server.id, "start")}
	                            disabled={busy || missingUnit || server.systemd.activeState === "active"}
	                            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-green-500/10 border border-green-400/20 text-green-300/80 hover:bg-green-500/20 transition-all disabled:opacity-40"
	                          >
	                            Start
	                          </button>
	                          <button
	                            type="button"
	                            onClick={() => handleLlamaServerAction(server.id, "stop")}
	                            disabled={busy || missingUnit || server.systemd.activeState === "inactive" || server.systemd.activeState === "unknown"}
	                            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all disabled:opacity-40"
	                          >
	                            Stop
	                          </button>
	                          <button
	                            type="button"
	                            onClick={() => handleLlamaServerAction(server.id, "restart")}
	                            disabled={busy || missingUnit}
	                            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-purple-500/15 border border-purple-400/20 text-purple-300 hover:bg-purple-500/25 transition-all disabled:opacity-40"
	                          >
	                            {busy ? "Working..." : "Restart"}
	                          </button>
	                          <button
	                            type="button"
	                            onClick={() => setLlamaConfigExpanded(configExpanded ? null : server.id)}
	                            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all"
	                          >
	                            {configExpanded ? "Hide config" : "Config"}
	                          </button>
	                          <button
	                            type="button"
	                            onClick={() => setExpandedLlamaServerId(detailsExpanded ? null : server.id)}
	                            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all"
	                          >
	                            {detailsExpanded ? "Hide details" : "Details"}
	                          </button>
	                          <button
	                            type="button"
	                            onClick={() => handleLlamaServerLogs(server.id)}
	                            disabled={missingUnit}
	                            className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all disabled:opacity-40"
	                          >
	                            Logs
	                          </button>
	                        </div>
	                      </div>

	                      {/* Inline config section */}
	                      {configExpanded && (
	                        <div className="border-t border-white/5 bg-black/10 p-3 space-y-3 last:rounded-b-[7px]">
	                          {server.id === "inference" && (
	                            <div className="space-y-2">
	                              <div className="flex items-center gap-2">
	                                <label className="flex items-center gap-2 cursor-pointer">
	                                  <input
	                                    type="checkbox"
	                                    checked={llamacppEnabled}
	                                    onChange={(e) => {
	                                      setLlamacppEnabled(e.target.checked);
	                                      handleLlamaServerSettings("inference", { enabled: e.target.checked });
	                                    }}
	                                    className="w-4 h-4 rounded border-white/20 bg-white/5 text-purple-400 focus:ring-purple-400/30"
	                                  />
	                                  <span className="text-xs text-white/70">Enabled</span>
	                                </label>
	                              </div>
	                              {llamacppEnabled && (
	                                <div className="space-y-2">
	                                  <div className="flex gap-2">
	                                    <label className="block text-xs text-white/50 w-12">URL</label>
	                                    <input
	                                      type="text"
	                                      value={llamacppUrl}
	                                      onChange={(e) => setLlamacppUrl(e.target.value)}
	                                      onBlur={() => handleLlamaServerSettings("inference", { url: llamacppUrl })}
	                                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
	                                      placeholder="http://localhost:8080"
	                                    />
	                                  </div>
	                                  <div className="flex items-center gap-2">
	                                    <label className="flex items-center gap-2 cursor-pointer">
	                                      <input
	                                        type="checkbox"
	                                        checked={llamacppSharesGpu}
	                                        onChange={(e) => {
	                                          setLlamacppSharesGpu(e.target.checked);
	                                          handleLlamaServerSettings("inference", { sharesGpu: e.target.checked });
	                                        }}
	                                        className="w-4 h-4 rounded border-white/20 bg-white/5 text-purple-400 focus:ring-purple-400/30"
	                                      />
	                                      <span className="text-xs text-white/70">Shares GPU</span>
	                                    </label>
	                                    <span className="text-xs text-white/30">Coordinate VRAM with image generation</span>
	                                  </div>
	                                </div>
	                              )}
	                              <p className="text-xs text-white/30">Main GPU inference server (router mode).</p>
	                            </div>
	                          )}
	                          {server.id === "extraction" && (
	                            <div className="space-y-2">
	                              <div className="flex gap-2">
	                                <label className="block text-xs text-white/50 w-12">URL</label>
	                                <input
	                                  type="text"
	                                  value={extractionModelUrl}
	                                  onChange={(e) => setExtractionModelUrl(e.target.value)}
	                                  onBlur={() => handleLlamaServerSettings("extraction", { url: extractionModelUrl })}
	                                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
	                                  placeholder="http://localhost:8083"
	                                />
	                              </div>
	                              <div className="flex gap-2 items-end">
	                                <div>
	                                  <label className="block text-xs text-white/50 mb-1">Ctx size</label>
	                                  <input
	                                    type="number"
	                                    value={extractionCtxSize}
	                                    onChange={(e) => setExtractionCtxSize(Math.max(2048, parseInt(e.target.value) || 16384))}
	                                    onBlur={() => handleLlamaServerSettings("extraction", { ctxSize: extractionCtxSize })}
	                                    min={2048} max={131072} step={1024}
	                                    className="w-28 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none focus:ring-1 focus:ring-purple-400/30"
	                                  />
	                                  <span className="text-xs text-white/30 ml-2">tokens</span>
	                                </div>
	                                <div className="flex-1">
	                                  <label className="block text-xs text-white/50 mb-1">Model</label>
	                                  {extractionServerModels.length > 0 && !extractionUseCustom ? (
	                                    <div className="relative" ref={extractionModelDropdownRef}>
	                                      <button onClick={() => setExtractionModelDropdownOpen((o) => !o)} className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono">
	                                        <span className="truncate flex-1 text-left">{extractionModelId || "Select…"}</span>
	                                        {chevronSvg(extractionModelDropdownOpen)}
	                                      </button>
	                                      <DropdownPanel open={extractionModelDropdownOpen} className="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto">
	                                        {extractionServerModels.map((m) => (
	                                          <button key={m.id} onClick={() => {
	                                            setExtractionModelId(m.id); setExtractionModelDropdownOpen(false);
	                                            handleLlamaServerSettings("extraction", { modelId: m.id });
	                                          }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === extractionModelId ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                            {m.name}
	                                          </button>
	                                        ))}
	                                        <button onClick={() => setExtractionUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                      </DropdownPanel>
	                                    </div>
	                                  ) : (
	                                    <input type="text" value={extractionModelId} onChange={(e) => setExtractionModelId(e.target.value)}
	                                      onBlur={() => handleLlamaServerSettings("extraction", { modelId: extractionModelId })}
	                                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 font-mono outline-none focus:ring-1 focus:ring-purple-400/30" placeholder="model-name" />
	                                  )}
	                                </div>
	                              </div>
	                              <div className="flex items-center justify-between">
	                                <div>
	                                  <label className="block text-xs text-white/70">Fallback to available model</label>
	                                  <p className="text-xs text-white/30 mt-0.5">Use first available model if selected is not loaded</p>
	                                </div>
	                                <ToggleSwitch checked={extractionFallbackEnabled} onChange={() => {
	                                  const v = !extractionFallbackEnabled;
	                                  setExtractionFallbackEnabled(v);
	                                  handleLlamaServerSettings("extraction", { fallbackEnabled: v });
	                                }} accentColor="purple" />
	                              </div>
	                              <p className="text-xs text-white/30">Dedicated instance for memory extraction tasks.</p>
	                            </div>
	                          )}
	                          {server.id === "reranker" && (
	                            <div className="space-y-2">
	                              <div className="flex items-center gap-2">
	                                <label className="flex items-center gap-2 cursor-pointer">
	                                  <input type="checkbox" checked={rerankerEnabled} onChange={(e) => {
	                                    setRerankerEnabled(e.target.checked);
	                                    handleLlamaServerSettings("reranker", { enabled: e.target.checked });
	                                  }} className="w-4 h-4 rounded border-white/20 bg-white/5 text-purple-400 focus:ring-purple-400/30" />
	                                  <span className="text-xs text-white/70">Enabled</span>
	                                </label>
	                              </div>
	                              {rerankerEnabled && (
	                                <div className="space-y-2">
	                                  <div className="flex gap-2">
	                                    <label className="block text-xs text-white/50 w-12">URL</label>
	                                    <input type="text" value={rerankerUrl} onChange={(e) => setRerankerUrl(e.target.value)}
	                                      onBlur={() => handleLlamaServerSettings("reranker", { url: rerankerUrl })}
	                                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
	                                      placeholder="http://localhost:8082" />
	                                  </div>
	                                  <div>
	                                    <label className="block text-xs text-white/50 mb-1">Model</label>
	                                    {rerankerModels.length > 0 && !rerankerUseCustom ? (
	                                      <div className="relative" ref={rerankerModelDropdownRef}>
	                                        <button onClick={() => setRerankerModelDropdownOpen((o) => !o)} className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono">
	                                          <span className="truncate flex-1 text-left">{rerankerModelId || "Select…"}</span>
	                                          {chevronSvg(rerankerModelDropdownOpen)}
	                                        </button>
	                                        <DropdownPanel open={rerankerModelDropdownOpen} className="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto">
	                                          {rerankerModels.map((m) => (
	                                            <button key={m.id} onClick={() => {
	                                              setRerankerModelId(m.id); setRerankerModelDropdownOpen(false);
	                                              handleLlamaServerSettings("reranker", { modelId: m.id });
	                                            }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === rerankerModelId ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                              {m.name}
	                                            </button>
	                                          ))}
	                                          <button onClick={() => setRerankerUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                        </DropdownPanel>
	                                      </div>
	                                    ) : (
	                                      <input type="text" value={rerankerModelId} onChange={(e) => setRerankerModelId(e.target.value)}
	                                        onBlur={() => handleLlamaServerSettings("reranker", { modelId: rerankerModelId })}
	                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 font-mono outline-none focus:ring-1 focus:ring-purple-400/30"
	                                        placeholder="qwen3-reranker" />
	                                    )}
	                                  </div>
	                                </div>
	                              )}
	                              <p className="text-xs text-white/30">Cross-encoder reranker for memory retrieval.</p>
	                            </div>
	                          )}
	                          {server.id === "embedding" && (
	                            <div className="space-y-2">
	                              <div className="flex gap-2">
	                                {(["ollama", "llamacpp"] as const).map((p) => (
	                                  <button key={p} onClick={() => {
	                                    setEmbeddingProvider(p);
	                                    const url = p === "llamacpp" ? "http://localhost:8084" : "http://localhost:11434";
	                                    setEmbeddingUrl(url);
	                                    setEmbeddingModels([]); setEmbeddingUseCustom(false);
	                                    handleLlamaServerSettings("embedding", { provider: p, url });
	                                  }} className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
	                                    embeddingProvider === p ? "bg-purple-500/20 border-purple-400/30 text-purple-200" : "bg-white/5 border-white/10 text-white/60 hover:bg-white/10"
	                                  }`}>{p === "ollama" ? "Ollama" : "llama.cpp"}</button>
	                                ))}
	                              </div>
	                              <div className="flex gap-2">
	                                <label className="block text-xs text-white/50 w-12">URL</label>
	                                <input type="text" value={embeddingUrl} onChange={(e) => setEmbeddingUrl(e.target.value)}
	                                  onBlur={() => handleLlamaServerSettings("embedding", { url: embeddingUrl })}
	                                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
	                                  placeholder={embeddingProvider === "llamacpp" ? "http://localhost:8084" : "http://localhost:11434"} />
	                              </div>
	                              <div>
	                                <label className="block text-xs text-white/50 mb-1">Model</label>
	                                {embeddingModels.length > 0 && !embeddingUseCustom ? (
	                                  <div className="relative" ref={embeddingModelDropdownRef}>
	                                    <button onClick={() => setEmbeddingModelDropdownOpen((o) => !o)} className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono">
	                                      <span className="truncate flex-1 text-left">{embeddingModel || "Select…"}</span>
	                                      {chevronSvg(embeddingModelDropdownOpen)}
	                                    </button>
	                                    <DropdownPanel open={embeddingModelDropdownOpen} className="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto">
	                                      {embeddingModels.map((m) => (
	                                        <button key={m.id} onClick={() => {
	                                          setEmbeddingModel(m.id); setEmbeddingModelDropdownOpen(false);
	                                          handleLlamaServerSettings("embedding", { modelId: m.id });
	                                        }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === embeddingModel ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                          {m.name}
	                                        </button>
	                                      ))}
	                                      <button onClick={() => setEmbeddingUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                    </DropdownPanel>
	                                  </div>
	                                ) : (
	                                  <input type="text" value={embeddingModel} onChange={(e) => setEmbeddingModel(e.target.value)}
	                                    onBlur={() => handleLlamaServerSettings("embedding", { modelId: embeddingModel })}
	                                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 font-mono outline-none focus:ring-1 focus:ring-purple-400/30"
	                                    placeholder="qwen3-embedding:0.6b" />
	                                )}
	                                {storedEmbeddingDimension && (
	                                  <p className="text-xs text-white/30 mt-1">Stored dimension: <span className="text-white/50">{storedEmbeddingDimension}</span></p>
	                                )}
	                              </div>
	                              {embeddingConfigChanged && (
	                                <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2 text-xs text-amber-200/90">
	                                  <p className="font-medium">Embedding config changed.</p>
	                                  <p className="text-amber-100/70">Save settings, then re-embed existing memories and corpus with the new model.</p>
	                                </div>
	                              )}
	                            </div>
	                          )}
	                          {server.id === "title-generation" && (
	                            <div className="space-y-2">
	                              <div className="flex items-center gap-2">
	                                <label className="flex items-center gap-2 cursor-pointer">
	                                  <input type="checkbox" checked={titleGenerationEnabled} onChange={(e) => {
	                                    setTitleGenerationEnabled(e.target.checked);
	                                    handleLlamaServerSettings("title-generation", { enabled: e.target.checked });
	                                  }} className="w-4 h-4 rounded border-white/20 bg-white/5 text-purple-400 focus:ring-purple-400/30" />
	                                  <span className="text-xs text-white/70">Enabled</span>
	                                </label>
	                              </div>
	                              {titleGenerationEnabled && (
	                                <div className="space-y-2">
	                                  <div className="flex gap-2">
	                                    <label className="block text-xs text-white/50 w-12">URL</label>
	                                    <input type="text" value={titleGenerationUrl} onChange={(e) => setTitleGenerationUrl(e.target.value)}
	                                      onBlur={() => handleLlamaServerSettings("title-generation", { url: titleGenerationUrl })}
	                                      className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
	                                      placeholder="http://localhost:8085" />
	                                  </div>
	                                  <div>
	                                    <label className="block text-xs text-white/50 mb-1">Model</label>
	                                    {titleGenerationModels.length > 0 && !titleGenerationUseCustom ? (
	                                      <div className="relative" ref={titleGenerationModelDropdownRef}>
	                                        <button onClick={() => setTitleGenerationModelDropdownOpen((o) => !o)} className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono">
	                                          <span className="truncate flex-1 text-left">{titleGenerationModelId || "Select…"}</span>
	                                          {chevronSvg(titleGenerationModelDropdownOpen)}
	                                        </button>
	                                        <DropdownPanel open={titleGenerationModelDropdownOpen} className="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto">
	                                          {titleGenerationModels.map((m) => (
	                                            <button key={m.id} onClick={() => {
	                                              setTitleGenerationModelId(m.id); setTitleGenerationModelDropdownOpen(false);
	                                              handleLlamaServerSettings("title-generation", { modelId: m.id });
	                                            }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === titleGenerationModelId ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                              {m.name}
	                                            </button>
	                                          ))}
	                                          <button onClick={() => setTitleGenerationUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                        </DropdownPanel>
	                                      </div>
	                                    ) : (
	                                      <input type="text" value={titleGenerationModelId} onChange={(e) => setTitleGenerationModelId(e.target.value)}
	                                        onBlur={() => handleLlamaServerSettings("title-generation", { modelId: titleGenerationModelId })}
	                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 font-mono outline-none focus:ring-1 focus:ring-purple-400/30"
	                                        placeholder="qwen3.5-0.8b" />
	                                    )}
	                                  </div>
	                                </div>
	                              )}
	                              <p className="text-xs text-white/30">Tiny CPU-only instance for generating short chat titles.</p>
	                            </div>
	                          )}
	                        </div>
	                      )}

	                      {/* Details section */}
	                      {detailsExpanded && (
	                        <div className="border-t border-white/5 bg-black/10 p-3 space-y-3 last:rounded-b-[7px]">
	                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
	                            <div><span className="text-white/30">Role</span><p className="text-white/60">{server.role}</p></div>
	                            <div><span className="text-white/30">PID</span><p className="text-white/60 font-mono">{server.systemd.mainPid ?? "n/a"}</p></div>
	                            <div><span className="text-white/30">Unit file</span><p className="text-white/60 font-mono truncate" title={server.systemd.fragmentPath}>{server.systemd.fragmentPath || "n/a"}</p></div>
	                            <div><span className="text-white/30">Working directory</span><p className="text-white/60 font-mono truncate" title={server.systemd.workingDirectory}>{server.systemd.workingDirectory || "n/a"}</p></div>
	                            <div><span className="text-white/30">Substate</span><p className="text-white/60 font-mono">{server.systemd.subState || "n/a"}</p></div>
	                            <div><span className="text-white/30">Active since</span><p className="text-white/60 font-mono">{formatSystemdTimestamp(server.systemd.activeEnterTimestamp)}</p></div>
	                          </div>
	                          <div>
	                            <span className="text-xs text-white/30">Models from /v1/models</span>
	                            <p className="text-xs text-white/60 font-mono truncate" title={server.http.modelIds.join(", ")}>{modelsPreview}</p>
	                          </div>
	                          <div>
	                            <span className="text-xs text-white/30">ExecStart</span>
	                            <pre className="mt-1 max-h-28 overflow-auto rounded-md border border-white/10 bg-black/20 p-2 text-[10px] text-white/55 whitespace-pre-wrap break-words">
	                              {server.systemd.execStart || server.systemd.error || "No launch command reported by systemd."}
	                            </pre>
	                          </div>
	                        </div>
	                      )}
	                    </div>
	                  );
	                })}
	              </div>

	              {llamaServerLogs && (
	                <div className="rounded-lg border border-white/10 bg-black/20 overflow-hidden">
	                  <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-white/5">
	                    <div className="min-w-0">
	                      <p className="text-xs text-white/70">Recent logs</p>
	                      <p className="text-[11px] text-white/35 font-mono truncate">{llamaServerLogs.unitName || llamaServerLogs.id}</p>
	                    </div>
	                    <button type="button" onClick={() => setLlamaServerLogs(null)}
	                      className="px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/10 text-white/50 hover:text-white/75 hover:bg-white/10 transition-all">
	                      Close
	                    </button>
	                  </div>
	                  <pre className="max-h-64 overflow-auto p-3 text-[10px] leading-relaxed text-white/55 whitespace-pre-wrap break-words">
	                    {llamaServerLogs.loading ? "Loading logs..." : llamaServerLogs.error || llamaServerLogs.logs}
	                  </pre>
	                </div>
	              )}
	            </div>
	          </div>

          {/* Model Favorites */}
          <div id="favorites" className="space-y-2 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-white/60">Model Favorites</label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showOnlyFavorites}
                  onChange={(e) => setShowOnlyFavorites(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-amber-400 focus:ring-amber-400/30"
                />
                <span className="text-xs text-white/50">Show only favorites in chat</span>
              </label>
            </div>
            <div className="relative" ref={favoritesDropdownRef}>
              <button
                onClick={() => setFavoritesDropdownOpen((o) => !o)}
                className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
              >
                <span className="truncate flex-1 text-left">
                  {favoriteModels.size === 0
                    ? "No favorites selected"
                    : `${favoriteModels.size} favorite${favoriteModels.size === 1 ? "" : "s"} selected`}
                </span>
                {chevronSvg(favoritesDropdownOpen)}
              </button>
              <DropdownPanel
                open={favoritesDropdownOpen}
                className="left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto"
              >
                {models.map((m) => {
                  const isFav = favoriteModels.has(m.id);
                  return (
                    <button
                      key={`${m.provider || "ollama"}-${m.id}`}
                      onClick={() => {
                        setFavoriteModels((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        });
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-white/10 transition-all"
                      title={isFav ? "Remove from favorites" : "Add to favorites"}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill={isFav ? "currentColor" : "none"}
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`shrink-0 transition-colors ${isFav ? "text-amber-400" : "text-white/30"}`}
                      >
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                      </svg>
                      <span className="truncate flex-1 text-white/70">{m.name}</span>
                      {m.parameterSize && <span className="text-[10px] text-white/30 shrink-0">{m.parameterSize}</span>}
                      <ProviderIcon
                        provider={m.provider}
                        className={m.provider === "llamacpp" ? "text-[#ff8236] shrink-0" : "text-white/40 shrink-0"}
                      />
                    </button>
                  );
                })}
              </DropdownPanel>
            </div>
          </div>



          {/* Migration + Backups */}
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-medium text-white/70 uppercase tracking-wider">Migration &amp; Backups</h5>
              <button
                onClick={refreshBackups}
                disabled={backupsLoading}
                className="text-[11px] text-white/40 hover:text-white/70 transition-colors"
              >
                {backupsLoading ? "Loading…" : "Refresh"}
              </button>
            </div>

            <p className="text-xs text-white/40">
              Re-embedding rebuilds vector tables for every memory and corpus entry. This can take several minutes on large stores and the chat is unavailable while vectors are being rewritten. A backup is strongly recommended.
            </p>

            {backupMessage && (
              <div className={`text-xs p-2 rounded ${backupMessage.type === "ok" ? "bg-green-500/10 text-green-300/80" : "bg-red-500/10 text-red-300/80"}`}>
                {backupMessage.text}
              </div>
            )}

            {/* Backup controls */}
            <div className="flex gap-2">
              <input
                type="text"
                value={backupLabel}
                onChange={(e) => setBackupLabel(e.target.value)}
                placeholder="Optional label (e.g., 'before qwen3 switch')"
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 focus:border-purple-400/30 transition-all"
              />
              <button
                onClick={handleCreateBackup}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-purple-500/15 border border-purple-400/20 text-purple-200 hover:bg-purple-500/25 transition-all shrink-0"
              >
                Back up now
              </button>
            </div>

            {/* Backups list */}
            {backups.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {backups.map((b) => {
                  const isConfirming = confirmRestoreId === b.id;
                  const sizeMb = (b.sourceSizes.memoriesBytes + b.sourceSizes.corpusBytes) / (1024 * 1024);
                  return (
                    <div key={b.id} className="p-2 rounded-lg bg-white/[0.03] border border-white/5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-white/70">{b.id}</span>
                            {b.label && <span className="text-white/50 truncate">— {b.label}</span>}
                          </div>
                          <div className="text-[11px] text-white/40 mt-0.5">
                            {b.counts.memories} memories · {b.counts.corpus} corpus · {sizeMb.toFixed(1)} MB · {b.embedding.model}
                            {b.embedding.dimension ? ` (dim ${b.embedding.dimension})` : ""}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {isConfirming ? (
                            <>
                              <button
                                onClick={() => handleRestoreBackup(b.id)}
                                className="px-2 py-0.5 rounded text-[11px] bg-red-500/20 border border-red-400/30 text-red-200 hover:bg-red-500/30 transition-all"
                              >
                                Confirm restore
                              </button>
                              <button
                                onClick={() => setConfirmRestoreId(null)}
                                className="px-2 py-0.5 rounded text-[11px] text-white/50 hover:text-white/80"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => setConfirmRestoreId(b.id)}
                                className="px-2 py-0.5 rounded text-[11px] bg-white/5 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all"
                              >
                                Restore
                              </button>
                              <button
                                onClick={() => handleDeleteBackup(b.id)}
                                className="px-2 py-0.5 rounded text-[11px] text-white/30 hover:text-red-400/80 transition-all"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Migrate controls */}
            <div className="pt-2 border-t border-white/5 space-y-2">
              {!migrationRunning && !confirmMigrate && (
                <button
                  onClick={() => setConfirmMigrate(true)}
                  className="w-full px-3 py-2 rounded-lg text-xs font-medium bg-purple-500/15 border border-purple-400/25 text-purple-200 hover:bg-purple-500/25 transition-all"
                >
                  Re-embed all memories &amp; corpus
                </button>
              )}

              {!migrationRunning && confirmMigrate && (
                <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-2.5 text-xs space-y-2">
                  <p className="text-amber-200/90 font-medium">Re-embed with <code className="font-mono text-amber-100">{embeddingModel}</code>?</p>
                  <p className="text-amber-100/70">
                    This rewrites every vector. It may take minutes, and the chat is unavailable while it runs. Create a backup first if you haven't.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleRunMigration}
                      className="px-3 py-1 rounded text-[11px] font-medium bg-amber-500/25 border border-amber-400/40 text-amber-100 hover:bg-amber-500/40 transition-all"
                    >
                      Start migration
                    </button>
                    <button
                      onClick={() => setConfirmMigrate(false)}
                      className="px-3 py-1 rounded text-[11px] text-white/50 hover:text-white/80 transition-all"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {migrationRunning && migrationProgress && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-white/60 capitalize">{migrationProgress.phase}</span>
                    {migrationProgress.total != null && (
                      <span className="text-white/40">
                        {migrationProgress.processed ?? 0} / {migrationProgress.total}
                      </span>
                    )}
                  </div>
                  {migrationProgress.total != null && migrationProgress.total > 0 && (
                    <div className="h-1.5 bg-white/5 rounded overflow-hidden">
                      <div
                        className="h-full bg-purple-400/60 transition-all"
                        style={{
                          width: `${Math.min(100, ((migrationProgress.processed ?? 0) / migrationProgress.total) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  {migrationProgress.message && (
                    <p className="text-[11px] text-white/40">{migrationProgress.message}</p>
                  )}
                  <button
                    onClick={handleCancelMigration}
                    className="text-[11px] text-red-400/70 hover:text-red-400"
                  >
                    Cancel migration
                  </button>
                </div>
              )}

              {migrationError && (
                <div className="text-xs p-2 rounded bg-red-500/10 border border-red-400/20 text-red-300/90">
                  {migrationError}
                </div>
              )}

              {migrationResult && !migrationRunning && (
                <div className="text-xs p-2 rounded bg-green-500/10 border border-green-400/20 text-green-300/90">
                  Migrated {migrationResult.memories} memories and {migrationResult.corpus} corpus entries at dimension {migrationResult.dimension}.
                </div>
              )}
            </div>
          </div>

          {/* Default Vision Model */}
          <div id="vision" className="space-y-2">
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
              <DropdownPanel
                open={visionModelDropdownOpen}
                className="left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto"
              >
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
                    <ProviderIcon
                      provider={m.provider}
                      className={m.provider === "llamacpp" ? "text-[#ff8236] shrink-0" : "text-white/40 shrink-0"}
                    />
                  </button>
                ))}
              </DropdownPanel>
            </div>
            <p className="text-white/30 text-xs">
              Model used for image analysis in the Vision sandbox.
            </p>
          </div>

          {/* Model Context Windows */}
          {models.length > 0 && (
            <div id="context" className="space-y-2">
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
                {(() => {
                  const ctx = Object.keys(modelContextWindows).length;
                  const pt = Object.values(modelPreserveThinking).filter(Boolean).length;
                  const total = ctx + pt;
                  return total > 0 ? (
                    <span className="text-xs text-blue-300/60 font-normal">
                      ({total} override{total !== 1 ? "s" : ""})
                    </span>
                  ) : null;
                })()}
              </button>
              {ctxWindowsExpanded && (
                <>
                  <p className="text-white/30 text-xs">Override the default context window per model. Applies to new chats. Preserve Thinking (llama.cpp only) retains historical reasoning traces — Qwen3.6+ feature, ignored by other models.</p>
                  <div className="space-y-1.5">
                    {models.map((m) => {
                      const override = modelContextWindows[m.id];
                      const hasOverride = override !== undefined;
                      const isLlamacpp = m.provider === "llamacpp";
                      const preserveThinking = modelPreserveThinking[m.id] === true;
                      return (
                        <div key={m.id} className="flex items-center gap-2">
                          <span className="text-xs text-white/50 truncate flex-1 min-w-0" title={m.id}>{m.name}</span>
                          {isLlamacpp && (
                            <button
                              onClick={() =>
                                setModelPreserveThinking((prev) => {
                                  const next = { ...prev };
                                  if (preserveThinking) delete next[m.id];
                                  else next[m.id] = true;
                                  return next;
                                })
                              }
                              title={preserveThinking ? "Preserve thinking: on — historical reasoning traces retained in context" : "Preserve thinking: off"}
                              className={`shrink-0 text-[10px] px-2 py-1 rounded border transition-all ${
                                preserveThinking
                                  ? "border-white/20 text-white/80"
                                  : "border-white/10 text-white/30 hover:text-white/50"
                              }`}
                              style={preserveThinking ? {
                                backgroundColor: `rgba(var(--theme-primary), 0.15)`,
                                borderColor: `rgba(var(--theme-primary-border))`,
                                color: `rgba(var(--theme-primary-text))`,
                              } : undefined}
                            >
                              Preserve thinking
                            </button>
                          )}
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
          <div id="theme" className="space-y-2">
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
                { value: "emerald" as Theme, label: "Emerald", preview: "from-emerald-900" },
                { value: "copper" as Theme, label: "Copper", preview: "from-orange-900" },
                { value: "oxidized-copper" as Theme, label: "Verdigris", preview: "from-teal-900" },
                { value: "iron" as Theme, label: "Iron", preview: "from-gray-800" },
                { value: "rust" as Theme, label: "Rust", preview: "from-orange-950" },
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
              <ToggleSwitch
                checked={flatBackground}
                onChange={() => setFlatBackground(!flatBackground)}
                accentColor="blue"
              />
            </div>
          </div>

          {/* Corner Shape */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Corner Shape</label>
            <div className="flex gap-2">
              {[
                { value: "round" as CornerShape, label: "Round", swatch: "rounded-lg corner-round" },
                { value: "squircle" as CornerShape, label: "Squircle", swatch: "rounded-lg corner-squircle" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setCornerShape(opt.value)}
                  className={`flex-1 px-3 py-3 rounded-lg text-sm font-medium border transition-all flex items-center justify-center gap-2 ${
                    cornerShape === opt.value
                      ? "border-white/30 bg-white/5"
                      : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <span className={`inline-block w-4 h-4 border border-white/50 ${opt.swatch}`} />
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-white/30 text-xs">
              {cornerShape === "squircle"
                ? "Superellipse curves for a softer, iOS-style corner. Falls back to round on unsupported browsers."
                : "Classic circular arcs on rounded elements."}
            </p>
          </div>

          {/* Corner Radius */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Corner Radius</label>
            <div className="flex gap-2">
              {[
                { value: "compact" as CornerRadius, label: "Compact", swatchSize: "w-3 h-3", swatchRadius: "2px" },
                { value: "default" as CornerRadius, label: "Default", swatchSize: "w-4 h-4", swatchRadius: "4px" },
                { value: "generous" as CornerRadius, label: "Generous", swatchSize: "w-4 h-4", swatchRadius: "7px" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setCornerRadius(opt.value)}
                  className={`flex-1 px-3 py-3 rounded-lg text-sm font-medium border transition-all flex items-center justify-center gap-2 ${
                    cornerRadius === opt.value
                      ? "border-white/30 bg-white/5"
                      : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <span
                    className={`inline-block border border-white/50 ${opt.swatchSize} ${cornerShape === "squircle" ? "corner-squircle" : "corner-round"}`}
                    style={{ borderRadius: opt.swatchRadius }}
                  />
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="text-white/30 text-xs">
              Scales all rounded corners. 
            </p>
          </div>

          {/* Activity Shape */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Activity Shape</label>
            <div className="flex gap-2">
              {([
                { value: "octahedron" as ActivityShape, label: "Octahedron" },
                { value: "cube" as ActivityShape, label: "Cube" },
                { value: "tetrahedron" as ActivityShape, label: "Tetrahedron" },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setActivityShape(opt.value)}
                  className={`flex-1 px-3 py-3 rounded-lg text-sm font-medium border transition-all flex flex-col items-center gap-1.5 ${
                    activityShape === opt.value
                      ? "border-white/30 bg-white/5"
                      : "border-white/10 hover:border-white/20"
                  }`}
                >
                  <PolyhedronLogo
                    isActive={true}
                    shape={opt.value}
                    hue={activityHue}
                    count={1}
                    size={20}
                    speed={0.6}
                  />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
            <p className="text-white/30 text-xs">
              The 3D shape used for activity indicators throughout the interface.
            </p>
          </div>

          {/* Activity Hue */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Activity Color</label>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={activityHue}
                onChange={(e) => setActivityHue(Number(e.target.value))}
                className="flex-1 h-2 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white/80 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white/30 [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-track]:transparent"
                style={{
                  background: `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => `hsl(${i * 30}, 85%, 55%)`).join(', ')})`,
                }}
              />
              <div
                className="w-6 h-6 rounded-full border border-white/20 shrink-0"
                style={{ backgroundColor: `hsl(${activityHue}, 85%, 55%)` }}
              />
            </div>
            <div className="flex items-center gap-2 mt-1">
              <PolyhedronLogo
                isActive={true}
                shape={activityShape}
                hue={activityHue}
                count={3}
                size={16}
                gap={2}
                speed={0.6}
              />
              <span className="text-white/30 text-xs">
                Hue {activityHue}°{activityHue === 38 ? ' (default)' : ''}
              </span>
            </div>
          </div>

          {/* Background Effect */}
          <div id="background" className="space-y-2">
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

          {/* Chromatic Aberration */}
          {(backgroundEffect === "ripple-grid" || backgroundEffect === "ripple-dots") && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-white/60">Chromatic Aberration</label>
                  <p className="text-white/30 text-xs mt-0.5">
                    Red/blue fringing that grows toward the screen edges
                  </p>
                </div>
                <ToggleSwitch
                  checked={chromaticAberration}
                  onChange={() => setChromaticAberration(!chromaticAberration)}
                  accentColor="blue"
                />
              </div>
            </div>
          )}

          {/* Mouse Warp */}
          {(backgroundEffect === "ripple-grid" || backgroundEffect === "ripple-dots") && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-white/60">Mouse Warp</label>
                  <p className="text-white/30 text-xs mt-0.5">
                    Subtle repulsion of grid/dots around the cursor
                  </p>
                </div>
                <ToggleSwitch
                  checked={mouseWarp}
                  onChange={() => setMouseWarp(!mouseWarp)}
                  accentColor="blue"
                />
              </div>
            </div>
          )}

          {/* Haptic Feedback */}
          <div id="haptics" className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium text-white/60">Haptic Feedback</label>
                <p className="text-xs text-white/30 mt-0.5">Vibration feedback for interactions (mobile only)</p>
              </div>
              <ToggleSwitch
                checked={hapticsEnabled}
                onChange={() => setHapticsEnabled(!hapticsEnabled)}
                accentColor="blue"
              />
            </div>
          </div>

          {/* Push Notifications */}
          <div id="notifications" className="space-y-3 pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <div className="min-w-0 pr-3">
                <label className="block text-sm font-medium text-white/60">Push notifications</label>
                <p className="text-xs text-white/30 mt-0.5">
                  Notify this device when an agent reply is ready and you're not already viewing the app.
                </p>
              </div>
              <ToggleSwitch
                checked={push.status === "subscribed"}
                onChange={() => {
                  setPushTestState(null);
                  if (push.status === "subscribed") {
                    void push.disable();
                  } else {
                    void push.enable();
                  }
                }}
                disabled={push.support !== "supported" || push.status === "loading"}
                accentColor="blue"
              />
            </div>

            {push.support === "needs-install" && (
              <p className="text-xs text-amber-300/80">
                Add qu.je to your Home Screen first — iOS only delivers push notifications to installed PWAs.
              </p>
            )}
            {push.support === "unsupported" && (
              <p className="text-xs text-white/40">
                This browser doesn't support Web Push notifications.
              </p>
            )}
            {push.permission === "denied" && (
              <p className="text-xs text-red-300/80">
                Browser notifications are blocked. Enable them in your browser/system settings, then try again.
              </p>
            )}
            {push.error && (
              <p className="text-xs text-red-300/80 break-words">{push.error}</p>
            )}

            {push.status === "subscribed" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      try {
                        const result = await sendPushTest();
                        setPushTestState({
                          tone: "ok",
                          text: `Sent — delivered ${result.delivered}, expired ${result.expired}, failed ${result.failed}`,
                        });
                      } catch (err: any) {
                        setPushTestState({ tone: "err", text: err?.message || "Failed to send test" });
                      }
                    }}
                    className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all"
                  >
                    Send test notification
                  </button>
                  {pushTestState && (
                    <span className={`text-xs ${pushTestState.tone === "ok" ? "text-green-400/80" : "text-red-400/80"}`}>
                      {pushTestState.text}
                    </span>
                  )}
                </div>
              </div>
            )}

            {push.devices.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <p className="text-xs text-white/40">Registered devices</p>
                <ul className="space-y-1">
                  {push.devices.map((d) => {
                    const ua = d.userAgent || "Unknown device";
                    const trimmed = ua.length > 80 ? ua.slice(0, 80) + "…" : ua;
                    return (
                      <li
                        key={d.deviceId}
                        className="flex items-center justify-between gap-2 text-xs text-white/50 bg-white/[0.03] border border-white/5 rounded-md px-2 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-mono text-[10px] text-white/40">{d.deviceId.slice(0, 8)}</p>
                          <p className="truncate text-white/55">{trimmed}</p>
                        </div>
                        <span className="text-[10px] text-white/30 shrink-0">
                          {new Date(d.lastSeenAt).toLocaleDateString()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          {/* Agent Persona */}
          <div id="persona" className="space-y-3 pt-2 border-t border-white/10">
            <label className="block text-sm font-medium text-white/60">Agent Persona</label>
            <p className="text-white/30 text-xs -mt-2">
              The agent's core identity, voice, and values. Loaded from <code className="text-white/40">~/.quje-agent/persona.md</code>.
            </p>

            <div className="space-y-2">
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
          </div>

          {/* User Document */}
          <div id="user-doc" className="space-y-3 pt-2 border-t border-white/10">
            <label className="block text-sm font-medium text-white/60">About You</label>
            <p className="text-white/30 text-xs -mt-2">
              Optional. Share your name, preferences, and context.
            </p>

            <div className="space-y-2">
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
          </div>

          {/* System Prompt Presets */}
          <div id="presets" className="space-y-3 pt-2 border-t border-white/10">
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
              Prompts that append to the base agent prompt.
            </p>

            {presetMessage && (
              <p className={`text-xs ${presetMessage.type === "ok" ? "text-green-400/80" : "text-red-400/80"}`}>
                {presetMessage.text}
              </p>
            )}

            {presets.length === 0 ? (
              <p className="text-white/30 text-xs italic">No presets configured. Add a preset to use mode-specific prompts.</p>
            ) : (
              <div className="space-y-3">
                {presets.map((preset) => {
                  const isEditingContent = editingPresetId === preset.id;
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
                      {isEditingContent ? (
                        <div className="p-3 space-y-2">
                          <label className="block text-xs text-white/40">Content</label>
                          <textarea
                            value={editingPresetContent}
                            onChange={(e) => setEditingPresetContent(e.target.value)}
                            rows={6}
                            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white/80 placeholder-white/30 resize-y outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all font-mono"
                            placeholder="Mode-specific instructions (appended to base prompt)..."
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={handleSavePreset}
                              disabled={presetSaving}
                              className="flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all disabled:opacity-40"
                              style={{
                                backgroundColor: `rgba(var(--theme-primary-muted), 0.15)`,
                                borderColor: `rgba(var(--theme-primary-border))`,
                                color: `rgba(var(--theme-primary-text))`,
                              }}
                            >
                              {presetSaving ? "Saving..." : "Save"}
                            </button>
                            <button
                              onClick={() => {
                                setEditingPresetId(null);
                                setEditingPresetContent("");
                              }}
                              disabled={presetSaving}
                              className="flex-1 px-3 py-2 rounded-lg text-xs font-medium border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/5 transition-all disabled:opacity-40"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="p-3 space-y-2">
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
                              className="text-white/20 hover:text-red-400/70 transition-colors p-0.5 shrink-0"
                              title="Delete preset"
                            >
                              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M18 6L6 18" />
                                <path d="M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-white/50 truncate">
                                {preset.content ? preset.content.split("\n")[0]?.substring(0, 60) || "No content" : "No content"}
                              </p>
                              <p className="text-[10px] text-white/30">
                                {preset.content ? `${preset.content.length} characters` : ""}
                              </p>
                            </div>
                            <button
                              onClick={() => {
                                setEditingPresetId(preset.id);
                                setEditingPresetContent(preset.content);
                              }}
                              className="text-xs px-2 py-1 rounded-md bg-white/5 border border-white/10 text-white/50 hover:text-white/70 hover:bg-white/10 transition-all shrink-0"
                            >
                              Edit content
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* API Keys Section */}
          <div id="api-keys" className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">API Keys</h3>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">Default Web Search Provider</label>
              <div className="relative" ref={webSearchProviderDropdownRef}>
                <button
                  onClick={() => setWebSearchProviderDropdownOpen((o) => !o)}
                  className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
                >
                  <span className="truncate flex-1 text-left">
                    {WEB_SEARCH_PROVIDER_OPTIONS.find((p) => p.id === defaultWebSearchProvider)?.label || "Brave Search"}
                  </span>
                  {chevronSvg(webSearchProviderDropdownOpen)}
                </button>
                <DropdownPanel
                  open={webSearchProviderDropdownOpen}
                  className="left-0 right-0 top-full mt-1 overflow-hidden"
                >
                  {WEB_SEARCH_PROVIDER_OPTIONS.map((provider) => (
                    <button
                      key={provider.id}
                      onClick={() => { setDefaultWebSearchProvider(provider.id); setWebSearchProviderDropdownOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-all ${
                        defaultWebSearchProvider === provider.id ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                      }`}
                      style={{
                        backgroundColor: defaultWebSearchProvider === provider.id ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                        color: defaultWebSearchProvider === provider.id ? `rgba(var(--theme-secondary-text))` : '',
                      }}
                    >
                      <span className="block">{provider.label}</span>
                      <span className="block text-[11px] text-white/35 mt-0.5">{provider.description}</span>
                    </button>
                  ))}
                </DropdownPanel>
              </div>
              <p className="text-white/30 text-xs">
                Used when the web_search agent tool does not specify a provider. Agents can still override it for a specific search.
              </p>
            </div>
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
            <div className="space-y-2">
              <label className="block text-sm text-white/50">Exa Search API Key</label>
              <input
                type="password"
                value={exaApiKey}
                onChange={(e) => setExaApiKey(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all"
                placeholder="exa_api_key..."
                autoComplete="off"
              />
              <p className="text-white/30 text-xs">
                Required for Exa-powered web search. Provides richer results with highlights, summaries, and deep reasoning. Get a key at{" "}
                <a href="https://exa.ai" target="_blank" rel="noopener noreferrer" className="text-blue-400/60 hover:text-blue-400/80">
                  exa.ai
                </a>
              </p>
            </div>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">Tavily Search API Key</label>
              <input
                type="password"
                value={tavilyApiKey}
                onChange={(e) => setTavilyApiKey(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-blue-400/30 focus:border-blue-400/30 transition-all"
                placeholder="tvly-..."
                autoComplete="off"
              />
              <p className="text-white/30 text-xs">
                Required for Tavily-powered web search. Supports ranked results, optional generated answers, and date/domain filters. Get a key at{" "}
                <a href="https://app.tavily.com" target="_blank" rel="noopener noreferrer" className="text-blue-400/60 hover:text-blue-400/80">
                  app.tavily.com
                </a>
              </p>
            </div>
          </div>

          {/* Image Generation */}
          <div id="images" className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Image Generation</h3>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">Backend</label>
              <div className="relative" ref={imageBackendDropdownRef}>
                <button
                  onClick={() => setImageBackendDropdownOpen((o) => !o)}
                  className="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer"
                >
                  <span className="truncate flex-1 text-left">
                    {imageBackend === "sdcpp" ? "sd-server (stable-diffusion.cpp)" : "ComfyUI"}
                  </span>
                  {chevronSvg(imageBackendDropdownOpen)}
                </button>
                <DropdownPanel
                  open={imageBackendDropdownOpen}
                  className="left-0 right-0 top-full mt-1 overflow-hidden"
                >
                  {(["comfyui", "sdcpp"] as const).map((b) => (
                    <button
                      key={b}
                      onClick={() => { setImageBackend(b); setImageBackendDropdownOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-xs transition-all ${
                        imageBackend === b ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                      }`}
                      style={{
                        backgroundColor: imageBackend === b ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                        color: imageBackend === b ? `rgba(var(--theme-secondary-text))` : '',
                      }}
                    >
                      {b === "sdcpp" ? "sd-server (stable-diffusion.cpp)" : "ComfyUI"}
                    </button>
                  ))}
                </DropdownPanel>
              </div>
              <p className="text-white/30 text-xs">
                Used by the Image Sandbox and the generate_image agent tool. sd-server loads one model at startup; configure via its launch command.
              </p>
            </div>
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
            </div>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">sd-server URL</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={sdcppUrl}
                  onChange={(e) => setSdcppUrl(e.target.value)}
                  className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-amber-400/30 focus:border-amber-400/30 transition-all"
                  placeholder="http://127.0.0.1:1234"
                />
                <button
                  onClick={handleTestSdcpp}
                  disabled={sdcppStatus === "checking"}
                  className="px-3 py-2 rounded-lg text-sm font-medium bg-amber-500/15 border border-amber-400/20 text-amber-300 hover:bg-amber-500/25 transition-all disabled:opacity-40 shrink-0"
                >
                  {sdcppStatus === "checking" ? "Testing..." : "Test"}
                </button>
              </div>
              {sdcppStatus && sdcppStatus !== "checking" && (
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${sdcppStatus === "connected" ? "bg-green-400" : "bg-red-400"}`} />
                  <span className={`text-xs ${sdcppStatus === "connected" ? "text-green-400/80" : "text-red-400/80"}`}>
                    {sdcppStatus === "connected" ? "Connected" : "Not available"}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Skills Section */}
          <div id="skills" className="space-y-3 pt-2 border-t border-white/10">
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
          <div id="extraction" className="border-t border-white/10 pt-6">
            <h3 className="text-sm font-semibold text-white/80 mb-4">Delayed Memory Extraction</h3>
            
            <div className="space-y-4">
              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="block text-sm font-medium text-white/60">Enable delayed extraction</label>
                  <p className="text-xs text-white/30 mt-0.5">Extract memories from chats after inactivity</p>
                </div>
                <ToggleSwitch
                  checked={delayedExtractionEnabled}
                  onChange={() => setDelayedExtractionEnabled(!delayedExtractionEnabled)}
                  accentColor="purple"
                />
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

              {/* Sleep Cycle & Wake Cycle */}
              <div className="pt-4 border-t border-white/10 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-white/60">Sleep cycle threshold</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={15}
                      max={240}
                      step={15}
                      value={sleepCycleThreshold}
                      onChange={(e) => setSleepCycleThreshold(Number(e.target.value))}
                      className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                    />
                    <span className="text-xs text-white/40 w-16 text-right">{sleepCycleThreshold} min</span>
                  </div>
                  <p className="text-xs text-white/30">After this period of inactivity, the sleep cycle begins and autonomous modes activate</p>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Wake cycle</label>
                    <p className="text-xs text-white/30">Periodic autonomous exploration during sleep — web research, notebook writing, curiosity</p>
                  </div>
                  <ToggleSwitch
                    checked={wakeCycleEnabled}
                    onChange={() => setWakeCycleEnabled(!wakeCycleEnabled)}
                    accentColor="purple"
                  />
                </div>

                {wakeCycleEnabled && (
                  <div>
                    <label className="block text-sm font-medium text-white/60">Wake interval</label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={24}
                        step={1}
                        value={wakeCycleInterval}
                        onChange={(e) => setWakeCycleInterval(Number(e.target.value))}
                        className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                      />
                      <span className="text-xs text-white/40 w-16 text-right">{wakeCycleInterval}h</span>
                    </div>
                    <p className="text-xs text-white/30">How often to wake during the sleep cycle</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Tool Options Section */}
          <div id="tools" className="border-t border-white/10 pt-6">
            <h3 className="text-sm font-semibold text-white/80 mb-4">Tool Options</h3>

            <div className="space-y-4">
              <p className="text-xs text-white/40 -mt-2">
                Controls how filesystem tools shape their results. Tighter limits keep tool output from bloating the
                conversation context and slowing prompt prefill on subsequent turns.
              </p>

              {/* read_file default line limit */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-white/60">read_file default line limit</label>
                  <span className="text-xs text-white/40">{readFileDefaultLines} lines</span>
                </div>
                <input
                  type="range"
                  min={100}
                  max={5000}
                  step={100}
                  value={readFileDefaultLines}
                  onChange={(e) => setReadFileDefaultLines(Number(e.target.value))}
                  className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                />
                <p className="text-xs text-white/30">When the agent calls read_file without a limit, return up to this many lines and append a truncation marker so it can paginate with offset.</p>
              </div>

              {/* read_file byte cap */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-white/60">read_file byte cap</label>
                  <span className="text-xs text-white/40">{Math.round(readFileMaxBytes / 1024)} KB</span>
                </div>
                <input
                  type="range"
                  min={32 * 1024}
                  max={2 * 1024 * 1024}
                  step={32 * 1024}
                  value={readFileMaxBytes}
                  onChange={(e) => setReadFileMaxBytes(Number(e.target.value))}
                  className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                />
                <p className="text-xs text-white/30">Hard cap on returned bytes (after line slicing) — safety net for files with pathological line lengths like minified bundles or base64 blobs.</p>
              </div>
            </div>
          </div>

          {/* Bluesky Section */}
          <div id="bluesky" className="border-t border-white/10 pt-6">
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
                  <ToggleSwitch
                    checked={blueskyEnabled}
                    onChange={() => setBlueskyEnabled(!blueskyEnabled)}
                    accentColor="emerald"
                  />
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
                  <ToggleSwitch
                    checked={blueskyAutoSendToAgent}
                    onChange={() => setBlueskyAutoSendToAgent(!blueskyAutoSendToAgent)}
                    accentColor="emerald"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <label className={`block text-sm font-medium ${blueskyAutoSendToAgent ? "text-white/60" : "text-white/30"}`}>Auto-respond to notifications</label>
                    <p className="text-xs text-white/30 mt-0.5">Agent autonomously reviews and replies to mentions/replies</p>
                  </div>
                  <ToggleSwitch
                    checked={blueskyAutoRespond && blueskyAutoSendToAgent}
                    onChange={() => setBlueskyAutoRespond(!blueskyAutoRespond)}
                    accentColor="emerald"
                    disabled={!blueskyAutoSendToAgent}
                  />
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
                  Connect the agent's Bluesky account to receive notifications and interact with the platform.
                  You'll need to create an app password in Bluesky settings.
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
          <div id="tts" className="space-y-3 pt-2 border-t border-white/10">
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
                    <DropdownPanel
                      open={backendDropdownOpen}
                      className="left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto"
                    >
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
                    </DropdownPanel>
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
                      <ToggleSwitch
                        checked={ttsSettings.streamingEnabled}
                        onChange={async () => {
                          const updated = await updateTTSSettings({ streamingEnabled: !ttsSettings.streamingEnabled });
                          if (updated) setTtsSettings(updated);
                        }}
                        accentColor="purple"
                      />
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
                        <DropdownPanel
                          open={boundaryTierDropdownOpen}
                          className="left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto"
                        >
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
                        </DropdownPanel>
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
                  <ToggleSwitch
                    checked={ttsSettings.autoReadEnabled}
                    onChange={async () => {
                      const updated = await updateTTSSettings({ autoReadEnabled: !ttsSettings.autoReadEnabled });
                      if (updated) setTtsSettings(updated);
                    }}
                    accentColor="blue"
                  />
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
                    <DropdownPanel
                      open={voiceDropdownOpen}
                      className="left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto"
                    >
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
                    </DropdownPanel>
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
          {/* Passkeys Section */}
          <div id="passkeys" className="space-y-3 pt-2 border-t border-white/10">
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
