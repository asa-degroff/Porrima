import { mkdtemp, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectLocalImageMimeType,
  expandLocalImagePath,
  isWithinAnyRoot,
  resolveLocalImageRequest,
} from "../services/local-image-serving.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("expandLocalImagePath", () => {
  it("accepts absolute paths", () => {
    expect(expandLocalImagePath("/tmp/render.png")).toBe("/tmp/render.png");
  });

  it("expands home-relative paths", () => {
    expect(expandLocalImagePath("~/render.png")).toBe(join(homedir(), "render.png"));
  });

  it("decodes file URLs with an empty or localhost host", () => {
    expect(expandLocalImagePath("file:///tmp/a%20b.png")).toBe("/tmp/a b.png");
    expect(expandLocalImagePath("file://localhost/tmp/a.png")).toBe("/tmp/a.png");
  });

  it("rejects remote file hosts, external URLs, relative paths, and empty input", () => {
    expect(expandLocalImagePath("file://remotehost/tmp/a.png")).toBeNull();
    expect(expandLocalImagePath("https://example.com/a.png")).toBeNull();
    expect(expandLocalImagePath("media/a.png")).toBeNull();
    expect(expandLocalImagePath("data:image/png;base64,AAAA")).toBeNull();
    expect(expandLocalImagePath("")).toBeNull();
    expect(expandLocalImagePath("  ")).toBeNull();
  });

  it("rejects null bytes", () => {
    expect(expandLocalImagePath("/tmp/a\0b.png")).toBeNull();
  });
});

describe("isWithinAnyRoot", () => {
  it("matches a root exactly and beneath it", () => {
    expect(isWithinAnyRoot("/tmp", ["/tmp"])).toBe(true);
    expect(isWithinAnyRoot("/tmp/a/b.png", ["/tmp"])).toBe(true);
  });

  it("does not match sibling prefixes", () => {
    expect(isWithinAnyRoot("/tmpfoo/a.png", ["/tmp"])).toBe(false);
    expect(isWithinAnyRoot("/etc/passwd", ["/tmp", "/home"])).toBe(false);
  });
});

describe("detectLocalImageMimeType", () => {
  it("recognizes PNG bytes", () => {
    expect(detectLocalImageMimeType(PNG_1X1)).toBe("image/png");
  });

  it("recognizes common image signatures", () => {
    expect(detectLocalImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectLocalImageMimeType(Buffer.from("GIF89a...."))).toBe("image/gif");
    expect(detectLocalImageMimeType(Buffer.from("RIFF____WEBP", "ascii"))).toBe("image/webp");
    expect(detectLocalImageMimeType(Buffer.from("____ftypavif", "ascii"))).toBe("image/avif");
    expect(detectLocalImageMimeType(Buffer.from([0xff, 0x0a]))).toBe("image/jxl");
  });

  it("rejects non-image content", () => {
    expect(detectLocalImageMimeType(Buffer.from("hello world"))).toBeNull();
    expect(detectLocalImageMimeType(Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBeNull();
  });
});

describe("resolveLocalImageRequest", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-image-serving-"));
    await writeFile(join(dir, "render.png"), PNG_1X1);
    // A file named like an image but with non-image bytes must not be served.
    await writeFile(join(dir, "secret.png"), "not actually an image");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves an image inside an allowed root", async () => {
    const result = await resolveLocalImageRequest(join(dir, "render.png"), [dir]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mimeType).toBe("image/png");
      expect(result.size).toBe(PNG_1X1.length);
    }
  });

  it("rejects a non-image file even when named .png", async () => {
    const result = await resolveLocalImageRequest(join(dir, "secret.png"), [dir]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(415);
  });

  it("rejects paths outside the allowed roots", async () => {
    const result = await resolveLocalImageRequest("/etc/hosts", [dir]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("rejects relative paths and missing files", async () => {
    const relative = await resolveLocalImageRequest("render.png", [dir]);
    expect(relative.ok).toBe(false);
    if (!relative.ok) expect(relative.status).toBe(400);

    const missing = await resolveLocalImageRequest(join(dir, "nope.png"), [dir]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);
  });
});
