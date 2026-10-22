// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OklchColorPicker } from "./OklchColorPicker";

afterEach(() => {
  cleanup();
});

describe("OklchColorPicker", () => {
  it("commits a typed hex value on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OklchColorPicker label="Background" value="#1e1b4b" onChange={onChange} />);

    const field = screen.getByRole("textbox", { name: "Background hex value" });
    await user.clear(field);
    await user.type(field, "#2a1a3f{enter}");

    expect(onChange).toHaveBeenCalledWith("#2a1a3f");
    expect(field).toHaveValue("#2a1a3f");
  });

  it("commits a typed hex value on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OklchColorPicker label="Background" value="#1e1b4b" onChange={onChange} />);

    const field = screen.getByRole("textbox", { name: "Background hex value" });
    await user.clear(field);
    await user.type(field, "#2a1a3f");
    await user.tab();

    expect(onChange).toHaveBeenCalledWith("#2a1a3f");
  });

  it("restores the current value when the typed hex is invalid", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={onChange} />);

    const field = screen.getByRole("textbox", { name: "Accent hex value" });
    await user.clear(field);
    await user.type(field, "zzz");
    await user.tab();

    expect(onChange).not.toHaveBeenCalled();
    expect(field).toHaveValue("#fbbf24");
  });

  it("emits an in-gamut hex when a slider moves", () => {
    const onChange = vi.fn();
    render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={onChange} />);

    const hue = screen.getByRole("slider", { name: "Accent hue" });
    fireEvent.change(hue, { target: { value: "180" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const hex = onChange.mock.calls[0][0] as string;
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(hex).not.toBe("#fbbf24");
  });

  it("re-syncs the workspace when the parent changes the value", () => {
    const { rerender } = render(
      <OklchColorPicker label="Background" value="#1e1b4b" onChange={() => {}} />
    );
    rerender(<OklchColorPicker label="Background" value="#101525" onChange={() => {}} />);

    const hue = screen.getByRole("slider", { name: "Background hue" }) as HTMLInputElement;
    expect(Number(hue.value)).toBe(270); // #101525 is h = 269.998°
  });

  it("maps pointer positions on the plane to lightness and chroma", () => {
    const onChange = vi.fn();
    const originalRect = HTMLCanvasElement.prototype.getBoundingClientRect;
    HTMLCanvasElement.prototype.setPointerCapture = () => {};
    HTMLCanvasElement.prototype.getBoundingClientRect = function (this: HTMLCanvasElement) {
      return new DOMRect(0, 0, this.width, this.height);
    };
    try {
      render(<OklchColorPicker label="Accent" value="#ffffff" onChange={onChange} />);
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      // Plane center: L = 0.5, C = 0.5 * 0.35, hue unchanged. White's hue is
      // its ~1e-16 a/b residual (~89.9°), a low-chroma hue where the gamut
      // caps at C ≈ 0.102 for L = 0.5, so the 0.175 request clamps down.
      fireEvent.pointerDown(canvas, { clientX: canvas.width / 2, clientY: canvas.height / 2, pointerId: 1 });
      // Bottom-left corner: L = 0, C = 0.
      fireEvent.pointerDown(canvas, { clientX: 0, clientY: canvas.height, pointerId: 1 });
    } finally {
      HTMLCanvasElement.prototype.getBoundingClientRect = originalRect;
    }
    expect(onChange).toHaveBeenLastCalledWith("#000000");
    expect(onChange).toHaveBeenNthCalledWith(1, "#7a6000");
  });

  it("clamps the lightness range in dark mode", () => {
    render(<OklchColorPicker label="Background" value="#1e1b4b" onChange={() => {}} darkOnly />);

    const lightness = screen.getByRole("slider", { name: "Background lightness" }) as HTMLInputElement;
    expect(Number(lightness.max)).toBeGreaterThan(0.5);
    expect(Number(lightness.max)).toBeLessThan(0.65);
  });

  it("paints the header bar with the committed color", () => {
    render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={() => {}} />);

    expect(screen.getByTestId("swatch")).toHaveStyle({ background: "rgb(251, 191, 36)" });
  });

  it("flips the bar ink to whichever side of the swatch is legible", () => {
    const { rerender } = render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={() => {}} />);
    // A bright accent takes the dark ink (11.6:1 vs 1.7:1 for white).
    expect(screen.getByTestId("swatch")).toHaveStyle({ color: "rgb(5, 6, 10)" });

    rerender(<OklchColorPicker label="Accent" value="#1e1b4b" onChange={() => {}} />);
    // A dark swatch takes white (16:1 vs 1.2:1 for dark ink).
    expect(screen.getByTestId("swatch")).toHaveStyle({ color: "rgb(255, 255, 255)" });
  });

  it("keeps the bar on the committed color when a typed hex is rejected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={onChange} />);

    const field = screen.getByRole("textbox", { name: "Accent hex value" });
    await user.clear(field);
    await user.type(field, "#zz{enter}");

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("swatch")).toHaveStyle({ background: "rgb(251, 191, 36)" });
  });

  it("follows the swatch when a slider moves it", () => {
    const onChange = vi.fn();
    render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={onChange} />);

    fireEvent.change(screen.getByRole("slider", { name: "Accent hue" }), { target: { value: "180" } });

    const hex = onChange.mock.calls[0][0] as string;
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    expect(screen.getByTestId("swatch")).toHaveStyle({ background: `rgb(${r}, ${g}, ${b})` });
  });

  it("carries the pair contrast on the bar when a partner is given", () => {
    const { rerender } = render(
      <OklchColorPicker label="Accent" value="#fbbf24" onChange={() => {}} contrastAgainst="#1e1b4b" />
    );
    expect(screen.getByText("9.6:1")).toBeInTheDocument();

    rerender(
      <OklchColorPicker label="Accent" value="#fbbf24" onChange={() => {}} contrastAgainst="#ffffff" />
    );
    expect(screen.getByText("1.7:1")).toBeInTheDocument();
  });

  it("carries no contrast readout without a partner", () => {
    render(<OklchColorPicker label="Accent" value="#fbbf24" onChange={() => {}} />);

    expect(screen.queryByText(/^\d+(\.\d)?:1$/)).toBeNull();
  });
});
