import type { CustomTheme } from "../types";

export const DEFAULT_CUSTOM_THEME: CustomTheme = {
  background: "#1e1b4b",
  accent: "#fbbf24",
};

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

function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b]
    .map((component) => Math.round(component).toString(16).padStart(2, "0"))
    .join("")}`;
}

function mixRgb(first: Rgb, second: Rgb, secondWeight: number): Rgb {
  const weight = Math.min(1, Math.max(0, secondWeight));
  return {
    r: first.r + (second.r - first.r) * weight,
    g: first.g + (second.g - first.g) * weight,
    b: first.b + (second.b - first.b) * weight,
  };
}

function mixHex(first: string, second: string, secondWeight: number): string {
  return rgbToHex(mixRgb(hexToRgb(first), hexToRgb(second), secondWeight));
}

function channelLuminance(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function getRelativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

export function isCustomThemeBackgroundDark(background: string): boolean {
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

function contrastRatio(first: string, second: string): number {
  const firstLuminance = getRelativeLuminance(first);
  const secondLuminance = getRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function readableAccentText(accent: string, background: string): string {
  const candidates = [
    mixHex(accent, "#ffffff", 0.35),
    mixHex(accent, "#ffffff", 0.65),
    "#ffffff",
  ];
  return candidates.find((candidate) => contrastRatio(candidate, background) >= 3) || "#ffffff";
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
