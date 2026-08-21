import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_THEME,
  getCustomThemeBackgroundError,
  getCustomThemeCssVariables,
  isCustomThemeBackgroundDark,
  normalizeHexColor,
  normalizeThemePresetName,
  saveThemePreset,
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
});
