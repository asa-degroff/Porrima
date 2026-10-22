// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThemePicker } from "./ThemePicker";

afterEach(() => {
  cleanup();
});

function renderCustom(background: string, accent: string) {
  return render(
    <ThemePicker
      theme="custom"
      customTheme={{ background, accent }}
      onThemeChange={vi.fn()}
      onCustomThemeChange={vi.fn()}
    />
  );
}

describe("ThemePicker contrast readout", () => {
  it("stays quiet when the pair clears both bars", () => {
    renderCustom("#1e1b4b", "#fbbf24");

    expect(screen.queryByRole("status")).toBeNull();
    // Both controls carry the same measurement, since it belongs to the pair.
    expect(screen.getAllByText("9.6:1")).toHaveLength(2);
  });

  it("warns when the accent is too close to the background to read as UI", () => {
    renderCustom("#1e1b4b", "#111827");

    expect(screen.getByRole("status")).toHaveTextContent("borders, rails and icons");
  });

  it("warns when the picked accent stands out but the derived text does not", () => {
    renderCustom("#008474", "#94dfd0");

    expect(screen.getByRole("status")).toHaveTextContent("body-size type");
  });

  it("measures nothing while the background itself is inadmissible", () => {
    // A background that fails the dark gate never reaches the screen — every
    // CSS variable falls back to the default theme — so the pair has no
    // rendered meaning to report.
    renderCustom("#f8fafc", "#e2e8f0");

    expect(screen.getByRole("alert")).toHaveTextContent("darker background");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/^\d+(\.\d)?:1$/)).toBeNull();
  });
});
