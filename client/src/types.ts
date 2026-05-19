export interface MessageUsage {
  input: number;
  output: number;
  totalTokens: number;
}

export type ModelProgressPhase = "loading" | "prefill" | "generating";
export type ModelProgressCacheState = "hot" | "partial" | "cold" | "unknown";
export type ModelProgressConfidence = "matched-slot" | "inferred-active-slot" | "unknown";
export type InferenceActivityPhase = "prefill" | "decode";

export interface ModelProgress {
  phase: ModelProgressPhase;
  modelId: string;
  chatId?: string;
  baseUrl?: string;
  slotId?: number;
  processedTokens?: number;
  promptTokens?: number;
  progress?: number;
  elapsedMs: number;
  /** When true, the progress event should be displayed to the user. */
  showIndicator?: boolean;
  estimatedRemainingMs?: number;
  cacheState?: ModelProgressCacheState;
  confidence: ModelProgressConfidence;
  updatedAt: number;
  receivedAt?: number;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ChatToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  images?: ImageAttachment[]; // For tools that return images (e.g., generate_and_review)
}

/** A segment represents one unit of agent output in chronological order */
export interface MessageSegment {
  seq: number;
  type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual" | "compaction_marker";
  content?: string;
  toolCall?: ChatToolCall;
  toolResult?: ChatToolResult;
  artifact?: Artifact;
  generatedImage?: GeneratedImage;
  visual?: InlineVisual;
  /** Client-only: live tool status during streaming (not persisted) */
  liveStatus?: { name: string; status: "running" | "done" | "error"; result?: string };
}

export interface ImageAttachment {
  data: string;      // base64-encoded (no data: prefix)
  mimeType: string;  // e.g. "image/png"
  name: string;      // original filename
  id?: string;       // server-stored image ID
  url?: string;      // full-resolution URL (e.g. /api/user-images/:id/image.jpg)
  thumbUrl?: string;  // thumbnail URL (e.g. /api/user-images/:id/thumb)
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  thinkingDurationMs?: number;
  usage?: MessageUsage;
  toolCalls?: ChatToolCall[];
  toolResults?: ChatToolResult[];
  artifacts?: Artifact[];
  generatedImages?: GeneratedImage[];
  visuals?: InlineVisual[];
  images?: ImageAttachment[];
  queued?: boolean;
  timestamp: number;
  /** Ordered segments for interleaved display - replaces toolCalls/toolResults/artifacts order */
  segments?: MessageSegment[];
  /** Marks this message as a compaction summary (inserted when messages are removed due to context limits) */
  _isCompactionSummary?: boolean;
  /** Message is preserved for UI display but excluded from the LLM context */
  _outOfContext?: boolean;
  /** Number of messages that were compacted to create this summary */
  _compactedMessageCount?: number;
  /** Archive IDs represented by this compaction summary (used by deferred enrichment) */
  _archiveIds?: string[];
  /** Marks this message as in-progress (streaming/tool execution not yet complete) */
  _inProgress?: boolean;
  /** Marks this message as a system-generated message (not from agent response) */
  _isSystemMessage?: boolean;
  /** Hidden system row should be merged into the next user message, not replayed as prefix history. */
  _mergeIntoNextUserMessage?: boolean;
  _isMidTurnCompaction?: boolean;
  _compactionRemovedCount?: number;
  _compactionCycle?: number;
  /** Marks this message as a synthesis trigger — excluded from delayed extraction */
  _isSynthesisMessage?: boolean;
  /** Automation metadata for scheduled system-chat turns. */
  _isAutomationMessage?: boolean;
  _automationTaskId?: string;
  _automationRunId?: string;
  /** Empty assistant placeholder inserted when the user sends a steering message.
   *  While set, streaming deltas from the pre-steering generation are not applied here
   *  (they land on the previous assistant msg via message_complete). Cleared by follow_up_start. */
  _steeringPending?: boolean;
  /** Groups canonical split assistant rows that belong to one visible assistant turn. */
  _toolLoopId?: string;
  /** True when this row is one tool-use iteration, not the final assistant answer. */
  _toolLoopFragment?: boolean;
  /** pi-ai provider identity used when this assistant row was generated. */
  _provider?: string;
  _api?: string;
  _model?: string;
  /** Brief summary of what was done, generated for long assistant messages */
  recap?: string;
}

