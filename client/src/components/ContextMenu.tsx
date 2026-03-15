import { useEffect, useRef, useCallback } from "react";
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

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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
