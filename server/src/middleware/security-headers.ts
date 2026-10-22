import type { Request, Response, NextFunction } from "express";

/**
 * Baseline hardening for every response.
 *
 * Deliberately no `script-src`: the SPA is self-hosted, but a strict script CSP
 * needs a nonce/hash pass over index.html and the Vite output. The artifact and
 * visual routes replace this header with their sandbox policy.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  );
  next();
}