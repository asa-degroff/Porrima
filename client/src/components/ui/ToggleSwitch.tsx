const ACCENT_COLORS: Record<string, { on: string; off: string }> = {
  purple:  { on: "bg-purple-500/30", off: "bg-white/10" },
  blue:    { on: "bg-blue-500/30",   off: "bg-white/10" },
  emerald: { on: "bg-emerald-500/30", off: "bg-white/10" },
  violet:  { on: "bg-violet-500/30", off: "bg-white/10" },
};

interface ToggleSwitchProps {
  checked: boolean;
  onChange: () => void;
  accentColor: "purple" | "blue" | "emerald" | "violet";
  disabled?: boolean;
  ariaLabel?: string;
}

export function ToggleSwitch({ checked, onChange, accentColor, disabled, ariaLabel }: ToggleSwitchProps) {
  const colors = ACCENT_COLORS[accentColor];
  return (
    <button
      onClick={onChange}
      disabled={disabled}
      className={`group relative shrink-0 w-12 h-6 rounded-full
        transition-[background-color] ease-[cubic-bezier(0.4,0,0.2,1)] duration-200
        ${checked ? colors.on : colors.off}
        ${disabled ? "opacity-40 cursor-not-allowed pointer-events-none" : "cursor-pointer"}`}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
    >
      <span
        className={`absolute top-1 w-4 h-4 rounded-full bg-white/80
          transition-[left,transform] duration-200
          ease-[cubic-bezier(0.34,1.56,0.64,1)]
          ${checked ? "left-7" : "left-1"}
          group-active:scale-90`}
      />
    </button>
  );
}
