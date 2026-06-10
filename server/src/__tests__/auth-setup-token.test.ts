import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";

async function loadAuthStorage(dataDir: string) {
  vi.resetModules();
  process.env.PORRIMA_DATA_DIR = dataDir;
  return import("../services/auth-storage.js");
}

function makeRequest(setupToken?: string, authenticated = false): Request {
  const sessionData: Record<string, unknown> = {};
  if (authenticated) {
    sessionData.authenticated = true;
  }
  return {
    session: sessionData,
    get(name: string) {
      return name.toLowerCase() === "x-porrima-setup-token" ? setupToken : undefined;
    },
    body: {},
  } as unknown as Request;
}

afterEach(() => {
  delete process.env.PORRIMA_DATA_DIR;
  vi.resetModules();
});

describe("first-run setup token", () => {
  it("creates a stable 0600 token and verifies it by exact value", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      const tokenPath = storage.getSetupTokenFilePath();

      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(await storage.getOrCreateSetupToken()).toBe(token);
      expect((statSync(tokenPath).mode & 0o777)).toBe(0o600);
      expect(await storage.verifySetupToken(token)).toBe(true);
      expect(await storage.verifySetupToken(` ${token}\n`)).toBe(true);
      expect(await storage.verifySetupToken(`${token}x`)).toBe(false);
      expect(await storage.verifySetupToken("")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("denies first-run registration authorization without the setup token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-route-"));
    try {
      await loadAuthStorage(dataDir);
      const { authorizeRegistration } = await import("../routes/auth.js");

      expect(await authorizeRegistration(makeRequest(), false)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("accepts first-run registration authorization with the setup token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-route-"));
    const storage = await loadAuthStorage(dataDir);
    const token = await storage.getOrCreateSetupToken();
    try {
      const { authorizeRegistration } = await import("../routes/auth.js");
      const req = makeRequest(token);

      expect(await authorizeRegistration(req, false)).toBe(true);
      expect(req.session.registrationSetupAuthorized).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("uses authenticated sessions only after setup is complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-route-"));
    try {
      await loadAuthStorage(dataDir);
      const { authorizeRegistration } = await import("../routes/auth.js");

      expect(await authorizeRegistration(makeRequest(undefined, false), true)).toBe(false);
      expect(await authorizeRegistration(makeRequest(undefined, true), true)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
