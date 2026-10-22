/**
 * Regression test for the "No challenge in session" bug.
 *
 * Bug summary: with `NODE_ENV=production` and the documented local-only setup
 * (ORIGIN=http://localhost:<port>, RP_ID=localhost), the session cookie was
 * configured `secure: true`. The browser silently drops Secure cookies
 * received over plain HTTP, so the session was never persisted between
 * /api/auth/register/options and /api/auth/register/verify. The verify step
 * then 400'd with "No challenge in session".
 *
 * These tests pin the contract that:
 *   1. The session cookie config must be safe for the local-only path:
 *      no Secure attribute on cookies emitted for plain-HTTP requests.
 *   2. The cookie config keeps the other security attributes intact.
 *   3. End-to-end: hitting /api/auth/register/options over plain HTTP must
 *      return a Set-Cookie header so the browser has a session id to send
 *      back on the verify step.
 *   4. End-to-end, both directions: with `trust proxy` set the way production
 *      sets it, a request that arrives as HTTPS gets the Secure attribute and
 *      a plain-HTTP request does not. The config value is `secure: "auto"`, so
 *      the attribute is decided per request by express-session — which is a
 *      library behavior, and it used to be asserted only in prose. Prose is not
 *      a referee; the two directions are measured here.
 */

import express from "express";
import session from "express-session";
import type { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "http";

const originalNodeEnv = process.env.NODE_ENV;
const originalOrigin = process.env.ORIGIN;
const originalRpID = process.env.RP_ID;
const originalDataDir = process.env.PORRIMA_DATA_DIR;

function restoreEnv(
  name: "NODE_ENV" | "ORIGIN" | "RP_ID" | "PORRIMA_DATA_DIR",
  value: string | undefined
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("NODE_ENV", originalNodeEnv);
  restoreEnv("ORIGIN", originalOrigin);
  restoreEnv("RP_ID", originalRpID);
  restoreEnv("PORRIMA_DATA_DIR", originalDataDir);
  vi.resetModules();
});

describe("session cookie config", () => {
  it("does not require Secure for the documented local-only production path", async () => {
    // APP_DATA_DIR is captured at module-import time, so the data dir must
    // be set BEFORE the import below. We use a fresh tmp dir so this test
    // never touches the real ~/.porrima/auth/ on the host.
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-cookie-test-"));
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "http://localhost:3001";
    process.env.RP_ID = "localhost";
    process.env.PORRIMA_DATA_DIR = dataDir;

    const { getSessionCookieConfig } = await import("../services/session-cookie-config.js");

    const config = getSessionCookieConfig();
    // `false` was replaced by "auto" so the Cloudflare-fronted path can get a
    // Secure attribute without breaking this one. The failure mode is the same
    // in either direction: a Secure cookie on a plain-HTTP origin is dropped by
    // the browser, the session is never persisted, and /register/verify 400s
    // with "No challenge in session". What makes "auto" safe is that it resolves
    // to false when the request is not secure -- asserted end-to-end below, not
    // assumed here.
    expect(config.secure).toBe("auto");
  });

  it("keeps the other cookie attributes intact", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-cookie-test-"));
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "http://localhost:3001";
    process.env.RP_ID = "localhost";
    process.env.PORRIMA_DATA_DIR = dataDir;

    const { getSessionCookieConfig } = await import("../services/session-cookie-config.js");
    const config = getSessionCookieConfig();
    expect(config.httpOnly).toBe(true);
    expect(config.sameSite).toBe("lax");
    expect(config.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("register/options Set-Cookie behavior", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    // Fresh tmp data dir for every test, so we never touch the host's
    // real ~/.porrima/auth/ and tests are independent.
    const dataDir = mkdtempSync(join(tmpdir(), "porrima-cookie-test-"));
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "http://localhost:3001";
    process.env.RP_ID = "localhost";
    process.env.PORRIMA_DATA_DIR = dataDir;
    vi.resetModules();

    // Import the cookie config factory, the auth router, and the auth
    // storage helpers with the env vars set so the captured APP_DATA_DIR
    // points at our tmp dir.
    const { getSessionCookieConfig } = await import("../services/session-cookie-config.js");
    const { default: authRouter } = await import("../routes/auth.js");
    const { getOrCreateSetupToken } = await import("../services/auth-storage.js");

    // Force a setup token in this tmp data dir so the request passes
    // authorizeRegistration().
    const token = await getOrCreateSetupToken();
    if (!token) throw new Error("test setup: failed to create setup token");

    // Stash the token on a global so the `it` blocks can read it.
    (globalThis as Record<string, unknown>).__porrima_test_token = token;

    const app = express();
    // index.ts sets this in production, so the test app mirrors it: req.secure
    // is derived from X-Forwarded-Proto, which is what `secure: "auto"` keys on.
    app.set("trust proxy", 1);
    app.use(
      session({
        secret: "test-secret",
        resave: false,
        saveUninitialized: false,
        cookie: getSessionCookieConfig(),
      })
    );
    app.use("/api/auth", authRouter);

    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__porrima_test_token;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("emits a Set-Cookie header for a plain-HTTP request in production", async () => {
    const token = (globalThis as Record<string, unknown>).__porrima_test_token as string;

    const res = await fetch(`${baseUrl}/api/auth/register/options`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3001",
        "x-porrima-setup-token": token,
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    // The browser drops Secure cookies received over HTTP, which was the
    // root cause. Pin the absence of Secure here so this never regresses.
    expect(setCookie!.toLowerCase()).not.toMatch(/;\s*secure/);
    expect(setCookie!.toLowerCase()).toMatch(/httponly/);
    expect(setCookie!.toLowerCase()).toMatch(/samesite=lax/);
  });

  it("emits a Secure attribute for a request that arrives as HTTPS via X-Forwarded-Proto", async () => {
    // The Cloudflare-fronted path terminates TLS upstream and sets
    // X-Forwarded-Proto: https. With trust proxy: 1 (set in production by
    // index.ts, mirrored on this test app), req.secure is true at request time
    // and express-session's `secure: "auto"` resolves to true for this session.
    //
    // The Secure attribute used to be left unasserted here on the grounds that
    // it is "express built-in behavior". That is exactly the claim that needs a
    // measurement: the whole point of "auto" is that the attribute is decided at
    // request time, so a regression in trust proxy or in the cookie config would
    // be invisible without it.
    const token = (globalThis as Record<string, unknown>).__porrima_test_token as string;

    const res = await fetch(`${baseUrl}/api/auth/register/options`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Match the configured ORIGIN so validateWebAuthnEnv does not 400.
        origin: "http://localhost:3001",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "porrima.example.com",
        host: "127.0.0.1",
        "x-porrima-setup-token": token,
      },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    expect(setCookie!.toLowerCase()).toMatch(/;\s*secure/);
  });
});
