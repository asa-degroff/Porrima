import type { CustomTheme, Theme } from "../types";
import { getCustomThemeBackgroundError } from "../utils/custom-theme";

export const THEME_OPTIONS: Array<{ value: Theme; label: string; preview: string }> = [
  { value: "default", label: "Lapis", preview: "from-purple-900" },
  { value: "ocean", label: "Ocean", preview: "from-sky-900" },
  { value: "forest", label: "Forest", preview: "from-green-900" },
  { value: "crimson", label: "Crimson", preview: "from-rose-900" },
  { value: "mono", label: "Asphalt", preview: "from-gray-900" },
  { value: "strawberry", label: "Strawberry", preview: "from-pink-700" },
  { value: "coffee", label: "Coffee", preview: "from-amber-950" },
  { value: "emerald", label: "Emerald", preview: "from-emerald-900" },
  { value: "copper", label: "Copper", preview: "from-orange-900" },
  { value: "oxidized-copper", label: "Verdigris", preview: "from-teal-900" },
  { value: "iron", label: "Iron", preview: "from-gray-800" },
  { value: "rust", label: "Rust", preview: "from-orange-950" },
  { value: "custom", label: "Custom", preview: "from-white/20" },
];

interface ThemePickerProps {
  theme: Theme;
  customTheme: CustomTheme;
  onThemeChange: (theme: Theme) => void;
  onCustomThemeChange: (theme: CustomTheme) => void;
}

export function ThemePicker({ theme, customTheme, onThemeChange, onCustomThemeChange }: ThemePickerProps) {
  const backgroundError = getCustomThemeBackgroundError(customTheme.background);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {THEME_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            onClick={() => onThemeChange(option.value)}
            aria-pressed={theme === option.value}
            className={`relative px-3 py-3 rounded-lg text-sm font-medium border transition-all overflow-hidden min-h-12 ${
              theme === option.value
                ? "border-white/30"
                : "border-white/10 hover:border-white/20"
            } pressable`}
          >
            <div
              className={`absolute inset-0 bg-gradient-to-br ${option.preview} to-transparent opacity-20`}
              aria-hidden="true"
            />
            {option.value === "custom" && (
              <div
                className="absolute inset-0 opacity-35"
                style={{ background: `linear-gradient(135deg, ${customTheme.background}, ${customTheme.accent})` }}
                aria-hidden="true"
              />
            )}
            <span className="relative z-10">{option.label}</span>
          </button>
        ))}
      </div>

      {theme === "custom" && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3 space-y-3">
          <div>
            <p className="text-sm font-medium text-white/70">Custom colors</p>
            <p className="text-xs text-white/35 mt-0.5">
              Choose a dark background and an accent color. The gradient and supporting theme colors are derived automatically.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <ColorControl
              label="Background"
              value={customTheme.background}
              onChange={(background) => onCustomThemeChange({ ...customTheme, background })}
            />
            <ColorControl
              label="Accent"
              value={customTheme.accent}
              onChange={(accent) => onCustomThemeChange({ ...customTheme, accent })}
            />
          </div>

          {backgroundError ? (
            <p className="text-xs text-red-300/80" role="alert">{backgroundError}</p>
          ) : (
            <p className="text-xs text-white/30">The background must remain dark enough for the app's light text.</p>
          )}
        </div>
      )}
    </>
  );
}

function ColorControl({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="flex items-center gap-3 rounded-md border border-white/10 bg-black/10 px-3 py-2 cursor-pointer">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-label={`${label} color`}
        className="h-9 w-9 shrink-0 rounded border border-white/20 bg-transparent cursor-pointer"
      />
      <span className="min-w-0">
        <span className="block text-xs text-white/60">{label}</span>
        <span className="block text-[11px] text-white/35 font-mono uppercase">{value}</span>
      </span>
    </label>
  );
}
