// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RefObject } from "react";
import type { ImageAttachment } from "../types";
import type { BrowserViewerFrame } from "../hooks/useBrowserViewer";
import { GEOM_KEY } from "../hooks/useBrowserViewerGeometry";
import { BrowserViewer } from "./BrowserViewer";

function makeFrame(url: string, pageUrl = "https://example.com/page"): BrowserViewerFrame {
  const image: ImageAttachment = { url, mimeType: "image/png", name: "browser-screenshot" };
  return { image, pageUrl, pageTitle: "Example Page", at: Date.now() };
}

/**
 * Render the viewer inside a stubbed wrapper. jsdom has no layout engine,
 * so clientWidth/clientHeight are pinned to a 800x600 "desktop" wrapper —
 * the hook's defaults/clamps are exercised against known bounds.
 */
function renderViewer(
  frame: BrowserViewerFrame | null,
  opts: { active?: boolean; collapsed?: boolean; storedGeom?: string; consentPending?: boolean } = {},
) {
  if (opts.storedGeom !== undefined) {
    localStorage.setItem(GEOM_KEY, opts.storedGeom);
  }
  if (opts.collapsed) {
    localStorage.setItem("porrima-browser-viewer-collapsed", "true");
  }
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-render-wrapper", "true");
  Object.defineProperty(wrapper, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(wrapper, "clientHeight", { configurable: true, value: 600 });
  document.body.appendChild(wrapper);
  const wrapperRef: RefObject<HTMLDivElement | null> = { current: wrapper };
  const utils = render(
    <BrowserViewer
      frame={frame}
      active={opts.active ?? false}
      consentPending={opts.consentPending}
      wrapperRef={wrapperRef}
    />,
    { container: wrapper },
  );
  return { wrapper, wrapperRef, ...utils };
}

/** Default docked geometry at the stubbed 800x600 bounds. */
const DEFAULTS = { left: "566px", top: "16px", width: "210px" };

function cardStyle(wrapper: HTMLDivElement) {
  const card = wrapper.querySelector<HTMLElement>("[data-browser-viewer]");
  if (!card) throw new Error("viewer card not rendered");
  return card.style;
}

describe("BrowserViewer", () => {
  beforeEach(() => {
    localStorage.clear();
    // jsdom has no canvas for img decoding, but silence resource loading noise
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    // Custom render containers are not removed by cleanup() — detach them so
    // screen queries never cross test boundaries.
    document.body
      .querySelectorAll("[data-render-wrapper]")
      .forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it("renders the latest frame and page host when expanded", () => {
    renderViewer(makeFrame("/api/tool-result-images/a/image.png"));
    const enlarge = screen.getByRole("button", { name: /enlarge browser screenshot/i });
    const img = enlarge.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/api/tool-result-images/a/image.png");
    expect(screen.getByText("example.com")).toBeTruthy();
  });

  it("falls back to 'Browser' when the page URL has no hostname", () => {
    renderViewer(makeFrame("/api/tool-result-images/g/image.png", "about:blank"));
    expect(screen.getByText("Browser")).toBeTruthy();
  });

  it("opens the lightbox on frame click", async () => {
    const user = userEvent.setup();
    renderViewer(makeFrame("/api/tool-result-images/b/image.png"));
    await user.click(screen.getByRole("button", { name: /enlarge browser screenshot/i }));
    expect(screen.getByText("×")).toBeTruthy();
  });

  it("collapses to a chip, persists the preference, and re-expands", async () => {
    const user = userEvent.setup();
    renderViewer(makeFrame("/api/tool-result-images/c/image.png"));
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
    const { wrapperRef, rerender } = renderViewer(
      makeFrame("/api/tool-result-images/d/image.png"),
    );
    await user.click(screen.getByRole("button", { name: /minimize browser view/i }));

    // No unseen badge for the frame that was already viewed.
    const chip = screen.getByRole("button", { name: /open browser view/i });
    expect(chip.querySelector("span.animate-pulse")).toBeNull();

    rerender(
      <BrowserViewer
        frame={makeFrame("/api/tool-result-images/e/image.png")}
        active={false}
        wrapperRef={wrapperRef}
      />,
    );
    expect(chip.querySelector("span.animate-pulse")).not.toBeNull();
  });

  it("shows a pulse indicator while a browser tool is running", () => {
    renderViewer(makeFrame("/api/tool-result-images/f/image.png"), { active: true });
    const dot = screen.getByTitle("Agent is driving the browser");
    expect(dot.className).toContain("animate-pulse");
  });

  it("renders a connecting placeholder while a tool runs with no frame yet", () => {
    renderViewer(null, { active: true });
    expect(screen.getByText("Opening the browser…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enlarge browser screenshot/i })).toBeNull();
  });

  it("surfaces the remote-debugging consent hint when pending", () => {
    renderViewer(null, { active: true, consentPending: true });
    expect(screen.getByText(/allow remote debugging/i)).toBeTruthy();
  });

  it("docks the chip at the card's top-right corner", () => {
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/n/image.png"), {
      collapsed: true,
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    const style = cardStyle(wrapper);
    expect(style.left).toBe("320px"); // 100 + 260 - 40 (chip size)
    expect(style.top).toBe("200px");
  });

  it("restores the card at its original position when the chip expands", async () => {
    const user = userEvent.setup();
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/o/image.png"), {
      collapsed: true,
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    await user.click(screen.getByRole("button", { name: /open browser view/i }));
    const style = cardStyle(wrapper);
    expect(style.left).toBe("100px");
    expect(style.top).toBe("200px");
    expect(style.width).toBe("260px");
  });

  it("docks at the default position when no geometry is stored", () => {
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/h/image.png"));
    const style = cardStyle(wrapper);
    expect(style.left).toBe(DEFAULTS.left);
    expect(style.top).toBe(DEFAULTS.top);
    expect(style.width).toBe(DEFAULTS.width);
  });

  it("restores stored geometry and clamps it to the wrapper", () => {
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/i/image.png"), {
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    const style = cardStyle(wrapper);
    expect(style.left).toBe("100px");
    expect(style.top).toBe("200px");
    expect(style.width).toBe("260px");

    // Out-of-bounds stored geometry gets pulled back inside.
    const second = renderViewer(makeFrame("/api/tool-result-images/j/image.png"), {
      storedGeom: JSON.stringify({ x: -9999, y: 9999, w: 2000 }),
    });
    const clamped = cardStyle(second.wrapper);
    expect(clamped.left).toBe("8px");
    expect(clamped.width).toBe("520px");
  });

  it("resets to the default docked position", async () => {
    const user = userEvent.setup();
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/k/image.png"), {
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    await user.click(screen.getByRole("button", { name: /reset browser view/i }));
    const style = cardStyle(wrapper);
    expect(style.left).toBe(DEFAULTS.left);
    expect(style.top).toBe(DEFAULTS.top);
    expect(style.width).toBe(DEFAULTS.width);
    expect(JSON.parse(localStorage.getItem(GEOM_KEY)!)).toEqual({ x: 566, y: 16, w: 210 });
  });

  it("nudges with arrow keys and persists", async () => {
    const user = userEvent.setup();
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/l/image.png"));
    const frame = screen.getByRole("button", { name: /enlarge browser screenshot/i });
    frame.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(cardStyle(wrapper).left).toBe("582px");
    expect(JSON.parse(localStorage.getItem(GEOM_KEY)!)).toMatchObject({ x: 582, y: 16 });
  });

  it("resizes with + and - keys, clamped to the max width", async () => {
    const user = userEvent.setup();
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/m/image.png"));
    const frame = screen.getByRole("button", { name: /enlarge browser screenshot/i });
    frame.focus();
    await user.keyboard("+++++++++++++++++++++++++++++++++"); // 29 x +16px
    // 210 + 29*16 = 674 → clamped to the 520px max
    expect(cardStyle(wrapper).width).toBe("520px");
    await user.keyboard("-");
    expect(cardStyle(wrapper).width).toBe("504px");
  });

  // jsdom has no pointer capture, but the handlers live on the corner zones
  // themselves, so direct pointer events exercise the same wiring the field
  // exercises (pointerId 1 isolates the gesture; see CornerState).
  function dragCorner(corner: number, fromX: number, toX: number) {
    // Corner zones in DOM order: top-left, top-right, bottom-left, bottom-right.
    // isPrimary: jsdom defaults it to false, but a real gesture's first pointer
    // is primary — the component guards on that.
    const init = (clientX: number) => ({
      clientX,
      clientY: 300,
      pointerId: 1,
      isPrimary: true,
    });
    const cornerEl = screen.getAllByTitle("Drag to resize")[corner];
    fireEvent.pointerDown(cornerEl, init(fromX));
    fireEvent.pointerMove(cornerEl, init(toX));
    fireEvent.pointerUp(cornerEl, init(toX));
  }

  it("resizes from the right corners — the right edge follows the pointer", () => {
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/p/image.png"), {
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    dragCorner(3, 360, 390); // bottom-right corner, drag 30px right
    const style = cardStyle(wrapper);
    expect(style.left).toBe("100px"); // x pinned
    expect(style.width).toBe("290px");
    expect(JSON.parse(localStorage.getItem(GEOM_KEY)!)).toEqual({ x: 100, y: 200, w: 290 });
  });

  it("resizes from the left corners — the left edge follows, the right edge stays", () => {
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/q/image.png"), {
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    dragCorner(2, 100, 60); // bottom-left corner, drag 40px left
    const style = cardStyle(wrapper);
    expect(style.left).toBe("60px");
    expect(style.width).toBe("300px"); // right edge still 100 + 260 = 360
  });

  it("clamps a left-corner drag against the wrapper's left margin", () => {
    const { wrapper } = renderViewer(makeFrame("/api/tool-result-images/r/image.png"), {
      storedGeom: JSON.stringify({ x: 100, y: 200, w: 260 }),
    });
    dragCorner(2, 100, -100); // 200px past the left margin
    const style = cardStyle(wrapper);
    expect(style.left).toBe("8px"); // margin floor
    expect(style.width).toBe("460px"); // still below the 520px max
  });
});
