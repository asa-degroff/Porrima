export interface TTSSettings {
  voice: string;
  speed: number;
  pitch: number;
  autoReadEnabled: boolean; // Global default for new chats
  // Streaming TTS settings (Qwen3-TTS only)
  backend: "kokoro" | "qwen3-tts";
  streamingEnabled: boolean;
  streamingChunkSize: number; // 30-80 tokens per chunk
  streamingBoundaryTier: "clause" | "sentence";
}

export interface TTSGenerateRequest {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
}

export interface TTSGenerateResponse {
  audioUrl: string;
  duration: number;
  fileSize: number;
}

export interface TTSVoiceInfo {
  id: string;
  name: string;
  gender: "female" | "male";
  accent: "american" | "british" | "other";
}

export const DEFAULT_TTS_SETTINGS: TTSSettings = {
  voice: "af_heart",
  speed: 1.0,
  pitch: 1.0,
  autoReadEnabled: false,
  backend: "kokoro",
  streamingEnabled: false,
  streamingChunkSize: 50,
  streamingBoundaryTier: "clause",
};
