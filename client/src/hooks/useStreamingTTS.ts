/**
 * Streaming TTS Hook - MediaSource API Integration
 *
 * Receives base64 WAV chunks and appends them incrementally to a MediaSource.
 * Chunks that arrive before the SourceBuffer opens are queued instead of
 * dropped, which matters immediately after resetting for a new playback.
 */

import { useState, useCallback, useRef, useEffect } from "react";

export interface StreamingTTSState {
  isReady: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  error: string | null;
}

const WAV_HEADER_SIZE = 44;

function decodeBase64(base64Wav: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64Wav);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stripWavHeader(bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (bytes.length <= WAV_HEADER_SIZE) return bytes;
  const sliced = bytes.slice(WAV_HEADER_SIZE);
  return new Uint8Array<ArrayBuffer>(sliced.buffer, sliced.byteOffset, sliced.byteLength);
}

export function useStreamingTTS() {
  const [state, setState] = useState<StreamingTTSState>({
    isReady: false,
    isPlaying: false,
    isPaused: false,
    error: null,
  });

  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const pendingChunksRef = useRef<Uint8Array<ArrayBuffer>[]>([]);
  const firstChunkRef = useRef(true);
  const isStreamEndedRef = useRef(false);
  const isPausedRef = useRef(false);
  const onEndedRef = useRef<(() => void) | null>(null);

  const prepareChunk = useCallback((base64Wav: string): Uint8Array<ArrayBuffer> => {
    const bytes = decodeBase64(base64Wav);
    if (firstChunkRef.current) {
      firstChunkRef.current = false;
      return bytes;
    }
    return stripWavHeader(bytes);
  }, []);

  const flushPending = useCallback(() => {
    const ms = mediaSourceRef.current;
    const sb = sourceBufferRef.current;
    if (!ms || ms.readyState !== "open" || !sb || sb.updating) return;

    const next = pendingChunksRef.current.shift();
    if (next) {
      try {
        sb.appendBuffer(next);
      } catch (err) {
        console.error("[StreamingTTS] Failed to append queued chunk:", err);
        setState((prev) => ({ ...prev, error: "Audio buffer append failed" }));
      }
      return;
    }

    if (isStreamEndedRef.current) {
      try {
        ms.endOfStream();
      } catch {
        // Ignore races with a closing MediaSource.
      }
    }
  }, []);

  const disposeCurrentStream = useCallback(() => {
    const ms = mediaSourceRef.current;
    const audio = audioRef.current;

    if (ms?.readyState === "open") {
      try {
        ms.endOfStream();
      } catch {
        // The source may already be ending; reset should still continue.
      }
    }

    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    mediaSourceRef.current = null;
    sourceBufferRef.current = null;
    audioRef.current = null;
  }, []);

  const initializeStream = useCallback(() => {
    if (!window.MediaSource) {
      setState((prev) => ({ ...prev, isReady: false, error: "MediaSource API not supported" }));
      return;
    }

    const ms = new MediaSource();
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(ms);
    audio.src = objectUrl;

    mediaSourceRef.current = ms;
    audioRef.current = audio;
    objectUrlRef.current = objectUrl;

    ms.addEventListener("sourceopen", () => {
      if (mediaSourceRef.current !== ms) return;
      try {
        const mimeType = MediaSource.isTypeSupported("audio/wav; codecs=1")
          ? "audio/wav; codecs=1"
          : "audio/wav";
        const sb = ms.addSourceBuffer(mimeType);
        if ("mode" in sb) {
          (sb as any).mode = "sequence";
        }

        sb.addEventListener("updateend", () => {
          if (mediaSourceRef.current !== ms || sourceBufferRef.current !== sb) return;
          flushPending();
          if (audio.paused && !isPausedRef.current && !isStreamEndedRef.current) {
            audio.play().catch((err) => {
              if (err.name !== "NotAllowedError") {
                console.warn("[StreamingTTS] Auto-play failed:", err);
              }
            });
          }
        });

        sb.addEventListener("error", () => {
          if (mediaSourceRef.current !== ms || sourceBufferRef.current !== sb) return;
          console.error("[StreamingTTS] SourceBuffer error");
          setState((prev) => ({ ...prev, error: "Audio buffer error" }));
        });

        sourceBufferRef.current = sb;
        setState((prev) => ({ ...prev, isReady: true, error: null }));
        flushPending();
      } catch (err) {
        console.error("[StreamingTTS] Failed to initialize audio buffer:", err);
        setState((prev) => ({ ...prev, error: "Failed to initialize audio buffer", isReady: false }));
      }
    });

    ms.addEventListener("sourceclose", () => {
      if (mediaSourceRef.current !== ms) return;
      setState((prev) => ({ ...prev, isPlaying: false, isReady: false }));
    });

    audio.addEventListener("playing", () => {
      setState((prev) => ({ ...prev, isPlaying: true }));
    });
    audio.addEventListener("pause", () => {
      if (!isPausedRef.current) {
        setState((prev) => ({ ...prev, isPlaying: false }));
      }
    });
    audio.addEventListener("ended", () => {
      setState((prev) => ({ ...prev, isPlaying: false, isPaused: false }));
      onEndedRef.current?.();
    });
  }, [flushPending]);

  useEffect(() => {
    initializeStream();
    return () => {
      disposeCurrentStream();
    };
  }, [disposeCurrentStream, initializeStream]);

  const appendChunk = useCallback((base64Wav: string) => {
    const chunk = prepareChunk(base64Wav);
    const ms = mediaSourceRef.current;
    const sb = sourceBufferRef.current;

    if (!ms || ms.readyState !== "open" || !sb || sb.updating || isPausedRef.current) {
      pendingChunksRef.current.push(chunk);
      return;
    }

    try {
      sb.appendBuffer(chunk);
    } catch (err) {
      console.error("[StreamingTTS] Failed to append chunk:", err);
      setState((prev) => ({ ...prev, error: "Failed to append audio chunk" }));
    }
  }, [prepareChunk]);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    audioRef.current?.pause();
    setState((prev) => ({ ...prev, isPaused: true, isPlaying: false }));
  }, []);

  const resume = useCallback(() => {
    isPausedRef.current = false;
    setState((prev) => ({ ...prev, isPaused: false }));
    flushPending();

    if (audioRef.current?.paused) {
      audioRef.current.play().catch((err) => {
        if (err.name !== "NotAllowedError") {
          console.warn("[StreamingTTS] Resume play failed:", err);
        }
      });
    }
  }, [flushPending]);

  const endStream = useCallback(() => {
    isStreamEndedRef.current = true;
    flushPending();
  }, [flushPending]);

  const setOnEnded = useCallback((cb: (() => void) | null) => {
    onEndedRef.current = cb;
  }, []);

  const reset = useCallback(() => {
    pendingChunksRef.current = [];
    firstChunkRef.current = true;
    isStreamEndedRef.current = false;
    isPausedRef.current = false;
    onEndedRef.current = null;
    disposeCurrentStream();
    setState({
      isReady: false,
      isPlaying: false,
      isPaused: false,
      error: null,
    });
    initializeStream();
  }, [disposeCurrentStream, initializeStream]);

  return {
    ...state,
    appendChunk,
    pause,
    resume,
    endStream,
    reset,
    setOnEnded,
    audio: audioRef.current,
  };
}
