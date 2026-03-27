import { useRef } from "react";

interface DragHandleProps {
  onDoubleTap?: () => void;
  gestureHandlers?: {
    onTouchStart?: (e: React.TouchEvent) => void;
    onTouchMove?: (e: React.TouchEvent) => void;
    onTouchEnd?: (e: React.TouchEvent) => void;
  };
}

export function DragHandle({ onDoubleTap, gestureHandlers }: DragHandleProps) {
  const lastTapRef = useRef<number>(0);

  return (
    <div
      className="w-full flex justify-center py-3 shrink-0 touch-none"
      {...gestureHandlers}
    >
      <button
        onClick={() => {
          const now = Date.now();
          if (now - lastTapRef.current < 250) {
            onDoubleTap?.();
          }
          lastTapRef.current = now;
        }}
        className="w-10 h-1.5 rounded-full bg-white/20 hover:bg-white/40 transition-colors touch-none"
        aria-label="Drag handle"
        title="Double-tap to close or drag to swipe"
      />
    </div>
  );
}
