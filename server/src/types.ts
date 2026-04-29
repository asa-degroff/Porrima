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
  data: string;      // base64-encoded (no data: prefix)
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
  /** Marks this message as a system-generated message (not from agent response) */
  _isSystemMessage?: boolean;
  _isSynthesisMessage?: boolean;
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
  createdAt: string;
  lastModified: string;
  activeSkills?: string[]; // List of active skill names
  projectId?: string; // Optional project association
  // Delayed extraction tracking
  lastDelayedExtractionAt?: string;
  lastDelayedExtractionMessageIndex?: number;
  // Zeitgeist synthesis tracking
  lastZeitgeistSynthesisAt?: string;
  // Ollama runtime options (per-chat overrides)
  ollamaOptions?: {
    keepAlive?: string | number;  // e.g., "15m", "5m", 300, -1, 0
    numGpu?: number;              // GPU layers to offload
    numPredict?: number;          // Max tokens to generate
  };
}

export interface Project {
  id: string;
  name: string;
  path: string; // project root directory
  color: string; // UI accent color (e.g., "emerald", "purple", "blue")
  pinned: boolean;
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

export type InferenceProvider = "ollama" | "llamacpp";

export type MemoryBlockScope = "global" | "project";

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
  supersededBy?: string;
  supersedes?: string;
}

export interface OllamaModel {
  id: string;
  name: string;
  parameterSize: string;
  family: string;
  contextWindow: number;
  supportsImages?: boolean;  // True if model has vision capabilities
  provider?: InferenceProvider;  // Default: "ollama" for backward compat
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

export interface Settings {
  defaultModelId: string;
  defaultVisionModelId?: string;
  defaultSystemPrompt: string;
  braveApiKey: string;
  exaApiKey: string;
  tavilyApiKey: string;
  defaultWebSearchProvider?: WebSearchProvider;
  comfyuiUrl?: string;
  sdcppUrl?: string;            // default "http://127.0.0.1:1234" — stable-diffusion.cpp sd-server
  imageBackend?: "comfyui" | "sdcpp";  // default "comfyui"
  modelContextWindows?: Record<string, number>;
  theme?: Theme;
  activityShape?: ActivityShape;
  activityHue?: number;
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
  // Ollama server URL (shared by model discovery, title gen, zeitgeist, vision,
  // GPU coordination, and — when embeddingProvider is "ollama" — the default
  // embedding URL). default "http://localhost:11434".
  ollamaUrl?: string;
  // llama.cpp server settings
  llamacppEnabled?: boolean;
  llamacppUrl?: string;         // default "http://localhost:8080"
  llamacppSharesGpu?: boolean;  // default true — unload Ollama before llama.cpp and vice versa
  // Extraction server (CPU-only llama.cpp instance)
  extractionCtxSize?: number;   // default 16384 — context window for extraction server
  // Reranker server (CPU-only llama.cpp instance)
  rerankerEnabled?: boolean;    // default true
  rerankerUrl?: string;         // default "http://localhost:8082"
  rerankerModelId?: string;     // default "qwen3-reranker" — model name sent to the reranker server
  // Title generation server (CPU-only llama.cpp instance, tiny model)
  titleGenerationEnabled?: boolean;  // default true
  titleGenerationUrl?: string;       // default "http://localhost:8085"
  titleGenerationModelId?: string;   // default "qwen3.5-0.8b" — model name sent to the title-generation server
  // Embedding server (Ollama or llama.cpp)
  embeddingProvider?: "ollama" | "llamacpp";  // default "ollama"
  embeddingUrl?: string;        // default "http://localhost:11434" (ollama) or "http://localhost:8084" (llamacpp)
  embeddingModel?: string;      // default "qwen3-embedding:0.6b"
  embeddingDimension?: number;  // dimension of currently stored vectors; set by migration
  // Model favorites
  favoriteModels?: string[];
  showOnlyFavorites?: boolean;
  // Per-model llama.cpp chat_template_kwargs. When true, passes
  // preserve_thinking:true so the model sees its own historical reasoning
  // traces (Qwen3.6+ feature). Ignored by models that don't recognize the kwarg.
  modelPreserveThinking?: Record<string, boolean>;
  // Bluesky integration settings
  bluesky?: BlueskySettings;
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
  // Tool options
  // read_file default line limit when no `limit` arg is provided (default 1000).
  readFileDefaultLines?: number;
  // read_file hard byte cap on returned content, applied after line slicing
  // as a safety net for pathological lines / minified bundles (default 262144).
  readFileMaxBytes?: number;
}

export interface BlueskySettings {
  enabled: boolean;
  username?: string;  // Handle (e.g., "user.bsky.social")
  appPassword?: string;  // Encrypted at rest
  pollingIntervalMinutes?: number;  // Default: 10
  notificationTypes?: string[];  // ['mention', 'reply', 'follow', 'like', 'repost']
  autoSendToAgent?: boolean;  // Auto-send notifications to Bluesky chat
  autoRespondToNotifications?: boolean;  // Agent autonomously responds to notifications
  blueskyChatId?: string;  // Dedicated chat for Bluesky interactions
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

// Bluesky types
export interface BlueskyNotification {
  uri: string;
  cid: string;
  reason: 'mention' | 'reply' | 'follow' | 'like' | 'repost' | 'quote';
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record: {
    text?: string;
    createdAt?: string;
    reply?: {
      root?: { uri: string; cid: string };
      parent?: { uri: string; cid: string };
    };
  };
  indexedAt: string;
  isRead: boolean;
}

export interface BlueskyThread {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record: {
    text: string;
    createdAt: string;
    reply?: {
      root: { uri: string; cid: string };
      parent: { uri: string; cid: string };
    };
  };
  embed?: any;
  replyCount: number;
  likeCount: number;
  repostCount: number;
  parent?: BlueskyThreadPost;
  replies?: BlueskyThreadPost[];
}

export interface BlueskyThreadPost {
  uri: string;
  cid: string;
  author: {
    did: string;
    handle: string;
    displayName?: string;
  };
  record: {
    text: string;
    createdAt: string;
  };
  embed?: any;
  replyCount: number;
  likeCount: number;
  repostCount: number;
}

export interface BlueskyPostResult {
  uri: string;
  cid: string;
  success: boolean;
}

export interface BlueskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  followersCount: number;
  followsCount: number;
  postsCount: number;
}
