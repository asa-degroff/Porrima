export interface MessageUsage {
  input: number;
  output: number;
  totalTokens: number;
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

export interface ImageAttachment {
  /** Base64-encoded image bytes. Present for new uploads and model-boundary hydration only. */
  data?: string;
  mimeType: string;  // e.g. "image/png"
  name: string;      // original filename
  id?: string;       // server-stored image ID
  url?: string;      // full-resolution URL (e.g. /api/user-images/:id/image.jpg)
  thumbUrl?: string;  // thumbnail URL (e.g. /api/user-images/:id/thumb)
}

export interface MessageSegment {
  seq: number;
  type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual" | "compaction_marker";
  content?: string;
  toolCall?: ChatToolCall;
  toolResult?: ChatToolResult;
  artifact?: Artifact;
  generatedImage?: GeneratedImage;
  visual?: InlineVisual;
}

export interface ChatMessage {
  /** Absolute chat_message_rows.sequence for UI edit/retry targeting. Never persisted. */
  _rowSequence?: number;
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
  segments?: MessageSegment[];
  timestamp: number;
  /** Transient flag: message is still being generated (mid-tool-loop). Stripped on completion. */
  _inProgress?: boolean;
  /** Marks this message as a compaction summary (inserted when messages are removed due to context limits) */
  _isCompactionSummary?: boolean;
  /** Message is preserved for UI display but excluded from the LLM context */
  _outOfContext?: boolean;
  /** Number of messages that were compacted to create this summary */
  _compactedMessageCount?: number;
  /**
   * Archive IDs represented by this compaction summary. Used by deferred LLM
   * enrichment to locate the summary and rewrite its content with upgraded
   * descriptions once the (CPU) extraction model finishes.
   */
  _archiveIds?: string[];
  /** Marks this message's content as promoted from thinking (not useful for previews) */
  _thinkingPromoted?: boolean;
  /** Groups canonical split assistant rows that belong to one visible assistant turn. */
  _toolLoopId?: string;
  /** True when this row is one tool-use iteration, not the final assistant answer. */
  _toolLoopFragment?: boolean;
  /** pi-ai provider identity used when this assistant row was generated. */
  _provider?: string;
  _api?: string;
  _model?: string;
  /** Marks this message as a system-generated message (not from agent response) */
  _isSystemMessage?: boolean;
  /** Hidden system row containing passively recalled memories. */
  _isPassiveMemoryRecall?: boolean;
  _recalledMemoryIds?: string[];
  /** Hidden system row should be merged into the next user message, not replayed as prefix history. */
  _mergeIntoNextUserMessage?: boolean;
  _isMidTurnCompaction?: boolean;
  _compactionRemovedCount?: number;
  _compactionCycle?: number;
  _isSynthesisMessage?: boolean;
  /** Automation metadata for scheduled system-chat turns. */
  _isAutomationMessage?: boolean;
  _automationTaskId?: string;
  _automationRunId?: string;
  /** Brief summary of what was done, generated for long assistant messages */
  recap?: string;
}

export type ChatType = "agent" | "quick" | "system";

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
  // Zeitgeist synthesis tracking
  lastZeitgeistSynthesisAt?: string;

}

export type ProjectLocationType = "local" | "ssh";

