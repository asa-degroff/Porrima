import type { Request, Response, NextFunction } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  /** Namespace so two limiters don't share buckets. */
  name: string;
  windowMs: number;
  max: number;
}

/**
 * Small in-memory fixed-window limiter. Porrima is single-process with a
 * single user, so a process-local table is adequate; it exists to stop
 * unauthenticated loops (setup-token guessing, option generation) rather than
 * to provide distributed quotas.
 *
 * `trust proxy` is set in production, so `req.ip` is the client address behind
 * the Cloudflare tunnel.
 */
export function rateLimit({ name, windowMs, max }: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.max(windowMs, 60_000));
  // Never hold the process open for the sweeper.
  sweep.unref?.();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const address = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${name}:${address}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - bucket.count)));

    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: "Too many requests" });
      return;
    }
    next();
  };
}