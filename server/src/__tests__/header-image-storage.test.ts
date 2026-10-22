import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "porrima-header-image-"));
  tempDirs.push(dir);
  return dir;
}

async function loadWithHome<T>(homeDir: string): Promise<T> {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return { ...actual, homedir: () => homeDir };
  });
  return (await import("../services/header-image-storage.js")) as unknown as T;
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("header image storage", () => {
  it("derives the served type from decoded bytes, not the declared MIME", async () => {
    const homeDir = makeTempDir();
    const storage = await loadWithHome<typeof import("../services/header-image-storage.js")>(homeDir);
    const png = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#336699" },
    })
      .png()
      .toBuffer();

    // Client lies about the type; the decoder decides it is a PNG.
    const info = await storage.saveHeaderImage(png, "image/svg+xml");
    expect(info.url).toContain("image.png");
    expect(info.mimeType).toBe("image/png");
  });

  it("rejects unprocessable bytes before replacing the stored image", async () => {
    const homeDir = makeTempDir();
    const storage = await loadWithHome<typeof import("../services/header-image-storage.js")>(homeDir);
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#112233" },
    })
      .png()
      .toBuffer();
    await storage.saveHeaderImage(png, "image/png");

    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    );
    await expect(storage.saveHeaderImage(svg, "image/png")).rejects.toThrow();

    // The previous valid image is still the one being served.
    const info = await storage.getHeaderImageInfo();
    expect(info.exists).toBe(true);
    expect(info.url).toContain("image.png");
  });
});