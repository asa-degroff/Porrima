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

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  usage?: MessageUsage;
  toolCalls?: ChatToolCall[];
  toolResults?: ChatToolResult[];
  artifacts?: Artifact[];
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
}

export interface ChatListItem {
  id: string;
  title: string;
  type: ChatType;
  lastModified: string;
  preview: string;
}

export interface OllamaModel {
  id: string;
  name: string;
  parameterSize: string;
  family: string;
  contextWindow: number;
}

export interface Settings {
  defaultModelId: string;
  defaultSystemPrompt: string;
  braveApiKey: string;
}

export type MemoryCategory = "preference" | "fact" | "behavior" | "instruction";

export interface MemorySummary {
  id: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  createdAt: string;
  lastAccessed: string;
  accessCount: number;
  sourceChatId: string;
}

export interface Artifact {
  id: string;
  title: string;
  url: string;
}
