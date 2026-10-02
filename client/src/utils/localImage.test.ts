import { describe, expect, it } from "vitest";
import { toLocalImageApiSrc } from "./localImage";

describe("toLocalImageApiSrc", () => {
  it("maps absolute local paths to the on-demand route", () => {
    expect(toLocalImageApiSrc("/tmp/render.png")).toBe(
      "/api/local-images?path=%2Ftmp%2Frender.png",
    );
  });

  it("maps home-relative paths and file URLs", () => {
    expect(toLocalImageApiSrc("~/out.png")).toBe("/api/local-images?path=~%2Fout.png");
    expect(toLocalImageApiSrc("file:///tmp/a%20b.png")).toBe(
      "/api/local-images?path=%2Ftmp%2Fa%20b.png",
    );
  });

  it("percent-encodes query-special characters in the path", () => {
    const mapped = toLocalImageApiSrc("/tmp/out (1)&x=2.png");
    expect(mapped).toBeDefined();
    const url = new URL(mapped!, "http://localhost");
    expect(url.searchParams.get("path")).toBe("/tmp/out (1)&x=2.png");
  });

  it("leaves external, inline, app-served, and relative sources untouched", () => {
    expect(toLocalImageApiSrc("https://example.com/a.png")).toBeUndefined();
    expect(toLocalImageApiSrc("http://example.com/a.png")).toBeUndefined();
    expect(toLocalImageApiSrc("//cdn.example.com/a.png")).toBeUndefined();
    expect(toLocalImageApiSrc("data:image/png;base64,AAAA")).toBeUndefined();
    expect(toLocalImageApiSrc("blob:http://localhost/abc")).toBeUndefined();
    expect(toLocalImageApiSrc("/api/tool-result-images/abc/image.png")).toBeUndefined();
    expect(toLocalImageApiSrc("media/header.png")).toBeUndefined();
    expect(toLocalImageApiSrc("")).toBeUndefined();
    expect(toLocalImageApiSrc(undefined)).toBeUndefined();
  });

  it("rejects file URLs with a remote host", () => {
    expect(toLocalImageApiSrc("file://remotehost/tmp/a.png")).toBeUndefined();
  });
});
