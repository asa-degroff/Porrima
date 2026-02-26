export interface MessageUsage {
  input: number;
  output: number;
  totalTokens: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  usage?: MessageUsage;
  timestamp: number;
}

export interface Chat {
  id: string;
  title: string;
  modelId: string;
  systemPrompt: string;
  messages: ChatMessage[];
  createdAt: string;
  lastModified: string;
}

export interface ChatListItem {
  id: string;
  title: string;
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
