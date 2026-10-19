// OKLCH color-space utilities.
//
// OKLCH (OKLab in cylindrical form, Ottosson 2020; matrix revision
// 2021-01-25) gives perceptually even axes: equal steps in L track
// perceived lightness, and C runs to the edge of the representable gamut at
// each (L, H). sRGB is the app's destination format (hex storage, CSS), so
// every conversion is paired with a gamut test and a chroma clamp —
// out-of-gamut OKLCH values have no hex representation, so they are reduced
// along the same (L, H) ray until they fit.

export interface Oklch {
  /** Lightness, 0 (black) to 1 (white). */
  l: number;
  /** Chroma, 0 (neutral) to the gamut limit at the given lightness and hue. */
  c: number;
  /** Hue in degrees, 0 to 360. */
  h: number;
}

/** Upper search bound for the chroma bisection. Beyond the largest sRGB gamut
 *  chroma (~0.316), so always out of gamut at every (L, H). */
const CHROMA_SEARCH_MAX = 0.4;

/** Tolerance for gamut-boundary comparisons in the linear domain. */
const GAMUT_EPSILON = 1e-9;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** sRGB 0..1 channel to linear light. */
function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Linear light to sRGB 0..1 channel (unclamped). */
function linearToSrgb(channel: number): number {
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function hexToRgbUnit(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.trim().toLowerCase();
  const full = /^#([0-9a-f]{3})$/.test(raw)
    ? `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`
    : raw;
  if (!/^#[0-9a-f]{6}$/.test(full)) return null;
  return {
    r: Number.parseInt(full.slice(1, 3), 16) / 255,
    g: Number.parseInt(full.slice(3, 5), 16) / 255,
    b: Number.parseInt(full.slice(5, 7), 16) / 255,
  };
}

function rgbUnitToHex(r: number, g: number, b: number): string {
  const to8 = (channel: number) => Math.round(clampUnit(channel) * 255);
  return `#${[to8(r), to8(g), to8(b)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

interface Oklab {
  l: number;
  a: number;
  b: number;
}

/** OKLCH to OKLab (cylindrical to Cartesian in the a, b plane). */
export function oklchToOklab(l: number, c: number, h: number): Oklab {
  const radians = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(radians), b: c * Math.sin(radians) };
}

/** OKLab to OKLCH. The hue of a neutral color (c = 0) is 0. */
export function oklabToOklch(l: number, a: number, b: number): Oklch {
  return { l, c: Math.hypot(a, b), h: normalizeHue((Math.atan2(b, a) * 180) / Math.PI) };
}

/** sRGB 0..1 (gamma-encoded) to OKLab. */
export function rgbToOklab(r: number, g: number, b: number): Oklab {
  return linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
}

/** Linear sRGB (0..1; may exceed the range for out-of-gamut colors) to OKLab. */
function linearToOklab(r: number, g: number, b: number): Oklab {
  const lmsL = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const lmsM = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const lmsS = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l = Math.cbrt(lmsL);
  const m = Math.cbrt(lmsM);
  const s = Math.cbrt(lmsS);
  return {
    l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

/** OKLab to linear sRGB (unclamped — may fall outside the gamut). */
export function oklabToLinearSrgb(lab: Oklab): { r: number; g: number; b: number } {
  const lmsL = lab.l + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const lmsM = lab.l - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const lmsS = lab.l - 0.0894841775 * lab.a - 1.2914855480 * lab.b;
  const l = lmsL ** 3;
  const m = lmsM ** 3;
  const s = lmsS ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
}

/** OKLCH to linear sRGB (unclamped). */
export function oklchToLinearSrgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
  return oklabToLinearSrgb(oklchToOklab(l, c, h));
}

/** Linear sRGB to sRGB 0..1 (clamped). */
export function linearSrgbToUnit(linear: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  return {
    r: clampUnit(linearToSrgb(linear.r)),
    g: clampUnit(linearToSrgb(linear.g)),
    b: clampUnit(linearToSrgb(linear.b)),
  };
}

/** True when the OKLCH color falls inside the sRGB gamut (linear domain). */
export function inSrgbGamut(l: number, c: number, h: number): boolean {
  if (c <= 0) return true;
  const linear = oklchToLinearSrgb(l, c, h);
  return (
    linear.r >= -GAMUT_EPSILON && linear.r <= 1 + GAMUT_EPSILON &&
    linear.g >= -GAMUT_EPSILON && linear.g <= 1 + GAMUT_EPSILON &&
    linear.b >= -GAMUT_EPSILON && linear.b <= 1 + GAMUT_EPSILON
  );
}

/**
 * The largest chroma at or below `chroma` that stays in the sRGB gamut at the
 * given lightness and hue.
 *
 * The sRGB gamut is not convex in OKLab: near the blue corner a (L, H) ray
 * can leave the gamut and re-enter it, so the in-gamut test along the ray is
 * not monotonic. A plain bisection would stop at the first boundary. Instead
 * scan down from `chroma` for the last in-gamut point, then refine it by
 * bisection — always reducing chroma, the standard perceptual direction.
 */
export function clampChroma(l: number, h: number, chroma: number): number {
  const lightness = clampUnit(l);
  const c = Math.min(Math.max(0, chroma), CHROMA_SEARCH_MAX);
  if (inSrgbGamut(lightness, c, h)) return c;
  const step = 0.001;
  let found = 0;
  for (let cc = c - step; cc >= step; cc -= step) {
    if (inSrgbGamut(lightness, cc, h)) {
      found = cc;
      break;
    }
  }
  let lo = found;
  let hi = Math.min(found + step, c);
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(lightness, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * The largest chroma that stays in the sRGB gamut at the given lightness and
 * hue (the outermost in-gamut point along the (L, H) ray).
 */
export function maxChroma(l: number, h: number): number {
  return clampChroma(l, h, CHROMA_SEARCH_MAX);
}

/**
 * OKLCH to sRGB 0..1. Total: out-of-gamut chroma is reduced to the nearest
 * in-gamut point along the ray and channels are clamped, so the result is
 * always representable.
 */
export function oklchToSrgb(l: number, c: number, h: number): { r: number; g: number; b: number } {
  const lightness = clampUnit(l);
  const hue = normalizeHue(h);
  const chroma = clampChroma(lightness, hue, c);
  return linearSrgbToUnit(oklchToLinearSrgb(lightness, chroma, hue));
}

/** OKLCH to hex. Total — see {@link oklchToSrgb}. */
export function oklchToHex(l: number, c: number, h: number): string {
  const srgb = oklchToSrgb(l, c, h);
  return rgbUnitToHex(srgb.r, srgb.g, srgb.b);
}

/** Hex to OKLCH. Throws on invalid input. */
export function hexToOklch(hex: string): Oklch {
  const rgb = hexToRgbUnit(hex);
  if (!rgb) throw new Error(`Invalid hex color: ${hex}`);
  const lab = rgbToOklab(rgb.r, rgb.g, rgb.b);
  return oklabToOklch(lab.l, lab.a, lab.b);
}

/** WCAG relative luminance of sRGB 0..1 channels. */
export function relativeLuminanceRgb(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbToLinear(clampUnit(r)) +
    0.7152 * srgbToLinear(clampUnit(g)) +
    0.0722 * srgbToLinear(clampUnit(b))
  );
}

/** WCAG relative luminance of the neutral gray at the given lightness. */
export function neutralGrayLuminance(l: number): number {
  const srgb = oklchToSrgb(l, 0, 0);
  return relativeLuminanceRgb(srgb.r, srgb.g, srgb.b);
}

/** The lightness whose neutral gray lands on the given relative luminance. */
export function lightnessForLuminance(target: number): number {
  if (target <= 0) return 0;
  if (target >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (neutralGrayLuminance(mid) < target) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Mix two hex colors in OKLab space — the straight line between them in
 * perceptual space, so midpoints stay vivid instead of muddying toward gray
 * the way RGB channel averaging does. `secondWeight` is 0 for `first` and 1
 * for `second`. The result is gamut-clamped (see {@link oklchToHex}).
 */
export function mixHexOklab(firstHex: string, secondHex: string, secondWeight: number): string {
  const weight = Math.min(1, Math.max(0, secondWeight));
  const first = hexToOklch(firstHex);
  const second = hexToOklch(secondHex);
  const labA = oklchToOklab(first.l, first.c, first.h);
  const labB = oklchToOklab(second.l, second.c, second.h);
  const mixed = oklabToOklch(
    labA.l + (labB.l - labA.l) * weight,
    labA.a + (labB.a - labA.a) * weight,
    labA.b + (labB.b - labA.b) * weight,
  );
  return oklchToHex(mixed.l, mixed.c, mixed.h);
}
