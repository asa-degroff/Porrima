import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOM_THEME,
  getCustomThemeBackgroundError,
  getCustomThemeCssVariables,
  isCustomThemeBackgroundDark,
  normalizeHexColor,
} from "./custom-theme";

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
