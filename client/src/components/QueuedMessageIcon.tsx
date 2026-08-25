import { useEffect, useRef, useState } from "react";

interface QueuedMessageIconProps {
  /** Show the icon. When it flips to false, the icon lingers briefly so the
   *  exit fade can play before unmounting. */
  visible: boolean;
  title?: string;
}

/**
 * Static speech-bubble glyph for chats with queued messages waiting.
 *
 * Deliberately unanimated — a queued message is parked, not doing work, in
 * contrast to the animated PrefillActivityIcon (cache warming). Fades in on
 * appearance and lingers ~200ms on removal so a drain reads as the icon
 * quietly leaving rather than popping out.
 */
export function QueuedMessageIcon({ visible, title }: QueuedMessageIconProps) {
  const [render, setRender] = useState(visible);
  const [exiting, setExiting] = useState(false);
  const mountedRef = useRef(visible);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (visible) {
      mountedRef.current = true;
      setRender(true);
      setExiting(false);
    } else if (mountedRef.current) {
      mountedRef.current = false;
      setExiting(true);
      timerRef.current = window.setTimeout(() => {
        setRender(false);
        setExiting(false);
      }, 200);
    }
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [visible]);

  if (!render) return null;

  return (
    <div
      className="text-sky-400/70"
      style={{
        opacity: exiting ? 0 : 1,
        transition: "opacity 200ms ease",
        animation: exiting ? "none" : "queued-message-in 180ms ease-out",
      }}
      title={title}
      aria-hidden={!title}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </div>
  );
}
