import { memo } from "react";
import { useHaptics } from "../hooks/useHaptics";
import type { PlaybackState } from "../hooks/useTTS";

interface Props {
  playbackState: PlaybackState;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

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

  const { isPlaying, isPaused, currentTime, duration } = playbackState;

  if (!isPlaying && !isPaused) {
    return null;
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#1a1a2e]/95 backdrop-blur-md border-t border-white/10 py-2 px-4 safe-area-bottom">
      <div className="max-w-4xl mx-auto flex items-center gap-3">
        {/* Play/Pause button */}
        <button
          onClick={() => {
            light();
            isPlaying ? onPause() : onResume();
          }}
          className="w-9 h-9 rounded-full bg-blue-500/20 border border-blue-400/30 text-blue-300 flex items-center justify-center hover:bg-blue-500/30 transition-colors shrink-0"
          title={isPlaying ? "Pause" : "Resume"}
        >
          {isPlaying ? pauseIcon : playIcon}
        </button>

        {/* Progress bar */}
        <div className="flex-1 min-w-0">
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-400/60 transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[10px] text-white/40">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* Stop button */}
        <button
          onClick={() => {
            light();
            onStop();
          }}
          className="w-9 h-9 rounded-full bg-white/10 border border-white/20 text-white/60 flex items-center justify-center hover:bg-white/20 hover:text-white/80 transition-colors shrink-0"
          title="Stop"
        >
          {stopIcon}
        </button>
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
