import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { rateLimit } from "../middleware/rate-limit.js";

function makeReq(ip: string): Request {
  return { ip, socket: { remoteAddress: ip } } as unknown as Request;
}

function makeRes() {
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    headers,
  };
  return res as unknown as Response & { statusCode: number; body: unknown; headers: Map<string, string> };
}

describe("rateLimit", () => {
  it("allows requests up to the limit and rejects the next one", () => {
    const limiter = rateLimit({ name: "test", windowMs: 60_000, max: 2 });
    const next = vi.fn() as unknown as NextFunction;

    const first = makeRes();
    limiter(makeReq("127.0.0.1"), first, next);
    expect(next).toHaveBeenCalledTimes(1);

    const second = makeRes();
    limiter(makeReq("127.0.0.1"), second, next);
    expect(next).toHaveBeenCalledTimes(2);

    const third = makeRes();
    limiter(makeReq("127.0.0.1"), third, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(third.statusCode).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
  });

  it("keeps separate buckets per client address", () => {
    const limiter = rateLimit({ name: "test-per-ip", windowMs: 60_000, max: 1 });
    const next = vi.fn() as unknown as NextFunction;

    limiter(makeReq("10.0.0.1"), makeRes(), next);
    limiter(makeReq("10.0.0.2"), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);

    const blocked = makeRes();
    limiter(makeReq("10.0.0.1"), blocked, next);
    expect(blocked.statusCode).toBe(429);
  });
});