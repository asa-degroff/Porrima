import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings, ThemePreset } from "../types.js";

async function loadChatStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  mkdirSync(join(homeDir, ".porrima"), { recursive: true });
  return import("../services/chat-storage.js");
}

function makePreset(overrides: Partial<ThemePreset> = {}): ThemePreset {
  return {
    id: "preset-1",
    name: "Night",
    background: "#101525",
    accent: "#ef6c3b",
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("normalizeThemePresetName", () => {
  it("trims, collapses whitespace, and caps length", async () => {
    const { normalizeThemePresetName } = await loadChatStorage(mkdtempSync(join(tmpdir(), "porrima-theme-")));
    expect(normalizeThemePresetName("  my   theme ")).toBe("my theme");
    expect(normalizeThemePresetName("a".repeat(40))).toBe("a".repeat(32));
    expect(normalizeThemePresetName("   ")).toBeNull();
    expect(normalizeThemePresetName(42)).toBeNull();
  });
});

describe("normalizeThemePresets", () => {
  async function fn() {
    const storage = await loadChatStorage(mkdtempSync(join(tmpdir(), "porrima-theme-")));
    return storage.normalizeThemePresets;
  }

  it("returns an empty list for non-array input", async () => {
    const normalize = await fn();
    expect(normalize(undefined)).toEqual([]);
    expect(normalize("nope")).toEqual([]);
  });

  it("normalizes hex colors and names on valid entries", async () => {
    const normalize = await fn();
    const result = normalize([makePreset({ name: "  Night  ", background: "#AB12CD" })]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Night");
    expect(result[0].background).toBe("#ab12cd");
  });

  it("drops entries with invalid hexes, light backgrounds, missing ids, or empty names", async () => {
    const normalize = await fn();
    const result = normalize([
      makePreset({ id: "bad-hex", background: "not-a-color" }),
      makePreset({ id: "light-bg", background: "#ffffff" }),
      makePreset({ id: "  " }),
      makePreset({ id: "empty-name", name: "   " }),
      makePreset(),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("preset-1");
  });

  it("dedupes case-insensitive names keeping the first entry", async () => {
    const normalize = await fn();
    const result = normalize([
      makePreset({ id: "first", name: "Night" }),
      makePreset({ id: "second", name: "night" }),
    ]);
    expect(result.map((preset) => preset.id)).toEqual(["first"]);
  });

  it("caps the list at 50 presets", async () => {
    const normalize = await fn();
    const many = Array.from({ length: 60 }, (_, index) =>
      makePreset({ id: `p-${index}`, name: `Theme ${index}`, accent: `#ef${(index % 256).toString(16).padStart(2, "0")}3b` }),
    );
    expect(normalize(many)).toHaveLength(50);
  });
});

describe("normalizeSettings theme preset fields", () => {
  async function fn() {
    const storage = await loadChatStorage(mkdtempSync(join(tmpdir(), "porrima-theme-")));
    return storage.normalizeSettings;
  }

  it("keeps the active preset id only when it references a surviving preset", async () => {
    const normalize = await fn();

    const withActive = normalize({
      themePresets: [makePreset({ id: "preset-1" })],
      activeThemePresetId: "preset-1",
    } as unknown as Settings);
    expect(withActive.activeThemePresetId).toBe("preset-1");
    expect(withActive.themePresets).toHaveLength(1);

    const stale = normalize({
      themePresets: [makePreset({ id: "preset-2" })],
      activeThemePresetId: "preset-1",
    } as unknown as Settings);
    expect(stale.activeThemePresetId).toBeUndefined();
  });

  it("omits empty themePresets and still validates the working customTheme", async () => {
    const normalize = await fn();

    const empty = normalize({ themePresets: [] } as unknown as Settings);
    expect(empty.themePresets).toBeUndefined();

    const badCustom = normalize({
      customTheme: { background: "#ffffff", accent: "#111111" },
    } as unknown as Settings);
    expect(badCustom.customTheme).toBeUndefined();
  });
});
