import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readSetupTokenState(tokenPath: string): any {
  return JSON.parse(readFileSync(tokenPath, "utf-8"));
}

afterEach(() => {
  delete process.env.PORRIMA_DATA_DIR;
  vi.resetModules();
});

describe("first-run setup token", () => {
  it("creates a 0600 hash-only token state and verifies the raw token", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      const tokenPath = storage.getSetupTokenFilePath();

      if (!token) throw new Error("expected a fresh setup token");
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(await storage.getOrCreateSetupToken()).toBeNull();
      expect((statSync(tokenPath).mode & 0o777)).toBe(0o600);
      const fileContents = readFileSync(tokenPath, "utf-8");
      expect(fileContents).not.toContain(token);
      const state = JSON.parse(fileContents);
      expect(state.tokenSha256).toBe(sha256(token));
      expect(state.failedAttempts).toBe(0);
      expect(state.maxFailedAttempts).toBe(storage.SETUP_TOKEN_MAX_FAILED_ATTEMPTS);
      expect(await storage.verifySetupToken(token)).toBe(true);
      expect(await storage.verifySetupToken(` ${token}\n`)).toBe(true);
      expect(await storage.verifySetupToken(`${token}x`)).toBe(false);
      expect(await storage.verifySetupToken("")).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("locks the setup token after the failed-attempt limit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      const tokenPath = storage.getSetupTokenFilePath();
      if (!token) throw new Error("expected a fresh setup token");

      for (let i = 0; i < storage.SETUP_TOKEN_MAX_FAILED_ATTEMPTS; i += 1) {
        expect(await storage.verifySetupToken(`wrong-${i}`)).toBe(false);
      }

      const state = readSetupTokenState(tokenPath);
      expect(state.failedAttempts).toBe(storage.SETUP_TOKEN_MAX_FAILED_ATTEMPTS);
      expect(state.lockedAt).toEqual(expect.any(String));
      expect(await storage.verifySetupToken(token)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects expired setup tokens until a fresh setup run rotates them", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      const tokenPath = storage.getSetupTokenFilePath();
      if (!token) throw new Error("expected a fresh setup token");

      const state = readSetupTokenState(tokenPath);
      state.expiresAt = new Date(Date.now() - 1_000).toISOString();
      writeFileSync(tokenPath, `${JSON.stringify(state, null, 2)}\n`);

      expect(await storage.verifySetupToken(token)).toBe(false);
      expect(await storage.getOrCreateSetupToken({ rotateExpired: false })).toBeNull();

      const rotated = await storage.getOrCreateSetupToken();
      expect(rotated).toEqual(expect.any(String));
      expect(rotated).not.toBe(token);
      expect(await storage.verifySetupToken(rotated)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers from a setup-token lock after the cooldown", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      const tokenPath = storage.getSetupTokenFilePath();
      if (!token) throw new Error("expected a fresh setup token");

      for (let i = 0; i < storage.SETUP_TOKEN_MAX_FAILED_ATTEMPTS; i += 1) {
        expect(await storage.verifySetupToken(`wrong-${i}`)).toBe(false);
      }
      expect(await storage.verifySetupToken(token)).toBe(false);

      // Simulate the cooldown elapsing instead of waiting 15 minutes.
      const state = readSetupTokenState(tokenPath);
      state.lockedAt = new Date(Date.now() - storage.SETUP_TOKEN_LOCK_MS - 1_000).toISOString();
      writeFileSync(tokenPath, `${JSON.stringify(state, null, 2)}\n`);

      expect(await storage.verifySetupToken(token)).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("binds a consumed token to one session and re-arms it on restart", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      if (!token) throw new Error("expected a fresh setup token");

      expect(await storage.verifySetupToken(token, "session-a")).toBe(true);
      // A different client holding the leaked token is rejected.
      expect(await storage.verifySetupToken(token, "session-b")).toBe(false);
      // The legitimate session can retry a failed WebAuthn ceremony, even
      // without re-entering the token.
      expect(await storage.verifySetupToken(token, "session-a")).toBe(true);
      expect(await storage.verifySetupToken(undefined, "session-a")).toBe(true);
      expect(await storage.verifySetupToken(undefined, "session-b")).toBe(false);

      // A restart loses the in-memory session store, so the token is re-armed.
      await storage.releaseConsumedSetupToken();
      expect(await storage.verifySetupToken(token, "session-b")).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects and clears setup tokens once setup is complete", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-auth-token-"));
    try {
      const storage = await loadAuthStorage(dataDir);
      const token = await storage.getOrCreateSetupToken();
      const tokenPath = storage.getSetupTokenFilePath();
      if (!token) throw new Error("expected a fresh setup token");

      await storage.addCredential("owner", {
        id: "credential-id",
        publicKey: "public-key",
        counter: 0,
        createdAt: new Date().toISOString(),
      });

      expect(await storage.verifySetupToken(token)).toBe(false);
      expect(existsSync(tokenPath)).toBe(false);
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
      if (!token) throw new Error("expected a fresh setup token");
      const { authorizeRegistration } = await import("../routes/auth.js");
      const req = makeRequest(token);

      expect(await authorizeRegistration(req, false)).toBe(true);
      expect(await authorizeRegistration(makeRequest(undefined), false)).toBe(false);
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
