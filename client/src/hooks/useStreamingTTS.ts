/**
 * Streaming TTS Hook - MediaSource API Integration
 * 
 * Receives audio_chunk SSE events and streams them incrementally via MediaSource Extensions.
 * Supports pause on tool execution and graceful fallback to non-streaming playback.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import type { TTSSettings } from "../types";

export interface StreamingTTSState {
  isReady: boolean;
  isPlaying: boolean;
  isPaused: boolean;
  error: string | null;
}

/**
 * Hook for streaming TTS audio chunks via MediaSource API
 * 
 * Usage:
 *   const { appendChunk, isReady, isPaused } = useStreamingTTS();
 *   
 *   // In SSE event handler:
 *   eventSource.addEventListener('audio_chunk', (e) => {
 *     const { data } = JSON.parse(e.data);
 *     appendChunk(data.data); // base64 WAV
 *   });
 */
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
  const pendingChunksRef = useRef<string[]>([]); // Queue chunks while buffer is updating
  
  // Initialize MediaSource on mount
  useEffect(() => {
    // Check if MediaSource is supported
    if (!window.MediaSource) {
      setState(prev => ({ ...prev, error: "MediaSource API not supported" }));
      return;
    }
    
    // Check if WAV/PCM is supported
    if (!MediaSource.isTypeSupported('audio/wav; codecs=pcm')) {
      // Fallback to MP3 if available
      if (!MediaSource.isTypeSupported('audio/mpeg')) {
        setState(prev => ({ 
          ...prev, 
          error: "WAV/PCM and MP3 not supported - falling back to non-streaming",
          isReady: false 
        }));
        return;
      }
    }
    
    const ms = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(ms);
    audioRef.current = audio;
    
    ms.addEventListener('sourceopen', () => {
      try {
        // Try WAV first, fallback to MP3
        const mimeType = MediaSource.isTypeSupported('audio/wav; codecs=pcm') 
          ? 'audio/wav; codecs=pcm' 
          : 'audio/mpeg';
        
        const sb = ms.addSourceBuffer(mimeType);
        sb.mode = 'sequence'; // Critical: tells MSE chunks are sequential
        
        sb.addEventListener('updateend', () => {
          // Append pending chunks if any
          if (pendingChunksRef.current.length > 0 && !sb.updating) {
            const nextChunk = pendingChunksRef.current.shift();
            if (nextChunk) {
              try {
                const binary = atob(nextChunk);
                const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
                sb.appendBuffer(bytes);
              } catch (err) {
                console.error('[StreamingTTS] Failed to append chunk:', err);
              }
            }
          }
          
          // Auto-play if not already playing
          if (ms.readyState === 'open' && audio.paused && !state.isPaused) {
            audio.play().catch(err => {
              console.warn('[StreamingTTS] Auto-play failed:', err);
            });
          }
        });
        
        sb.addEventListener('error', (e) => {
          console.error('[StreamingTTS] SourceBuffer error:', e);
          setState(prev => ({ ...prev, error: "Audio buffer error" }));
        });
        
        sourceBufferRef.current = sb;
        setState(prev => ({ ...prev, isReady: true }));
      } catch (err) {
        console.error('[StreamingTTS] Failed to add source buffer:', err);
        setState(prev => ({ ...prev, error: "Failed to initialize audio buffer", isReady: false }));
      }
    });
    
    ms.addEventListener('sourceclose', () => {
      setState(prev => ({ ...prev, isPlaying: false, isReady: false }));
    });
    
    mediaSourceRef.current = ms;
    
    return () => {
      if (ms.readyState === 'open') {
        ms.endOfStream();
      }
      audio.pause();
      audio.src = '';
      URL.revokeObjectURL(audio.src);
    };
  }, []);
  
  // Append WAV chunk (includes 44-byte header)
  const appendChunk = useCallback((base64Wav: string) => {
    const sb = sourceBufferRef.current;
    
    if (!sb) {
      console.warn('[StreamingTTS] SourceBuffer not ready - queuing chunk');
      pendingChunksRef.current.push(base64Wav);
      return;
    }
    
    if (state.isPaused) {
      // Don't append while paused - queue for later
      pendingChunksRef.current.push(base64Wav);
      return;
    }
    
    if (sb.updating) {
      // Buffer is busy - queue chunk
      pendingChunksRef.current.push(base64Wav);
      return;
    }
    
    try {
      const binary = atob(base64Wav);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      sb.appendBuffer(bytes);
    } catch (err) {
      console.error('[StreamingTTS] Failed to append chunk:', err);
      setState(prev => ({ ...prev, error: "Failed to append audio chunk" }));
    }
  }, [state.isPaused]);
  
  // Pause playback
  const pause = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setState(prev => ({ ...prev, isPaused: true, isPlaying: false }));
  }, []);
  
  // Resume playback
  const resume = useCallback(() => {
    setState(prev => ({ ...prev, isPaused: false }));
    
    // Append any pending chunks
    if (sourceBufferRef.current && !sourceBufferRef.current.updating) {
      while (pendingChunksRef.current.length > 0) {
        const chunk = pendingChunksRef.current.shift();
        if (chunk) {
          try {
            const binary = atob(chunk);
            const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
            sourceBufferRef.current.appendBuffer(bytes);
          } catch (err) {
            console.error('[StreamingTTS] Failed to append pending chunk:', err);
          }
        }
      }
    }
    
    if (audioRef.current && audioRef.current.paused) {
      audioRef.current.play().catch(err => {
        console.warn('[StreamingTTS] Resume play failed:', err);
      });
    }
  }, []);
  
  // End stream (call when done event received)
  const endStream = useCallback(() => {
    const ms = mediaSourceRef.current;
    if (ms && ms.readyState === 'open') {
      ms.endOfStream();
    }
    setState(prev => ({ ...prev, isPlaying: false }));
  }, []);
  
  return {
    ...state,
    appendChunk,
    pause,
    resume,
    endStream,
    audio: audioRef.current,
  };
}
