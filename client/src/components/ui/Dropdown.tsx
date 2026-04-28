import { DropdownPanel } from "./DropdownPanel";
import { Chevron } from "./Chevron";
import type { DropdownState } from "../../hooks/useDropdown";

const DEFAULT_TRIGGER_CLASS =
  "w-full flex items-center gap-1.5 bg-white/5 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white/80 outline-none hover:bg-white/10 transition-all disabled:opacity-40 cursor-pointer";

const DEFAULT_PANEL_CLASS = "left-0 right-0 top-full mt-1 max-h-[280px] overflow-y-auto";

interface DropdownProps {
  state: DropdownState;
  trigger: React.ReactNode;
  children: React.ReactNode;
  disabled?: boolean;
  wrapperClassName?: string;
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
  panelClassName?: string;
}

// Bundles the relative wrapper, trigger button (with chevron), and panel.
// For most cases pass `trigger` as `<span className="truncate flex-1 text-left">{label}</span>`.
// For custom triggers (multiple inline elements, icons), pass any ReactNode — chevron is appended.
export function Dropdown({
  state,
  trigger,
  children,
  disabled,
  wrapperClassName,
  triggerClassName = DEFAULT_TRIGGER_CLASS,
  triggerStyle,
  panelClassName = DEFAULT_PANEL_CLASS,
}: DropdownProps) {
  const wrapperClass = wrapperClassName ? `relative ${wrapperClassName}` : "relative";
  return (
    <div className={wrapperClass} ref={state.ref}>
      <button
        onClick={() => !disabled && state.toggle()}
        disabled={disabled}
        className={triggerClassName}
        style={triggerStyle}
      >
        {trigger}
        <Chevron open={state.open} />
      </button>
      <DropdownPanel open={state.open} className={panelClassName}>
        {children}
      </DropdownPanel>
    </div>
  );
}
