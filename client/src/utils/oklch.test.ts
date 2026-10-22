import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  hexToOklch,
  inSrgbGamut,
  lightnessForLuminance,
  maxChroma,
  mixHexOklab,
  neutralGrayLuminance,
  oklchToHex,
  relativeLuminanceHex,
} from "./oklch";

describe("oklch conversions", () => {
  it("maps white and black to the lightness extremes", () => {
    const white = hexToOklch("#ffffff");
    expect(white.l).toBeCloseTo(1, 5);
    expect(white.c).toBeLessThan(1e-4);
    const black = hexToOklch("#000000");
    expect(black.l).toBeCloseTo(0, 5);
    expect(black.c).toBeLessThan(1e-4);
  });

  it("round-trips 8-bit hex colors exactly", () => {
    for (const hex of ["#1e1b4b", "#fbbf24", "#ff0000", "#00ff00", "#0000ff", "#101525", "#778899", "#0a0a0a"]) {
      const { l, c, h } = hexToOklch(hex);
      expect(oklchToHex(l, c, h)).toBe(hex);
    }
  });

  it("places the pure primaries at the documented oklch coordinates", () => {
    // Anchors from Ottosson's paper (2021-01-25 matrix revision).
    const red = hexToOklch("#ff0000");
    expect(red.l).toBeCloseTo(0.628, 2);
    expect(red.c).toBeCloseTo(0.258, 2);
    expect(red.h).toBeCloseTo(29.2, 0);
    const blue = hexToOklch("#0000ff");
    expect(blue.l).toBeCloseTo(0.452, 2);
    expect(blue.c).toBeCloseTo(0.313, 2);
    expect(blue.h).toBeCloseTo(264.1, 0);
  });

  it("reaches the sRGB gamut boundary at the max chroma", () => {
    for (const [l, h] of [[0.5, 270], [0.7, 325], [0.3, 45]] as const) {
      const c = maxChroma(l, h);
      expect(inSrgbGamut(l, c, h)).toBe(true);
      expect(inSrgbGamut(l, c * 1.01, h)).toBe(false);
    }
  });

  it("collapses to near-zero chroma at the lightness extremes", () => {
    // The true boundary is exactly C = 0 at both poles; the small residuals
    // are rounding noise in the 10-digit matrix constants at the degenerate
    // point, not reachable chroma.
    expect(maxChroma(0, 150)).toBeLessThan(0.005);
    expect(maxChroma(1, 150)).toBeLessThan(0.005);
  });

  it("finds the outermost in-gamut point when the ray leaves and re-enters", () => {
    // Near the blue corner the sRGB gamut is not convex in OKLab: the (L, H)
    // ray leaves the gamut and re-enters at the pure blue corner. The max
    // chroma must be the corner (in gamut), not the first boundary.
    const corner = maxChroma(0.452, 264.1);
    expect(inSrgbGamut(0.452, corner, 264.1)).toBe(true);
    expect(corner).toBeGreaterThan(0.29);
    expect(inSrgbGamut(0.452, corner * 1.01, 264.1)).toBe(false);
  });

  it("lets green reach further chroma than magenta at the same lightness", () => {
    expect(maxChroma(0.8, 150)).toBeGreaterThan(maxChroma(0.8, 300));
  });

  it("clamps out-of-gamut chroma instead of producing an invalid hex", () => {
    const hex = oklchToHex(0.5, 0.6, 270);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    const resolved = hexToOklch(hex);
    expect(inSrgbGamut(resolved.l, resolved.c, resolved.h)).toBe(true);
  });

  it("finds the dark-background lightness boundary at the WCAG threshold", () => {
    const l = lightnessForLuminance(0.183);
    expect(l).toBeGreaterThan(0.5);
    expect(l).toBeLessThan(0.65);
    expect(neutralGrayLuminance(l)).toBeCloseTo(0.183, 3);
  });

  it("mixes in oklab space and stays inside the gamut", () => {
    const mixed = mixHexOklab("#fbbf24", "#ffffff", 0.65);
    expect(mixed).toMatch(/^#[0-9a-f]{6}$/);
    expect(mixed).not.toBe("#fbbf24");
    expect(mixed).not.toBe("#ffffff");
    const resolved = hexToOklch(mixed);
    expect(inSrgbGamut(resolved.l, resolved.c, resolved.h)).toBe(true);
  });

  it("measures relative luminance straight from hex", () => {
    expect(relativeLuminanceHex("#ffffff")).toBeCloseTo(1, 6);
    expect(relativeLuminanceHex("#000000")).toBeCloseTo(0, 6);
    expect(relativeLuminanceHex("#808080")).toBeCloseTo(0.216, 3);
    expect(relativeLuminanceHex("#abc")).toBeCloseTo(relativeLuminanceHex("#aabbcc") ?? 0, 6);
    expect(relativeLuminanceHex("nope")).toBeNull();
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 6);
    expect(contrastRatio(0.183, 1)).toBeCloseTo(4.506, 3);
    expect(contrastRatio(0.4, 0.4)).toBeCloseTo(1, 6);
  });

  it("throws on invalid hex input", () => {
    expect(() => hexToOklch("rgb(1, 2, 3)")).toThrow();
  });
});