export interface Project {
  id: string;
  name: string;
  path: string; // project root directory
  locationType?: ProjectLocationType;
  sshConnectionId?: string;
  color: string; // UI accent color (e.g., "emerald", "purple", "blue")
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

export interface ChatListItem {
  id: string;
  title: string;
  type: ChatType;
  lastModified: string;
  preview: string;
  projectId?: string;
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

export interface ChatMessageWindow {
  messages: ChatMessage[];
  offset: number;
  total: number;
  hasMoreBefore: boolean;
}

export type InferenceProvider = "llamacpp";

export type MemoryBlockScope = "global" | "project" | "archived";

export interface MemoryBlock {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: MemoryBlockScope;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: "agent" | "user";
  tokenEstimate: number;
  blockType?: "note" | "notebook" | "synthesis" | "zeitgeist-archive";
  supersededBy?: string;
  supersedes?: string;
}

export interface InferenceModel {
  id: string;
  name: string;
  parameterSize: string;
  family: string;
  contextWindow: number;
  supportsImages?: boolean;  // True if model has vision capabilities
  provider: InferenceProvider;
}

export type Theme = "default" | "ocean" | "forest" | "crimson" | "mono" | "strawberry" | "coffee" | "emerald" | "copper" | "oxidized-copper" | "iron" | "rust";
export type BackgroundEffect = "static" | "ripple-grid" | "scan-lines" | "ripple-dots";
export type ActivityShape = "octahedron" | "cube" | "tetrahedron";

export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}

export type WebSearchProvider = "brave" | "exa" | "tavily";
export type RetrievalDepthProfile = "fast" | "balanced" | "thorough" | "custom";

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
  sdcppUrl?: string;            // default "http://127.0.0.1:1234" — stable-diffusion.cpp sd-server
  imageBackend?: "comfyui" | "sdcpp";  // default "comfyui"
  theme?: Theme;
  activityShape?: ActivityShape;
  activityHue?: number;
  activitySaturation?: number;
  systemPromptPresets?: SystemPromptPreset[];
  defaultVisionPreset?: string;
  // Delayed memory extraction settings
  delayedExtractionEnabled?: boolean;
  delayedExtractionThresholdMinutes?: number;
  delayedExtractionMessageCap?: number;
  // Zeitgeist continuity block settings
  zeitgeistEnabled?: boolean;
  zeitgeistInactivityThresholdHours?: number;
  // Corpus enrichment batch size (how many entries to process per check)
  enrichmentBatchSize?: number;
  // Extraction model configuration
  extractionModelId?: string;
  extractionModelUrl?: string;  // Direct URL for dedicated extraction model (e.g., http://localhost:8083)
  extractionFallbackEnabled?: boolean;
// llama.cpp server settings
  llamacppEnabled?: boolean;
  llamacppUrl?: string;         // default "http://localhost:8080"
  llamacppSharesGpu?: boolean;  // default true — unload idle models before image generation
  // App-level behavior for llama.cpp physical slot routing. "auto" lets
  // llama.cpp choose slots and use its RAM prompt cache; "enforced" sends
  // id_slot based on app-managed leases.
  llamacppSlotBindingMode?: "auto" | "enforced";
  // Extraction server (CPU-only llama.cpp instance)
  extractionCtxSize?: number;       // default 16384 — context window for extraction server
  extractionMaxTokens?: number;     // default 4000 — max output tokens for extraction calls
  extractionTimeoutMs?: number;     // default 600000 — abort extraction requests after this many ms
  // Reranker server (CPU-only llama.cpp instance)
  rerankerEnabled?: boolean;    // default true
  rerankerUrl?: string;         // default "http://localhost:8082"
  rerankerModelId?: string;     // default "qwen3-reranker" — model name sent to the reranker server
  rerankerTimeoutMs?: number;   // default 25000 — abort rerank requests after this many milliseconds
  // Retrieval pipeline budget. Presets control both turn-start memory retrieval
  // and passive recall; custom unlocks the numeric overrides below.
  retrievalDepthProfile?: RetrievalDepthProfile;
  memoryContextSearchQueryChars?: number;
  memoryContextRerankQueryChars?: number;
  memoryContextSearchLimit?: number;
  memoryContextCandidatePool?: number;
  memoryContextRerankDocumentLimit?: number;
  memoryContextRerankTopN?: number;
  passiveRecallQueryChars?: number;
  passiveRecallRerankQueryChars?: number;
  passiveRecallSearchLimit?: number;
  passiveRecallCandidatePool?: number;
  passiveRecallDiverseCandidateLimit?: number;
  passiveRecallRerankDocumentLimit?: number;
  passiveRecallRerankDocumentChars?: number;
  passiveRecallRerankTopN?: number;
  passiveRecallMemoriesPerInjection?: number;
  passiveRecallMemoriesPerTurn?: number;
  // Title generation server (CPU-only llama.cpp instance, tiny model)
  titleGenerationEnabled?: boolean;  // default true
  titleGenerationUrl?: string;       // default "http://localhost:8085"
  titleGenerationModelId?: string;   // default "qwen3.5-0.8b" — model name sent to the title-generation server
// Embedding server (llama.cpp)
  embeddingProvider?: "llamacpp";
  embeddingUrl?: string;        // default "http://localhost:8084"
  embeddingModel?: string;      // default "qwen3-embedding:0.6b"
  embeddingDimension?: number;  // dimension of currently stored vectors; set by migration
  // Model favorites
  favoriteModels?: string[];
  showOnlyFavorites?: boolean;
  // Global llama.cpp chat_template_kwargs. When true, passes
  // preserve_thinking:true so models/templates that support it can see
  // historical reasoning traces (Qwen3.6+ feature).
  preserveThinking?: boolean;
  // Legacy per-model storage; read for backward compatibility only.
  modelPreserveThinking?: Record<string, boolean>;
  // Sleep mode — when the user clicked the sleep button to release the system
  // to autonomous mode. Acts as both: (a) immediate activation of the sleep cycle,
  // and (b) 2h synthesis cooldown (scheduler skips periodic runs while < 2h elapsed).
  sleepModeTriggeredAt?: string;
  // User activity tracking — stamped on every user-initiated message send.
  lastUserActivityAt?: string;
  // Agent completion tracking — stamped when the agent's last response fully completed
  // (after tool loop, compaction, etc.). The sleep cycle's inactivity timer measures
  // from this timestamp rather than lastUserActivityAt, preventing premature sleep
  // activation while the agent is still producing output.
  lastAgentCompletedAt?: string;
  // Sleep cycle — when user is idle for this many minutes, the sleep cycle begins.
  // During sleep, synthesis and wake cycles run autonomously.
  sleepCycleThresholdMinutes?: number;
  // Wake cycle — periodic autonomous exploration during sleep cycle.
  wakeCycleEnabled?: boolean;
  wakeCycleIntervalHours?: number;
  // Post-synthesis cache warm — number of recent agent chats to warm after
  // each synthesis cycle. Default 3. Set to 0 to disable.
  postSynthesisWarmCount?: number;
  // System stats bar — show/hide resource usage in sidebar
  systemStatsEnabled?: boolean;
  // System stats history buffer duration in seconds (default 60)
  systemStatsBufferSeconds?: number;
  // GPU PCI addresses to hide from system stats (e.g. ["0000:17:00.0"])
  systemStatsHiddenGpus?: string[];
  // Agent display name — shown in the sidebar search bar and elsewhere
  agentName?: string;
  // Header image — user-uploaded image displayed in the chat header instead of model name
  headerImageEnabled?: boolean;
  headerImageId?: string;  // filename stem (e.g. "header")
  // Tool options
  // read_file default line limit when no `limit` arg is provided (default 1000).
  readFileDefaultLines?: number;
  // read_file hard byte cap on returned content, applied after line slicing
  // as a safety net for pathological lines / minified bundles (default 262144).
  readFileMaxBytes?: number;
  // Max characters per memory block (note blocks only; synthesis/notebook/archived exempt)
  maxBlockChars?: number;
  // Cross-project score multiplier — dampens memories from other projects during retrieval.
  // 0.3 means cross-project memories get 30% of their original score, preventing them from
  // dominating results while still allowing highly relevant content to surface. Default 0.3.
  crossProjectScoreMultiplier?: number;
  // Global/system chat project-memory multiplier — controls how strongly project-scoped
  // memories compete in chats without a current project. Default 1.0 means all projects
  // are treated as equally relevant; lower values make no-project chats more global-focused.
  globalProjectScoreMultiplier?: number;
  // Per-slot llama.cpp binary overrides. Maps slot id → absolute path to llama-server binary.
  // When set for a slot, that slot uses this binary instead of the global llama-current.
  // E.g. { "extraction": "/home/asa/bin/ik-llama/llama-server" }
  llamaServerBins?: Record<string, string>;
  // Structured service-launch overrides written as managed systemd drop-ins.
  llamaServiceConfigs?: Record<string, any>;
  // The default llama.cpp binary path (from llama-current symlink). Used by UI for display.
  llamaServerDefaultBin?: string;
  // Parent directory scanned for child llama.cpp build directories containing llama-server.
  llamaBinaryScanDir?: string;
}

