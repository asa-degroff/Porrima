export type TTSBackend = "kokoro" | "qwen3-tts" | "supertonic-3";

export interface TTSSettings {
  voice: string;
  speed: number;
  pitch: number;
  enabled: boolean; // Master TTS toggle
  autoReadEnabled: boolean; // Global default for new chats
  // Streaming TTS settings (Qwen3-TTS only for now)
  backend: TTSBackend;
  voicesByBackend?: Partial<Record<TTSBackend, string>>;
  streamingEnabled: boolean;
  streamingChunkSize: number; // 30-80 tokens per chunk
  streamingBoundaryTier: "clause" | "sentence";
  supertonicLanguage: string;
  supertonicSteps: number;
  supertonicMaxChunkLength: number;
  supertonicSilenceDuration: number;
  supertonicTrailingSilence: number;
}

export interface TTSGenerateRequest {
  text: string;
  voice?: string;
  speed?: number;
  pitch?: number;
  backend?: TTSBackend;
  supertonicLanguage?: string;
  supertonicSteps?: number;
  supertonicMaxChunkLength?: number;
  supertonicSilenceDuration?: number;
  supertonicTrailingSilence?: number;
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
  enabled: false,
  autoReadEnabled: false,
  backend: "kokoro",
  voicesByBackend: {
    kokoro: "af_heart",
    "qwen3-tts": "Ryan",
    "supertonic-3": "M1",
  },
  streamingEnabled: false,
  streamingChunkSize: 50,
  streamingBoundaryTier: "clause",
  supertonicLanguage: "en",
  supertonicSteps: 8,
  supertonicMaxChunkLength: 300,
  supertonicSilenceDuration: 0.3,
  supertonicTrailingSilence: 0.1,
};
