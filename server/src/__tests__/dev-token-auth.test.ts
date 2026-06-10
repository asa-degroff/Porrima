import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoProductionDevTokenBypass, requireAuth } from "../middleware/auth.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalPorrimaDevToken = process.env.PORRIMA_DEV_TOKEN;

function makeRequest(authHeader?: string, authenticated = false): Request {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
    session: authenticated ? { authenticated: true } : {},
  } as unknown as Request;
}

function makeResponse(): Response & { statusCodeValue?: number; jsonValue?: unknown } {
  const res = {
    statusCodeValue: undefined as number | undefined,
    jsonValue: undefined as unknown,
    status(code: number) {
      this.statusCodeValue = code;
      return this;
    },
    json(value: unknown) {
      this.jsonValue = value;
      return this;
    },
  };
  return res as Response & { statusCodeValue?: number; jsonValue?: unknown };
}

function runRequireAuth(req: Request) {
  const res = makeResponse();
  const next = vi.fn() as NextFunction;
  requireAuth(req, res, next);
  return { res, next };
}

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalPorrimaDevToken === undefined) {
    delete process.env.PORRIMA_DEV_TOKEN;
  } else {
    process.env.PORRIMA_DEV_TOKEN = originalPorrimaDevToken;
  }
});

describe("development bearer token bypass", () => {
  it("allows matching bearer tokens outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.PORRIMA_DEV_TOKEN = "dev-secret";

    const { res, next } = runRequireAuth(makeRequest("Bearer dev-secret"));

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCodeValue).toBeUndefined();
  });

  it("rejects bearer tokens in production even when configured", () => {
    process.env.NODE_ENV = "production";
    process.env.PORRIMA_DEV_TOKEN = "dev-secret";

    const { res, next } = runRequireAuth(makeRequest("Bearer dev-secret"));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCodeValue).toBe(401);
    expect(res.jsonValue).toEqual({ error: "Authentication required" });
  });

  it("still allows authenticated sessions in production", () => {
    process.env.NODE_ENV = "production";

    const { res, next } = runRequireAuth(makeRequest(undefined, true));

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCodeValue).toBeUndefined();
  });

  it("fails startup config when a dev token is set in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PORRIMA_DEV_TOKEN = "dev-secret";

    expect(() => assertNoProductionDevTokenBypass()).toThrow(
      /PORRIMA_DEV_TOKEN cannot be set when NODE_ENV=production/
    );
  });

  it("allows dev token config outside production", () => {
    process.env.NODE_ENV = "test";
    process.env.PORRIMA_DEV_TOKEN = "dev-secret";

    expect(() => assertNoProductionDevTokenBypass()).not.toThrow();
  });
});
