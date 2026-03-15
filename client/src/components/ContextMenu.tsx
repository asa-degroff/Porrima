import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}

export function ContextMenu({ x, y, onClose, children }: ContextMenuProps) {
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

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[160px] rounded-lg border border-white/10 bg-black/90 backdrop-blur-xl shadow-xl py-1"
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
  children: React.ReactNode;
}

export function ContextMenuItem({ onClick, destructive, children }: ContextMenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-2 ${
        destructive
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
      startPos.current = { x: touch.clientX, y: touch.clientY };
      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        onOpen({ x: touch.clientX, y: touch.clientY });
        timerRef.current = null;
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

  // Clean up on unmount
  useEffect(() => clear, [clear]);

  return { onTouchStart, onTouchMove, onTouchEnd };
}
