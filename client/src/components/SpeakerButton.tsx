import { memo } from "react";

interface Props {
  onClick: () => void;
  disabled?: boolean;
  isPlaying?: boolean;
  size?: "sm" | "md";
  className?: string;
}

const speakerIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

const stopIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
  </svg>
);

const pauseIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const playIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

export const SpeakerButton = memo(function SpeakerButton({
  onClick,
  disabled,
  isPlaying,
  size = "sm",
  className,
}: Props) {
  const iconSize = size === "sm" ? 14 : 18;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${
        disabled
          ? "opacity-30 cursor-not-allowed"
          : "hover:bg-white/10 cursor-pointer"
      } ${className || ""}`}
      title={isPlaying ? "Stop" : "Read aloud"}
    >
      {isPlaying ? stopIcon : speakerIcon}
      <span className="text-xs text-white/60">{isPlaying ? "Stop" : "Read"}</span>
    </button>
  );
});
