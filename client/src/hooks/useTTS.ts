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
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false }));
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

  /**
   * Play text aloud
   */
  const play = useCallback(
    async (text: string, options?: { voice?: string; speed?: number; pitch?: number }) => {
      if (!text.trim()) return;

      setError(null);

      try {
        // Set loading state and suppress spurious error events
        loadingRef.current = true;
        setPlaybackState((prev) => ({ ...prev, isLoading: true }));

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
          });

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
    [settings.voice, settings.speed, settings.pitch, settings.backend]
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
    }));
  }, []);

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
