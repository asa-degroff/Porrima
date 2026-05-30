import { useCallback, useEffect, useRef, useState } from "react";

interface UseGestureDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
  direction: "up" | "right";
  threshold?: number;
  maxOffset?: number;
  onProgressChange?: (progress: number) => void;
}

interface GestureDrawerReturn {
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchCancel: (e: React.TouchEvent) => void;
  };
  edgeHandlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
    onTouchCancel: (e: React.TouchEvent) => void;
  };
  containerRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  isDragging: boolean;
  isAnimating: boolean;
  openProgress: number;
}

const VELOCITY_THRESHOLD = 0.3; // px/ms — fast flicks snap even at short distance
const DEFAULT_THRESHOLD = 0.3; // 30% of max offset to snap open/closed
const DAMPING = 0.85; // velocity damping per frame
const EDGE_RESISTANCE = 0.3; // resistance factor at boundaries
const MD_BREAKPOINT = 768; // px — matches Tailwind's md: breakpoint
const INTENT_THRESHOLD = 8; // px before a touch becomes a drawer gesture
const AXIS_LOCK_RATIO = 1.15; // vertical intent wins slightly ambiguous gestures

export function useGestureDrawer({
  isOpen,
  onClose,
  onOpen,
  direction = "up",
  threshold = DEFAULT_THRESHOLD,
  maxOffset,
  onProgressChange,
}: UseGestureDrawerProps): GestureDrawerReturn {
  const [isDragging, setIsDragging] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);
  const [containerSize, setContainerSize] = useState(0);

  const isDraggingRef = useRef(false);
  const isTrackingTouchRef = useRef(false);
  const touchStartRef = useRef<{ primary: number; cross: number } | null>(null);
  const dragStartOffsetRef = useRef(0);
  const velocityRef = useRef<number>(0);
  const lastTouchRef = useRef<{ pos: number; time: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  // Refs that mirror the latest values so that touch handlers and the RAF
  // animation can read them synchronously without waiting for a React render.
  // This avoids the stale-closure bug where multiple touchmove events fire
  // between renders and an onTouchEnd callback captures an outdated offset
  // from the last render — causing the snap decision and animation start
  // position to be wrong (sidebar "snaps to the other side").
  const currentOffsetRef = useRef(0);
  const containerSizeRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  const isAnimatingRef = useRef(false);

  // Keep refs in sync. currentOffsetRef and containerSizeRef are also
  // updated synchronously in their setters (see setOffsetSync / setSizeSync).
  currentOffsetRef.current = currentOffset;
  containerSizeRef.current = containerSize;
  isOpenRef.current = isOpen;
  isAnimatingRef.current = isAnimating;

  // Synchronous state+ref setters — update the ref immediately so that
  // subsequent handler calls in the same event batch read the fresh value.
  const setOffsetSync = useCallback((value: number) => {
    currentOffsetRef.current = value;
    setCurrentOffset(value);
  }, []);

  const setSizeSync = useCallback((value: number) => {
    containerSizeRef.current = value;
    setContainerSize(value);
  }, []);

  // Measure container on mount and resize
  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const size = direction === "up" ? el.offsetHeight : el.offsetWidth;
      setSizeSync(size || (maxOffset ?? 0));
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [direction, maxOffset, setSizeSync]);

  // Initialize offset based on open state
  useEffect(() => {
    if (!isDraggingRef.current && isAnimatingRef.current === false && containerSizeRef.current > 0) {
      const newOffset = isOpen ? containerSizeRef.current : 0;
      setOffsetSync(newOffset);
    }
  }, [isOpen, isAnimating, containerSize, setOffsetSync]);

  // Notify progress changes
  useEffect(() => {
    if (onProgressChange && containerSize > 0) {
      const progress = Math.min(1, Math.max(0, currentOffset / containerSize));
      onProgressChange(progress);
    }
  }, [currentOffset, containerSize, onProgressChange]);

  const getTouchPos = useCallback((e: React.TouchEvent) => {
    return direction === "up" ? e.touches[0].clientY : e.touches[0].clientX;
  }, [direction]);

  const getCrossTouchPos = useCallback((e: React.TouchEvent) => {
    return direction === "up" ? e.touches[0].clientX : e.touches[0].clientY;
  }, [direction]);

  const getTranslate = useCallback((offset: number) => {
    if (direction === "up") {
      // Bottom sheet: offset=0 → hidden below (100%), offset=max → visible (0%)
      return `translateY(calc(100% - ${offset}px))`;
    }
    // Left sidebar: offset=0 → hidden left (-100%), offset=max → visible (0%)
    return `translateX(calc(${offset}px - 100%))`;
  }, [direction]);

  const snapToState = useCallback((targetOpen: boolean) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    // Read from refs to get the latest values — avoids stale closures
    const cs = containerSizeRef.current;
    const target = targetOpen ? cs : 0;
    const start = currentOffsetRef.current;
    const startTime = performance.now();
    const duration = 250; // ms

    isAnimatingRef.current = true;
    setIsAnimating(true);

    const animate = (time: number) => {
      const elapsed = time - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const newOffset = start + (target - start) * eased;

      setOffsetSync(newOffset);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        isAnimatingRef.current = false;
        setIsAnimating(false);
        // Read isOpen from the ref — it may have changed during the animation
        // (e.g. the user tapped the backdrop) so we must not use the stale
        // closure value.
        if (!targetOpen) {
          onClose();
        } else if (onOpen && !isOpenRef.current) {
          onOpen();
        }
      }
    };

    rafRef.current = requestAnimationFrame(animate);
  }, [onClose, onOpen]);

  const startTrackingTouch = useCallback((e: React.TouchEvent, startOffset: number) => {
    const primary = getTouchPos(e);
    const cross = getCrossTouchPos(e);
    touchStartRef.current = { primary, cross };
    dragStartOffsetRef.current = startOffset;
    lastTouchRef.current = { pos: primary, time: performance.now() };
    velocityRef.current = 0;
    isTrackingTouchRef.current = true;
    isDraggingRef.current = false;
    setIsDragging(false);
  }, [getCrossTouchPos, getTouchPos]);

  const resetTouchTracking = useCallback(() => {
    isTrackingTouchRef.current = false;
    isDraggingRef.current = false;
    touchStartRef.current = null;
    lastTouchRef.current = null;
    velocityRef.current = 0;
    setIsDragging(false);
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    if (window.innerWidth >= MD_BREAKPOINT) return;

    // Cancel any running snap animation so the new drag doesn't fight the
    // RAF loop for control of currentOffset.
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    isAnimatingRef.current = false;
    setIsAnimating(false);

    const startOffset = isOpenRef.current ? containerSizeRef.current : currentOffsetRef.current;
    startTrackingTouch(e, startOffset);
  }, [startTrackingTouch]);

  // Edge swipe: starts drag from closed state (offset 0)
  const onEdgeTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    if (window.innerWidth >= MD_BREAKPOINT) return;
    if (isOpenRef.current || isDraggingRef.current) return;

    // Cancel any running snap animation
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    isAnimatingRef.current = false;
    setIsAnimating(false);

    setOffsetSync(0);
    startTrackingTouch(e, 0);
  }, [setOffsetSync, startTrackingTouch]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isTrackingTouchRef.current) return;
    if (e.touches.length !== 1) return;

    const pos = getTouchPos(e);
    const crossPos = getCrossTouchPos(e);
    const start = touchStartRef.current;
    if (!start) return;

    const touchDelta = direction === "up" ? start.primary - pos : pos - start.primary;
    const crossDelta = crossPos - start.cross;

    if (!isDraggingRef.current) {
      const absPrimary = Math.abs(touchDelta);
      const absCross = Math.abs(crossDelta);

      if (absPrimary < INTENT_THRESHOLD && absCross < INTENT_THRESHOLD) return;

      if (absCross > absPrimary * AXIS_LOCK_RATIO) {
        resetTouchTracking();
        return;
      }

      const hasOpenOffset = dragStartOffsetRef.current > 0 || isOpenRef.current;
      const movesDrawer = hasOpenOffset ? touchDelta < 0 : touchDelta > 0;

      if (!movesDrawer) {
        resetTouchTracking();
        return;
      }

      isDraggingRef.current = true;
      setIsDragging(true);
    }

    const now = performance.now();
    const lastTouch = lastTouchRef.current;

    // Calculate velocity
    if (lastTouch) {
      const dt = now - lastTouch.time;
      if (dt > 0) {
        const rawDv = (pos - lastTouch.pos) / dt;
        const dv = direction === "up" ? -rawDv : rawDv;
        // Exponential moving average for smoother velocity
        velocityRef.current = velocityRef.current * DAMPING + dv * (1 - DAMPING);
      }
    }

    lastTouchRef.current = { pos, time: now };

    // Calculate offset with edge resistance. touchDelta is positive in the
    // opening direction and negative in the closing direction.
    const cs = containerSizeRef.current;
    let rawOffset = dragStartOffsetRef.current + touchDelta;

    // Apply resistance at boundaries
    if (rawOffset < 0) {
      rawOffset = rawOffset * EDGE_RESISTANCE;
    } else if (rawOffset > cs) {
      rawOffset = cs + (rawOffset - cs) * EDGE_RESISTANCE;
    }

    // Clamp to valid range
    const clampedOffset = Math.max(0, Math.min(cs, rawOffset));
    setOffsetSync(clampedOffset);

    if (e.cancelable) e.preventDefault();
  }, [getCrossTouchPos, getTouchPos, direction, resetTouchTracking, setOffsetSync]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isTrackingTouchRef.current) return;

    const wasDragging = isDraggingRef.current;
    isDraggingRef.current = false;
    isTrackingTouchRef.current = false;
    setIsDragging(false);
    lastTouchRef.current = null;
    touchStartRef.current = null;

    if (!wasDragging) return;
    if (e.cancelable) e.preventDefault();

    // Read from refs so we always use the latest values, even if
    // multiple touchmove events fired between renders and the
    // closure-captured state is stale.
    const velocity = velocityRef.current;
    const distance = currentOffsetRef.current;
    const cs = containerSizeRef.current;
    const snapThreshold = cs * threshold;

    // Determine snap target based on distance and velocity
    let shouldOpen: boolean;

    if (Math.abs(velocity) > VELOCITY_THRESHOLD) {
      // Velocity-based snap — direction matters
      shouldOpen = velocity > 0;
    } else {
      // Distance-based snap
      shouldOpen = distance > snapThreshold;
    }

    snapToState(shouldOpen);
  }, [threshold, snapToState]);

  const onTouchCancel = useCallback((e: React.TouchEvent) => {
    if (!isTrackingTouchRef.current) return;

    const wasDragging = isDraggingRef.current;
    resetTouchTracking();

    if (!wasDragging) return;
    if (e.cancelable) e.preventDefault();
    snapToState(isOpenRef.current);
  }, [resetTouchTracking, snapToState]);

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Track container ref for measurement
  const containerCallback = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
    if (el) {
      const size = direction === "up" ? el.offsetHeight : el.offsetWidth;
      setSizeSync(size || (maxOffset ?? 0));
    }
  }, [direction, maxOffset, setSizeSync]);

  // Apply transform style only when actively dragging or animating the snap.
  // When idle, return empty style so CSS classes control position (important for
  // desktop where md:translate-x-0 must not be overridden by inline styles).
  const active = isDragging || isAnimating;
  const style: React.CSSProperties = active ? {
    transform: getTranslate(currentOffset),
    touchAction: "none",
    willChange: "transform",
    transition: "none",
  } : {};

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
    edgeHandlers: { onTouchStart: onEdgeTouchStart, onTouchMove, onTouchEnd, onTouchCancel },
    containerRef: containerCallback,
    style,
    isDragging,
    isAnimating,
    openProgress: containerSize > 0 ? Math.min(1, Math.max(0, currentOffset / containerSize)) : 0,
  };
}
