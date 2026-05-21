import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Allow Bearer token auth for CLI/script access (development only)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const devToken = process.env.PORRIMA_DEV_TOKEN || process.env.QUJE_DEV_TOKEN;
    if (devToken && token === devToken) {
      return next();
    }
  }

  if (req.session?.authenticated) return next();
  res.status(401).json({ error: "Authentication required" });
}
