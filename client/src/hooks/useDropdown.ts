import { useCallback, useRef, useState } from "react";
import { useClickOutside } from "./useClickOutside";

export interface DropdownState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  close: () => void;
  ref: React.RefObject<HTMLDivElement | null>;
}

export function useDropdown(initial = false): DropdownState {
  const [open, setOpen] = useState(initial);
  const ref = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  useClickOutside(ref, close, open);

  return { open, setOpen, toggle, close, ref };
}
