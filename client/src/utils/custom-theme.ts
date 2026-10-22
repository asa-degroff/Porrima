import type { CustomTheme, ThemePreset } from "../types";
import { contrastRatio, mixHexOklab, relativeLuminanceHex } from "./oklch";

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  background: "#1e1b4b",
  accent: "#fbbf24",
};

export const THEME_PRESET_MAX_NAME_LENGTH = 32;

/** Client-side mirror of the server's name rules (trim, collapse whitespace,
 *  length cap) — same contract as normalizeThemePresetName in chat-storage.ts. */
export function normalizeThemePresetName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (!name) return null;
  return name.length > THEME_PRESET_MAX_NAME_LENGTH
    ? name.slice(0, THEME_PRESET_MAX_NAME_LENGTH).trim()
    : name;
}

export type ThemePresetSaveResult =
  | { ok: true; presets: ThemePreset[]; id: string }
  | { ok: false; error: string };

/**
 * Save the current custom colors as a theme preset. When `boundId` names an
 * existing preset, the save applies to it in place — editing the name renames
 * it, changing the colors recolors it, and the id is preserved. Without a
 * binding the save creates a new entry. Names are unique
 * case-insensitively; a collision returns an error instead of writing.
 */
export function saveThemePreset(
  presets: ThemePreset[],
  boundId: string | undefined,
  name: string,
  colors: CustomTheme,
): ThemePresetSaveResult {
  const normalized = normalizeThemePresetName(name);
  if (!normalized) return { ok: false, error: "Enter a name to save this theme." };
  const collides = (skipId?: string) =>
    presets.some((preset) => preset.id !== skipId && preset.name.toLowerCase() === normalized.toLowerCase());
  const bound = boundId ? presets.find((preset) => preset.id === boundId) : undefined;
  if (bound) {
    if (collides(bound.id)) {
      return { ok: false, error: `A theme named “${normalized}” already exists.` };
    }
    return {
      ok: true,
      id: bound.id,
      presets: presets.map((preset) =>
        preset.id === bound.id
          ? { ...preset, name: normalized, background: colors.background, accent: colors.accent }
          : preset,
      ),
    };
  }
  if (collides()) {
    return { ok: false, error: `A theme named “${normalized}” already exists.` };
  }
  const id = crypto.randomUUID();
  return {
    ok: true,
    id,
    presets: [...presets, { id, name: normalized, background: colors.background, accent: colors.accent }],
  };
}

/**
 * Save the current colors as a brand-new preset, ignoring any bound preset.
 * Mirrors {@link saveThemePreset}'s name validation but resolves collisions by
 * appending " (2)", " (3)", … instead of erroring, so one-click duplication of
 * a loaded theme never needs a manual rename.
 */
export function saveThemePresetAsNew(
  presets: ThemePreset[],
  name: string,
  colors: CustomTheme,
): ThemePresetSaveResult {
  const normalized = normalizeThemePresetName(name);
  if (!normalized) return { ok: false, error: "Enter a name to save this theme." };
  const id = crypto.randomUUID();
  return {
    ok: true,
    id,
    presets: [
      ...presets,
      { id, name: uniqueThemePresetName(normalized, presets), background: colors.background, accent: colors.accent },
    ],
  };
}

