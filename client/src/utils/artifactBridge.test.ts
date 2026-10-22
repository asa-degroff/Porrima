import { describe, expect, it } from "vitest";
import { injectArtifactBridge } from "./artifactBridge";

describe("artifact bridge injection", () => {
  it("installs the height and error channels before </head>", () => {
    const html = "<html><head><title>x</title></head><body><p>hi</p></body></html>";
    const out = injectArtifactBridge(html, "https://qu.je");

    expect(out).toContain('var PARENT_ORIGIN = "https://qu.je";');
    expect(out).toContain("artifact-height");
    expect(out).toContain("artifact-error");
    expect(out.indexOf("PARENT_ORIGIN")).toBeLessThan(out.indexOf("</head>"));
  });

  it("targets the app origin instead of the wildcard", () => {
    const out = injectArtifactBridge("<html><head></head><body></body></html>", "http://localhost:3001");
    expect(out).toContain("height: height }, PARENT_ORIGIN);");
    expect(out).not.toContain("}, '*');");
  });

  it("falls back to the wildcard only for an opaque parent origin", () => {
    const out = injectArtifactBridge("<html><body></body></html>", "null");
    expect(out).toContain('var PARENT_ORIGIN = "*";');
  });

  it("handles fragments without head or body tags", () => {
    const out = injectArtifactBridge("<div>hi</div>", "http://localhost:3001");
    expect(out.startsWith("<script>")).toBe(true);
    expect(out.endsWith("<div>hi</div>")).toBe(true);
  });
});