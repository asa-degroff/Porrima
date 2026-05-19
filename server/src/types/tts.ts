export type TTSBackend = "kokoro" | "qwen3-tts" | "supertonic-3";

/**
 * Controls what markdown elements are included or excluded during TTS text preprocessing.
 * - "minimal": Keep almost everything (code blocks, inline code, URLs). Strip only LaTeX.
 * - "standard": Strip code blocks and URLs, but keep inline code words. (Recommended)
 * - "stripped": Remove code blocks, inline code, URLs, and LaTeX. (Previous default)
 */
export type TTSTextMode = "minimal" | "standard" | "stripped";

export interface TTSSettings {
  voice: string;
  speed: number;
  pitch: number;
  enabled: boolean; // Master TTS toggle
  autoReadEnabled: boolean; // Global default for new chats
  // Text preprocessing mode — controls what markdown elements are included in TTS
  ttsTextMode: TTSTextMode;
  // Streaming TTS settings (Qwen3-TTS only for now)
  backend: TTSBackend;
  voicesByBackend?: Partial<Record<TTSBackend, string>>;
  streamingEnabled: boolean;
  streamingChunkSize: number; // 30-80 tokens per chunk
  streamingBoundaryTier: "clause" | "sentence";
  supertonicPitchSemitones: number;
  kokoroPitchShiftProcessor: "resample" | "rubberband";
  supertonicPitchShiftProcessor: "resample" | "rubberband";
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
  supertonicPitchSemitones?: number;
  supertonicLanguage?: string;
  supertonicSteps?: number;
  supertonicMaxChunkLength?: number;
  supertonicSilenceDuration?: number;
  supertonicTrailingSilence?: number;
  kokoroPitchShiftProcessor?: "resample" | "rubberband";
  supertonicPitchShiftProcessor?: "resample" | "rubberband";
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
  ttsTextMode: "stripped",
  backend: "kokoro",
  voicesByBackend: {
    kokoro: "af_heart",
    "qwen3-tts": "Ryan",
    "supertonic-3": "M1",
  },
  streamingEnabled: false,
  streamingChunkSize: 50,
  streamingBoundaryTier: "clause",
  supertonicPitchSemitones: 0,
  kokoroPitchShiftProcessor: "resample",
  supertonicPitchShiftProcessor: "rubberband",
  supertonicLanguage: "en",
  supertonicSteps: 8,
  supertonicMaxChunkLength: 300,
  supertonicSilenceDuration: 0.3,
  supertonicTrailingSilence: 0.1,
};