/** First name free of case-insensitive collisions: `name` itself or `name (2)`, `name (3)`, … */
function uniqueThemePresetName(name: string, presets: ThemePreset[]): string {
  const taken = new Set(presets.map((preset) => preset.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i += 1) {
    const suffix = ` (${i})`;
    const base =
      name.length + suffix.length > THEME_PRESET_MAX_NAME_LENGTH
        ? name.slice(0, THEME_PRESET_MAX_NAME_LENGTH - suffix.length).trim()
        : name;
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

// The application uses light text and translucent white surfaces throughout.
// This threshold is approximately the maximum luminance that still gives
// white text a 4.5:1 contrast ratio.
export const CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE = 0.183;

type Rgb = { r: number; g: number; b: number };

const CUSTOM_THEME_VARIABLES = [
  "--custom-theme-background",
  "--custom-theme-accent-rgb",
  "--custom-theme-primary-text-rgb",
  "--custom-theme-secondary-rgb",
  "--custom-theme-secondary-text-rgb",
  "--custom-theme-accent-text-rgb",
  "--custom-theme-gradient-edge",
  "--custom-theme-gradient-quarter",
  "--custom-theme-gradient-near-center",
] as const;

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  const short = /^#([0-9a-f]{3})$/.exec(raw);
  if (short) {
    return `#${short[1].split("").map((part) => `${part}${part}`).join("")}`;
  }
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
}

export function normalizeCustomTheme(value: unknown): CustomTheme | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CustomTheme>;
  const background = normalizeHexColor(candidate.background);
  const accent = normalizeHexColor(candidate.accent);
  if (!background || !accent) return null;
  return { background, accent };
}

function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHexColor(hex) || DEFAULT_CUSTOM_THEME.background;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToCss({ r, g, b }: Rgb): string {
  return `${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}`;
}

/**
 * Mix two hex colors in OKLab space. Mixing in perceptual space keeps the
 * midpoint of the transition vivid — RGB channel averaging drifts toward
 * gray on complementary hues.
 */
function mixHex(first: string, second: string, secondWeight: number): string {
  return mixHexOklab(first, second, secondWeight);
}

/** WCAG relative luminance of a theme hex. An unparseable hex falls back to
 *  the default background, as every caller has always done. The luminance and
 *  ratio math lives in utils/oklch.ts — this is a theme-flavored wrapper, not a
 *  second implementation. */
export function getRelativeLuminance(hex: string): number {
  const normalized = normalizeHexColor(hex);
  return relativeLuminanceHex(normalized ?? DEFAULT_CUSTOM_THEME.background) ?? 0;
}

/** WCAG contrast ratio between two theme hexes, 1 (identical) to 21. */
export function getCustomThemeContrast(first: string, second: string): number {
  return contrastRatio(getRelativeLuminance(first), getRelativeLuminance(second));
}export function isCustomThemeBackgroundDark(background: string): boolean {
  const normalized = normalizeHexColor(background);
  return normalized !== null && getRelativeLuminance(normalized) <= CUSTOM_THEME_MAX_BACKGROUND_LUMINANCE;
}

export function getCustomThemeBackgroundError(background: string): string | null {
  if (!normalizeHexColor(background)) return "Choose a valid background color.";
  if (!isCustomThemeBackgroundDark(background)) {
    return "Choose a darker background so the app's light text remains readable.";
  }
  return null;
}

/** WCAG 1.4.11 (non-text contrast): the ratio at which accent-colored borders,
 *  rails and icons read as distinct from the background. */
export const ACCENT_UI_MIN_CONTRAST = 3;

/** WCAG 1.4.3 (text): the ratio body-size text needs against its background. */
export const ACCENT_TEXT_MIN_CONTRAST = 4.5;

/** The floor the derivation itself enforces on accent-derived text colors. It
 *  is the UI threshold, not the text threshold — which is why a custom theme
 *  can end up with body text below 4.5:1 while every guard still passes. */
const ACCENT_TEXT_DERIVATION_MIN_CONTRAST = ACCENT_UI_MIN_CONTRAST;

/** The accent color the app actually paints text with: the accent lightened
 *  toward white in OKLab until it clears the derivation floor above. Exported
 *  because the contrast readout has to measure what is rendered, not just what
 *  was picked. */
export function readableAccentText(accent: string, background: string): string {
  const candidates = [
    mixHex(accent, "#ffffff", 0.35),
    mixHex(accent, "#ffffff", 0.65),
    "#ffffff",
  ];
  return (
    candidates.find(
      (candidate) => getCustomThemeContrast(candidate, background) >= ACCENT_TEXT_DERIVATION_MIN_CONTRAST,
    ) ?? "#ffffff"
  );
}

export interface CustomThemeAccentContrast {
  /** The picked accent against the background — governs borders, rails, icons. */
  accentRatio: number;
  /** The derived accent-text color against the background — governs type. */
  textRatio: number;
  /** Null when both clear their thresholds; otherwise what is short and by how much. */
  note: string | null;
}

/**
 * Contrast readout for the accent/background pair. Two ratios because the theme
 * renders the pair twice: the picked accent for non-text UI, and a lightened
 * version of it for text. A pair can fail either bar independently — a dark
 * accent on a dark background makes accent borders invisible while the derived
 * text still reads fine, and a mid-tone accent can clear 3:1 as text while the
 * picked color never stands out as a border.
 */
export function getCustomThemeAccentContrast(background: string, accent: string): CustomThemeAccentContrast {
  const accentRatio = getCustomThemeContrast(accent, background);
  const textRatio = getCustomThemeContrast(readableAccentText(accent, background), background);
  const shortfalls: string[] = [];
  if (accentRatio < ACCENT_UI_MIN_CONTRAST) {
    shortfalls.push(
      `the accent sits ${accentRatio.toFixed(1)}:1 against the background — below ${ACCENT_UI_MIN_CONTRAST}:1 its borders, rails and icons will not stand out`,
    );
  }
  if (textRatio < ACCENT_TEXT_MIN_CONTRAST) {
    shortfalls.push(
      `accent text resolves to ${textRatio.toFixed(1)}:1 — below ${ACCENT_TEXT_MIN_CONTRAST}:1 for body-size type`,
    );
  }
  return {
    accentRatio,
    textRatio,
    note: shortfalls.length > 0 ? `Low contrast: ${shortfalls.join("; ")}.` : null,
  };
}

export function getCustomThemeCssVariables(theme: CustomTheme): Record<string, string> {
  const normalized = normalizeCustomTheme(theme);
  const effective = normalized && isCustomThemeBackgroundDark(normalized.background)
    ? normalized
    : DEFAULT_CUSTOM_THEME;
  const accent = hexToRgb(effective.accent);
  const accentText = readableAccentText(effective.accent, effective.background);
  const secondary = mixHex(effective.accent, "#ffffff", 0.12);
  const secondaryText = readableAccentText(secondary, effective.background);

  return {
    "--custom-theme-background": effective.background,
    "--custom-theme-accent-rgb": rgbToCss(accent),
    "--custom-theme-primary-text-rgb": rgbToCss(hexToRgb(accentText)),
    "--custom-theme-secondary-rgb": rgbToCss(hexToRgb(secondary)),
    "--custom-theme-secondary-text-rgb": rgbToCss(hexToRgb(secondaryText)),
    "--custom-theme-accent-text-rgb": rgbToCss(hexToRgb(accentText)),
    "--custom-theme-gradient-edge": mixHex(effective.background, "#000000", 0.55),
    "--custom-theme-gradient-quarter": mixHex(effective.background, "#000000", 0.30),
    "--custom-theme-gradient-near-center": mixHex(effective.background, "#000000", 0.15),
  };
}

export function applyCustomThemeCssVariables(root: HTMLElement, theme: CustomTheme): void {
  for (const [name, value] of Object.entries(getCustomThemeCssVariables(theme))) {
    root.style.setProperty(name, value);
  }
}

export function clearCustomThemeCssVariables(root: HTMLElement): void {
  for (const name of CUSTOM_THEME_VARIABLES) {
    root.style.removeProperty(name);
  }
}
