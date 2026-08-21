import { useEffect, useRef, useState } from "react";
import type { CustomTheme, Theme, ThemePreset } from "../types";
import { getCustomThemeBackgroundError, normalizeThemePresetName } from "../utils/custom-theme";

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
  // Optional saved-preset support. When omitted (e.g. the setup wizard), the
  // picker renders exactly as before.
  themePresets?: ThemePreset[];
  /** Id of the preset currently loaded into the editor. While set, the save
   *  row edits that preset in place (rename via the name field, recolor via
   *  the color controls). */
  activeThemePresetId?: string;
  onLoadPreset?: (preset: ThemePreset) => void;
  /** Save the current colors under the draft name. Applies to the bound
   *  preset in place when one is loaded, otherwise creates a new preset. */
  onSavePreset?: (name: string) => void;
  /** Delete the bound (loaded) preset. */
  onDeletePreset?: () => void;
  /** Report draft-name edits so the parent can clear save errors and unbind
   *  from the loaded preset when the name is cleared (save-as-new). */
  onPresetNameChange?: (draft: string) => void;
  presetError?: string | null;
}

export function ThemePicker({
  theme,
  customTheme,
  onThemeChange,
  onCustomThemeChange,
  themePresets,
  activeThemePresetId,
  onLoadPreset,
  onSavePreset,
  onDeletePreset,
  onPresetNameChange,
  presetError,
}: ThemePickerProps) {
  const backgroundError = getCustomThemeBackgroundError(customTheme.background);
  const presets = themePresets ?? [];
  const presetSupport = Boolean(onLoadPreset && onSavePreset && onDeletePreset);
  const boundPreset = activeThemePresetId
    ? presets.find((preset) => preset.id === activeThemePresetId)
    : undefined;

  // Name draft for the save row. Prefilled when a preset is loaded (or was
  // loaded in a previous session, via the persisted binding); while the draft
  // is non-empty the editor is bound to that preset, and clearing it detaches
  // so the next save creates a new preset.
  const [presetNameDraft, setPresetNameDraft] = useState(() =>
    activeThemePresetId
      ? presets.find((preset) => preset.id === activeThemePresetId)?.name ?? ""
      : ""
  );
  const [confirmDeleteArmed, setConfirmDeleteArmed] = useState(false);
  const prevBoundId = useRef(activeThemePresetId);

  // Clearing the binding (delete, theme switch) empties the draft so the
  // editor starts from a clean, unbound state.
  useEffect(() => {
    if (prevBoundId.current && !activeThemePresetId) setPresetNameDraft("");
    prevBoundId.current = activeThemePresetId;
    setConfirmDeleteArmed(false);
  }, [activeThemePresetId]);

  // The armed delete state disarms itself after a short grace period.
  useEffect(() => {
    if (!confirmDeleteArmed) return;
    const timer = window.setTimeout(() => setConfirmDeleteArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteArmed]);

  const handleTileClick = (value: Theme) => {
    // Entering custom mode directly (not via a preset) starts an unnamed theme.
    if (value === "custom" && theme !== "custom") setPresetNameDraft("");
    onThemeChange(value);
  };

  const loadPreset = (preset: ThemePreset) => {
    setPresetNameDraft(preset.name);
    onLoadPreset?.(preset);
  };

  const handlePresetNameChange = (value: string) => {
    setPresetNameDraft(value);
    onPresetNameChange?.(value);
  };

  const handleDeleteClick = () => {
    if (!confirmDeleteArmed) {
      setConfirmDeleteArmed(true);
      return;
    }
    setConfirmDeleteArmed(false);
    onDeletePreset?.();
  };

  const draftName = normalizeThemePresetName(presetNameDraft);
  const canSavePreset = presetSupport &&
    Boolean(draftName) && backgroundError === null;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {THEME_OPTIONS.map((option) => (
          <button
            type="button"
            key={option.value}
            onClick={() => handleTileClick(option.value)}
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

      {presetSupport && presets.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-white/40">Saved themes</p>
          <div className="flex flex-wrap gap-2">
            {presets.map((preset) => {
              const active = activeThemePresetId === preset.id;
              return (
                <button
                  type="button"
                  key={preset.id}
                  onClick={() => loadPreset(preset)}
                  aria-pressed={active}
                  title={active ? `Editing “${preset.name}”` : `Load “${preset.name}”`}
                  className={`relative px-3 py-2 rounded-lg text-sm font-medium border transition-all overflow-hidden min-h-10 ${
                    active
                      ? "border-white/30"
                      : "border-white/10 hover:border-white/20"
                  } pressable`}
                >
                  <div
                    className={`absolute inset-0 transition-opacity ${
                      active ? "opacity-50" : "opacity-30"
                    }`}
                    style={{ background: `linear-gradient(135deg, ${preset.background}, ${preset.accent})` }}
                    aria-hidden="true"
                  />
                  <span className="relative z-10">{preset.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

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

          {presetSupport && (
            <div className="space-y-2">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <input
                  value={presetNameDraft}
                  onChange={(event) => handlePresetNameChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canSavePreset) {
                      event.preventDefault();
                      onSavePreset?.(presetNameDraft);
                    }
                  }}
                  placeholder="Save as preset…"
                  maxLength={32}
                  aria-label="Preset name"
                  className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/10 px-3 py-2 text-sm text-white/90 placeholder:text-white/30"
                />
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onSavePreset?.(presetNameDraft)}
                    disabled={!canSavePreset}
                    className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 pressable"
                  >
                    {boundPreset ? "Update preset" : "Save preset"}
                  </button>
                  {boundPreset && (
                    <button
                      type="button"
                      onClick={handleDeleteClick}
                      aria-label={confirmDeleteArmed ? `Confirm delete “${boundPreset.name}”` : `Delete “${boundPreset.name}”`}
                      title={confirmDeleteArmed ? "Click again to delete" : "Delete this preset"}
                      className={`grid h-9 w-9 place-items-center rounded-md border transition-colors pressable ${
                        confirmDeleteArmed
                          ? "border-red-400/40 bg-red-500/20 text-red-200 hover:bg-red-500/30"
                          : "border-white/10 bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/80"
                      }`}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </div>
              </div>
              {presetError && (
                <p className="text-xs text-red-300/80" role="alert">{presetError}</p>
              )}
            </div>
          )}

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

/** Same icon as the sidebar context menu's Delete item (ChatListItem), so the
 *  shared `.trash-lid` hover animation in glass.css applies automatically. */
function TrashIcon() {
  return (
    <svg
      className="trash-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ overflow: "visible" }}
      aria-hidden="true"
    >
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <g className="trash-lid">
        <path d="M3 6h18" />
        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      </g>
    </svg>
  );
}
