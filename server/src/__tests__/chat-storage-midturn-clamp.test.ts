/**
 * Pins the mid-turn extraction timeout clamp boundaries in normalizeSettings.
 *
 * Why this exists: the cap is defined twice — server (extraction-settings.ts)
 * and client (SettingsModal.tsx). 5747028 raised the client cap 5→15 min
 * without touching the server (10 min), so the modal would have offered
 * 10-15 min picks that the server silently clamped. The server cap is the
 * authority: the modal must never offer more than it allows. These tests pin
 * the server side of that contract; the client constant stays a mirror.
 */
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import type { Settings } from "../types.js";
import {
  DEFAULT_MID_TURN_EXTRACTION_TIMEOUT_MS,
  MAX_MID_TURN_EXTRACTION_TIMEOUT_MS,
  MIN_MID_TURN_EXTRACTION_TIMEOUT_MS,
} from "../services/extraction-settings.js";

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

async function normalize(input: Partial<Settings>): Promise<Settings> {
  const storage = await loadChatStorage(mkdtempSync(join(tmpdir(), "porrima-midturn-")));
  return storage.normalizeSettings(input as Settings);
}

describe("normalizeSettings mid-turn extraction timeout clamp", () => {
  it("defaults when unset", async () => {
    const result = await normalize({});
    expect(result.midTurnExtractionTimeoutMs).toBe(DEFAULT_MID_TURN_EXTRACTION_TIMEOUT_MS);
  });

  it("accepts the full 15 min cap (client mirror must match)", async () => {
    const result = await normalize({ midTurnExtractionTimeoutMs: 900_000 });
    expect(result.midTurnExtractionTimeoutMs).toBe(900_000);
    expect(MAX_MID_TURN_EXTRACTION_TIMEOUT_MS).toBe(900_000);
  });

  it("clamps above the cap to exactly the cap", async () => {
    const result = await normalize({ midTurnExtractionTimeoutMs: 900_001 });
    expect(result.midTurnExtractionTimeoutMs).toBe(MAX_MID_TURN_EXTRACTION_TIMEOUT_MS);
  });

  it("clamps below the floor to exactly the floor", async () => {
    const result = await normalize({ midTurnExtractionTimeoutMs: 14_999 });
    expect(result.midTurnExtractionTimeoutMs).toBe(MIN_MID_TURN_EXTRACTION_TIMEOUT_MS);
  });
});
