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

/** A segment represents one unit of agent output in chronological order */
export interface MessageSegment {
  seq: number;
  type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual";
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
  role: "user" | "assistant";
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
  /** Number of messages that were compacted to create this summary */
  _compactedMessageCount?: number;
  /** Marks this message as in-progress (streaming/tool execution not yet complete) */
  _inProgress?: boolean;
}

export type ChatType = "agent" | "quick" | "bluesky";

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
}

export interface ChatListItem {
  id: string;
  title: string;
  type: ChatType;
  lastModified: string;
  preview: string;
  projectId?: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  pinned: boolean;
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

export type Theme = "default" | "ocean" | "forest" | "crimson" | "mono" | "strawberry" | "coffee";
export type BackgroundEffect = "static" | "ripple-grid" | "scan-lines" | "ripple-dots";

export interface SystemPromptPreset {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}

export interface Settings {
  defaultModelId: string;
  defaultVisionModelId?: string;
  defaultSystemPrompt: string;
  braveApiKey: string;
  comfyuiUrl?: string;
  modelContextWindows?: Record<string, number>;
  theme?: Theme;
  backgroundEffect?: BackgroundEffect;
  flatBackground?: boolean;
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
  extractionFallbackEnabled?: boolean;
  // Creative direction settings
  creativeDirections?: CreativeDirectionSettings;
  // llama.cpp server settings
  llamacppEnabled?: boolean;
  llamacppUrl?: string;         // default "http://localhost:8080"
  llamacppSharesGpu?: boolean;  // default true
  // Model favorites
  favoriteModels?: string[];
  showOnlyFavorites?: boolean;
  bluesky?: BlueskySettings;
}

export interface CreativeDirectionSettings {
  enabled?: boolean;
  modelId?: string;
  limit?: number;
  minNovelty?: number;
  maxExecutions?: number;
  maxReviewIterations?: number;
  imageModelId?: string;
  cfgScale?: number;
  steps?: number;
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
  directionId?: string;  // For agent generations: which creative direction was used
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
export interface TTSSettings {
  voice: string;
  speed: number;
  pitch: number;
  enabled: boolean;
  autoReadEnabled: boolean;
  backend: "kokoro" | "qwen3-tts";
  streamingEnabled: boolean;
  streamingChunkSize: number;
  streamingBoundaryTier: "clause" | "sentence";
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
  toolResults?: ChatToolResult[];
  artifacts?: Artifact[];
  visuals?: InlineVisual[];
  memories?: { memoryId: string; text: string }[];
}

export interface NotebookIndex {
  entries: { id: string; createdAt: string; author: 'user' | 'agent'; preview: string }[];
  lastActivityDate: string | null;
}
