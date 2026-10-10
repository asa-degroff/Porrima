// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImageAttachment } from "../types";
import type { BrowserViewerFrame } from "../hooks/useBrowserViewer";
import { BrowserViewer } from "./BrowserViewer";

function makeFrame(url: string, pageUrl = "https://example.com/page"): BrowserViewerFrame {
  const image: ImageAttachment = { url, mimeType: "image/png", name: "browser-screenshot" };
  return { image, pageUrl, pageTitle: "Example Page", at: Date.now() };
}

describe("BrowserViewer", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom has no canvas for img decoding, but silence resource loading noise
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the latest frame and page host when expanded", () => {
    render(<BrowserViewer frame={makeFrame("/api/tool-result-images/a/image.png")} active={false} />);
    const enlarge = screen.getByRole("button", { name: /enlarge browser screenshot/i });
    const img = enlarge.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/tool-result-images/a/image.png");
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("falls back to 'Browser' when the page URL has no hostname", () => {
    render(<BrowserViewer frame={makeFrame("/api/tool-result-images/g/image.png", "about:blank")} active={false} />);
    expect(screen.getByText("Browser")).toBeTruthy();
  });

  it("opens the lightbox on frame click", async () => {
    const user = userEvent.setup();
    render(<BrowserViewer frame={makeFrame("/api/tool-result-images/b/image.png")} active={false} />);
    await user.click(screen.getByRole("button", { name: /enlarge browser screenshot/i }));
    expect(screen.getByText("×")).toBeTruthy();
  });

  it("collapses to a chip, persists the preference, and re-expands", async () => {
    const user = userEvent.setup();
    render(<BrowserViewer frame={makeFrame("/api/tool-result-images/c/image.png")} active={false} />);
    await user.click(screen.getByRole("button", { name: /minimize browser view/i }));

    expect(screen.getByRole("button", { name: /open browser view/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enlarge browser screenshot/i })).toBeNull();
    expect(localStorage.getItem("porrima-browser-viewer-collapsed")).toBe("true");

    await user.click(screen.getByRole("button", { name: /open browser view/i }));
    expect(screen.getByRole("button", { name: /enlarge browser screenshot/i })).toBeTruthy();
    expect(localStorage.getItem("porrima-browser-viewer-collapsed")).toBe("false");
  });

  it("badges the collapsed chip when a newer frame lands", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <BrowserViewer frame={makeFrame("/api/tool-result-images/d/image.png")} active={false} />,
    );
    await user.click(screen.getByRole("button", { name: /minimize browser view/i }));

    // No unseen badge for the frame that was already viewed.
    const chip = screen.getByRole("button", { name: /open browser view/i });
    expect(chip.querySelector("span.animate-pulse")).toBeNull();

    rerender(<BrowserViewer frame={makeFrame("/api/tool-result-images/e/image.png")} active={false} />);
    expect(chip.querySelector("span.animate-pulse")).not.toBeNull();
  });

  it("shows a pulse indicator while a browser tool is running", () => {
    render(<BrowserViewer frame={makeFrame("/api/tool-result-images/f/image.png")} active />);
    const dot = screen.getByTitle("Agent is driving the browser");
    expect(dot.className).toContain("animate-pulse");
  });
});
