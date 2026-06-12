import { useState, useCallback, useRef, useEffect } from "react";
import type { TTSSettings } from "../types";
import { getTTSSettings, getTTSStatus, updateTTSSettings } from "../api/tts";
import { useStreamingTTS } from "./useStreamingTTS";

const DEFAULT_SETTINGS: TTSSettings = {
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
  streamingChunkSize: 30,
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

export interface PlaybackState {
  isPlaying: boolean;
  isPaused: boolean;
  isLoading: boolean;
  currentTime: number;
  duration: number;
  audioUrl: string | null;
  currentChunk?: number;
  totalChunks?: number;
  mode?: "single" | "chunked-url" | "chunked-stream";
  waitingForContinuation?: boolean;
}

interface TTSQueueItem {
  audioUrl: string;
  duration: number;
  index: number;
  totalChunks: number;
}

interface PlayOptions {
  voice?: string;
  speed?: number;
  pitch?: number;
  /** Called when playback naturally ends (not on abort/reset). */
  onPlaybackEnd?: () => void;
}

function audioBlobUrlFromBase64(base64Audio: string, mimeType = "audio/wav"): string {
  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

/**
 * Hook for managing TTS playback
 *
 * Two streaming modes:
 * 1. "data" mode — inline base64 audio in SSE events, streamed via MediaSource (low latency)
 * 2. "url" mode — SSE events contain URLs, client fetches WAV files (backward compatible)
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

  // MediaSource streaming hook for "data" mode
  const streamingTTS = useStreamingTTS();

  // Legacy audio element for URL mode
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const playIdRef = useRef(0);
  const streamAbortRef = useRef<AbortController | null>(null);
  const chunkQueueRef = useRef<TTSQueueItem[]>([]);
  const chunkModeRef = useRef<"url" | "data" | null>(null);
  const chunkAudioActiveRef = useRef(false);
  const chunkStreamDoneRef = useRef(false);
  const liveAgentAudioActiveRef = useRef(false);
  const liveAgentChunkIndexRef = useRef(0);
  const objectAudioUrlsRef = useRef<Set<string>>(new Set());
  const onAudioEndedRef = useRef<() => void>(() => {
    setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false, isLoading: false }));
  });
  // Ref for the onPlaybackEnd callback — always points to the latest one
  const onPlaybackEndRef = useRef<(() => void) | undefined>(undefined);
  // While snapshot playback is active, don't re-init the live queue
  const snapshotPlayingRef = useRef(false);
  // Tracks whether the live agent stream ended while snapshot playback was active
  const liveStreamDoneDuringSnapshotRef = useRef(false);
  // Buffers live audio chunks that arrive during snapshot playback, so they can
  // be played after the snapshot finishes instead of being dropped.
  const pendingLiveChunksRef = useRef<TTSQueueItem[]>([]);
  // Fires when a live-mode handoff (resumeLivePlayback) finishes naturally.
  const livePlaybackEndRef = useRef<(() => void) | null>(null);

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
      setSettings(event.detail);
    };

    window.addEventListener('tts-settings-updated', handleSettingsChange as EventListener);
    return () => {
      window.removeEventListener('tts-settings-updated', handleSettingsChange as EventListener);
    };
  }, []);

  // Initialize legacy audio element
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

  const cleanupLiveAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    const currentAudioUrl = currentAudioUrlRef.current;
    if (currentAudioUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(currentAudioUrl);
      objectAudioUrlsRef.current.delete(currentAudioUrl);
    }
    currentAudioUrlRef.current = null;

    for (const item of chunkQueueRef.current) {
      if (item.audioUrl.startsWith("blob:")) {
        URL.revokeObjectURL(item.audioUrl);
        objectAudioUrlsRef.current.delete(item.audioUrl);
      }
    }

    for (const url of objectAudioUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectAudioUrlsRef.current.clear();

    chunkQueueRef.current = [];
    pendingLiveChunksRef.current = [];
    chunkStreamDoneRef.current = true;
    liveAgentAudioActiveRef.current = false;
    liveAgentChunkIndexRef.current = 0;
    chunkAudioActiveRef.current = false;
    chunkModeRef.current = null;
    liveStreamDoneDuringSnapshotRef.current = false;
    livePlaybackEndRef.current = null;
    loadingRef.current = false;
  }, []);

  const resetPlayback = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    cleanupLiveAudio();
    onPlaybackEndRef.current = undefined;
    snapshotPlayingRef.current = false;
    liveStreamDoneDuringSnapshotRef.current = false;
    onAudioEndedRef.current = () => {
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false, isLoading: false }));
    };
    streamingTTS.setOnEnded(null);
    streamingTTS.reset();
  }, [cleanupLiveAudio, streamingTTS]);

  // --- URL MODE: Play queued chunk using legacy HTMLAudioElement ---
  const playQueuedChunk = useCallback(async (playId: number) => {
    if (playId !== playIdRef.current || chunkModeRef.current !== "url") return;

    const next = chunkQueueRef.current.shift();
    if (!next) {
      chunkAudioActiveRef.current = false;
      if (chunkStreamDoneRef.current) {
        chunkModeRef.current = null;
        const currentAudioUrl = currentAudioUrlRef.current;
        if (currentAudioUrl?.startsWith("blob:")) {
          URL.revokeObjectURL(currentAudioUrl);
          objectAudioUrlsRef.current.delete(currentAudioUrl);
          currentAudioUrlRef.current = null;
        }
        setPlaybackState((prev) => ({
          ...prev,
          isPlaying: false,
          isPaused: false,
          isLoading: false,
          currentTime: 0,
        }));
        // URL-mode playback finished. Fire the appropriate callback:
        // - onPlaybackEnd for snapshot playback (used to chain follow-up reads)
        // - livePlaybackEnd for live-mode handoff (used to clear the follow state)
        if (onPlaybackEndRef.current) {
          snapshotPlayingRef.current = false;
          const cb = onPlaybackEndRef.current;
          onPlaybackEndRef.current = undefined;
          if (cb) cb();
        }
        if (livePlaybackEndRef.current) {
          liveAgentAudioActiveRef.current = false;
          const cb = livePlaybackEndRef.current;
          livePlaybackEndRef.current = null;
          if (cb) cb();
        }
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

    const previousAudioUrl = currentAudioUrlRef.current;
    if (previousAudioUrl?.startsWith("blob:") && previousAudioUrl !== next.audioUrl) {
      URL.revokeObjectURL(previousAudioUrl);
      objectAudioUrlsRef.current.delete(previousAudioUrl);
    }

    chunkAudioActiveRef.current = true;
    currentAudioUrlRef.current = next.audioUrl;
    loadingRef.current = true;
    // The global `ended` listener registered in the useEffect will also fire
    // for this same `ended` event. In URL mode we want exactly one
    // playQueuedChunk call per chunk, so let the per-chunk listener below
    // own the handoff and neutralize the global dispatch for this chunk.
    onAudioEndedRef.current = () => {};

    // Attach a per-chunk `ended` listener with { once: true } so the recursive
    // handoff to the next chunk fires exactly once per chunk. The global
    // `ended` listener can fire more than once across a single chunk
    // transition in some browsers when the audio src changes rapidly: the
    // stale `ended` for the previous source can arrive after we've already
    // started loading the next one, which would otherwise shift another
    // chunk off the queue and cut the in-flight chunk off after a few hundred
    // milliseconds of audio.
    const handleChunkEnded = () => {
      if (playId !== playIdRef.current || chunkModeRef.current !== "url") return;
      void playQueuedChunk(playId);
    };
    audio.addEventListener("ended", handleChunkEnded, { once: true });

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

      if (playId !== playIdRef.current || chunkModeRef.current !== "url") {
        loadingRef.current = false;
        return;
      }

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
        mode: "chunked-url",
      });

      await audio.play();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to play audio chunk";
      setError(message);
      console.error("[TTS] Chunk playback error:", err);
      audio.removeEventListener("ended", handleChunkEnded);
      loadingRef.current = false;
      chunkAudioActiveRef.current = false;
      setPlaybackState((prev) => ({ ...prev, isLoading: false, isPlaying: false }));
    }
  }, []);

  // --- SSE STREAM READER (shared) ---
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
    return (settings.backend === "supertonic-3" || settings.backend === "kokoro") && text.trim().length > 220;
  }, [settings.backend]);

  /**
   * Play text using chunked streaming.
   * Tries "data" mode first (inline audio), falls back to "url" mode.
   */
  const playChunked = useCallback(async (
    text: string,
    options?: PlayOptions,
  ) => {
    const playId = ++playIdRef.current;
    resetPlayback();
    setError(null);

    // Store the callback on the ref so the audio 'ended' handler can access the latest one
    onPlaybackEndRef.current = options?.onPlaybackEnd;
    snapshotPlayingRef.current = true;

    const controller = new AbortController();
    streamAbortRef.current = controller;
    loadingRef.current = true;

    setPlaybackState({
      isPlaying: false,
      isPaused: false,
      isLoading: true,
      currentTime: 0,
      duration: 0,
      audioUrl: null,
      currentChunk: 0,
      totalChunks: 0,
      mode: "chunked-stream",
    });

    try {
      // The server emits each generated chunk as a complete WAV file. Appending
      // those chunks into one MediaSource stream is unreliable because WAV
      // headers describe a finite data section, so browsers can stop after the
      // first chunk. Queue the complete files instead.
      const streamMode = "url";
      chunkModeRef.current = streamMode;
      chunkStreamDoneRef.current = false;

      const body: Record<string, any> = {
        text,
        voice: options?.voice ?? settings.voice,
        speed: options?.speed ?? settings.speed,
        pitch: options?.pitch ?? settings.pitch,
        backend: settings.backend,
        supertonicPitchSemitones: settings.supertonicPitchSemitones,
        supertonicLanguage: settings.supertonicLanguage,
        supertonicSteps: settings.supertonicSteps,
        supertonicMaxChunkLength: settings.supertonicMaxChunkLength,
        supertonicSilenceDuration: settings.supertonicSilenceDuration,
        supertonicTrailingSilence: settings.supertonicTrailingSilence,
        kokoroPitchShiftProcessor: settings.kokoroPitchShiftProcessor,
        supertonicPitchShiftProcessor: settings.supertonicPitchShiftProcessor,
      };

      const res = await fetch("/api/tts/generate-stream", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to generate audio" }));
        throw new Error(err.error || "Failed to generate audio");
      }

      await readSseStream(res, (event, data) => {
        if (playId !== playIdRef.current) return;

        if (event === "chunk_plan") {
          setPlaybackState((prev) => ({ ...prev, totalChunks: data.totalChunks ?? 0 }));
          return;
        }

        if (event === "audio_chunk") {
          // DATA MODE: inline base64 audio
          if (chunkModeRef.current === "data" && data.data) {
            streamingTTS.appendChunk(data.data);
            setPlaybackState((prev) => ({
              ...prev,
              isPlaying: true,
              isLoading: false,
              currentChunk: data.index + 1,
              totalChunks: data.totalChunks,
              duration: data.duration,
            }));
            return;
          }

          // URL MODE: queue and play sequentially
          if (chunkModeRef.current === "url" && data.audioUrl) {
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
        }

        if (event === "done") {
          chunkStreamDoneRef.current = true;
          if (chunkModeRef.current === "data") {
            streamingTTS.endStream();
            setPlaybackState((prev) => ({ ...prev, isLoading: false }));
            // Data-mode audio finishes asynchronously after endStream.
            // Fire onPlaybackEnd only when playback actually completes.
            streamingTTS.setOnEnded(() => {
              snapshotPlayingRef.current = false;
              const cb = onPlaybackEndRef.current;
              onPlaybackEndRef.current = undefined;
              streamingTTS.setOnEnded(null);
              if (cb) cb();
            });
          } else {
            if (!chunkAudioActiveRef.current && chunkQueueRef.current.length === 0) {
              void playQueuedChunk(playId);
            }
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
      resetPlayback();
      setPlaybackState((prev) => ({ ...prev, isLoading: false, isPlaying: false }));
    }
  }, [
    playQueuedChunk,
    readSseStream,
    resetPlayback,
    settings.backend,
    settings.kokoroPitchShiftProcessor,
    settings.pitch,
    settings.speed,
    settings.supertonicPitchSemitones,
    settings.supertonicPitchShiftProcessor,
    settings.supertonicLanguage,
    settings.supertonicMaxChunkLength,
    settings.supertonicSilenceDuration,
    settings.supertonicSteps,
    settings.supertonicTrailingSilence,
    settings.voice,
    streamingTTS,
  ]);

  /**
   * Play text aloud
   */
  const play = useCallback(
    async (text: string, options?: PlayOptions) => {
      if (!text.trim()) return;

      if (shouldUseChunkedPlayback(text)) {
        await playChunked(text, options);
        return;
      }

      setError(null);

      try {
        const playId = ++playIdRef.current;
        resetPlayback();

        // Store the callback on the ref
        onPlaybackEndRef.current = options?.onPlaybackEnd;
        snapshotPlayingRef.current = true;

        // Single-mode playback ends via the audio element 'ended' event.
        // Hook onPlaybackEnd into onAudioEndedRef so it fires when playback
        // actually completes (not sooner), and snapshotPlayingRef is cleared
        // at the exact right moment.
        const singlePlayId = playId;
        onAudioEndedRef.current = () => {
          if (singlePlayId !== playIdRef.current) return;
          setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: false, isLoading: false }));
          snapshotPlayingRef.current = false;
          const cb = onPlaybackEndRef.current;
          onPlaybackEndRef.current = undefined;
          if (cb) cb();
        };

        loadingRef.current = true;
        setPlaybackState((prev) => ({
          ...prev,
          isLoading: true,
          mode: "single",
          currentChunk: 0,
          totalChunks: 0,
          waitingForContinuation: false,
        }));

        if (audioRef.current) {
          audioRef.current.pause();
        }

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
            supertonicPitchSemitones: settings.supertonicPitchSemitones,
            supertonicLanguage: settings.supertonicLanguage,
            supertonicSteps: settings.supertonicSteps,
            supertonicMaxChunkLength: settings.supertonicMaxChunkLength,
            supertonicSilenceDuration: settings.supertonicSilenceDuration,
            supertonicTrailingSilence: settings.supertonicTrailingSilence,
            kokoroPitchShiftProcessor: settings.kokoroPitchShiftProcessor,
            supertonicPitchShiftProcessor: settings.supertonicPitchShiftProcessor,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed to generate audio" }));
          throw new Error(err.error || "Failed to generate audio");
        }

        const data = await res.json();
        const audioUrl = data.audioUrl;

        if (audioRef.current) {
          const audio = audioRef.current;
          currentAudioUrlRef.current = audioUrl;

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
    [
      playChunked,
      resetPlayback,
      settings.voice,
      settings.speed,
      settings.pitch,
      settings.backend,
      settings.kokoroPitchShiftProcessor,
      settings.supertonicPitchSemitones,
      settings.supertonicPitchShiftProcessor,
      settings.supertonicLanguage,
      settings.supertonicSteps,
      settings.supertonicMaxChunkLength,
      settings.supertonicSilenceDuration,
      settings.supertonicTrailingSilence,
      shouldUseChunkedPlayback,
    ]
  );

  const pause = useCallback(() => {
    if (playbackState.mode === "chunked-stream" && streamingTTS.isPlaying) {
      streamingTTS.pause();
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: true }));
      return;
    }
    if (audioRef.current && playbackState.isPlaying) {
      audioRef.current.pause();
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isPaused: true }));
    }
  }, [playbackState.isPlaying, playbackState.mode, streamingTTS]);

  const resume = useCallback(() => {
    if (playbackState.mode === "chunked-stream" && streamingTTS.isPaused) {
      streamingTTS.resume();
      setPlaybackState((prev) => ({ ...prev, isPlaying: true, isPaused: false }));
      return;
    }
    if (audioRef.current && playbackState.isPaused && currentAudioUrlRef.current) {
      audioRef.current.play();
      setPlaybackState((prev) => ({ ...prev, isPlaying: true, isPaused: false }));
    }
  }, [playbackState.isPaused, playbackState.mode, streamingTTS]);

  const stop = useCallback(() => {
    playIdRef.current++;
    resetPlayback();
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
  }, [resetPlayback]);

  const setContinuationWaiting = useCallback((waiting: boolean) => {
    setPlaybackState((prev) => {
      if (waiting) {
        if (prev.isPlaying || prev.isPaused || prev.isLoading) return prev;
        return {
          ...prev,
          isLoading: true,
          currentTime: 0,
          duration: 0,
          audioUrl: null,
          currentChunk: 0,
          totalChunks: 0,
          mode: "chunked-url",
          waitingForContinuation: true,
        };
      }

      if (prev.isPlaying || prev.isPaused || !prev.isLoading) return prev;
      return {
        ...prev,
        isLoading: false,
        currentTime: 0,
        duration: 0,
        waitingForContinuation: false,
      };
    });
  }, []);

  const checkAvailability = useCallback(async (): Promise<boolean> => {
    try {
      const data = await getTTSStatus(settings.backend);
      return data.available === true;
    } catch {
      return false;
    }
  }, [settings.backend]);

  /**
   * Hand off from snapshot ("read now") playback to live streaming audio.
   * Called when snapshot playback naturally ends while the agent is still streaming.
   * Transfers any buffered live chunks to the active queue and starts playback.
   *
   * `onPlaybackEnd` is fired when the live queue drains naturally (either because
   * the agent stream ended or because the buffered chunks finished with no
   * more coming). It is NOT fired on user-initiated stop/reset.
   */
  const resumeLivePlayback = useCallback((options?: { onPlaybackEnd?: () => void }) => {
    snapshotPlayingRef.current = false;

    // Transfer live audio chunks that were buffered during snapshot playback
    // so they can be played instead of being lost.
    chunkQueueRef.current.push(...pendingLiveChunksRef.current);
    pendingLiveChunksRef.current = [];

    // If the agent stream ended during snapshot playback, mark the stream as
    // done and don't expect more chunks.
    if (liveStreamDoneDuringSnapshotRef.current) {
      liveStreamDoneDuringSnapshotRef.current = false;
      chunkStreamDoneRef.current = true;
      liveAgentAudioActiveRef.current = false;
    } else {
      // Agent is still streaming — expect more live chunks.
      chunkStreamDoneRef.current = false;
      liveAgentAudioActiveRef.current = true;
    }

    liveAgentChunkIndexRef.current = 0;
    chunkModeRef.current = "url";
    chunkAudioActiveRef.current = false;

    // Store the handoff callback so the URL-mode "queue drained" branch can
    // fire it when live playback completes.
    livePlaybackEndRef.current = options?.onPlaybackEnd ?? null;

    const hasChunks = chunkQueueRef.current.length > 0;
    setPlaybackState((prev) => ({
      ...prev,
      isPlaying: false,
      isPaused: false,
      isLoading: hasChunks || !chunkStreamDoneRef.current,
      currentTime: 0,
      duration: 0,
      audioUrl: null,
      currentChunk: 0,
      totalChunks: 0,
      mode: "chunked-url" as const,
    }));

    // Kick off playback of any buffered live chunks
    if (hasChunks && !chunkAudioActiveRef.current) {
      void playQueuedChunk(playIdRef.current);
    } else if (!hasChunks && chunkStreamDoneRef.current) {
      // No chunks to play and the agent stream is already done
      const endCb = livePlaybackEndRef.current;
      livePlaybackEndRef.current = null;
      setPlaybackState((prev) => ({ ...prev, isPlaying: false, isLoading: false }));
      if (endCb) endCb();
    }
  }, [playQueuedChunk]);

  /**
   * Handle an incoming live audio chunk from agent streaming.
   * Called by the chat SSE handler when the agent emits audio_chunk events.
   * Live agent chunks are complete WAV files. Play them as a small URL queue;
   * appending arbitrary WAV files through MediaSource is unreliable in browsers.
   */
  const handleAgentAudioChunk = useCallback((chunk: {
    chunkId: string;
    index?: number;
    totalChunks?: number;
    data: string;
    mimeType: string;
    sampleRate: number;
    duration?: number;
  }) => {
    // Buffer live chunks during snapshot playback instead of dropping them,
    // so they can be played after the snapshot-to-live handoff.
    if (snapshotPlayingRef.current) {
      const audioUrl = audioBlobUrlFromBase64(chunk.data, chunk.mimeType || "audio/wav");
      objectAudioUrlsRef.current.add(audioUrl);
      pendingLiveChunksRef.current.push({
        audioUrl,
        duration: chunk.duration ?? 0,
        index: chunk.index ?? liveAgentChunkIndexRef.current++,
        totalChunks: chunk.totalChunks ?? 0,
      });
      return;
    }

    if (!liveAgentAudioActiveRef.current) {
      playIdRef.current++;
      resetPlayback();
      liveAgentAudioActiveRef.current = true;
      liveAgentChunkIndexRef.current = 0;
      chunkModeRef.current = "url";
      chunkStreamDoneRef.current = false;
      setPlaybackState((prev) => ({
        ...prev,
        isPlaying: false,
        isPaused: false,
        isLoading: true,
        currentTime: 0,
        duration: 0,
        audioUrl: null,
        currentChunk: 0,
        totalChunks: 0,
        mode: "chunked-url" as const,
      }));
    }

    const audioUrl = audioBlobUrlFromBase64(chunk.data, chunk.mimeType || "audio/wav");
    objectAudioUrlsRef.current.add(audioUrl);
    const index = chunk.index ?? liveAgentChunkIndexRef.current++;
    chunkQueueRef.current.push({
      audioUrl,
      duration: chunk.duration ?? 0,
      index,
      totalChunks: chunk.totalChunks ?? 0,
    });

    if (!chunkAudioActiveRef.current) {
      void playQueuedChunk(playIdRef.current);
    }
  }, [playQueuedChunk, resetPlayback]);

  const handleAgentAudioDone = useCallback(() => {
    // If snapshot playback is active, defer the done signal.
    // resumeLivePlayback will check this flag and mark the stream as done.
    if (snapshotPlayingRef.current) {
      liveStreamDoneDuringSnapshotRef.current = true;
      return;
    }

    chunkStreamDoneRef.current = true;
    liveAgentAudioActiveRef.current = false;
    setPlaybackState((prev) => ({ ...prev, isLoading: false }));

    if (!chunkAudioActiveRef.current && chunkQueueRef.current.length === 0) {
      void playQueuedChunk(playIdRef.current);
    }
  }, [playQueuedChunk]);

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
    setContinuationWaiting,
    checkAvailability,
    handleAgentAudioChunk,
    handleAgentAudioDone,
    resumeLivePlayback,
    cleanupLiveAudio,
  };
}