export type ChatType = "agent" | "quick" | "bluesky" | "system";

export interface Chat {
  id: string;
  title: string;
  type: ChatType;
  modelId: string;
  systemPrompt: string;
  contextWindow?: number;
  messages: ChatMessage[];
  /** Absolute index of messages[0] when this Chat carries a paged message window. */
  messageOffset?: number;
  /** Total persisted messages for this chat when this Chat carries a paged window. */
  messageTotal?: number;
  /** True when older messages exist before messageOffset. */
  hasMoreMessages?: boolean;
  createdAt: string;
  lastModified: string;
  activeSkills?: string[]; // List of active skill names
  projectId?: string; // Optional project association
  // Delayed extraction tracking
  lastDelayedExtractionAt?: string;
  lastDelayedExtractionMessageIndex?: number;
}

export type AutomationKind = "synthesis" | "wake" | "custom";
export type AutomationScheduleType = "interval" | "daily";
export type AutomationActivationPolicy = "idle" | "sleep_only" | "manual_only";
export type AutomationRunStatus = "running" | "success" | "failed" | "skipped";

export interface AutomationSchedule {
  type: AutomationScheduleType;
  /** Interval schedule, in minutes. */
  everyMinutes?: number;
  /** Daily schedule, "HH:mm" in local server time. */
  timeOfDay?: string;
}

export interface AutomationPromptStep {
  id: string;
  title: string;
  prompt: string;
}

export interface AutomationNotificationSettings {
  enabled: boolean;
  titleTemplate?: string;
}

export interface AutomationTask {
  id: string;
  kind: AutomationKind;
  title: string;
  enabled: boolean;
  builtIn: boolean;
  orderIndex: number;
  chatId: string;
  schedule: AutomationSchedule;
  activationPolicy: AutomationActivationPolicy;
  promptSteps: AutomationPromptStep[];
  notifications: AutomationNotificationSettings;
  maxIterations: number;
  timeoutMs: number;
  lastRunAt?: string;
  nextRunAt?: string;
  lastStatus?: AutomationRunStatus;
  consecutiveFailures?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRun {
  id: string;
  taskId: string;
  status: AutomationRunStatus;
  origin: "scheduler" | "manual" | "migration";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  summary?: string;
  toolCallCount?: number;
  chatId?: string;
  assistantMessageIndex?: number;
}

export interface ChatListItem {
  id: string;
  title: string;
  type: ChatType;
  lastModified: string;
  preview: string;
  projectId?: string;
}

export interface ChatMessageWindow {
  messages: ChatMessage[];
  offset: number;
  total: number;
  hasMoreBefore: boolean;
}

export type ProjectLocationType = "local" | "ssh";

export interface Project {
  id: string;
  name: string;
  path: string;
  locationType?: ProjectLocationType;
  sshConnectionId?: string;
  color: string;
  pinned: boolean;
  createdAt: string;
  lastModified: string;
}

export type SshKnownHostsMode = "strict" | "accept-new" | "off";

export interface SshConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  identityFile?: string;
  knownHostsMode: SshKnownHostsMode;
  enabled: boolean;
  allowBash: boolean;
  allowFileWrite: boolean;
  allowAbsolutePaths: boolean;
  createdAt: string;
  lastModified: string;
}

export interface PersonaStore {
  content: string;
  lastModified: string | null;
  path?: string;
}

export interface UserDocument {
  content: string;
  lastModified: string | null;
  path?: string;
}

export type InferenceProvider = "ollama" | "llamacpp";

export interface OllamaModel {
  id: string;
  name: string;
  parameterSize: string;
  family: string;
  contextWindow: number;
  supportsImages?: boolean;
  provider?: InferenceProvider;  // Default: "ollama" for backward compat
}

export interface ConversationSearchResult {
  chatId: string;
  chatTitle: string | null;
  messageIndex: number;
  role: string;
  content: string;
  rank: number;
}

