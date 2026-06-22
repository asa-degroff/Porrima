import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
  /** If true, opening this menu notifies the mobile sidebar to disable its swipe-to-close gesture. */
  blocksSidebarClose?: boolean;
}

const SIDEBAR_BLOCK_CLOSE_SHOW = "sidebar-block-close:show";
const SIDEBAR_BLOCK_CLOSE_HIDE = "sidebar-block-close:hide";

export function ContextMenu({ x, y, onClose, children, blocksSidebarClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position to keep menu within viewport
  const getPosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return { left: x, top: y };
    const rect = menu.getBoundingClientRect();
    const left = x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 8 : x;
    const top = y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 8 : y;
    return { left, top };
  }, [x, y]);

  useEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      const { left, top } = getPosition();
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
  }, [getPosition]);

  // Click/touch outside to close
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e instanceof TouchEvent ? e.target : e.target;
      if (menuRef.current && !menuRef.current.contains(target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Notify the mobile sidebar to disable its swipe-to-close gesture while open.
  useEffect(() => {
    if (!blocksSidebarClose) return;
    window.dispatchEvent(new CustomEvent(SIDEBAR_BLOCK_CLOSE_SHOW));
    return () => {
      window.dispatchEvent(new CustomEvent(SIDEBAR_BLOCK_CLOSE_HIDE));
    };
  }, [blocksSidebarClose]);

  return createPortal(
    <div
      ref={menuRef}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-[160px] rounded-lg border border-white/10 app-solid-popover shadow-xl py-1"
      style={{ left: x, top: y }}
    >
      {children}
    </div>,
    document.body
  );
}

interface ContextMenuItemProps {
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

export function ContextMenuItem({ onClick, destructive, disabled, children }: ContextMenuItemProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
        disabled
          ? "cursor-not-allowed text-white/35"
          : destructive
          ? "text-red-400 hover:text-red-300 hover:bg-red-500/10"
          : "text-white/80 hover:text-white hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 10;

/**
 * Returns event handlers for long-press (touch-hold) context menus.
 * Attach the returned props to the target element alongside onContextMenu.
 */
export function useLongPress(
  onOpen: (pos: { x: number; y: number }) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPos.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      firedRef.current = false;
      const touch = e.touches[0];
      const sourceElement = e.currentTarget;
      startPos.current = { x: touch.clientX, y: touch.clientY };

      if (clickSuppressor.current) {
        clickSuppressor.current();
        clickSuppressor.current = null;
      }

      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        onOpen({ x: touch.clientX, y: touch.clientY });
        timerRef.current = null;

        // Mobile browsers may dispatch a synthetic mousedown + click after a
        // touch-hold. Suppress that sequence for the long-pressed element so
        // its normal click action cannot run under the open context menu.
        let removed = false;
        let cleanupTimer: number | null = null;
        const remove = () => {
          if (removed) return;
          removed = true;
          if (cleanupTimer !== null) {
            window.clearTimeout(cleanupTimer);
          }
          document.removeEventListener("mousedown", suppress, true);
          document.removeEventListener("click", suppress, true);
          clickSuppressor.current = null;
        };
        const suppress = (mouseEvent: MouseEvent) => {
          const target = mouseEvent.target;
          if (target instanceof Node && sourceElement.contains(target)) {
            mouseEvent.preventDefault();
            mouseEvent.stopPropagation();
            mouseEvent.stopImmediatePropagation();
          }
          if (mouseEvent.type === "click") {
            firedRef.current = false;
            remove();
          }
        };
        clickSuppressor.current = remove;
        document.addEventListener("mousedown", suppress, true);
        document.addEventListener("click", suppress, true);
        cleanupTimer = window.setTimeout(remove, 1000);
      }, LONG_PRESS_MS);
    },
    [onOpen],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPos.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startPos.current.x;
      const dy = touch.clientY - startPos.current.y;
      if (dx * dx + dy * dy > MOVE_THRESHOLD * MOVE_THRESHOLD) {
        clear();
      }
    },
    [clear],
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // If long-press fired, suppress the subsequent click / tap
      if (firedRef.current) {
        e.preventDefault();
      }
      clear();
    },
    [clear],
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!firedRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    firedRef.current = false;
  }, []);

  // Clean up the native suppressor if the long-pressed element unmounts before
  // the synthetic click sequence arrives.
  const clickSuppressor = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      if (clickSuppressor.current) {
        clickSuppressor.current();
        clickSuppressor.current = null;
      }
    };
  }, []);

  // Clean up on unmount
  useEffect(() => clear, [clear]);

  return { onTouchStart, onTouchMove, onTouchEnd, onClickCapture };
}
