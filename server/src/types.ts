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
  type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual";
  content?: string;
  toolCall?: ChatToolCall;
  toolResult?: ChatToolResult;
  artifact?: Artifact;
  generatedImage?: GeneratedImage;
  visual?: InlineVisual;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  usage?: MessageUsage;
  toolCalls?: ChatToolCall[];
  toolResults?: ChatToolResult[];
  artifacts?: Artifact[];
  generatedImages?: GeneratedImage[];
  visuals?: InlineVisual[];
  images?: ImageAttachment[];
  segments?: MessageSegment[];
  timestamp: number;
}

export type ChatType = "agent" | "quick";

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

export interface Project {
  id: string;
  name: string;
  path: string; // project root directory
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

export interface OllamaModel {
  id: string;
  name: string;
  parameterSize: string;
  family: string;
  contextWindow: number;
}

export type Theme = "default" | "ripple-grid";

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
  systemPromptPresets?: SystemPromptPreset[];
  defaultVisionPreset?: string;
  // Delayed memory extraction settings
  delayedExtractionEnabled?: boolean;
  delayedExtractionThresholdMinutes?: number;
  delayedExtractionMessageCap?: number;
  // Extraction model configuration
  extractionModelId?: string;
  extractionFallbackEnabled?: boolean;
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
  id: string;
  title: string;
  url: string;
}

export interface InlineVisual {
  id: string;
  title: string;
  html: string;
  url: string;
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
  toolResults?: ChatToolResult[];   // Agent entries only
  artifacts?: Artifact[];           // Agent entries only
  memories?: { memoryId: string; text: string }[];  // Extracted or explicit
}

export interface NotebookIndex {
  entries: { id: string; createdAt: string; author: 'user' | 'agent'; preview: string }[];
  lastActivityDate: string | null;  // ISO date of most recent entry
}
