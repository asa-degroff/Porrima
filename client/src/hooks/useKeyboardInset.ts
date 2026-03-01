import { useState, useEffect } from "react";

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

    const update = () => {
      // The keyboard height is the gap between the layout viewport (window.innerHeight)
      // and the visual viewport (which shrinks when the keyboard is shown).
      const keyboardHeight = window.innerHeight - vv.height;
      setInset(keyboardHeight > 0 ? keyboardHeight : 0);
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return inset;
}
