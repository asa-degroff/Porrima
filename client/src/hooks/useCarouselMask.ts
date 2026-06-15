import { useEffect, useState, useCallback, type RefObject } from "react";

/**
 * Computes a dynamic CSS mask-image for a horizontally scrollable carousel.
 * Only fades edges where there's actually hidden content beyond them.
 *
 * Returns a `style` object to spread on the scroll container.
 */
export function useCarouselMask(ref: RefObject<HTMLElement | null>) {
  const [style, setStyle] = useState<React.CSSProperties>({});

  const compute = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const { scrollLeft, scrollWidth, clientWidth } = el;
    const epsilon = 1; // sub-pixel tolerance

    // No overflow — no mask needed
    if (scrollWidth <= clientWidth + epsilon) {
      setStyle({ WebkitMaskImage: "none", maskImage: "none" });
      return;
    }

    const atStart = scrollLeft <= epsilon;
    const atEnd = scrollLeft + clientWidth >= scrollWidth - epsilon;

    const leftFade = atStart ? "black 0" : "transparent 0, black 12px";
    const rightFade = atEnd ? "black 100%" : "black calc(100% - 12px), transparent 100%";

    const mask = `linear-gradient(to right, ${leftFade}, ${rightFade})`;
    setStyle({ WebkitMaskImage: mask, maskImage: mask });
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onScroll = () => requestAnimationFrame(compute);
    const ro = new ResizeObserver(() => requestAnimationFrame(compute));

    el.addEventListener("scroll", onScroll, { passive: true });
    ro.observe(el);
    compute();

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [compute, ref]);

  return style;
}
