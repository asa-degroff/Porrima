import { useEffect, useState } from "react";

/** True when the OS/user has requested reduced motion.
 *  House pattern: animated indicators collapse to a static frame under this
 *  setting (Five Beats precedent) — components gate their animation, this
 *  hook tracks the preference live. */
export function useReducedMotion() {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    setReduced(mq.matches);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return reduced;
}
