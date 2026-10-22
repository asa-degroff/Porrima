import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_THEME,
  getCustomThemeAccentContrast,
  getCustomThemeBackgroundError,
  getCustomThemeContrast,
  getCustomThemeCssVariables,
  getRelativeLuminance,
  isCustomThemeBackgroundDark,
  normalizeHexColor,
  normalizeThemePresetName,
  saveThemePreset,
  saveThemePresetAsNew,
} from "./custom-theme";
import type { ThemePreset } from "../types";

describe("custom theme colors", () => {
  it("normalizes short and mixed-case hex colors", () => {
    expect(normalizeHexColor("#AbC")).toBe("#aabbcc");
    expect(normalizeHexColor(" #12Ef90 ")).toBe("#12ef90");
    expect(normalizeHexColor("rgb(1, 2, 3)")).toBeNull();
  });

  it("only accepts backgrounds dark enough for the dark UI", () => {
    expect(isCustomThemeBackgroundDark(DEFAULT_CUSTOM_THEME.background)).toBe(true);
    expect(getCustomThemeBackgroundError("#ffffff")).toContain("darker background");
    expect(getCustomThemeBackgroundError("#101525")).toBeNull();
  });

  it("derives gradient and token variables from the selected colors", () => {
    const variables = getCustomThemeCssVariables({ background: "#101525", accent: "#ef6c3b" });

    expect(variables["--custom-theme-background"]).toBe("#101525");
    expect(variables["--custom-theme-accent-rgb"]).toBe("239, 108, 59");
    expect(variables["--custom-theme-gradient-edge"]).not.toBe("#101525");
    expect(variables["--custom-theme-gradient-near-center"]).not.toBe(variables["--custom-theme-gradient-edge"]);
  });
});

