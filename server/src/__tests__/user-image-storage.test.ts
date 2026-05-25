import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../types.js";

const ONE_BY_ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

async function loadUserImageStorage(homeDir: string) {
  vi.resetModules();
  vi.doMock("os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("os")>();
    return {
      ...actual,
      homedir: () => homeDir,
    };
  });

  return import("../services/user-image-storage.js");
}

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("user image storage", () => {
  it("strips persisted attachment data and hydrates it from disk for model replay", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "porrima-user-image-storage-"));
    try {
      const storage = await loadUserImageStorage(homeDir);
      const record = await storage.saveUserImage("image-test", ONE_BY_ONE_PNG, "image/png", "pixel.png");
      const withData: ImageAttachment = {
        data: ONE_BY_ONE_PNG.toString("base64"),
        mimeType: record.mimeType,
        name: record.name,
        id: record.id,
        url: record.url,
        thumbUrl: record.thumbUrl,
      };

      const stripped = storage.stripImageAttachmentData(withData);
      expect(stripped).not.toHaveProperty("data");

      const hydrated = await storage.hydrateUserImageAttachment(stripped);
      expect(hydrated.data).toBe(withData.data);
      expect(hydrated.mimeType).toBe("image/png");
      expect(stripped.mimeType).toBe(withData.mimeType);
      expect(stripped.name).toBe(withData.name);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
