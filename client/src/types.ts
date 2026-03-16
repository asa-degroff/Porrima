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
  createdAt: string;
  lastModified: string;
}

export interface OllamaModel {
  id: string;
  name: string;
  parameterSize: string;
  family: string;
  contextWindow: number;
}

export type Theme = "default" | "ocean" | "forest" | "crimson" | "mono";
export type BackgroundEffect = "static" | "ripple-grid";

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
  systemPromptPresets?: SystemPromptPreset[];
  hapticsEnabled?: boolean;
}

export type MemoryCategory = "preference" | "fact" | "behavior" | "instruction" | "context" | "decision" | "note" | "reflection";

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
}

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
  autoReadEnabled: boolean;
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
  memories?: { memoryId: string; text: string }[];
}

export interface NotebookIndex {
  entries: { id: string; createdAt: string; author: 'user' | 'agent'; preview: string }[];
  lastActivityDate: string | null;
}
