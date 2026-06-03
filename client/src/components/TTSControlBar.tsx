import { memo } from "react";
import { useHaptics } from "../hooks/useHaptics";
import type { PlaybackState } from "../hooks/useTTS";

interface Props {
  playbackState: PlaybackState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

const loadingIcon = (
  <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

const playIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const pauseIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const stopIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
  </svg>
);

export const TTSControlBar = memo(function TTSControlBar({
  playbackState,
  onPause,
  onResume,
  onStop,
}: Props) {
  const { light } = useHaptics();

  const { isPlaying, isPaused, isLoading, currentTime, duration, waitingForContinuation } = playbackState;
  const isChunked = playbackState.mode === "chunked-url" || playbackState.mode === "chunked-stream";
  const chunkLabel = isChunked && playbackState.totalChunks
    ? `Chunk ${playbackState.currentChunk || 0}/${playbackState.totalChunks}`
    : null;

  if (!isPlaying && !isPaused && !isLoading) {
    return null;
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 theme-primary-bg backdrop-blur-md border-t theme-primary-border py-2 px-4 safe-area-bottom">
      <div className="max-w-4xl mx-auto flex items-center gap-3">
        {/* Play/Pause/Loading button */}
        {isLoading ? (
          <button
            className="w-9 h-9 rounded-full theme-accent-bg border theme-accent-border theme-accent-text flex items-center justify-center shrink-0 cursor-wait"
            title={waitingForContinuation ? "Waiting for more text..." : "Generating audio..."}
            disabled
          >
            {loadingIcon}
          </button>
        ) : (
          <button
            onClick={() => {
              light();
              isPlaying ? onPause() : onResume();
            }}
            className="w-9 h-9 rounded-full theme-accent-bg border theme-accent-border theme-accent-text flex items-center justify-center hover:theme-accent-bg-hover transition-colors shrink-0 pressable"
            title={isPlaying ? "Pause" : "Resume"}
          >
            {isPlaying ? pauseIcon : playIcon}
          </button>
        )}

        {/* Progress bar */}
        <div className="flex-1 min-w-0">
          {isLoading ? (
            <div className="h-1.5 theme-accent-bg rounded-full overflow-hidden">
              <div className="h-full theme-accent-text animate-pulse" style={{ width: "100%", opacity: 0.6 }} />
            </div>
          ) : (
            <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full theme-accent-text transition-all duration-300"
                style={{ width: `${progressPercent}%`, opacity: 0.6 }}
              />
            </div>
          )}
          <div className="flex justify-between mt-1 text-[10px] theme-primary-text opacity-60">
            {isLoading ? (
              <span>{waitingForContinuation ? "Waiting for more text..." : chunkLabel ? `Generating next audio... ${chunkLabel}` : "Generating audio..."}</span>
            ) : (
              <>
                <span>{chunkLabel || formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </>
            )}
          </div>
        </div>

        {/* Stop button */}
        {(!isLoading || waitingForContinuation) && (
          <button
            onClick={() => {
              light();
              onStop();
            }}
            className="w-9 h-9 rounded-full bg-white/10 border border-white/20 theme-primary-text opacity-60 flex items-center justify-center hover:bg-white/20 hover:opacity-80 transition-colors shrink-0 pressable"
            title="Stop"
          >
            {stopIcon}
          </button>
        )}
      </div>
    </div>
  );
});

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