describe("theme presets", () => {
  const base: ThemePreset = { id: "preset-1", name: "Night", background: "#101525", accent: "#ef6c3b" };

  it("normalizes preset names the same way the server does", () => {
    expect(normalizeThemePresetName("  my   theme ")).toBe("my theme");
    expect(normalizeThemePresetName("a".repeat(40))).toBe("a".repeat(32));
    expect(normalizeThemePresetName("   ")).toBeNull();
    expect(normalizeThemePresetName(42)).toBeNull();
  });

  const dawn = { background: "#1a1025", accent: "#8bd450" };

  it("creates a new preset when no preset is bound", () => {
    const result = saveThemePreset([base], undefined, "Dawn", dawn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presets).toHaveLength(2);
    expect(result.id).not.toBe(base.id);
    expect(result.presets[1]).toEqual({ id: result.id, name: "Dawn", ...dawn });
  });

  it("renames the bound preset in place when the name changes and colors do not", () => {
    const result = saveThemePreset([base], base.id, "  Nightfall  ", base);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe(base.id);
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0].name).toBe("Nightfall");
    expect(result.presets[0].background).toBe(base.background);
    expect(result.presets[0].accent).toBe(base.accent);
  });

  it("recolors the bound preset in place when the name is unchanged", () => {
    const result = saveThemePreset([base], base.id, "night", dawn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBe(base.id);
    expect(result.presets[0]).toEqual({ id: base.id, name: "night", ...dawn });
  });

  it("rejects a bound rename that collides with another preset's name", () => {
    const sibling: ThemePreset = { id: "preset-2", name: "Dawn", background: "#201015", accent: "#ff9d6b" };
    const result = saveThemePreset([base, sibling], base.id, "dawn", base);

    expect(result.ok).toBe(false);
  });

  it("rejects an unbound save that collides with any existing name", () => {
    const result = saveThemePreset([base], undefined, "NIGHT", dawn);

    expect(result.ok).toBe(false);
  });

  it("treats a stale binding as a new creation", () => {
    const result = saveThemePreset([base], "gone", "Dawn", dawn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).not.toBe(base.id);
    expect(result.presets).toHaveLength(2);
  });

  it("does not mutate the input list", () => {
    const input: ThemePreset[] = [base];
    const result = saveThemePreset(input, undefined, "Dawn", dawn);

    expect(input).toHaveLength(1);
    expect(input[0].name).toBe("Night");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.presets).not.toBe(input);
  });

  it("rejects empty names without writing", () => {
    const result = saveThemePreset([], undefined, "   ", dawn);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("name");
  });

  it("always creates a new preset, suffixing colliding names", () => {
    const result = saveThemePresetAsNew([base], "Night", dawn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).not.toBe(base.id);
    expect(result.presets).toHaveLength(2);
    expect(result.presets[0]).toEqual(base);
    expect(result.presets[1]).toEqual({ id: result.id, name: "Night (2)", ...dawn });
  });

  it("keeps incrementing the suffix until the name is unique", () => {
    const dup: ThemePreset = { id: "preset-2", name: "Night (2)", background: "#101525", accent: "#ef6c3b" };
    const result = saveThemePresetAsNew([base, dup], "night", dawn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presets[2].name).toBe("night (3)");
  });

  it("uses free names as-is and caps suffixed names to the length limit", () => {
    const fresh = saveThemePresetAsNew([base], "Dawn Chorus", dawn);

    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.presets[1].name).toBe("Dawn Chorus");

    const taken = "a".repeat(32);
    const existing: ThemePreset = { id: "preset-9", name: taken, ...dawn };
    const capped = saveThemePresetAsNew([existing], taken, dawn);

    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.presets[1].name.length).toBeLessThanOrEqual(32);
    expect(capped.presets[1].name.endsWith(" (2)")).toBe(true);
  });

  it("rejects empty names without writing", () => {
    const result = saveThemePresetAsNew([base], "   ", dawn);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("name");
  });

  it("measures contrast with the shared oklch luminance math", () => {
    expect(getRelativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    // The gate limit is where white text hits 4.5:1 — the reason the gate is 0.183.
    expect(getCustomThemeContrast("#ffffff", "#1e1b4b")).toBeGreaterThan(4.5);
    expect(getCustomThemeContrast("#808080", "#808080")).toBeCloseTo(1, 6);
    // An unparseable hex falls back to the default background, as before.
    expect(getRelativeLuminance("nope")).toBeCloseTo(getRelativeLuminance(DEFAULT_CUSTOM_THEME.background), 6);
  });

  it("reports an accent/background pair that clears both bars", () => {
    const pair = getCustomThemeAccentContrast(DEFAULT_CUSTOM_THEME.background, DEFAULT_CUSTOM_THEME.accent);

    expect(pair.accentRatio).toBeGreaterThan(9);
    expect(pair.textRatio).toBeGreaterThan(9);
    expect(pair.note).toBeNull();
  });

  it("flags an accent too close to the background to read as UI", () => {
    // Nearly-black accent on a dark background: borders and icons vanish, but
    // the derived text color is rescued by whitening and stays legible.
    const pair = getCustomThemeAccentContrast("#1e1b4b", "#111827");

    expect(pair.accentRatio).toBeLessThan(3);
    expect(pair.textRatio).toBeGreaterThanOrEqual(4.5);
    expect(pair.note).toContain("borders");
    expect(pair.note).not.toContain("body-size");
  });

  it("flags a pair whose accent stands out but whose text does not", () => {
    // A bright-but-low-chroma accent on a background sitting at the top of the
    // admissible range: the picked color clears 3:1, and even the whitened text
    // color only reaches 3.5:1 — a WCAG AA miss no current guard catches.
    const pair = getCustomThemeAccentContrast("#008474", "#94dfd0");

    expect(pair.accentRatio).toBeGreaterThanOrEqual(3);
    expect(pair.textRatio).toBeLessThan(4.5);
    expect(pair.note).toContain("body-size");
    expect(pair.note).not.toContain("borders");
  });

  it("reports both shortfalls when a pair fails both bars", () => {
    const pair = getCustomThemeAccentContrast("#1e1b4b", "#1f2937");

    expect(pair.accentRatio).toBeLessThan(3);
    expect(pair.textRatio).toBeLessThan(4.5);
    expect(pair.note).toContain("borders");
    expect(pair.note).toContain("body-size");
  });
});