export type Theme = "default" | "ocean" | "forest" | "crimson" | "mono" | "strawberry" | "coffee" | "emerald" | "copper" | "oxidized-copper" | "iron" | "rust";
export type BackgroundEffect = "static" | "ripple-grid" | "scan-lines" | "ripple-dots";
export type CornerShape = "round" | "squircle";
export type CornerRadius = "compact" | "default" | "generous";
export type ActivityShape = "octahedron" | "cube" | "tetrahedron";

export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}

export type WebSearchProvider = "brave" | "exa" | "tavily";

export interface Settings {
  defaultModelId: string;
  defaultVisionModelId?: string;
  defaultSystemPrompt: string;
  braveApiKey: string;
  exaApiKey: string;
  tavilyApiKey: string;
  braveSearchEnabled?: boolean;
  exaSearchEnabled?: boolean;
  tavilySearchEnabled?: boolean;
  defaultWebSearchProvider?: WebSearchProvider;
  comfyuiUrl?: string;
  sdcppUrl?: string;
  imageBackend?: "comfyui" | "sdcpp";
  modelContextWindows?: Record<string, number>;
  theme?: Theme;
  backgroundEffect?: BackgroundEffect;
  flatBackground?: boolean;
  chromaticAberration?: boolean;
  mouseWarp?: boolean;
  cornerShape?: CornerShape;
  cornerRadius?: CornerRadius;
  activityShape?: ActivityShape;
  activityHue?: number;
  activitySaturation?: number;
  systemPromptPresets?: SystemPromptPreset[];
  hapticsEnabled?: boolean;
  defaultVisionPreset?: string;
  // Delayed memory extraction settings
  delayedExtractionEnabled?: boolean;
  delayedExtractionThresholdMinutes?: number;
  delayedExtractionMessageCap?: number;
  // Corpus enrichment batch size (how many entries to process per check)
  enrichmentBatchSize?: number;
  // Extraction model configuration
  extractionModelId?: string;
  extractionModelUrl?: string;      // Direct URL for dedicated extraction model (e.g., http://localhost:8083)
  extractionFallbackEnabled?: boolean;
  // Ollama server URL (shared by model discovery, title gen, zeitgeist, vision,
  // GPU coordination, and the default embedding URL when embeddingProvider is
  // "ollama"). default "http://localhost:11434".
  ollamaUrl?: string;
  // llama.cpp server settings
  llamacppEnabled?: boolean;
  llamacppUrl?: string;         // default "http://localhost:8080"
  llamacppSharesGpu?: boolean;  // default true
  // "auto" lets llama.cpp select physical slots and restore prompt cache;
  // "enforced" sends app-managed id_slot leases.
  llamacppSlotBindingMode?: "auto" | "enforced";
  // Extraction server (CPU-only llama.cpp instance)
  extractionCtxSize?: number;   // default 16384 — context window for extraction server
  // Reranker server (CPU-only llama.cpp instance)
  rerankerEnabled?: boolean;    // default true
  rerankerUrl?: string;         // default "http://localhost:8082"
  rerankerModelId?: string;     // default "qwen3-reranker"
  // Title generation server (CPU-only llama.cpp instance, tiny model)
  titleGenerationEnabled?: boolean;  // default true
  titleGenerationUrl?: string;       // default "http://localhost:8085"
  titleGenerationModelId?: string;   // default "qwen3.5-0.8b"
  // Embedding server (Ollama or llama.cpp)
  embeddingProvider?: "ollama" | "llamacpp";
  embeddingUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  // Model favorites
  favoriteModels?: string[];
  showOnlyFavorites?: boolean;
  // Per-model llama.cpp chat_template_kwargs. When true, passes
  // preserve_thinking:true so the model sees its own historical reasoning
  // traces (Qwen3.6+ feature). Ignored by models that don't recognize the kwarg.
  modelPreserveThinking?: Record<string, boolean>;
  bluesky?: BlueskySettings;
  // Last active chat ID (for warm cache indicator)
  lastActiveChatId?: string;
  // Sleep mode — tracks when the user manually triggered synthesis
  sleepModeTriggeredAt?: string;
  // User activity tracking — stamped on every user-initiated message send
  lastUserActivityAt?: string;
  // Agent completion tracking — stamped when the agent's last response completed
  lastAgentCompletedAt?: string;
  // Sleep cycle — when user is idle for this many minutes, the sleep cycle begins
  sleepCycleThresholdMinutes?: number;
  // Wake cycle — periodic autonomous exploration during sleep cycle
  wakeCycleEnabled?: boolean;
  wakeCycleIntervalHours?: number;
  postSynthesisWarmCount?: number;
  systemStatsEnabled?: boolean;
  systemStatsBufferSeconds?: number;
  systemStatsHiddenGpus?: string[];
  // Header image — user-uploaded image displayed in the chat header instead of model name
  headerImageEnabled?: boolean;
  headerImageId?: string;  // filename stem
  // Tool options
  // read_file default line limit when no `limit` arg is provided (default 1000).
  readFileDefaultLines?: number;
  // read_file hard byte cap on returned content, applied after line slicing
  // as a safety net for pathological lines / minified bundles (default 262144).
  readFileMaxBytes?: number;
  // Max characters per memory block (note blocks only; synthesis/notebook/archived exempt)
  maxBlockChars?: number;
  // Cross-project score multiplier during memory retrieval. Default 0.3.
  crossProjectScoreMultiplier?: number;
  // Project-scoped memory multiplier for global/system chats. Default 1.0.
  globalProjectScoreMultiplier?: number;
}

