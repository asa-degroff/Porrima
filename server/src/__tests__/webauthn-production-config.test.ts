import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProductionWebAuthnConfig,
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

function makeRequest(currentUserVerification?: "preferred" | "required"): Request {
  return {
    session: currentUserVerification ? { currentUserVerification } : {},
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
});
