import { useState, useEffect } from "react";

function isKeyboardTarget(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const tag = element.tagName;
  return (
    element.isContentEditable ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    (tag === "INPUT" && (element as HTMLInputElement).type !== "file")
  );
}

/**
 * Returns the current keyboard height in pixels.
 *
 * With `interactive-widget=overlays-content`, the browser doesn't resize
 * the layout viewport when the on-screen keyboard opens — it overlays
 * the content instead. We use the VisualViewport API to detect the
 * difference and report it so the UI can add bottom padding.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    let lastInset = 0;

    const update = () => {
      // The keyboard height is the gap between the layout viewport (window.innerHeight)
      // and the visual viewport (which shrinks when the keyboard is shown).
      const keyboardHeight = isKeyboardTarget(document.activeElement)
        ? window.innerHeight - vv.height - vv.offsetTop
        : 0;
      const nextInset = Math.max(0, Math.round(keyboardHeight));
      if (nextInset !== lastInset) {
        lastInset = nextInset;
        setInset(nextInset);
      }
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    vv.addEventListener("resize", scheduleUpdate, { passive: true });
    vv.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("focusin", scheduleUpdate);
    window.addEventListener("focusout", scheduleUpdate);
    scheduleUpdate();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv.removeEventListener("resize", scheduleUpdate);
      vv.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("focusin", scheduleUpdate);
      window.removeEventListener("focusout", scheduleUpdate);
    };
  }, []);

  return inset;
}