export interface BlueskySettings {
  enabled: boolean;
  username?: string;
  appPassword?: string;
  pollingIntervalMinutes?: number;
  notificationTypes?: string[];
  autoSendToAgent?: boolean;
  autoRespondToNotifications?: boolean;
  blueskyChatId?: string;
}

export interface LlamaPathInfo {
  currentPath: string;
  version: string;
  valid: boolean;
  services?: Record<string, "active" | "inactive" | "failed" | "unknown">;
}

export interface LlamaPathUpdateResult {
  previousPath: string;
  currentPath: string;
  version: string;
  services: Record<string, "active" | "failed" | "unknown">;
  rolledBack: boolean;
  error?: string;
}

export interface LlamaBinaryInfo {
  path: string;
  version: string;
  isDefault: boolean;
}

export type MemoryCategory = "preference" | "fact" | "behavior" | "instruction" | "context" | "decision" | "note" | "reflection";

export type MemorySourceType = "chat" | "chat_delayed" | "chat_immediate" | "notebook" | "explicit";

export interface MemorySummary {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  sourceChatId: string;
  projectId?: string;
  sourceType?: MemorySourceType;
  sourceId?: string;
  supersededBy?: string;
  supersedes?: string;
}

export interface MemoryLineageEntry {
  id: string;
  text: string;
  createdAt: string;
}

export interface MemoryLineage {
  older: MemoryLineageEntry[];
  newer: MemoryLineageEntry[];
}

export interface MemoryBlock {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: "global" | "project";
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: "agent" | "user";
  tokenEstimate: number;
  supersededBy?: string;
  supersedes?: string;
}

export interface Artifact {
  id: string;           // canonical ID (persists across versions)
  title: string;
  url: string;          // version-specific URL
  version?: number;     // version number (defaults to 1 for backward compat)
}

export interface InlineVisual {
  id: string;
  title: string;
  html: string;
  url: string;
  version?: number;     // version number (defaults to 1 for backward compat)
}

export interface ImageGenerationParams {
  positivePrompt: string;
  negativePrompt?: string;
  model: string;
  steps: number;
  cfgScale: number;
  width: number;
  height: number;
  seed?: number;
  sampler?: string;
  scheduler?: string;
}

export interface GeneratedImage {
  id: string;
  url: string;
  params: ImageGenerationParams;
  resolvedSeed: number;
  createdAt: string;
  chatId?: string;
  generatedBy?: 'user' | 'agent';  // Track generation source
  description?: string;  // For analyzed images (search results may include these)
  type?: 'generated' | 'analyzed' | 'uploaded';  // For search results
  score?: number;  // For search results (relevance score)
  isFavorite?: boolean;  // User favorite status
}

