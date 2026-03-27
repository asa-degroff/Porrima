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

  const touchStartRef = useRef<number>(0);
  const velocityRef = useRef<number>(0);
  const lastTouchRef = useRef<{ pos: number; time: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);

  // Measure container on mount and resize
  useEffect(() => {
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const size = direction === "up" ? el.offsetHeight : el.offsetWidth;
      setContainerSize(size || (maxOffset ?? 0));
    };

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [direction, maxOffset]);

  // Initialize offset based on open state
  useEffect(() => {
    if (!isDragging && !isAnimating && containerSize > 0) {
      setCurrentOffset(isOpen ? containerSize : 0);
    }
  }, [isOpen, containerSize, isDragging, isAnimating]);

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

    const target = targetOpen ? containerSize : 0;
    const start = currentOffset;
    const startTime = performance.now();
    const duration = 250; // ms

    setIsAnimating(true);

    const animate = (time: number) => {
      const elapsed = time - startTime;
      const progress = Math.min(1, elapsed / duration);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const newOffset = start + (target - start) * eased;

      setCurrentOffset(newOffset);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setIsAnimating(false);
        if (!targetOpen) {
          onClose();
        } else if (onOpen && !isOpen) {
          onOpen();
        }
      }
    };

    rafRef.current = requestAnimationFrame(animate);
  }, [containerSize, currentOffset, onClose, onOpen, isOpen]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Only respond to single touch
    if (e.touches.length !== 1) return;

    const pos = getTouchPos(e);
    touchStartRef.current = pos;
    lastTouchRef.current = { pos, time: performance.now() };
    velocityRef.current = 0;
    setIsDragging(true);

    // Prevent scroll on the drawer content while dragging
    e.preventDefault();
  }, [getTouchPos]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;
    if (e.touches.length !== 1) return;

    const pos = getTouchPos(e);
    const now = performance.now();
    const lastTouch = lastTouchRef.current;

    // Calculate velocity
    if (lastTouch) {
      const dt = now - lastTouch.time;
      if (dt > 0) {
        const dv = (pos - lastTouch.pos) / dt;
        // Exponential moving average for smoother velocity
        velocityRef.current = velocityRef.current * DAMPING + dv * (1 - DAMPING);
      }
    }

    lastTouchRef.current = { pos, time: now };

    // Calculate offset with edge resistance
    let rawOffset = pos - touchStartRef.current + (isOpen ? containerSize : 0);

    // Apply resistance at boundaries
    if (rawOffset < 0) {
      rawOffset = rawOffset * EDGE_RESISTANCE;
    } else if (rawOffset > containerSize) {
      rawOffset = containerSize + (rawOffset - containerSize) * EDGE_RESISTANCE;
    }

    // Clamp to valid range
    const clampedOffset = Math.max(0, Math.min(containerSize, rawOffset));
    setCurrentOffset(clampedOffset);

    e.preventDefault();
  }, [isDragging, getTouchPos, isOpen, containerSize]);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return;

    setIsDragging(false);
    lastTouchRef.current = null;

    const velocity = velocityRef.current;
    const distance = currentOffset;
    const snapThreshold = containerSize * threshold;

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
  }, [isDragging, currentOffset, containerSize, threshold, snapToState]);

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
      setContainerSize(size || (maxOffset ?? 0));
    }
  }, [direction, maxOffset]);

  // Apply transform style when actively dragging or animating the snap
  const active = isDragging || isAnimating;
  const style: React.CSSProperties = active ? {
    transform: getTranslate(currentOffset),
    touchAction: "none",
    willChange: "transform",
    transition: "none",
  } : {};

  return {
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
    containerRef: containerCallback,
    style,
    isDragging,
    isAnimating,
    openProgress: containerSize > 0 ? Math.min(1, Math.max(0, currentOffset / containerSize)) : 0,
  };
}
