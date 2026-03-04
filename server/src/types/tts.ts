export interface TTSSettings {
  voice: string;
  speed: number;
  pitch: number;
  autoReadEnabled: boolean; // Global default for new chats
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
};
