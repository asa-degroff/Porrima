import { useState, useEffect, useCallback, useRef } from "react";
import { ToggleSwitch } from "./ui/ToggleSwitch";
import { Dropdown } from "./ui/Dropdown";
import { Chevron } from "./ui/Chevron";
import { useDropdown } from "../hooks/useDropdown";

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
import { getLlamaPath, updateLlamaPathApi, validateLlamaPathApi, listLlamaBinaries, listEmbeddingBackups, createEmbeddingBackup, deleteEmbeddingBackup, restoreEmbeddingBackup, runEmbeddingMigration, discoverModels, getAllServerHealth, getLlamaServers, controlLlamaServer, getLlamaServerLogs, updateLlamaServerSettings, listAvailableLlamaModels, applyLlamaSlotModel, clearLlamaSlotModelOverride, convertSlotToRouterMode, fetchAutomations, createAutomation, updateAutomation, deleteAutomation, runAutomationNow, resetAutomationPrompts, fetchAutomationRuns, fetchSshConnections, createSshConnection, updateSshConnection, deleteSshConnection, testSshConnection, type OverridableSlotId, type RouterCapableSlotId } from "../api/client";
import type { EmbeddingBackup, MigrationProgressEvent, DiscoveredModel, ServerHealthMap, LlamaServerAction, LlamaServerId, LlamaServerStatus } from "../api/client";
import { getPersona, updatePersona, getPersonaHistory, getPersonaVersion } from "../api/persona";
import { getUserDocument, updateUserDocument, deleteUserDocument } from "../api/user";
import type { AutomationRun, AutomationTask, OllamaModel, Settings, SystemPromptPreset, Theme, TTSSettings, BackgroundEffect, CornerShape, CornerRadius, ActivityShape, BlueskySettings, PersonaStore, UserDocument, LlamaBinaryInfo, LlamaPathInfo, LlamaPathUpdateResult, SshConnection, SshKnownHostsMode } from "../types";
import { getTTSVoices, getTTSSettings, updateTTSSettings } from "../api/tts";
import { SkillsBrowser } from "./SkillsBrowser";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { ProviderIcon } from "./ProviderIcon";
import { usePushNotifications } from "../hooks/usePushNotifications";
import { sendPushTest } from "../api/push";

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
  { id: 'ssh', label: 'Remote Hosts' },
  { id: 'persona', label: 'Persona' },
  { id: 'user-doc', label: 'About You' },
  { id: 'presets', label: 'Presets' },
  { id: 'api-keys', label: 'API Keys' },
  { id: 'images', label: 'Images' },
  { id: 'skills', label: 'Skills' },
  { id: 'extraction', label: 'Extraction' },
  { id: 'system-stats', label: 'System Stats' },
  { id: 'header-image', label: 'Header Image' },
  { id: 'memory-blocks', label: 'Memory Blocks' },
  { id: 'automations', label: 'Automations' },
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

type WebSearchProvider = NonNullable<Settings["defaultWebSearchProvider"]>;

const AUTOMATION_INTERVAL_MINUTES_MIN = 5;
const AUTOMATION_INTERVAL_MINUTES_MAX = 366 * 24 * 60;
const DEFAULT_AUTOMATION_INTERVAL_MINUTES = 24 * 60;
const DEFAULT_AUTOMATION_DAILY_TIME = "09:00";

const WEB_SEARCH_PROVIDER_OPTIONS: Array<{ id: WebSearchProvider; label: string; description: string }> = [
  { id: "brave", label: "Brave Search", description: "Fast snippets from Brave Search API." },
  { id: "exa", label: "Exa", description: "Richer search with highlights, summaries, and deep modes." },
  { id: "tavily", label: "Tavily", description: "Ranked web results with optional answers and date filters." },
];

function coerceWebSearchProvider(provider: Settings["defaultWebSearchProvider"]): WebSearchProvider {
  return WEB_SEARCH_PROVIDER_OPTIONS.some((option) => option.id === provider) ? provider! : "brave";
}

function isVisionModel(model: OllamaModel): boolean {
  const family = model.family.toLowerCase();
  const id = model.id.toLowerCase();
  return Boolean(model.supportsImages) ||
    family.includes("vl") ||
    family.startsWith("qwen35") ||
    id.includes("-vl") ||
    id.includes("vision") ||
    id.includes("llava") ||
    id.includes("pixtral");
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

function clampAutomationIntervalMinutes(value: unknown, fallback = DEFAULT_AUTOMATION_INTERVAL_MINUTES): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, AUTOMATION_INTERVAL_MINUTES_MIN), AUTOMATION_INTERVAL_MINUTES_MAX);
}

function normalizeAutomationTimeOfDay(value: unknown): string {
  return typeof value === "string" && /^\d{2}:\d{2}$/.test(value)
    ? value
    : DEFAULT_AUTOMATION_DAILY_TIME;
}

function formatAutomationDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatAutomationSchedule(task: AutomationTask): string {
  if (task.schedule.type === "daily") {
    return `Daily at ${normalizeAutomationTimeOfDay(task.schedule.timeOfDay)}`;
  }
  const minutes = clampAutomationIntervalMinutes(task.schedule.everyMinutes);
  if (minutes % (24 * 60) === 0) return `Every ${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `Every ${minutes / 60}h`;
  return `Every ${minutes}m`;
}

function automationStatusTone(status?: AutomationRun["status"]): string {
  if (status === "success") return "bg-green-500/10 text-green-300/80 border-green-400/20";
  if (status === "failed") return "bg-red-500/10 text-red-300/80 border-red-400/20";
  if (status === "running") return "bg-purple-500/10 text-purple-200/80 border-purple-400/20";
  return "bg-white/5 text-white/45 border-white/10";
}

function formatAutomationDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return "";
  const start = new Date(startedAt).getTime();
  const finish = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return "";
  const seconds = Math.round((finish - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

interface Props {
  settings: Settings;
  models: OllamaModel[];
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onLogout: () => void;
}

export function SettingsModal({ settings, models, onSave, onClose, onLogout }: Props) {
  const visionModelOptions = (() => {
    const capable = models.filter(isVisionModel);
    return capable.length > 0 ? capable : models;
  })();
  const [defaultModelId, setDefaultModelId] = useState(settings.defaultModelId);
  const [defaultVisionModelId, setDefaultVisionModelId] = useState(settings.defaultVisionModelId || settings.defaultModelId);
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
  const [braveSearchEnabled, setBraveSearchEnabled] = useState(settings.braveSearchEnabled ?? true);
  const [exaSearchEnabled, setExaSearchEnabled] = useState(settings.exaSearchEnabled ?? false);
  const [tavilySearchEnabled, setTavilySearchEnabled] = useState(settings.tavilySearchEnabled ?? false);
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
  const [llamacppSlotBindingMode, setLlamacppSlotBindingMode] = useState<"auto" | "enforced">(settings.llamacppSlotBindingMode ?? "auto");
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
  // Discovered binaries
  const [llamaBinaries, setLlamaBinaries] = useState<LlamaBinaryInfo[]>([]);
  const [llamaBinariesLoading, setLlamaBinariesLoading] = useState(false);
  const [llamaBinaryInput, setLlamaBinaryInput] = useState("");
  const [llamaBinaryValidating, setLlamaBinaryValidating] = useState(false);
  const [llamaBinaryValidation, setLlamaBinaryValidation] = useState<{ valid: boolean; error?: string } | null>(null);
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
  const [activitySaturation, setActivitySaturation] = useState<number>(settings.activitySaturation ?? 85);
  const [presets, setPresets] = useState<SystemPromptPreset[]>(settings.systemPromptPresets || []);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetContent, setEditingPresetContent] = useState<string>("");
  const [presetSaving, setPresetSaving] = useState(false);
  const [presetMessage, setPresetMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [hapticsEnabled, setHapticsEnabled] = useState(settings.hapticsEnabled ?? true);
  const push = usePushNotifications();
  const [pushTestState, setPushTestState] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [sshLoading, setSshLoading] = useState(false);
  const [sshSaving, setSshSaving] = useState(false);
  const [sshTestingId, setSshTestingId] = useState<string | null>(null);
  const [sshMessage, setSshMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [sshDraft, setSshDraft] = useState({
    name: "",
    host: "",
    port: 22,
    username: "",
    identityFile: "",
    knownHostsMode: "accept-new" as SshKnownHostsMode,
    enabled: true,
    allowBash: true,
    allowFileWrite: true,
    allowAbsolutePaths: false,
  });
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
  const [postSynthesisWarmCount, setPostSynthesisWarmCount] = useState(settings.postSynthesisWarmCount ?? 3);
  const [systemStatsEnabled, setSystemStatsEnabled] = useState(settings.systemStatsEnabled ?? false);
  const [systemStatsBufferSeconds, setSystemStatsBufferSeconds] = useState(settings.systemStatsBufferSeconds ?? 60);
  const systemStatsBufferDd = useDropdown();
  // GPU visibility: list of discovered GPUs with visibility toggles
  const [availableGpus, setAvailableGpus] = useState<Array<{ id: string; name: string; driver: string }>>([]);
  const [hiddenGpus, setHiddenGpus] = useState<Set<string>>(() => new Set(settings.systemStatsHiddenGpus ?? []));
  // Header image
  const [headerImageEnabled, setHeaderImageEnabled] = useState(settings.headerImageEnabled ?? false);
  const [headerImageUrl, setHeaderImageUrl] = useState<string | null>(null);
  const [headerImageExists, setHeaderImageExists] = useState(false);
  const [headerImageUploading, setHeaderImageUploading] = useState(false);
  const [automations, setAutomations] = useState<AutomationTask[]>([]);
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const [automationsRunningTaskId, setAutomationsRunningTaskId] = useState<string | null>(null);
  const [automationMessage, setAutomationMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [automationHistoryOpenTaskId, setAutomationHistoryOpenTaskId] = useState<string | null>(null);
  const [automationRunsByTaskId, setAutomationRunsByTaskId] = useState<Record<string, AutomationRun[]>>({});
  const [automationRunsLoadingTaskId, setAutomationRunsLoadingTaskId] = useState<string | null>(null);
  const [automationPromptExpandedTaskId, setAutomationPromptExpandedTaskId] = useState<string | null>(null);
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
  const [maxBlockChars, setMaxBlockChars] = useState(settings.maxBlockChars ?? 4000);
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
  const modelDd = useDropdown();
  const visionModelDd = useDropdown();
  const voiceDd = useDropdown();
  const backendDd = useDropdown();
  const boundaryTierDd = useDropdown();
  const extractionModelDd = useDropdown();
  const embeddingModelDd = useDropdown();
  const rerankerModelDd = useDropdown();
  const titleGenerationModelDd = useDropdown();
  const favoritesDd = useDropdown();
  const imageBackendDd = useDropdown();
  const webSearchProviderDd = useDropdown();
  const sshKnownHostsDd = useDropdown();
  const tocDd = useDropdown();
  // Binary selectors
  const extractionBinaryDd = useDropdown();
  const rerankerBinaryDd = useDropdown();
  const embeddingBinaryDd = useDropdown();
  const titleGenBinaryDd = useDropdown();

  // Per-task dropdown state for automations (avoids hooks-in-map issues)
  const [scheduleOpen, setScheduleOpen] = useState<Record<string, boolean>>({});
  const [activationOpen, setActivationOpen] = useState<Record<string, boolean>>({});
  const scheduleRefMap = useRef<Record<string, React.RefObject<HTMLDivElement | null>>>({});
  const activationRefMap = useRef<Record<string, React.RefObject<HTMLDivElement | null>>>({});

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      for (const taskId in scheduleRefMap.current) {
        const ref = scheduleRefMap.current[taskId];
        if (ref.current && !ref.current.contains(target)) {
          setScheduleOpen(prev => ({ ...prev, [taskId]: false }));
        }
      }
      for (const taskId in activationRefMap.current) {
        const ref = activationRefMap.current[taskId];
        if (ref.current && !ref.current.contains(target)) {
          setActivationOpen(prev => ({ ...prev, [taskId]: false }));
        }
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Discover available GPUs for visibility toggles
  useEffect(() => {
    let cancelled = false;
    async function discover() {
      try {
        const { fetchSystemStats: fetchStats } = await import("../api/client");
        const data = await fetchStats();
        if (cancelled) return;
        if (data.current && data.current.gpus.length > 0) {
          const gpus = data.current.gpus.map((g) => ({ id: g.id, name: g.name, driver: g.driver }));
          setAvailableGpus(gpus);
        }
      } catch {
        // GPU discovery failed — non-critical
      }
    }
    discover();
    return () => { cancelled = true; };
  }, []);

  // Check header image existence on mount
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const { getHeaderImageInfo } = await import("../api/client");
        const info = await getHeaderImageInfo();
        if (cancelled) return;
        if (info.exists) {
          setHeaderImageExists(true);
          setHeaderImageUrl(info.thumbUrl || info.url || null);
        }
      } catch {
        // non-critical
      }
    }
    check();
    return () => { cancelled = true; };
  }, []);

  // Header image handlers
  const handleHeaderImageUpload = useCallback(async (file: File) => {
    setHeaderImageUploading(true);
    try {
      const { uploadHeaderImage } = await import("../api/client");
      const arrayBuf = await file.arrayBuffer();
      await uploadHeaderImage(arrayBuf, file.type);
      // Re-fetch info
      const { getHeaderImageInfo } = await import("../api/client");
      const info = await getHeaderImageInfo();
      setHeaderImageExists(true);
      setHeaderImageUrl(info.thumbUrl || info.url || null);
      // Auto-enable on upload
      setHeaderImageEnabled(true);
    } catch (e: any) {
      console.error("Failed to upload header image:", e);
    } finally {
      setHeaderImageUploading(false);
    }
  }, []);

  const handleHeaderImageRemove = useCallback(async () => {
    try {
      const { deleteHeaderImageApi } = await import("../api/client");
      await deleteHeaderImageApi();
      setHeaderImageExists(false);
      setHeaderImageUrl(null);
      setHeaderImageEnabled(false);
    } catch (e: any) {
      console.error("Failed to remove header image:", e);
    }
  }, []);

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

  // Slot currently mid-apply (drop-in override write + daemon-reload + restart).
  const [applyingSlot, setApplyingSlot] = useState<OverridableSlotId | null>(null);

  // Apply a model to an overridable slot: writes the systemd drop-in, reloads,
  // restarts the unit, and persists the modelId in settings. Replaces the
  // previous "save modelId only" behavior so dropdown selection actually
  // changes the running model. Optimistically updates the dropdown trigger so
  // the selection feels immediate; reverts on error.
  const handleApplySlotModel = useCallback(async (slot: OverridableSlotId, modelId: string) => {
    if (!modelId) return;
    setApplyingSlot(slot);
    setLlamaServerMessage(null);
    let previous: string | null = null;
    if (slot === "title-generation") { previous = titleGenerationModelId; setTitleGenerationModelId(modelId); }
    else if (slot === "extraction") { previous = extractionModelId; setExtractionModelId(modelId); }
    else if (slot === "reranker") { previous = rerankerModelId; setRerankerModelId(modelId); }
    else if (slot === "embedding") { previous = embeddingModel; setEmbeddingModel(modelId); }
    try {
      const result = await applyLlamaSlotModel(slot, modelId);
      const s = result.server;
      setLlamaServers((prev) => prev.map((srv) => srv.id === slot ? s : srv));
      if (s.id === "title-generation" && s.expectedModel) setTitleGenerationModelId(s.expectedModel);
      else if (s.id === "extraction" && s.expectedModel) setExtractionModelId(s.expectedModel);
      else if (s.id === "reranker" && s.expectedModel) setRerankerModelId(s.expectedModel);
      else if (s.id === "embedding" && s.expectedModel) setEmbeddingModel(s.expectedModel);
      setLlamaServerMessage({ type: "ok", text: `Applied ${modelId} to ${s.label}; service restarted.` });
    } catch (e: any) {
      // Revert optimistic update so the trigger reflects the still-running model.
      if (previous !== null) {
        if (slot === "title-generation") setTitleGenerationModelId(previous);
        else if (slot === "extraction") setExtractionModelId(previous);
        else if (slot === "reranker") setRerankerModelId(previous);
        else if (slot === "embedding") setEmbeddingModel(previous);
      }
      setLlamaServerMessage({ type: "err", text: e?.message || "Failed to apply model" });
    } finally {
      setApplyingSlot(null);
    }
  }, [titleGenerationModelId, extractionModelId, rerankerModelId, embeddingModel]);

  const handleConvertToRouter = useCallback(async (slot: RouterCapableSlotId) => {
    setApplyingSlot(slot);
    setLlamaServerMessage(null);
    try {
      const result = await convertSlotToRouterMode(slot);
      setLlamaServers((prev) => prev.map((srv) => srv.id === slot ? result.server : srv));
      setLlamaServerMessage({ type: "ok", text: `${result.server.label} switched to router mode. Model swaps no longer require a restart.` });
    } catch (e: any) {
      setLlamaServerMessage({ type: "err", text: e?.message || "Failed to switch to router mode" });
    } finally {
      setApplyingSlot(null);
    }
  }, []);

  const handleClearSlotOverride = useCallback(async (slot: OverridableSlotId) => {
    setApplyingSlot(slot);
    setLlamaServerMessage(null);
    try {
      const result = await clearLlamaSlotModelOverride(slot);
      setLlamaServers((prev) => prev.map((srv) => srv.id === slot ? result.server : srv));
      setLlamaServerMessage({ type: "ok", text: result.removed ? `Reset ${slot} to unit default.` : `No override was active on ${slot}.` });
    } catch (e: any) {
      setLlamaServerMessage({ type: "err", text: e?.message || "Failed to clear override" });
    } finally {
      setApplyingSlot(null);
    }
  }, []);

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

  // Assign a binary to a specific server slot
  const handleAssignBinary = useCallback(async (slotId: OverridableSlotId, binaryDir: string) => {
    setLlamaServerMessage(null);
    try {
      const binaryPath = binaryDir ? `${binaryDir}/llama-server` : "";
      const result = await updateLlamaServerSettings(slotId, { binaryPath });
      setLlamaServers((prev) => prev.map((s) => s.id === slotId ? result.server : s));
      if (binaryDir) {
        setLlamaServerMessage({ type: "ok", text: `${result.server.label} now uses binary from ${binaryDir.split("/").pop()}.` });
      } else {
        setLlamaServerMessage({ type: "ok", text: `${result.server.label} reset to default binary (llama-current).` });
      }
    } catch (e: any) {
      setLlamaServerMessage({ type: "err", text: e?.message || "Failed to assign binary" });
    }
  }, []);

  // Validate a candidate binary path for registration
  const handleValidateBinaryPath = useCallback(async () => {
    const path = llamaBinaryInput.trim();
    if (!path) return;
    setLlamaBinaryValidating(true);
    setLlamaBinaryValidation(null);
    try {
      const result = await validateLlamaPathApi(path);
      setLlamaBinaryValidation(result);
      if (result.valid) {
        // Add to the binaries list (optimistic update)
        const binName = path.split("/").pop() || "";
        setLlamaBinaries((prev) => [...prev, { path, version: "", isDefault: false }]);
        setLlamaBinaryInput("");
      }
    } catch {
      setLlamaBinaryValidation({ valid: false, error: "Failed to validate path" });
    }
    setLlamaBinaryValidating(false);
  }, [llamaBinaryInput]);

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

  const refreshAutomations = useCallback(async () => {
    setAutomationsLoading(true);
    try {
      const data = await fetchAutomations();
      setAutomations(data.tasks);
      setAutomationsRunningTaskId(data.activeTaskId);
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to load automations" });
    } finally {
      setAutomationsLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshAutomations();
  }, [refreshAutomations]);

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

  // Load discovered binaries
  useEffect(() => {
    let cancelled = false;
    setLlamaBinariesLoading(true);
    listLlamaBinaries()
      .then((bins) => { if (!cancelled) setLlamaBinaries(bins); })
      .catch(() => { if (!cancelled) setLlamaBinaries([]); })
      .finally(() => { if (!cancelled) setLlamaBinariesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Refresh binaries when path is updated (Apply & Restart changes the default)
  const refreshLlamaBinaries = useCallback(async () => {
    try {
      const bins = await listLlamaBinaries();
      setLlamaBinaries(bins);
    } catch { /* already have cached list */ }
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

  // Slot-keyed disk-model loader. Local GGUFs in ~/.local/share/llama-models/
  // are the source of truth for swappable models. listAvailableLlamaModels
  // returns kind-filtered entries; we map to the {id,name} shape the dropdowns
  // already expect.
  const loadDiskModels = useCallback(async (
    slot: OverridableSlotId,
    setModels: (m: DiscoveredModel[]) => void,
    setLoading: (b: boolean) => void
  ) => {
    setLoading(true);
    try {
      const r = await listAvailableLlamaModels(slot);
      setModels(r.models.map((m) => ({ id: m.id, name: m.name })));
    } catch {
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Embedding dropdown: still uses Ollama discovery for provider=ollama.
  // For provider=llamacpp, source from local llama-models dir so swaps go
  // through the systemd-override flow.
  useEffect(() => {
    let cancelled = false;
    if (embeddingProvider === "llamacpp") {
      loadDiskModels("embedding",
        (m) => { if (!cancelled) setEmbeddingModels(m); },
        (b) => { if (!cancelled) setEmbeddingModelsLoading(b); });
      return () => { cancelled = true; };
    }
    const url = embeddingUrl.trim();
    if (!url) {
      setEmbeddingModels([]);
      return;
    }
    setEmbeddingModelsLoading(true);
    const handle = setTimeout(() => {
      discoverModels({ provider: "ollama", kind: "embedding", url })
        .then((r) => { if (!cancelled) setEmbeddingModels(r.models); })
        .catch(() => { if (!cancelled) setEmbeddingModels([]); })
        .finally(() => { if (!cancelled) setEmbeddingModelsLoading(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [embeddingProvider, embeddingUrl, loadDiskModels]);

  useEffect(() => {
    let cancelled = false;
    loadDiskModels("extraction",
      (m) => { if (!cancelled) setExtractionServerModels(m); },
      (b) => { if (!cancelled) setExtractionServerModelsLoading(b); });
    return () => { cancelled = true; };
  }, [loadDiskModels]);

  useEffect(() => {
    if (!rerankerEnabled) return;
    let cancelled = false;
    loadDiskModels("reranker",
      (m) => { if (!cancelled) setRerankerModels(m); },
      (b) => { if (!cancelled) setRerankerModelsLoading(b); });
    return () => { cancelled = true; };
  }, [rerankerEnabled, loadDiskModels]);

  useEffect(() => {
    if (!titleGenerationEnabled) return;
    let cancelled = false;
    loadDiskModels("title-generation",
      (m) => { if (!cancelled) setTitleGenerationModels(m); },
      (b) => { if (!cancelled) setTitleGenerationModelsLoading(b); });
    return () => { cancelled = true; };
  }, [titleGenerationEnabled, loadDiskModels]);

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

  const refreshSshConnections = useCallback(async () => {
    setSshLoading(true);
    try {
      setSshConnections(await fetchSshConnections());
    } catch (e: any) {
      setSshMessage({ type: "err", text: e?.message || "Failed to load SSH connections" });
    } finally {
      setSshLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshSshConnections();
  }, [refreshSshConnections]);

  const handleCreateSshConnection = useCallback(async () => {
    if (!sshDraft.name.trim() || !sshDraft.host.trim()) {
      setSshMessage({ type: "err", text: "Name and host are required." });
      return;
    }
    setSshSaving(true);
    setSshMessage(null);
    try {
      await createSshConnection({
        name: sshDraft.name.trim(),
        host: sshDraft.host.trim(),
        port: Number(sshDraft.port) || 22,
        username: sshDraft.username.trim() || undefined,
        identityFile: sshDraft.identityFile.trim() || undefined,
        knownHostsMode: sshDraft.knownHostsMode,
        enabled: sshDraft.enabled,
        allowBash: sshDraft.allowBash,
        allowFileWrite: sshDraft.allowFileWrite,
        allowAbsolutePaths: sshDraft.allowAbsolutePaths,
      });
      setSshDraft((prev) => ({ ...prev, name: "", host: "", username: "", identityFile: "" }));
      setSshMessage({ type: "ok", text: "SSH connection saved." });
      await refreshSshConnections();
    } catch (e: any) {
      setSshMessage({ type: "err", text: e?.message || "Failed to save SSH connection" });
    } finally {
      setSshSaving(false);
    }
  }, [refreshSshConnections, sshDraft]);

  const patchSshConnection = useCallback(async (id: string, patch: Partial<SshConnection>) => {
    setSshMessage(null);
    try {
      const updated = await updateSshConnection(id, patch);
      setSshConnections((prev) => prev.map((connection) => connection.id === id ? updated : connection));
    } catch (e: any) {
      setSshMessage({ type: "err", text: e?.message || "Failed to update SSH connection" });
    }
  }, []);

  const handleDeleteSshConnection = useCallback(async (id: string) => {
    setSshMessage(null);
    try {
      await deleteSshConnection(id);
      setSshConnections((prev) => prev.filter((connection) => connection.id !== id));
    } catch (e: any) {
      setSshMessage({ type: "err", text: e?.message || "Failed to delete SSH connection" });
    }
  }, []);

  const handleTestSshConnection = useCallback(async (id: string) => {
    setSshTestingId(id);
    setSshMessage(null);
    try {
      const result = await testSshConnection(id);
      setSshMessage({ type: "ok", text: result.output || "SSH connection succeeded." });
    } catch (e: any) {
      setSshMessage({ type: "err", text: e?.message || "SSH connection test failed" });
    } finally {
      setSshTestingId(null);
    }
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
      braveSearchEnabled,
      exaSearchEnabled,
      tavilySearchEnabled,
      defaultWebSearchProvider,
      comfyuiUrl: comfyuiUrl.trim() || undefined,
      sdcppUrl: sdcppUrl.trim() || undefined,
      imageBackend,
      ollamaUrl: ollamaUrl.trim() || undefined,
      llamacppEnabled,
      llamacppUrl: llamacppUrl.trim() || undefined,
      llamacppSharesGpu,
      llamacppSlotBindingMode,
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
      activitySaturation,
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
      postSynthesisWarmCount,
      systemStatsEnabled,
      systemStatsBufferSeconds,
      systemStatsHiddenGpus: Array.from(hiddenGpus),
      headerImageEnabled,
      extractionModelId,
      extractionModelUrl: extractionModelUrl.trim() || undefined,
      extractionFallbackEnabled,
      readFileDefaultLines,
      readFileMaxBytes,
      maxBlockChars,
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

  const replaceAutomation = (task: AutomationTask) => {
    setAutomations((prev) => prev.map((item) => (item.id === task.id ? task : item)));
  };

  const updateAutomationDraft = (id: string, patch: Partial<AutomationTask>) => {
    setAutomations((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const saveAutomationPatch = async (id: string, patch: Partial<AutomationTask>) => {
    setAutomationMessage(null);
    try {
      const updated = await updateAutomation(id, patch);
      replaceAutomation(updated);
      return updated;
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to update automation" });
      await refreshAutomations();
      return null;
    }
  };

  const loadAutomationRuns = async (id: string) => {
    setAutomationRunsLoadingTaskId(id);
    try {
      const runs = await fetchAutomationRuns(id, 25);
      setAutomationRunsByTaskId((prev) => ({ ...prev, [id]: runs }));
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to load automation history" });
    } finally {
      setAutomationRunsLoadingTaskId(null);
    }
  };

  const handleToggleAutomationHistory = async (id: string) => {
    setAutomationMessage(null);
    if (automationHistoryOpenTaskId === id) {
      setAutomationHistoryOpenTaskId(null);
      return;
    }
    setAutomationHistoryOpenTaskId(id);
    await loadAutomationRuns(id);
  };

  const handleAutomationScheduleTypeChange = async (
    task: AutomationTask,
    type: AutomationTask["schedule"]["type"],
  ) => {
    const schedule =
      type === "daily"
        ? {
            type,
            timeOfDay: task.schedule.type === "daily"
              ? normalizeAutomationTimeOfDay(task.schedule.timeOfDay)
              : DEFAULT_AUTOMATION_DAILY_TIME,
          }
        : {
            type,
            everyMinutes: task.schedule.type === "interval"
              ? clampAutomationIntervalMinutes(task.schedule.everyMinutes)
              : DEFAULT_AUTOMATION_INTERVAL_MINUTES,
          };
    updateAutomationDraft(task.id, { schedule });
    await saveAutomationPatch(task.id, { schedule });
  };

  const handleAutomationIntervalChange = (task: AutomationTask, value: string) => {
    const current = task.schedule.type === "interval"
      ? clampAutomationIntervalMinutes(task.schedule.everyMinutes)
      : DEFAULT_AUTOMATION_INTERVAL_MINUTES;
    const schedule = {
      type: "interval" as const,
      everyMinutes: clampAutomationIntervalMinutes(value, current),
    };
    updateAutomationDraft(task.id, { schedule });
  };

  const handleAutomationIntervalBlur = async (task: AutomationTask) => {
    const schedule = {
      type: "interval" as const,
      everyMinutes: task.schedule.type === "interval"
        ? clampAutomationIntervalMinutes(task.schedule.everyMinutes)
        : DEFAULT_AUTOMATION_INTERVAL_MINUTES,
    };
    updateAutomationDraft(task.id, { schedule });
    await saveAutomationPatch(task.id, { schedule });
  };

  const handleAutomationDailyTimeChange = (task: AutomationTask, value: string) => {
    const schedule = { type: "daily" as const, timeOfDay: value };
    updateAutomationDraft(task.id, { schedule });
  };

  const handleAutomationDailyTimeBlur = async (task: AutomationTask) => {
    const schedule = {
      type: "daily" as const,
      timeOfDay: task.schedule.type === "daily"
        ? normalizeAutomationTimeOfDay(task.schedule.timeOfDay)
        : DEFAULT_AUTOMATION_DAILY_TIME,
    };
    updateAutomationDraft(task.id, { schedule });
    await saveAutomationPatch(task.id, { schedule });
  };

  const handleAddAutomation = async () => {
    setAutomationMessage(null);
    try {
      const task = await createAutomation({
        title: "New Automation",
        enabled: false,
        schedule: { type: "interval", everyMinutes: 24 * 60 },
        activationPolicy: "idle",
        promptSteps: [{ id: "step-1", title: "Prompt", prompt: "Describe what this automation should do." }],
        notifications: { enabled: false },
      });
      setAutomations((prev) => [...prev, task].sort((a, b) => a.orderIndex - b.orderIndex));
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to create automation" });
    }
  };

  const handleDeleteAutomation = async (id: string) => {
    setAutomationMessage(null);
    try {
      await deleteAutomation(id);
      setAutomations((prev) => prev.filter((task) => task.id !== id));
      if (automationHistoryOpenTaskId === id) {
        setAutomationHistoryOpenTaskId(null);
      }
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to delete automation" });
    }
  };

  const handleRunAutomation = async (id: string) => {
    setAutomationMessage(null);
    try {
      await runAutomationNow(id);
      setAutomationsRunningTaskId(id);
      setAutomationMessage({ type: "ok", text: "Automation started" });
      if (automationHistoryOpenTaskId === id) {
        await loadAutomationRuns(id);
      }
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to start automation" });
    }
  };

  const handleResetAutomationPrompts = async (id: string) => {
    setAutomationMessage(null);
    try {
      const task = await resetAutomationPrompts(id);
      replaceAutomation(task);
      setAutomationMessage({ type: "ok", text: "Prompts reset" });
    } catch (err: any) {
      setAutomationMessage({ type: "err", text: err?.message || "Failed to reset prompts" });
    }
  };

  const moveAutomation = async (id: string, direction: -1 | 1) => {
    const sorted = [...automations].sort((a, b) => a.orderIndex - b.orderIndex);
    const idx = sorted.findIndex((task) => task.id === id);
    const swapIdx = idx + direction;
    if (idx < 0 || swapIdx < 0 || swapIdx >= sorted.length) return;
    const current = sorted[idx];
    const other = sorted[swapIdx];
    await saveAutomationPatch(current.id, { orderIndex: other.orderIndex });
    await saveAutomationPatch(other.id, { orderIndex: current.orderIndex });
    await refreshAutomations();
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
      // Refresh the path info and binaries list
      getLlamaPath().then(setLlamaPathInfo).catch(() => {});
      refreshLlamaBinaries();
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
            className="text-white hover:text-white transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-40 hover:opacity-70 transition-opacity">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Mobile body — single column with collapsible ToC dropdown */}
        <div className="flex flex-1 overflow-hidden flex-col">
          {/* Collapsible ToC bar — mobile only */}
          <div className="shrink-0 md:hidden border-b border-white/10">
            <div ref={tocDd.ref} className="relative">
              <button
                onClick={tocDd.toggle}
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
                <Chevron open={tocDd.open} size={12} />
              </button>
              <div
                className={`absolute z-40 left-0 right-0 top-full overflow-hidden transition-all ${
                  tocDd.open ? 'max-h-[60vh]' : 'max-h-0'
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
                      onClick={() => { scrollToSection(section.id); tocDd.close(); }}
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
            <label className="block text-sm font-medium text-white/60">Default Chat Model</label>
            <p className="text-xs text-white/30 -mt-1">
              Used for agent, project, and system chats. Quick chats let you pick a model per-chat.
            </p>
            <Dropdown
              state={modelDd}
              trigger={
                <span className="truncate flex-1 text-left">
                  {defaultModelId ? (models.find((m) => m.id === defaultModelId)?.name || defaultModelId) : "Auto (first available)"}
                </span>
              }
            >
              <button
                onClick={() => { setDefaultModelId(""); modelDd.close(); }}
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
                  onClick={() => { setDefaultModelId(m.id); modelDd.close(); }}
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
            </Dropdown>
          </div>

          {/* Inference Servers */}
          <div id="inference" className="space-y-4">
            <h3 className="text-sm font-semibold text-white/80">Inference Servers</h3>
            <p className="text-xs text-white/40 -mt-2">
              Main chat, memory extraction, cross-encoder reranker, embedding, title generation. Each URL can point at a separate instance.
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
                  Optional Ollama server URL. Also the default embedding URL when embedding provider is Ollama.
                </p>
              </div>
            </div>

            {/* Binaries — discovered llama.cpp builds + global symlink management */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm text-white/80">Binaries</h4>
                  <p className="text-xs text-white/30 mt-0.5">
                    Discovered llama.cpp builds. Servers use <code className="text-white/50">llama-current</code> by default unless overridden per-slot.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={refreshLlamaBinaries}
                  disabled={llamaBinariesLoading}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-white/5 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all disabled:opacity-40 shrink-0"
                >
                  {llamaBinariesLoading ? "Scanning..." : "Scan"}
                </button>
              </div>

              <div className="space-y-2 ml-2">
                {/* Default symlink display */}
                {llamaPathInfo && llamaPathInfo.valid && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-white/40">Default (llama-current):</span>
                    <span className="text-white/70 font-mono truncate" title={llamaPathInfo.currentPath}>
                      {llamaPathInfo.currentPath.split("/").pop()}
                    </span>
                    {llamaPathInfo.version && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-400/20 text-[10px] font-medium">
                        v{llamaPathInfo.version}
                      </span>
                    )}
                    <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-400/20 text-[10px] font-medium">default</span>
                  </div>
                )}

                {/* Discovered binaries list */}
                {llamaBinaries.length > 0 && (
                  <div className="space-y-1">
                    {llamaBinaries.map((bin) => (
                      <div key={bin.path} className="flex items-center gap-2 text-xs">
                        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: bin.isDefault ? "#a78bfa" : "#ffffff30" }} />
                        <span className="text-white/70 font-mono truncate" title={bin.path}>
                          {bin.path.split("/").pop()}
                        </span>
                        {bin.version && (
                          <span className="px-1.5 py-0.5 rounded bg-white/5 text-white/50 border border-white/10 text-[10px] font-medium">
                            v{bin.version}
                          </span>
                        )}
                        {bin.isDefault && (
                          <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-400/20 text-[10px] font-medium">default</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Register new binary */}
                <div className="flex gap-2 pt-1">
                  <input
                    type="text"
                    value={llamaBinaryInput}
                    onChange={(e) => { setLlamaBinaryInput(e.target.value); setLlamaBinaryValidation(null); }}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
                    placeholder="/home/asa/bin/llama-b8790"
                    disabled={llamaBinaryValidating}
                  />
                  <button
                    onClick={handleValidateBinaryPath}
                    disabled={!llamaBinaryInput.trim() || llamaBinaryValidating}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all disabled:opacity-40 shrink-0"
                  >
                    {llamaBinaryValidating ? "Checking..." : "Register"}
                  </button>
                </div>
                {llamaBinaryValidation && (
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${llamaBinaryValidation.valid ? "bg-green-400" : "bg-red-400"}`} />
                    <span className={`text-xs ${llamaBinaryValidation.valid ? "text-green-400/80" : "text-red-400/80"}`}>
                      {llamaBinaryValidation.valid ? "Valid — added to registry" : llamaBinaryValidation.error || "Invalid path"}
                    </span>
                  </div>
                )}
              </div>

              {/* Global symlink update */}
              <div className="space-y-2 ml-2 border-t border-white/5 pt-2 mt-1">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={llamaPathInput}
                    onChange={(e) => { setLlamaPathInput(e.target.value); setLlamaPathValidation(null); setLlamaPathMessage(null); }}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-purple-400/30 font-mono"
                    placeholder="/home/asa/bin/llama-b8790"
                    disabled={llamaPathUpdating}
                  />
                  <button
                    onClick={handleValidateLlamaPath}
                    disabled={!llamaPathInput.trim() || llamaPathValidating}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-white/5 border border-white/15 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all disabled:opacity-40 shrink-0"
                  >
                    {llamaPathValidating ? "Checking..." : "Validate"}
                  </button>
                  <button
                    onClick={handleUpdateLlamaPath}
                    disabled={!llamaPathInput.trim() || llamaPathUpdating || (llamaPathValidation !== null && !llamaPathValidation.valid)}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-purple-500/15 border border-purple-400/20 text-purple-300 hover:bg-purple-500/25 transition-all disabled:opacity-40 shrink-0"
                  >
                    {llamaPathUpdating ? "Applying..." : "Set Default"}
                  </button>
                </div>
                {llamaPathValidation && (
                  <div className="flex items-center gap-1.5">
                    <div className={`w-2 h-2 rounded-full ${llamaPathValidation.valid ? "bg-green-400" : "bg-red-400"}`} />
                    <span className={`text-xs ${llamaPathValidation.valid ? "text-green-400/80" : "text-red-400/80"}`}>
                      {llamaPathValidation.valid ? "Valid" : llamaPathValidation.error || "Invalid path"}
                    </span>
                  </div>
                )}
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
                  Set the global default binary. This updates the <code className="text-white/50">~/bin/llama-current</code> symlink and restarts all services.
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
	                              {server.override.active && (
	                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-purple-400/30 bg-purple-500/15 text-purple-200" title={server.override.modelPath || server.override.path}>
	                                  model override
	                                </span>
	                              )}
	                              {server.http.routerMode && (
	                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-400/30 bg-emerald-500/15 text-emerald-200" title="Slot multiplexes models via /v1/models — swaps go through /models/load (no restart)">
	                                  router mode
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
	                                  <div className="flex items-center gap-2">
	                                    <label className="block text-xs text-white/50 w-16">Slots</label>
	                                    <select
	                                      value={llamacppSlotBindingMode}
	                                      onChange={(e) => setLlamacppSlotBindingMode(e.target.value as "auto" | "enforced")}
	                                      className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/80 outline-none focus:ring-1 focus:ring-purple-400/30"
	                                    >
	                                      <option value="auto">Auto (recommended)</option>
	                                      <option value="enforced">Enforced id_slot</option>
	                                    </select>
	                                    <span className="text-xs text-white/30">Auto lets llama.cpp restore prompt cache.</span>
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
	                                    <Dropdown
	                                      state={extractionModelDd}
	                                      triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
	                                      panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
	                                      trigger={<span className="truncate flex-1 text-left">{extractionModelId || "Select…"}</span>}
	                                    >
	                                      {extractionServerModels.map((m) => (
	                                        <button key={m.id} onClick={() => {
	                                          extractionModelDd.close();
	                                          handleApplySlotModel("extraction", m.id);
	                                        }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === extractionModelId ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                          {m.name}
	                                        </button>
	                                      ))}
	                                      <button onClick={() => setExtractionUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                    </Dropdown>
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
	
                              {/* Binary selector */}
                              <div>
                                <label className="block text-xs text-white/50 mb-1">Binary</label>
                                {(() => {
                                  // resolvedBinary is a full path (/home/asa/bin/ik-llama/llama-server) but dropdown options are directories. Strip the binary name.
                                  const selected = server.resolvedBinary !== server.defaultBinary
                                    ? server.resolvedBinary.substring(0, server.resolvedBinary.lastIndexOf('/'))
                                    : "";
                                  const label = selected
                                    ? llamaBinaries.find(b => b.path === selected)?.path.split("/").pop() || selected.split("/").pop() || selected
                                    : "default (llama-current)";
                                  return (
                                    <Dropdown
                                      state={extractionBinaryDd}
                                      triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
                                      panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
                                      trigger={<span className="truncate flex-1 text-left">{label}</span>}
                                    >
                                      <button onClick={() => {
                                        extractionBinaryDd.close();
                                        handleAssignBinary(server.id as any, "");
                                      }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${!selected ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                                        default (llama-current)
                                      </button>
                                      {llamaBinaries.filter(b => !b.isDefault).map(b => (
                                        <button key={b.path} onClick={() => {
                                          extractionBinaryDd.close();
                                          handleAssignBinary(server.id as any, b.path);
                                        }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${selected === b.path ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                                          {b.path.split("/").pop()} (v{b.version || "?"})
                                        </button>
                                      ))}
                                    </Dropdown>
                                  );
                                })()}
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
	                                      <Dropdown
	                                        state={rerankerModelDd}
	                                        triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
	                                        panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
	                                        trigger={<span className="truncate flex-1 text-left">{rerankerModelId || "Select…"}</span>}
	                                      >
	                                        {rerankerModels.map((m) => (
	                                          <button key={m.id} onClick={() => {
	                                            rerankerModelDd.close();
	                                            handleApplySlotModel("reranker", m.id);
	                                          }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === rerankerModelId ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                            {m.name}
	                                          </button>
	                                        ))}
	                                        <button onClick={() => setRerankerUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                      </Dropdown>
	                                    ) : (
	                                      <input type="text" value={rerankerModelId} onChange={(e) => setRerankerModelId(e.target.value)}
	                                        onBlur={() => handleLlamaServerSettings("reranker", { modelId: rerankerModelId })}
	                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 font-mono outline-none focus:ring-1 focus:ring-purple-400/30"
	                                        placeholder="qwen3-reranker" />
	                                    )}
	                                  </div>
	                                </div>
	                              )}
	
                              {/* Binary selector */}
                              <div>
                                <label className="block text-xs text-white/50 mb-1">Binary</label>
                                {(() => {
                                  // resolvedBinary is a full path (/home/asa/bin/ik-llama/llama-server) but dropdown options are directories. Strip the binary name.
                                  const selected = server.resolvedBinary !== server.defaultBinary
                                    ? server.resolvedBinary.substring(0, server.resolvedBinary.lastIndexOf('/'))
                                    : "";
                                  const label = selected
                                    ? llamaBinaries.find(b => b.path === selected)?.path.split("/").pop() || selected.split("/").pop() || selected
                                    : "default (llama-current)";
                                  return (
                                    <Dropdown
                                      state={rerankerBinaryDd}
                                      triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
                                      panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
                                      trigger={<span className="truncate flex-1 text-left">{label}</span>}
                                    >
                                      <button onClick={() => {
                                        rerankerBinaryDd.close();
                                        handleAssignBinary(server.id as any, "");
                                      }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${!selected ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                                        default (llama-current)
                                      </button>
                                      {llamaBinaries.filter(b => !b.isDefault).map(b => (
                                        <button key={b.path} onClick={() => {
                                          rerankerBinaryDd.close();
                                          handleAssignBinary(server.id as any, b.path);
                                        }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${selected === b.path ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                                          {b.path.split("/").pop()} (v{b.version || "?"})
                                        </button>
                                      ))}
                                    </Dropdown>
                                  );
                                })()}
                              </div>
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
	                                  <Dropdown
	                                    state={embeddingModelDd}
	                                    triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
	                                    panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
	                                    trigger={<span className="truncate flex-1 text-left">{embeddingModel || "Select…"}</span>}
	                                  >
	                                    {embeddingModels.map((m) => (
	                                      <button key={m.id} onClick={() => {
	                                        embeddingModelDd.close();
	                                        if (embeddingProvider === "llamacpp") {
	                                          handleApplySlotModel("embedding", m.id);
	                                        } else {
	                                          setEmbeddingModel(m.id);
	                                          handleLlamaServerSettings("embedding", { modelId: m.id });
	                                        }
	                                      }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === embeddingModel ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                        {m.name}
	                                      </button>
	                                    ))}
	                                    <button onClick={() => setEmbeddingUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                  </Dropdown>
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

							{/* Binary selector — llama.cpp only */}
							{embeddingProvider === "llamacpp" && (
							  <div>
							    <label className="block text-xs text-white/50 mb-1">Binary</label>
							    {(() => {
							      // resolvedBinary is a full path but dropdown options are directories. Strip the binary name.
							      const selected = server.resolvedBinary !== server.defaultBinary
							        ? server.resolvedBinary.substring(0, server.resolvedBinary.lastIndexOf('/'))
							        : "";
							      const label = selected
							        ? llamaBinaries.find(b => b.path === selected)?.path.split("/").pop() || selected.split("/").pop() || selected
							        : "default (llama-current)";
							      return (
							        <Dropdown
							          state={embeddingBinaryDd}
							          triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
							          panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
							          trigger={<span className="truncate flex-1 text-left">{label}</span>}
							        >
							          <button onClick={() => {
							            embeddingBinaryDd.close();
							            handleAssignBinary(server.id as any, "");
							          }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${!selected ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
							            default (llama-current)
							          </button>
							          {llamaBinaries.filter(b => !b.isDefault).map(b => (
							            <button key={b.path} onClick={() => {
							              embeddingBinaryDd.close();
							              handleAssignBinary(server.id as any, b.path);
							            }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${selected === b.path ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
							              {b.path.split("/").pop()} (v{b.version || "?"})
							            </button>
							          ))}
							        </Dropdown>
							      );
							    })()}
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
	                                      <Dropdown
	                                        state={titleGenerationModelDd}
	                                        triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
	                                        panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
	                                        trigger={<span className="truncate flex-1 text-left">{titleGenerationModelId || "Select…"}</span>}
	                                      >
	                                        {titleGenerationModels.map((m) => (
	                                          <button key={m.id} onClick={() => {
	                                            titleGenerationModelDd.close();
	                                            handleApplySlotModel("title-generation", m.id);
	                                          }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${m.id === titleGenerationModelId ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
	                                            {m.name}
	                                          </button>
	                                        ))}
	                                        <button onClick={() => setTitleGenerationUseCustom(true)} className="w-full text-left px-3 py-2 text-xs italic text-white/50 hover:bg-white/10 border-t border-white/5 mt-1">Custom…</button>
	                                      </Dropdown>
	                                    ) : (
	                                      <input type="text" value={titleGenerationModelId} onChange={(e) => setTitleGenerationModelId(e.target.value)}
	                                        onBlur={() => handleLlamaServerSettings("title-generation", { modelId: titleGenerationModelId })}
	                                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white/80 font-mono outline-none focus:ring-1 focus:ring-purple-400/30"
	                                        placeholder="qwen3.5-0.8b" />
	                                    )}
	                                  </div>
	                                </div>
	                              )}
	
                              {/* Binary selector */}
                              <div>
                                <label className="block text-xs text-white/50 mb-1">Binary</label>
                                {(() => {
                                  // resolvedBinary is a full path but dropdown options are directories. Strip the binary name.
                                  const selected = server.resolvedBinary !== server.defaultBinary
                                    ? server.resolvedBinary.substring(0, server.resolvedBinary.lastIndexOf('/'))
                                    : "";
                                  const label = selected
                                    ? llamaBinaries.find(b => b.path === selected)?.path.split("/").pop() || selected.split("/").pop() || selected
                                    : "default (llama-current)";
                                  return (
                                    <Dropdown
                                      state={titleGenBinaryDd}
                                      triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white/80 outline-none hover:bg-white/10 transition-all cursor-pointer font-mono"
                                      panelClassName="left-0 right-0 top-full mt-1 max-h-[240px] overflow-y-auto"
                                      trigger={<span className="truncate flex-1 text-left">{label}</span>}
                                    >
                                      <button onClick={() => {
                                        titleGenBinaryDd.close();
                                        handleAssignBinary(server.id as any, "");
                                      }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${!selected ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                                        default (llama-current)
                                      </button>
                                      {llamaBinaries.filter(b => !b.isDefault).map(b => (
                                        <button key={b.path} onClick={() => {
                                          titleGenBinaryDd.close();
                                          handleAssignBinary(server.id as any, b.path);
                                        }} className={`w-full text-left px-3 py-2 text-xs font-mono transition-all ${selected === b.path ? "text-white" : "text-white/60 hover:bg-white/10"}`}>
                                          {b.path.split("/").pop()} (v{b.version || "?"})
                                        </button>
                                      ))}
                                    </Dropdown>
                                  );
                                })()}
                              </div>
                              <p className="text-xs text-white/30">Tiny CPU-only instance for generating short chat titles.</p>
	                            </div>
	                          )}
	                          {(server.id === "title-generation" || server.id === "extraction" || server.id === "reranker" || server.id === "embedding") && (
	                            <>
	                              {(applyingSlot === server.id || server.override.active) && (
	                                <div className="flex items-start justify-between gap-2 rounded-lg border border-purple-400/15 bg-purple-500/5 p-2">
	                                  <div className="text-xs text-white/60 min-w-0">
	                                    {applyingSlot === server.id ? (
	                                      <span className="text-purple-200">{server.http.routerMode ? "Loading model via /models/load…" : "Applying… writing override and restarting service."}</span>
	                                    ) : (
	                                      <>
	                                        <span className="text-purple-200">Drop-in override active.</span>{" "}
	                                        <span className="text-white/45 font-mono truncate inline-block max-w-full" title={server.override.modelPath || ""}>
	                                          {server.override.modelPath || "(uses --models-dir / router mode)"}
	                                        </span>
	                                      </>
	                                    )}
	                                  </div>
	                                  {server.override.active && applyingSlot !== server.id && (
	                                    <button
	                                      type="button"
	                                      onClick={() => handleClearSlotOverride(server.id as OverridableSlotId)}
	                                      className="px-2 py-1 rounded-md text-[11px] font-medium bg-white/5 border border-white/10 text-white/60 hover:bg-white/10 transition-all shrink-0"
	                                    >
	                                      Reset to default
	                                    </button>
	                                  )}
	                                </div>
	                              )}
	                              {(server.id === "title-generation" || server.id === "extraction") && !server.http.routerMode && applyingSlot !== server.id && (
	                                <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-400/15 bg-emerald-500/5 p-2">
	                                  <p className="text-xs text-white/60 min-w-0">
	                                    Switch this slot to router mode to swap models without restarting the service. Reset to default reverts.
	                                  </p>
	                                  <button
	                                    type="button"
	                                    onClick={() => handleConvertToRouter(server.id as RouterCapableSlotId)}
	                                    className="px-2 py-1 rounded-md text-[11px] font-medium bg-emerald-500/15 border border-emerald-400/25 text-emerald-200 hover:bg-emerald-500/25 transition-all shrink-0"
	                                  >
	                                    Switch to router mode
	                                  </button>
	                                </div>
	                              )}
	                            </>
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
            <Dropdown
              state={favoritesDd}
              trigger={
                <span className="truncate flex-1 text-left">
                  {favoriteModels.size === 0
                    ? "No favorites selected"
                    : `${favoriteModels.size} favorite${favoriteModels.size === 1 ? "" : "s"} selected`}
                </span>
              }
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
            </Dropdown>
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
              Re-embedding rebuilds vector tables for every memory. This can take several minutes on large stores and the chat is unavailable while vectors are being rewritten. A backup is strongly recommended.
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
            <Dropdown
              state={visionModelDd}
              trigger={
                <span className="truncate flex-1 text-left">
                  {models.find((m) => m.id === defaultVisionModelId)?.name || defaultVisionModelId}
                </span>
              }
            >
              {visionModelOptions.map((m) => (
                <button
                  key={m.id}
                  onClick={() => { setDefaultVisionModelId(m.id); visionModelDd.close(); }}
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
            </Dropdown>
            <p className="text-white/30 text-xs">
              Model used for image analysis. Defaults to your chat model.
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
                    saturation={activitySaturation}
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
                style={{ backgroundColor: `hsl(${activityHue}, ${activitySaturation}%, 55%)` }}
              />
            </div>

            {/* Saturation slider */}
            <div className="flex items-center gap-3 mt-2">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={activitySaturation}
                onChange={(e) => setActivitySaturation(Number(e.target.value))}
                className="flex-1 h-2 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white/30 [&::-webkit-slider-thumb]:shadow-md [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white/80 [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white/30 [&::-moz-range-thumb]:shadow-md [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-track]:transparent"
                style={{
                  background: `linear-gradient(to right, hsl(${activityHue}, 0%, 55%), hsl(${activityHue}, 100%, 55%))`,
                }}
              />
              <span className="text-white/30 text-xs w-8 text-right tabular-nums">{activitySaturation}%</span>
            </div>

            <div className="flex items-center gap-2 mt-2">
              <PolyhedronLogo
                isActive={true}
                shape={activityShape}
                hue={activityHue}
                saturation={activitySaturation}
                count={3}
                size={16}
                gap={2}
                speed={0.6}
              />
              <span className="text-white/30 text-xs">
                Hue {activityHue}°{activityHue === 38 && activitySaturation === 85 ? ' (default)' : ''}
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

          {/* Remote Hosts */}
          <div id="ssh" className="space-y-4 pt-2 border-t border-white/10">
            <div>
              <h3 className="text-sm font-medium text-white/70">Remote Hosts</h3>
              <p className="text-xs text-white/30 mt-1">
                SSH hosts can be attached to projects so file and bash tools run in the remote workspace.
              </p>
            </div>

            {sshMessage && (
              <div className={`text-xs p-2 rounded-lg border ${
                sshMessage.type === "ok"
                  ? "bg-green-500/10 border-green-400/20 text-green-300/80"
                  : "bg-red-500/10 border-red-400/20 text-red-300/80"
              }`}>
                {sshMessage.text}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <input
                type="text"
                value={sshDraft.name}
                onChange={(e) => setSshDraft((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Name"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
              />
              <input
                type="text"
                value={sshDraft.host}
                onChange={(e) => setSshDraft((prev) => ({ ...prev, host: e.target.value }))}
                placeholder="Host or Tailscale DNS name"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
              />
              <input
                type="text"
                value={sshDraft.username}
                onChange={(e) => setSshDraft((prev) => ({ ...prev, username: e.target.value }))}
                placeholder="Username"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
              />
              <input
                type="number"
                min={1}
                max={65535}
                value={sshDraft.port}
                onChange={(e) => setSshDraft((prev) => ({ ...prev, port: Number(e.target.value) || 22 }))}
                placeholder="Port"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
              />
              <input
                type="text"
                value={sshDraft.identityFile}
                onChange={(e) => setSshDraft((prev) => ({ ...prev, identityFile: e.target.value }))}
                placeholder="Identity file, optional"
                className="md:col-span-2 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all"
              />
              <Dropdown
                state={sshKnownHostsDd}
                trigger={
                  <span className="truncate flex-1 text-left">
                    {sshDraft.knownHostsMode === "accept-new" ? "Accept new" : sshDraft.knownHostsMode === "strict" ? "Strict" : "Disabled"}
                  </span>
                }
              >
                {(["accept-new", "strict", "off"] as SshKnownHostsMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => { setSshDraft((prev) => ({ ...prev, knownHostsMode: mode })); sshKnownHostsDd.close(); }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all ${
                      mode === sshDraft.knownHostsMode ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                    style={{
                      backgroundColor: mode === sshDraft.knownHostsMode ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
                      color: mode === sshDraft.knownHostsMode ? `rgba(var(--theme-secondary-text))` : '',
                    }}
                  >
                    {mode === "accept-new" ? "Accept new host keys" : mode === "strict" ? "Strict known hosts" : "Disable host key checks"}
                  </button>
                ))}
              </Dropdown>
              <button
                type="button"
                onClick={handleCreateSshConnection}
                disabled={sshSaving}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-emerald-500/15 border border-emerald-400/25 text-emerald-200 hover:bg-emerald-500/25 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {sshSaving ? "Saving..." : "Add Host"}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
              <label className="flex items-center gap-2 text-white/50">
                <input type="checkbox" checked={sshDraft.allowBash} onChange={(e) => setSshDraft((prev) => ({ ...prev, allowBash: e.target.checked }))} />
                Bash
              </label>
              <label className="flex items-center gap-2 text-white/50">
                <input type="checkbox" checked={sshDraft.allowFileWrite} onChange={(e) => setSshDraft((prev) => ({ ...prev, allowFileWrite: e.target.checked }))} />
                File writes
              </label>
              <label className="flex items-center gap-2 text-white/50">
                <input type="checkbox" checked={sshDraft.allowAbsolutePaths} onChange={(e) => setSshDraft((prev) => ({ ...prev, allowAbsolutePaths: e.target.checked }))} />
                Absolute paths
              </label>
            </div>

            <div className="space-y-2">
              {sshLoading ? (
                <p className="text-xs text-white/35">Loading remote hosts...</p>
              ) : sshConnections.length === 0 ? (
                <p className="text-xs text-white/35">No remote hosts configured.</p>
              ) : (
                sshConnections.map((connection) => (
                  <div key={connection.id} className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-white/75 truncate">{connection.name}</p>
                        <p className="text-xs text-white/35 font-mono truncate">
                          {connection.username ? `${connection.username}@` : ""}{connection.host}:{connection.port}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleTestSshConnection(connection.id)}
                          disabled={sshTestingId === connection.id}
                          className="px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/10 text-white/55 hover:text-white/80 hover:bg-white/10 transition-all disabled:opacity-50"
                        >
                          {sshTestingId === connection.id ? "Testing..." : "Test"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSshConnection(connection.id)}
                          className="px-2 py-1 rounded-md text-[11px] bg-red-500/10 border border-red-400/15 text-red-300/70 hover:bg-red-500/20 transition-all"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                      <label className="flex items-center gap-2 text-white/50">
                        <input type="checkbox" checked={connection.enabled} onChange={(e) => patchSshConnection(connection.id, { enabled: e.target.checked })} />
                        Enabled
                      </label>
                      <label className="flex items-center gap-2 text-white/50">
                        <input type="checkbox" checked={connection.allowBash} onChange={(e) => patchSshConnection(connection.id, { allowBash: e.target.checked })} />
                        Bash
                      </label>
                      <label className="flex items-center gap-2 text-white/50">
                        <input type="checkbox" checked={connection.allowFileWrite} onChange={(e) => patchSshConnection(connection.id, { allowFileWrite: e.target.checked })} />
                        Writes
                      </label>
                      <label className="flex items-center gap-2 text-white/50">
                        <input type="checkbox" checked={connection.allowAbsolutePaths} onChange={(e) => patchSshConnection(connection.id, { allowAbsolutePaths: e.target.checked })} />
                        Absolute
                      </label>
                    </div>
                  </div>
                ))
              )}
            </div>
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
              Optional. Share your name, preferences, and context about you.
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
              <Dropdown
                state={webSearchProviderDd}
                panelClassName="left-0 right-0 top-full mt-1 overflow-hidden"
                trigger={
                  <span className="truncate flex-1 text-left">
                    {WEB_SEARCH_PROVIDER_OPTIONS.find((p) => p.id === defaultWebSearchProvider)?.label || "Brave Search"}
                  </span>
                }
              >
                {WEB_SEARCH_PROVIDER_OPTIONS.map((provider) => (
                  <button
                    key={provider.id}
                    onClick={() => { setDefaultWebSearchProvider(provider.id); webSearchProviderDd.close(); }}
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
              </Dropdown>
              <p className="text-white/30 text-xs">
                Used when the web_search agent tool does not specify a provider. Agents can still override it for a specific search.
              </p>
            </div>
            {/* Provider enable toggles */}
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
                <input type="checkbox" checked={braveSearchEnabled} onChange={(e) => setBraveSearchEnabled(e.target.checked)} className="rounded border-white/20 bg-white/5 text-blue-400 focus:ring-blue-400/30" />
                Brave Search
              </label>
              <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
                <input type="checkbox" checked={exaSearchEnabled} onChange={(e) => setExaSearchEnabled(e.target.checked)} className="rounded border-white/20 bg-white/5 text-blue-400 focus:ring-blue-400/30" />
                Exa
              </label>
              <label className="flex items-center gap-2 text-sm text-white/60 cursor-pointer select-none">
                <input type="checkbox" checked={tavilySearchEnabled} onChange={(e) => setTavilySearchEnabled(e.target.checked)} className="rounded border-white/20 bg-white/5 text-blue-400 focus:ring-blue-400/30" />
                Tavily
              </label>
            </div>
            {/* Brave key — shown when enabled */}
            {braveSearchEnabled && (
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
            )}
            {/* Exa key — shown when enabled */}
            {exaSearchEnabled && (
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
                  Required for Exa-powered web search. Provides rich results with highlights, summaries, and deep reasoning. Get a key at{" "}
                  <a href="https://exa.ai" target="_blank" rel="noopener noreferrer" className="text-blue-400/60 hover:text-blue-400/80">
                    exa.ai
                  </a>
                </p>
              </div>
            )}
            {/* Tavily key — shown when enabled */}
            {tavilySearchEnabled && (
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
            )}
          </div>

          {/* Image Generation */}
          <div id="images" className="space-y-3 pt-2 border-t border-white/10">
            <h3 className="text-sm font-medium text-white/70">Image Generation</h3>
            <div className="space-y-2">
              <label className="block text-sm text-white/50">Backend</label>
              <Dropdown
                state={imageBackendDd}
                panelClassName="left-0 right-0 top-full mt-1 overflow-hidden"
                trigger={
                  <span className="truncate flex-1 text-left">
                    {imageBackend === "sdcpp" ? "sd-server (stable-diffusion.cpp)" : "ComfyUI"}
                  </span>
                }
              >
                {(["comfyui", "sdcpp"] as const).map((b) => (
                  <button
                    key={b}
                    onClick={() => { setImageBackend(b); imageBackendDd.close(); }}
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
              </Dropdown>
              <p className="text-white/30 text-xs">
                Used by the Image Sandbox. sd-server loads one model at startup; configure via its launch command.
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

                <div>
                  <label className="block text-sm font-medium text-white/60">Post-synthesis cache warm</label>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={postSynthesisWarmCount}
                      onChange={(e) => setPostSynthesisWarmCount(Number(e.target.value))}
                      className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                    />
                    <span className="text-xs text-white/40 w-16 text-right">{postSynthesisWarmCount === 0 ? 'off' : `${postSynthesisWarmCount} chats`}</span>
                  </div>
                  <p className="text-xs text-white/30">Warm caches for recent chats after synthesis. 0 disables. System chat is always warmed.</p>
                </div>

	              </div>
	            </div>
	          </div>

	          {/* System Stats */}
	          <div id="system-stats" className="border-t border-white/10 pt-6">
	            <h3 className="text-sm font-semibold text-white/80 mb-4">System Stats</h3>
	            <div className="space-y-4">
	              <div className="flex items-center justify-between">
	                <div>
	                  <label className="block text-sm font-medium text-white/60">Resource monitor</label>
	                  <p className="text-xs text-white/30 mt-0.5">Show CPU, RAM, swap, and GPU usage sparklines in the sidebar</p>
	                </div>
	                <ToggleSwitch checked={systemStatsEnabled} onChange={() => setSystemStatsEnabled(!systemStatsEnabled)} accentColor="purple" />
	              </div>

	              {systemStatsEnabled && (
	                <div>
	                  <label className="block text-sm font-medium text-white/60">History window</label>
	                  <p className="text-xs text-white/30 mb-2">How long to keep historical stats</p>
	                  <Dropdown
	                    state={systemStatsBufferDd}
	                    trigger={
	                      <span className="truncate flex-1 text-left text-xs text-white/70">
	                        {[30, 60, 120, 300, 600].find((v) => v === systemStatsBufferSeconds)
	                          ? { 30: "30 seconds", 60: "1 minute", 120: "2 minutes", 300: "5 minutes", 600: "10 minutes" }[systemStatsBufferSeconds]
	                          : "1 minute"}
	                      </span>
	                    }
	                  >
	                    {[
	                      { value: 30, label: "30 seconds" },
	                      { value: 60, label: "1 minute" },
	                      { value: 120, label: "2 minutes" },
	                      { value: 300, label: "5 minutes" },
	                      { value: 600, label: "10 minutes" },
	                    ].map((opt) => (
	                      <button
	                        key={opt.value}
	                        onClick={() => { setSystemStatsBufferSeconds(opt.value); systemStatsBufferDd.close(); }}
	                        className={`w-full text-left px-3 py-2 text-xs transition-all flex items-center justify-between ${
	                          opt.value === systemStatsBufferSeconds ? "text-white" : "text-white/60 hover:bg-white/10 hover:text-white/80"
	                        }`}
	                        style={{
	                          backgroundColor: opt.value === systemStatsBufferSeconds ? `rgba(var(--theme-secondary), 0.15)` : 'transparent',
	                          color: opt.value === systemStatsBufferSeconds ? `rgba(var(--theme-secondary-text))` : '',
	                        }}
	                      >
	                        <span>{opt.label}</span>
	                      </button>
	                    ))}
	                  </Dropdown>
	                </div>
	              )}

	                {/* GPU Visibility */}
	                {systemStatsEnabled && availableGpus.length > 0 && (
	                  <div>
	                    <label className="block text-sm font-medium text-white/60">GPU visibility</label>
	                    <p className="text-xs text-white/30 mb-2">Select which GPUs to show in the sidebar</p>
	                    <div className="space-y-1.5">
	                      {availableGpus.map((gpu) => {
	                        const isHidden = hiddenGpus.has(gpu.id);
	                        return (
	                          <div key={gpu.id} className="flex items-center justify-between">
	                            <div className="flex items-center gap-2">
                              <ToggleSwitch
                                checked={!isHidden}
                                onChange={() => {
                                  const next = new Set(hiddenGpus);
                                  if (isHidden) next.delete(gpu.id);
                                  else next.add(gpu.id);
                                  setHiddenGpus(next);
                                }}
                                accentColor="purple"
                              />
	                              <div>
	                                <span className="text-xs text-white/60">{gpu.name}</span>
	                                <span className="text-[10px] text-white/30 ml-1.5">({gpu.id})</span>
	                              </div>
	                            </div>
	                            <span className="text-[10px] text-white/30">{gpu.driver}</span>
	                          </div>
	                        );
	                      })}
	                    </div>
	                  </div>
	                )}
	              </div>
	            </div>

	          {/* Header Image */}
	          <div id="header-image" className="border-t border-white/10 pt-6">
	            <h3 className="text-sm font-semibold text-white/80 mb-4">Header Image</h3>
	            <div className="space-y-4">
	              <div className="flex items-center justify-between">
	                <div>
	                  <label className="block text-sm font-medium text-white/60">Show in chat header</label>
	                  <p className="text-xs text-white/30 mt-0.5">Display a custom image in the header instead of the model name</p>
	                </div>
	                <ToggleSwitch checked={headerImageEnabled} onChange={() => setHeaderImageEnabled(!headerImageEnabled)} accentColor="purple" />
	              </div>

	              {/* Image preview and upload */}
	              <div className="flex items-center gap-4">
	                {/* Preview box — matches the SystemStatsBar square window style */}
	                <div className="rounded-lg bg-black/20 border border-white/[0.05] p-1.5 flex items-center justify-center shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)]"
	                  style={{ width: 56, height: 56 }}>
	                  {headerImageUrl ? (
	                    <img
	                      src={headerImageUrl}
	                      alt="Header preview"
	                      className="w-8 h-8 rounded-md object-cover"
	                    />
	                  ) : (
	                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-white/20">
	                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
	                      <circle cx="8.5" cy="8.5" r="1.5"/>
	                      <polyline points="21 15 16 10 5 21"/>
	                    </svg>
	                  )}
	                </div>

	                <div className="flex-1 space-y-2">
	                  {!headerImageExists ? (
	                    <label className="inline-flex items-center gap-2 px-3 py-2 text-xs text-white/70 bg-white/5 hover:bg-white/10 rounded-lg cursor-pointer transition-colors border border-white/10">
	                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
	                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
	                        <polyline points="17 8 12 3 7 8"/>
	                        <line x1="12" y1="3" x2="12" y2="15"/>
	                      </svg>
	                      {headerImageUploading ? 'Uploading...' : 'Upload image'}
	                      <input
	                        type="file"
	                        accept="image/*"
	                        className="hidden"
	                        onChange={(e) => {
	                          const file = e.target.files?.[0];
	                          if (file) handleHeaderImageUpload(file);
	                          e.target.value = '';
	                        }}
	                        disabled={headerImageUploading}
	                      />
	                    </label>
	                  ) : (
	                    <div className="flex items-center gap-2">
	                      <label className="inline-flex items-center gap-2 px-3 py-2 text-xs text-white/70 bg-white/5 hover:bg-white/10 rounded-lg cursor-pointer transition-colors border border-white/10">
	                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
	                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
	                          <polyline points="17 8 12 3 7 8"/>
	                          <line x1="12" y1="3" x2="12" y2="15"/>
	                        </svg>
	                        {headerImageUploading ? 'Replacing...' : 'Replace'}
	                        <input
	                          type="file"
	                          accept="image/*"
	                          className="hidden"
	                          onChange={(e) => {
	                            const file = e.target.files?.[0];
	                            if (file) handleHeaderImageUpload(file);
	                            e.target.value = '';
	                          }}
	                          disabled={headerImageUploading}
	                        />
	                      </label>
	                      <button
	                        onClick={handleHeaderImageRemove}
	                        className="px-3 py-2 text-xs text-red-300/70 hover:text-red-300 bg-red-500/5 hover:bg-red-500/10 rounded-lg transition-colors border border-red-500/10"
	                      >
	                        Remove
	                      </button>
	                    </div>
	                  )}
	                  <p className="text-[10px] text-white/25">Square images work best. Cropped to center on upload.</p>
	                </div>
	              </div>
	            </div>
	          </div>

	          {/* Memory Blocks */}
	          <div id="memory-blocks" className="border-t border-white/10 pt-6">
	            <h3 className="text-sm font-semibold text-white/80 mb-4">Memory Blocks</h3>
	            <div className="space-y-2">
	              <div className="flex items-center justify-between">
	                <div>
	                  <label className="block text-sm font-medium text-white/60">Max block characters</label>
	                  <p className="text-xs text-white/30 mt-0.5">Maximum characters per memory block. Changes apply at next synthesis cycle.</p>
	                </div>
	                <span className="text-xs text-white/40">{maxBlockChars.toLocaleString()} chars</span>
	              </div>
	              <input
	                type="range"
	                min={1000}
	                max={10000}
	                step={500}
	                value={maxBlockChars}
	                onChange={(e) => setMaxBlockChars(Number(e.target.value))}
	                className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
	              />
	            </div>
	          </div>

	          {/* Automations Section */}
	          <div id="automations" className="border-t border-white/10 pt-6">
	            <div className="flex items-center justify-between gap-3 mb-4">
	              <div>
	                <h3 className="text-sm font-semibold text-white/80">Automations</h3>
	                <p className="text-xs text-white/30 mt-0.5">Recurring system-chat tasks with ordered schedules, editable prompts, and optional push notifications.</p>
	              </div>
	              <button
	                onClick={handleAddAutomation}
	                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/15 border border-purple-400/20 text-purple-200 hover:bg-purple-500/25 transition-all shrink-0"
	              >
	                Add
	              </button>
	            </div>

	            {automationMessage && (
	              <div className={`text-xs p-2 rounded mb-3 ${automationMessage.type === "ok" ? "bg-green-500/10 text-green-300/80" : "bg-red-500/10 text-red-300/80"}`}>
	                {automationMessage.text}
	              </div>
	            )}

	            {automationsLoading ? (
	              <p className="text-xs text-white/40">Loading automations...</p>
	            ) : (
	              <div className="space-y-3">
	                {[...automations].sort((a, b) => a.orderIndex - b.orderIndex).map((task, index, list) => {
	                  const everyMinutes = task.schedule.type === "interval"
	                    ? clampAutomationIntervalMinutes(task.schedule.everyMinutes)
	                    : DEFAULT_AUTOMATION_INTERVAL_MINUTES;
	                  const dailyTime = task.schedule.type === "daily"
	                    ? normalizeAutomationTimeOfDay(task.schedule.timeOfDay)
	                    : DEFAULT_AUTOMATION_DAILY_TIME;
	                  const isRunning = automationsRunningTaskId === task.id;
	                  const historyOpen = automationHistoryOpenTaskId === task.id;
	                  const historyLoading = automationRunsLoadingTaskId === task.id;
	                  const historyRuns = automationRunsByTaskId[task.id] || [];
                  const schedRef = scheduleRefMap.current[task.id] || (scheduleRefMap.current[task.id] = { current: null });
                  const actRef = activationRefMap.current[task.id] || (activationRefMap.current[task.id] = { current: null });
                  const scheduleState = {
                    open: scheduleOpen[task.id] ?? false,
                    setOpen: (v: boolean) => setScheduleOpen(prev => ({ ...prev, [task.id]: v })),
                    toggle: () => setScheduleOpen(prev => ({ ...prev, [task.id]: !prev[task.id] })),
                    close: () => setScheduleOpen(prev => ({ ...prev, [task.id]: false })),
                    ref: schedRef,
                  };
                  const activationState = {
                    open: activationOpen[task.id] ?? false,
                    setOpen: (v: boolean) => setActivationOpen(prev => ({ ...prev, [task.id]: v })),
                    toggle: () => setActivationOpen(prev => ({ ...prev, [task.id]: !prev[task.id] })),
                    close: () => setActivationOpen(prev => ({ ...prev, [task.id]: false })),
                    ref: actRef,
                  };
                  return (
	                    <div key={task.id} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-3">
	                      <div className="flex items-start justify-between gap-3">
	                        <div className="min-w-0 flex-1">
	                          <div className="flex items-center gap-2">
	                            {task.builtIn ? (
	                              <h4 className="text-sm font-medium text-white/70 truncate">{task.title}</h4>
	                            ) : (
	                              <input
	                                value={task.title}
	                                onChange={(e) => updateAutomationDraft(task.id, { title: e.target.value })}
	                                onBlur={() => saveAutomationPatch(task.id, { title: task.title })}
	                                className="min-w-0 flex-1 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-sm text-white/80 outline-none focus:border-purple-400/30"
	                              />
	                            )}
	                            {task.builtIn && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-white/35">Built-in</span>}
	                          </div>
	                          <p className="text-[11px] text-white/30 mt-1">
	                            {formatAutomationSchedule(task)}
	                            {task.lastRunAt ? ` · Last ran ${formatAutomationDate(task.lastRunAt)}` : " · Not run yet"}
	                            {task.nextRunAt ? ` · Next ${formatAutomationDate(task.nextRunAt)}` : ""}
	                            {task.lastStatus ? ` · ${task.lastStatus}` : ""}
	                            {task.consecutiveFailures ? ` · ${task.consecutiveFailures} failures` : ""}
	                          </p>
	                        </div>
	                        <ToggleSwitch
	                          checked={task.enabled}
	                          onChange={() => {
	                            updateAutomationDraft(task.id, { enabled: !task.enabled });
	                            saveAutomationPatch(task.id, { enabled: !task.enabled });
	                          }}
	                          accentColor="purple"
	                        />
	                      </div>

	                      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
	                        <label className="space-y-1">
	                          <span className="block text-[11px] text-white/45">Schedule</span>
	                          <Dropdown
	                            state={scheduleState}
	                            trigger={
	                              <span className="truncate flex-1 text-left">
	                                {task.schedule.type === "interval" ? "Interval" : "Daily"}
	                              </span>
	                            }
	                            triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/75 outline-none hover:bg-white/10 transition-all cursor-pointer"
	                            panelClassName="left-0 right-0 top-full mt-1 max-h-[120px] overflow-y-auto"
	                          >
	                            <button
	                              onClick={() => {
	                                handleAutomationScheduleTypeChange(task, "interval");
	                                scheduleState.close();
	                              }}
	                              className={`w-full text-left px-2 py-1.5 text-xs transition-all ${
	                                task.schedule.type === "interval" ? "text-white" : "text-white/50 hover:bg-white/10 hover:text-white/70"
	                              }`}
	                            >
	                              Interval
	                            </button>
	                            <button
	                              onClick={() => {
	                                handleAutomationScheduleTypeChange(task, "daily");
	                                scheduleState.close();
	                              }}
	                              className={`w-full text-left px-2 py-1.5 text-xs transition-all ${
	                                task.schedule.type === "daily" ? "text-white" : "text-white/50 hover:bg-white/10 hover:text-white/70"
	                              }`}
	                            >
	                              Daily
	                            </button>
	                          </Dropdown>
	                        </label>

	                        {task.schedule.type === "daily" ? (
	                          <label className="space-y-1">
	                            <span className="block text-[11px] text-white/45">Time</span>
	                            <input
	                              type="time"
	                              step={300}
	                              value={dailyTime}
	                              onChange={(e) => handleAutomationDailyTimeChange(task, e.target.value)}
	                              onBlur={() => handleAutomationDailyTimeBlur(task)}
	                              className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/75 outline-none focus:border-purple-400/30"
	                            />
	                          </label>
	                        ) : (
	                          <label className="space-y-1">
	                            <span className="block text-[11px] text-white/45">Every</span>
	                          <div className="flex items-center gap-2">
	                            <input
	                              type="number"
	                              min={AUTOMATION_INTERVAL_MINUTES_MIN}
	                              max={AUTOMATION_INTERVAL_MINUTES_MAX}
	                              step={5}
	                              value={everyMinutes}
	                              onChange={(e) => handleAutomationIntervalChange(task, e.target.value)}
	                              onBlur={() => handleAutomationIntervalBlur(task)}
	                              className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/75 outline-none focus:border-purple-400/30"
	                            />
	                            <span className="text-[11px] text-white/35">min</span>
	                          </div>
	                          </label>
	                        )}

	                        <label className="space-y-1">
	                          <span className="block text-[11px] text-white/45">Activation</span>
	                          <Dropdown
	                            state={activationState}
	                            trigger={
	                              <span className="truncate flex-1 text-left">
	                                {task.activationPolicy === "idle" ? "Idle" : task.activationPolicy === "sleep_only" ? "Sleep only" : "Manual only"}
	                              </span>
	                            }
	                            triggerClassName="w-full flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/75 outline-none hover:bg-white/10 transition-all cursor-pointer"
	                            panelClassName="left-0 right-0 top-full mt-1 max-h-[150px] overflow-y-auto"
	                          >
	                            <button
	                              onClick={() => {
	                                updateAutomationDraft(task.id, { activationPolicy: "idle" as const });
	                                saveAutomationPatch(task.id, { activationPolicy: "idle" });
	                                activationState.close();
	                              }}
	                              className={`w-full text-left px-2 py-1.5 text-xs transition-all ${
	                                task.activationPolicy === "idle" ? "text-white" : "text-white/50 hover:bg-white/10 hover:text-white/70"
	                              }`}
	                            >
	                              Idle
	                            </button>
	                            <button
	                              onClick={() => {
	                                updateAutomationDraft(task.id, { activationPolicy: "sleep_only" as const });
	                                saveAutomationPatch(task.id, { activationPolicy: "sleep_only" });
	                                activationState.close();
	                              }}
	                              className={`w-full text-left px-2 py-1.5 text-xs transition-all ${
	                                task.activationPolicy === "sleep_only" ? "text-white" : "text-white/50 hover:bg-white/10 hover:text-white/70"
	                              }`}
	                            >
	                              Sleep only
	                            </button>
	                            <button
	                              onClick={() => {
	                                updateAutomationDraft(task.id, { activationPolicy: "manual_only" as const });
	                                saveAutomationPatch(task.id, { activationPolicy: "manual_only" });
	                                activationState.close();
	                              }}
	                              className={`w-full text-left px-2 py-1.5 text-xs transition-all ${
	                                task.activationPolicy === "manual_only" ? "text-white" : "text-white/50 hover:bg-white/10 hover:text-white/70"
	                              }`}
	                            >
	                              Manual only
	                            </button>
	                          </Dropdown>
	                        </label>

	                        <div className="flex items-end justify-between gap-2">
	                          <label className="flex items-center gap-2 pb-1">
	                            <input
	                              type="checkbox"
	                              checked={task.notifications.enabled}
	                              onChange={(e) => {
	                                const notifications = { ...task.notifications, enabled: e.target.checked };
	                                updateAutomationDraft(task.id, { notifications });
	                                saveAutomationPatch(task.id, { notifications });
	                              }}
	                              className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-purple-400 focus:ring-purple-400/30"
	                            />
	                            <span className="text-[11px] text-white/45">Push on response</span>
	                          </label>
	                        </div>

	                        <label className="space-y-1">
	                          <span className="block text-[11px] text-white/45">Timeout</span>
	                          <div className="flex items-center gap-2">
	                            <input
	                              type="number"
	                              min={1}
	                              max={240}
	                              step={5}
	                              value={Math.round(task.timeoutMs / 60_000)}
	                              onChange={(e) => {
	                                const minutes = Math.max(1, Math.min(240, Number(e.target.value) || 1));
	                                updateAutomationDraft(task.id, { timeoutMs: minutes * 60_000 });
	                              }}
	                              onBlur={() => {
	                                const minutes = Math.max(1, Math.min(240, Math.round(task.timeoutMs / 60_000)));
	                                updateAutomationDraft(task.id, { timeoutMs: minutes * 60_000 });
	                                saveAutomationPatch(task.id, { timeoutMs: task.timeoutMs });
	                              }}
	                              className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/75 outline-none focus:border-purple-400/30"
	                            />
	                            <span className="text-[11px] text-white/35">min</span>
	                          </div>
	                        </label>

	                        <label className="space-y-1">
	                          <span className="block text-[11px] text-white/45">Max Turns</span>
	                          <input
	                            type="number"
	                            min={1}
	                            max={100}
	                            step={1}
	                            value={task.maxIterations}
	                            onChange={(e) => {
	                              const val = Math.max(1, Math.min(100, Number(e.target.value) || 1));
	                              updateAutomationDraft(task.id, { maxIterations: val });
	                            }}
	                            onBlur={() => {
	                              saveAutomationPatch(task.id, { maxIterations: task.maxIterations });
	                            }}
	                            className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white/75 outline-none focus:border-purple-400/30"
	                          />
	                        </label>
	                      </div>

	                      <div>
	                        <button
	                              onClick={() => setAutomationPromptExpandedTaskId(automationPromptExpandedTaskId === task.id ? null : task.id)}
	                              className="flex items-center gap-1.5 text-[11px] font-medium text-white/45 hover:text-white/60 transition-colors mb-1.5"
	                        >
	                              <Chevron open={automationPromptExpandedTaskId === task.id} size={10} />
	                              Prompts ({task.promptSteps.length})
	                        </button>
	                        {automationPromptExpandedTaskId === task.id ? (
	                              <div className="space-y-2">
	                                    {task.promptSteps.map((step, stepIndex) => (
	                                          <label key={step.id} className="block space-y-1">
	                                                <span className="block text-[11px] text-white/45">{step.title}</span>
	                                                <textarea
	                                                      value={step.prompt}
	                                                      onChange={(e) => {
	                                                            const promptSteps = task.promptSteps.map((s, i) => i === stepIndex ? { ...s, prompt: e.target.value } : s);
	                                                            updateAutomationDraft(task.id, { promptSteps });
	                                                      }}
	                                                      onBlur={() => saveAutomationPatch(task.id, { promptSteps: task.promptSteps })}
	                                                      rows={task.kind === "synthesis" ? 5 : 4}
	                                                      className="w-full bg-white/5 border border-white/10 rounded-md px-2.5 py-2 text-xs text-white/75 placeholder-white/25 outline-none focus:border-purple-400/30 resize-y"
	                                                />
	                                          </label>
	                                    ))}
	                              </div>
	                        ) : (
	                              <div className="space-y-1.5">
	                                    {task.promptSteps.map((step) => (
	                                          <div key={step.id} className="flex items-start gap-2">
	                                                <span className="text-[11px] text-white/35 shrink-0 mt-px">{step.title}</span>
	                                                <span className="text-[11px] text-white/20 truncate flex-1">
	                                                      {step.prompt ? step.prompt.split("\n")[0]?.substring(0, 80) : "—"}
	                                                </span>
	                                          </div>
	                                    ))}
	                              </div>
	                        )}
	                      </div>

	                      <div className="flex flex-wrap items-center gap-2">
	                        <button
	                          onClick={() => moveAutomation(task.id, -1)}
	                          disabled={index === 0}
	                          className="px-2 py-1 rounded-md text-xs bg-white/5 border border-white/10 text-white/50 hover:text-white/75 disabled:opacity-30 disabled:hover:text-white/50 transition-all"
	                        >
	                          Up
	                        </button>
	                        <button
	                          onClick={() => moveAutomation(task.id, 1)}
	                          disabled={index === list.length - 1}
	                          className="px-2 py-1 rounded-md text-xs bg-white/5 border border-white/10 text-white/50 hover:text-white/75 disabled:opacity-30 disabled:hover:text-white/50 transition-all"
	                        >
	                          Down
	                        </button>
	                        <button
	                          onClick={() => handleRunAutomation(task.id)}
	                          disabled={!!automationsRunningTaskId}
	                          className="px-2 py-1 rounded-md text-xs bg-purple-500/10 border border-purple-400/20 text-purple-200/80 hover:bg-purple-500/20 disabled:opacity-40 transition-all"
	                        >
	                          {isRunning ? "Running" : "Run now"}
	                        </button>
	                        <button
	                          onClick={() => handleToggleAutomationHistory(task.id)}
	                          className="px-2 py-1 rounded-md text-xs bg-white/5 border border-white/10 text-white/50 hover:text-white/75 transition-all"
	                        >
	                          {historyOpen ? "Hide history" : "History"}
	                        </button>
	                        {task.builtIn && (
	                          <button
	                            onClick={() => handleResetAutomationPrompts(task.id)}
	                            className="px-2 py-1 rounded-md text-xs bg-white/5 border border-white/10 text-white/50 hover:text-white/75 transition-all"
	                          >
	                            Reset prompts
	                          </button>
	                        )}
	                        {!task.builtIn && (
	                          <button
	                            onClick={() => handleDeleteAutomation(task.id)}
	                            className="ml-auto px-2 py-1 rounded-md text-xs bg-red-500/10 border border-red-400/20 text-red-200/70 hover:bg-red-500/20 transition-all"
	                          >
	                            Delete
	                          </button>
	                        )}
	                      </div>

	                      {historyOpen && (
	                        <div className="border-t border-white/10 pt-3 space-y-2">
	                          <div className="flex items-center justify-between gap-2">
	                            <h5 className="text-xs font-medium text-white/60">Run history</h5>
	                            <button
	                              onClick={() => loadAutomationRuns(task.id)}
	                              disabled={historyLoading}
	                              className="px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/10 text-white/45 hover:text-white/70 disabled:opacity-40 transition-all"
	                            >
	                              {historyLoading ? "Loading" : "Refresh"}
	                            </button>
	                          </div>
	                          {historyLoading && historyRuns.length === 0 ? (
	                            <p className="text-xs text-white/35">Loading run history...</p>
	                          ) : historyRuns.length === 0 ? (
	                            <p className="text-xs text-white/35">No runs recorded.</p>
	                          ) : (
	                            <div className="max-h-72 overflow-y-auto divide-y divide-white/10">
	                              {historyRuns.map((run) => {
	                                const duration = formatAutomationDuration(run.startedAt, run.finishedAt);
	                                return (
	                                  <div key={run.id} className="py-2 space-y-1.5">
	                                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
	                                      <span className={`px-1.5 py-0.5 rounded border ${automationStatusTone(run.status)}`}>
	                                        {run.status}
	                                      </span>
	                                      <span className="text-white/45">{formatAutomationDate(run.startedAt)}</span>
	                                      <span className="text-white/30">{run.origin}</span>
	                                      {duration && <span className="text-white/30">{duration}</span>}
	                                      {typeof run.toolCallCount === "number" && (
	                                        <span className="text-white/30">{run.toolCallCount} tools</span>
	                                      )}
	                                      {typeof run.assistantMessageIndex === "number" && (
	                                        <span className="text-white/25">message {run.assistantMessageIndex + 1}</span>
	                                      )}
	                                    </div>
	                                    {run.error ? (
	                                      <p className="text-xs text-red-200/70 whitespace-pre-wrap">{run.error}</p>
	                                    ) : run.summary ? (
	                                      <p className="text-xs text-white/50 whitespace-pre-wrap">{run.summary}</p>
	                                    ) : (
	                                      <p className="text-xs text-white/25">No summary captured.</p>
	                                    )}
	                                  </div>
	                                );
	                              })}
	                            </div>
	                          )}
	                        </div>
	                      )}
	                    </div>
	                  );
	                })}
	              </div>
	            )}
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
                {/* Master toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="block text-sm font-medium text-white/60">Enable TTS</label>
                    <p className="text-xs text-white/30 mt-0.5">Show speaker buttons on messages</p>
                  </div>
                  <ToggleSwitch
                    checked={ttsSettings.enabled}
                    onChange={async () => {
                      const updated = await updateTTSSettings({ enabled: !ttsSettings.enabled });
                      if (updated) setTtsSettings(updated);
                    }}
                    accentColor="purple"
                  />
                </div>

                {/* Backend selector */}
                <div className="space-y-1">
                  <label className="block text-sm text-white/50">TTS Backend</label>
                  <Dropdown
                    state={backendDd}
                    trigger={
                      <span className="truncate flex-1 text-left">
                        {ttsSettings.backend === "kokoro" ? "Kokoro (Standard)" : "Qwen3-TTS (Streaming)"}
                      </span>
                    }
                  >
                    <button
                      onClick={async () => {
                        const updated = await updateTTSSettings({ backend: "kokoro", voice: "af_heart" });
                        if (updated) setTtsSettings(updated);
                        backendDd.close();
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
                        backendDd.close();
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
                  </Dropdown>
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
                      <Dropdown
                        state={boundaryTierDd}
                        trigger={
                          <span className="truncate flex-1 text-left">
                            {ttsSettings.streamingBoundaryTier === "clause"
                              ? "Clause (faster, ~1ms)"
                              : "Sentence (better prosody, ~5ms)"}
                          </span>
                        }
                      >
                        <button
                          onClick={async () => {
                            const updated = await updateTTSSettings({ streamingBoundaryTier: "clause" });
                            if (updated) setTtsSettings(updated);
                            boundaryTierDd.close();
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
                            boundaryTierDd.close();
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
                      </Dropdown>
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
                  <Dropdown
                    state={voiceDd}
                    trigger={
                      <span className="truncate flex-1 text-left">
                        {(() => {
                          for (const cat of ttsVoices) {
                            const v = cat.voices.find((v) => v.id === ttsSettings.voice);
                            if (v) return `${v.name} (${v.id})`;
                          }
                          return ttsSettings.voice;
                        })()}
                      </span>
                    }
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
                              voiceDd.close();
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
                  </Dropdown>
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