export type MemoryCategory = "preference" | "fact" | "behavior" | "instruction" | "context" | "decision" | "note" | "reflection";

export type MemorySourceType = 'chat' | 'chat_delayed' | 'chat_immediate' | 'notebook' | 'explicit' | 'synthesis';

export interface Memory {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  embedding: number[];
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  sourceChatId?: string;  // Optional for synthesis/explicit memories
  projectId?: string;
  // Temporal layering fields
  sourceType?: MemorySourceType;
  sourceId?: string;  // chatId or notebookEntryId
  sourceMessageStartTimestamp?: number;
  sourceMessageEndTimestamp?: number;
  sourceMessageStartIndex?: number;
  sourceMessageEndIndex?: number;
  supersededBy?: string;  // ID of newer memory that supersedes this one
  supersedes?: string;  // ID of older memory that this one supersedes
}

export interface MemoryStore {
  memories: Memory[];
  lastSynthesis: string | null;
}

export type MemorySummary = Omit<Memory, "embedding">;

export interface Artifact {
  id: string;           // canonical ID (persists across versions)
  title: string;
  url: string;          // version-specific URL (e.g., /api/artifacts/:id/versions/:version)
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
}

export interface ComfyUIStatus {
  available: boolean;
  queueSize: number;
  models: string[];
}

export type GenerationStatus = "queued" | "processing" | "completed" | "error";

export interface GenerationState {
  id: string;
  chatId?: string;
  promptId?: string;
  clientId: string;
  params: ImageGenerationParams;
  status: GenerationStatus;
  progress: { step: number; total: number } | null;
  imageUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
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
  content: string;              // Markdown
  links?: NotebookLink;
  images?: ImageAttachment[];   // User entries only
  toolCalls?: ChatToolCall[];       // Agent entries only — paired with toolResults by id
  toolResults?: ChatToolResult[];   // Agent entries only
  artifacts?: Artifact[];           // Agent entries only
  visuals?: InlineVisual[];         // Agent entries only (inline visualizations)
  memories?: { memoryId: string; text: string }[];  // Extracted or explicit
}

export interface NotebookIndex {
  entries: { id: string; createdAt: string; author: 'user' | 'agent'; preview: string }[];
  lastActivityDate: string | null;  // ISO date of most recent entry
}
