import { useState, useCallback, useRef, useEffect } from "react";
import type { TTSSettings } from "../types";
import { getTTSSettings, updateTTSSettings } from "../api/tts";

const DEFAULT_SETTINGS: TTSSettings = {
  voice: "af_heart",
  speed: 1.0,
  pitch: 1.0,
  enabled: false,
  autoReadEnabled: false,
  backend: "kokoro",
  streamingEnabled: false,
  streamingChunkSize: 50,
  streamingBoundaryTier: "clause",
};

export interface PlaybackState {
  isPlaying: boolean;
  isPaused: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  audioUrl: string | null;
  currentChunk?: number;
  totalChunks?: number;
  mode?: "single" | "chunked";
}

interface TTSQueueItem {
  audioUrl: string;
  duration: number;
  index: number;
  totalChunks: number;
}

/**
 * Hook for managing TTS playback
 * Fetches current TTS settings from server on mount
 */
export function useTTS() {
  const [settings, setSettings] = useState<TTSSettings>(DEFAULT_SETTINGS);
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    isPaused: false,
    isLoading: false,
    currentTime: 0,
    duration: 0,
    audioUrl: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const playIdRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const chunkQueueRef = useRef<TTSQueueItem[]>([]);
  const chunkModeRef = useRef(false);
  const chunkAudioActiveRef = useRef(false);
  const chunkStreamDoneRef = useRef(false);
  const onAudioEndedRef = useRef<() => void>(() => {
    setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false, isLoading: false }));
  });

  // Fetch TTS settings from server on mount
  useEffect(() => {
    let mounted = true;
    getTTSSettings()
      .then((fetchedSettings) => {
        if (mounted) {
          setSettings(fetchedSettings);
        }
      })
      .catch((err) => {
        console.error("[useTTS] Failed to fetch settings:", err);
        setError("Failed to load TTS settings");
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    
    return () => {
      mounted = false;
    };
  }, []);

  // Listen for settings changes from SettingsModal
  useEffect(() => {
    const handleSettingsChange = (event: CustomEvent<TTSSettings>) => {
      console.log("[useTTS] Settings updated:", event.detail);
      setSettings(event.detail);
    };
    
    window.addEventListener('tts-settings-updated', handleSettingsChange as EventListener);
    return () => {
      window.removeEventListener('tts-settings-updated', handleSettingsChange as EventListener);
    };
  }, []);

  // Initialize audio element
  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    audio.addEventListener("ended", () => {
      onAudioEndedRef.current();
    });

    audio.addEventListener("timeupdate", () => {
      setPlaybackState((prev) => ({
        ...prev,
        currentTime: audio.currentTime,
        duration: audio.duration || 0,
      }));
    });

    audio.addEventListener("error", (e) => {
      // Ignore errors from src reset during loading transition
      if (loadingRef.current) return;
      console.error("[TTS] Audio error:", e);
      setError("Playback error");
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false }));
    });

    return () => {
      audio.pause();
      audio.src = "";
    };
  }, []);

  /**
   * Load TTS settings from server
   */
  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/tts/settings", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
      }
    } catch {
      // Use defaults
    }
  }, []);

  /**
   * Update TTS settings
   */
  const updateSettings = useCallback(async (newSettings: Partial<TTSSettings>) => {
    try {
      const res = await fetch("/api/tts/settings", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSettings),
      });
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        return data;
      }
    } catch (err) {
      console.error("[TTS] Failed to update settings:", err);
    }
    return null;
  }, []);

  const resetChunkPlayback = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    chunkQueueRef.current = [];
    chunkModeRef.current = false;
    chunkAudioActiveRef.current = false;
    chunkStreamDoneRef.current = false;
    onAudioEndedRef.current = () => {
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false, isLoading: false }));
    };
  }, []);

  const playQueuedChunk = useCallback(async (playId: number) => {
    if (playId !== playIdRef.current || !chunkModeRef.current) return;

    const next = chunkQueueRef.current.shift();
    if (!next) {
      chunkAudioActiveRef.current = false;
      if (chunkStreamDoneRef.current) {
        chunkModeRef.current = false;
        setPlaybackState((prev) => ({
          ...prev,
          isPlaying: false,
          isPaused: false,
          isLoading: false,
          currentTime: 0,
        }));
      } else {
        setPlaybackState((prev) => ({
          ...prev,
          isPlaying: false,
          isPaused: false,
          isLoading: true,
        }));
      }
      return;
    }

    const audio = audioRef.current;
    if (!audio) return;

    chunkAudioActiveRef.current = true;
    currentAudioUrlRef.current = next.audioUrl;
    loadingRef.current = true;

    try {
      await new Promise<void>((resolve, reject) => {
        const onReady = () => {
          audio.removeEventListener("error", onError);
          resolve();
        };
        const onError = () => {
          audio.removeEventListener("canplay", onReady);
          reject(new Error(`Failed to load audio from ${next.audioUrl}`));
        };
        audio.addEventListener("canplay", onReady, { once: true });
        audio.addEventListener("error", onError, { once: true });
        audio.src = next.audioUrl;
      });

      if (playId !== playIdRef.current || !chunkModeRef.current) return;

      loadingRef.current = false;
      setPlaybackState({
        isPlaying: true,
        isPaused: false,
        isLoading: false,
        currentTime: 0,
        duration: next.duration,
        audioUrl: next.audioUrl,
        currentChunk: next.index + 1,
        totalChunks: next.totalChunks,
        mode: "chunked",
      });

      await audio.play();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to play audio chunk";
      setError(message);
      console.error("[TTS] Chunk playback error:", err);
      loadingRef.current = false;
      chunkAudioActiveRef.current = false;
      setPlaybackState((prev) => ({ ...prev, isLoading: false, isPlaying: false }));
    }
  }, []);

  const readSseStream = useCallback(async (
    response: Response,
    onEvent: (event: string, data: any) => void,
  ) => {
    if (!response.body) {
      throw new Error("Streaming response body unavailable");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");

        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("event:")) {
            eventName = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }

        if (dataLines.length > 0) {
          onEvent(eventName, JSON.parse(dataLines.join("\n")));
        }
      }
    }
  }, []);

  const shouldUseChunkedPlayback = useCallback((text: string) => {
    return settings.backend === "supertonic-3" && text.trim().length > 220;
  }, [settings.backend]);

  const playChunked = useCallback(async (
    text: string,
    options?: { voice?: string; speed?: number; pitch?: number },
  ) => {
    const playId = ++playIdRef.current;
    resetChunkPlayback();
    setError(null);

    const controller = new AbortController();
    streamAbortRef.current = controller;
    chunkModeRef.current = true;
    chunkStreamDoneRef.current = false;
    loadingRef.current = true;

    onAudioEndedRef.current = () => {
      if (chunkModeRef.current) {
        void playQueuedChunk(playId);
      } else {
        setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false, isLoading: false }));
      }
    };

    setPlaybackState({
      isPlaying: false,
      isPaused: false,
      isLoading: true,
      currentTime: 0,
      duration: 0,
      audioUrl: null,
      currentChunk: 0,
      totalChunks: 0,
      mode: "chunked",
    });

    try {
      if (audioRef.current) {
        audioRef.current.pause();
      }

      const res = await fetch("/api/tts/generate-stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          text,
          voice: options?.voice ?? settings.voice,
          speed: options?.speed ?? settings.speed,
          pitch: options?.pitch ?? settings.pitch,
          backend: settings.backend,
        }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Failed to generate audio" }));
        throw new Error(error.error || "Failed to generate audio");
      }

      await readSseStream(res, (event, data) => {
        if (playId !== playIdRef.current) return;

        if (event === "chunk_plan") {
          setPlaybackState((prev) => ({ ...prev, totalChunks: data.totalChunks ?? 0 }));
          return;
        }

        if (event === "audio_chunk") {
          chunkQueueRef.current.push({
            audioUrl: data.audioUrl,
            duration: data.duration,
            index: data.index,
            totalChunks: data.totalChunks,
          });

          if (!chunkAudioActiveRef.current) {
            void playQueuedChunk(playId);
          }
          return;
        }

        if (event === "done") {
          chunkStreamDoneRef.current = true;
          if (!chunkAudioActiveRef.current && chunkQueueRef.current.length === 0) {
            void playQueuedChunk(playId);
          }
          return;
        }

        if (event === "error") {
          throw new Error(data.error || "Chunked TTS generation failed");
        }
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Failed to play audio";
      setError(message);
      console.error("[TTS] Chunked play error:", err);
      loadingRef.current = false;
      resetChunkPlayback();
      setPlaybackState((prev) => ({ ...prev, isLoading: false, isPlaying: false }));
    }
  }, [playQueuedChunk, readSseStream, resetChunkPlayback, settings.backend, settings.pitch, settings.speed, settings.voice]);

  /**
   * Play text aloud
   */
  const play = useCallback(
    async (text: string, options?: { voice?: string; speed?: number; pitch?: number }) => {
      if (!text.trim()) return;

      if (shouldUseChunkedPlayback(text)) {
        await playChunked(text, options);
        return;
      }

      setError(null);

      try {
        const playId = ++playIdRef.current;
        resetChunkPlayback();

        // Set loading state and suppress spurious error events
        loadingRef.current = true;
        setPlaybackState((prev) => ({
          ...prev,
          isLoading: true,
          mode: "single",
          currentChunk: 0,
          totalChunks: 0,
        }));

        // Stop any current playback
        if (audioRef.current) {
          audioRef.current.pause();
        }

        // Generate audio
        const res = await fetch("/api/tts/generate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            voice: options?.voice ?? settings.voice,
            speed: options?.speed ?? settings.speed,
            pitch: options?.pitch ?? settings.pitch,
            backend: settings.backend,
          }),
        });

        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: "Failed to generate audio" }));
          throw new Error(error.error || "Failed to generate audio");
        }

        const data = await res.json();
        const audioUrl = data.audioUrl;

        // Play the audio — wait for it to be ready first
        if (audioRef.current) {
          const audio = audioRef.current;
          currentAudioUrlRef.current = audioUrl;

          // Set up listeners BEFORE setting src
          await new Promise<void>((resolve, reject) => {
            const onReady = () => {
              audio.removeEventListener("error", onError);
              resolve();
            };
            const onError = () => {
              audio.removeEventListener("canplaythrough", onReady);
              reject(new Error(`Failed to load audio from ${audioUrl}`));
            };
            audio.addEventListener("canplaythrough", onReady, { once: true });
            audio.addEventListener("error", onError, { once: true });
            // Setting src triggers the load
            audio.src = audioUrl;
          });

          loadingRef.current = false;

          setPlaybackState({
            isPlaying: true,
            isPaused: false,
            isLoading: false,
            currentTime: 0,
            duration: data.duration,
            audioUrl,
            currentChunk: 0,
            totalChunks: 0,
            mode: "single",
          });

          if (playId !== playIdRef.current) return;
          await audio.play();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to play audio";
        setError(message);
        console.error("[TTS] Play error:", err);
        loadingRef.current = false;
        setPlaybackState((prev) => ({ ...prev, isLoading: false }));
      }
    },
    [playChunked, resetChunkPlayback, settings.voice, settings.speed, settings.pitch, settings.backend, shouldUseChunkedPlayback]
  );

  /**
   * Pause current playback
   */
  const pause = useCallback(() => {
    if (audioRef.current && playbackState.isPlaying) {
      audioRef.current.pause();
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: true }));
    }
  }, [playbackState.isPlaying]);

  /**
   * Resume paused playback
   */
  const resume = useCallback(() => {
    if (audioRef.current && playbackState.isPaused && currentAudioUrlRef.current) {
      audioRef.current.play();
      setPlaybackState((prev) => ({ ...prev, isPlaying: true, isPaused: false }));
    }
  }, [playbackState.isPaused]);

  /**
   * Stop playback
   */
  const stop = useCallback(() => {
    playIdRef.current++;
    resetChunkPlayback();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      currentAudioUrlRef.current = null;
    }
    setPlaybackState((prev) => ({
      ...prev,
      isPlaying: false,
      isPaused: false,
      currentTime: 0,
      isLoading: false,
    }));
  }, [resetChunkPlayback]);

  /**
   * Check if TTS service is available
   */
  const checkAvailability = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/tts/status", { credentials: "include" });
      if (!res.ok) return false;
      const data = await res.json();
      return data.available === true;
    } catch {
      return false;
    }
  }, []);

  return {
    settings,
    playbackState,
    error,
    loadSettings,
    updateSettings,
    play,
    pause,
    resume,
    stop,
    checkAvailability,
  };
}
