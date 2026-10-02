import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../types.js";

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

afterEach(() => {
  vi.doUnmock("os");
  vi.resetModules();
});

describe("normalizeSettings retired keys", () => {
  it("strips Image Sandbox, corpus-era, and GPU-sharing keys", async () => {
    const { normalizeSettings } = await loadChatStorage(mkdtempSync(join(tmpdir(), "porrima-retired-")));
    const retired = {
      imageSandboxEnabled: true,
      imageBackend: "comfyui",
      comfyuiUrl: "http://localhost:8188",
      sdcppUrl: "http://localhost:7860",
      defaultVisionPreset: "describe",
      defaultVisionModelId: "qwen3-vl:4b",
      enrichmentBatchSize: 5,
      llamacppSharesGpu: true,
      useChatModelForVision: true,
    };

    const result = normalizeSettings({
      ...retired,
      defaultModelId: "test-model",
    } as unknown as Settings);

    const resultRecord = result as unknown as Record<string, unknown>;
    for (const key of Object.keys(retired)) {
      expect(resultRecord[key]).toBeUndefined();
    }
    // saveSettings persists JSON.stringify(merged) — undefined values are what
    // actually removes the keys from the stored settings row.
    const persisted = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    for (const key of Object.keys(retired)) {
      expect(persisted).not.toHaveProperty(key);
    }
    expect(result.defaultModelId).toBe("test-model");
  });

  it("leaves the surviving chat vision setting in place", async () => {
    const { normalizeSettings } = await loadChatStorage(mkdtempSync(join(tmpdir(), "porrima-retired-")));
    const result = normalizeSettings({ imageCapPreset: "maximum" } as unknown as Settings);
    expect(result.imageCapPreset).toBe("maximum");
  });
});