export interface ComfyUIStatus {
  available: boolean;
  queueSize: number;
  models: string[];
}

export interface GenerationState {
  id: string;
  chatId?: string;
  promptId?: string;
  clientId: string;
  params: ImageGenerationParams;
  status: "queued" | "processing" | "completed" | "error";
  progress: { step: number; total: number } | null;
  imageUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// TTS Types
export type TTSBackend = "kokoro" | "qwen3-tts" | "supertonic-3";
export type TTSTextMode = "minimal" | "standard" | "stripped";

export interface TTSSettings {
  voice: string;
  speed: number;
  pitch: number;
  enabled: boolean;
  autoReadEnabled: boolean;
  ttsTextMode: TTSTextMode;
  backend: TTSBackend;
  voicesByBackend?: Partial<Record<TTSBackend, string>>;
  streamingEnabled: boolean;
  streamingChunkSize: number;
  streamingBoundaryTier: "clause" | "sentence";
  supertonicPitchSemitones: number;
  kokoroPitchShiftProcessor: "resample" | "rubberband";
  supertonicPitchShiftProcessor: "resample" | "rubberband";
  supertonicLanguage: string;
  supertonicSteps: number;
  supertonicMaxChunkLength: number;
  supertonicSilenceDuration: number;
  supertonicTrailingSilence: number;
}

export interface TTSVoiceInfo {
  id: string;
  name: string;
  gender: "female" | "male";
  accent: "american" | "british" | "other";
}

export interface TTSVoiceCategory {
  label: string;
  voices: TTSVoiceInfo[];
}

export interface TTSPythonCandidate {
  path: string;
  source: string;
  available: boolean;
  missingImports?: string[];
  error?: string;
}

export interface TTSBackendStatus {
  backend: TTSBackend;
  available: boolean;
  error?: string;
  pythonPath?: string;
  pythonSource?: string;
  requiredImports?: string[];
  installCommand?: string;
  pythonCandidates?: TTSPythonCandidate[];
}

// Vision Analysis Types (re-export from API client for convenience)
export interface VisionPreset {
  key: string;
  name: string;
  prompt: string;
  markdown: boolean;
}

export interface VisionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface AnalyzedImage {
  id: string;
  filename: string;
  url: string;
  description: string;
  preset: string;
  model: string;
  conversation: VisionMessage[];
  createdAt: string;
}

export interface NotebookLink {
  notebooks?: { entryId: string; author: 'user' | 'agent' }[];
  chats?: { chatId: string; title?: string }[];
  urls?: { url: string; title?: string }[];
}

export interface NotebookEntry {
  id: string;
  createdAt: string;
  author: 'user' | 'agent';
  content: string;
  links?: NotebookLink;
  images?: ImageAttachment[];
  toolCalls?: ChatToolCall[];
  toolResults?: ChatToolResult[];
  artifacts?: Artifact[];
  visuals?: InlineVisual[];
  memories?: { memoryId: string; text: string }[];
}

export interface NotebookIndex {
  entries: { id: string; createdAt: string; author: 'user' | 'agent'; preview: string }[];
  lastActivityDate: string | null;
}

export interface NotebookSearchResult {
  id: string;
  author: 'user' | 'agent';
  createdAt: string;
  preview: string;
  excerpt: string;
  rank: number;
}

// System stats
export interface GpuInfo {
  id: string;
  name: string;
  driver: "amdgpu" | "nvidia" | "i915" | "unknown";
  usage: number;
  vramTotal: number;
  vramUsed: number;
  temperature: number;
}

export interface SystemStatsSample {
  timestamp: number;
  cpu: { usage: number };
  ram: { total: number; available: number; used: number };
  swap: { total: number; free: number; used: number };
  gpus: GpuInfo[];
}

export interface SystemStatsResponse {
  current: SystemStatsSample | null;
  history: SystemStatsSample[];
  bufferSeconds: number;
  hiddenGpus: string[];
}
