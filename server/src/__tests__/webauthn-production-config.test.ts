import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRegistrationOriginAllowed,
  assertProductionWebAuthnConfig,
  getWebAuthnRequestContext,
  getWebAuthnUserVerification,
  shouldRequireUserVerification,
} from "../routes/auth.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalOrigin = process.env.ORIGIN;
const originalRpID = process.env.RP_ID;

function restoreEnv(name: "NODE_ENV" | "ORIGIN" | "RP_ID", value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function makeRequest(
  currentUserVerification?: "preferred" | "required",
  options: {
    origin?: string;
    forwardedHost?: string;
    forwardedProto?: string;
    hostname?: string;
    protocol?: string;
    host?: string;
  } = {}
): Request {
  const headers: Record<string, string> = {};
  if (options.origin) headers.origin = options.origin;
  if (options.forwardedHost) headers["x-forwarded-host"] = options.forwardedHost;
  if (options.forwardedProto) headers["x-forwarded-proto"] = options.forwardedProto;
  return {
    session: currentUserVerification ? { currentUserVerification } : {},
    headers,
    hostname: options.hostname ?? "localhost",
    protocol: options.protocol ?? "http",
    get(name: string) {
      return name.toLowerCase() === "host" ? options.host ?? "localhost:3001" : undefined;
    },
  } as unknown as Request;
}

afterEach(() => {
  restoreEnv("NODE_ENV", originalNodeEnv);
  restoreEnv("ORIGIN", originalOrigin);
  restoreEnv("RP_ID", originalRpID);
});

describe("production WebAuthn configuration", () => {
  it("does not require explicit RP config outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.ORIGIN;
    delete process.env.RP_ID;

    expect(() => assertProductionWebAuthnConfig()).not.toThrow();
    expect(getWebAuthnUserVerification()).toBe("preferred");
  });

  it("requires ORIGIN and RP_ID in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ORIGIN;
    delete process.env.RP_ID;

    expect(() => assertProductionWebAuthnConfig()).toThrow(
      /ORIGIN is required.*RP_ID is required/
    );
  });

  it("accepts exact HTTPS production origin and RP ID", () => {
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "https://porrima.example.com";
    process.env.RP_ID = "porrima.example.com";

    expect(() => assertProductionWebAuthnConfig()).not.toThrow();
    expect(getWebAuthnUserVerification()).toBe("required");
  });

  it("accepts explicit localhost production config for local-only setup", () => {
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "http://localhost:3001";
    process.env.RP_ID = "localhost";

    expect(() => assertProductionWebAuthnConfig()).not.toThrow();
  });

  it("rejects non-local HTTP production origins", () => {
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "http://porrima.example.com";
    process.env.RP_ID = "porrima.example.com";

    expect(() => assertProductionWebAuthnConfig()).toThrow(/ORIGIN must use https/);
  });

  it("rejects origin values with paths and mismatched RP IDs", () => {
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "https://porrima.example.com/app";
    process.env.RP_ID = "example.com";

    expect(() => assertProductionWebAuthnConfig()).toThrow(
      /ORIGIN must be an origin only.*RP_ID must match/
    );
  });

  it("uses session-persisted user verification for verification", () => {
    process.env.NODE_ENV = "production";
    expect(shouldRequireUserVerification(makeRequest("preferred"))).toBe(false);
    expect(shouldRequireUserVerification(makeRequest("required"))).toBe(true);
    expect(shouldRequireUserVerification(makeRequest())).toBe(true);
  });

  it("uses configured WebAuthn origin and RP ID instead of request headers", () => {
    process.env.NODE_ENV = "production";
    process.env.ORIGIN = "https://porrima.example.com";
    process.env.RP_ID = "porrima.example.com";

    const req = makeRequest(undefined, {
      origin: "https://evil.example.com",
      forwardedHost: "evil.example.com",
      hostname: "evil.example.com",
      protocol: "https",
      host: "evil.example.com",
    });
    const context = getWebAuthnRequestContext(req);

    expect(context).toMatchObject({
      configured: true,
      expectedOrigin: "https://porrima.example.com",
      rpID: "porrima.example.com",
      userVerification: "required",
    });
    expect(() => assertRegistrationOriginAllowed(req, context)).toThrow(
      /does not match configured ORIGIN/
    );
  });

  it("rejects partial configured WebAuthn env at request time", () => {
    process.env.NODE_ENV = "development";
    process.env.ORIGIN = "http://localhost:5173";
    delete process.env.RP_ID;

    expect(() => getWebAuthnRequestContext(makeRequest())).toThrow(
      /RP_ID is required when ORIGIN is configured/
    );
  });

  it("falls back to request WebAuthn context in development without env", () => {
    process.env.NODE_ENV = "development";
    delete process.env.ORIGIN;
    delete process.env.RP_ID;

    const context = getWebAuthnRequestContext(
      makeRequest(undefined, {
        origin: "http://localhost:5173",
        forwardedHost: "localhost:3001",
        hostname: "localhost",
        protocol: "http",
        host: "localhost:3001",
      })
    );

    expect(context).toMatchObject({
      configured: false,
      expectedOrigin: "http://localhost:5173",
      rpID: "localhost",
      userVerification: "preferred",
    });
  });
});
