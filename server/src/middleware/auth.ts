import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";

const DEV_TOKEN_ENV_NAMES = ["PORRIMA_DEV_TOKEN"] as const;

function configuredDevTokenEnvNames(): string[] {
  return DEV_TOKEN_ENV_NAMES.filter((name) => (process.env[name] ?? "").trim().length > 0);
}

function getConfiguredDevToken(): string | undefined {
  for (const name of DEV_TOKEN_ENV_NAMES) {
    const token = (process.env[name] ?? "").trim();
    if (token) return token;
  }
  return undefined;
}

function tokenMatches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

export function assertNoProductionDevTokenBypass(): void {
  if (process.env.NODE_ENV !== "production") return;

  const configured = configuredDevTokenEnvNames();
  if (configured.length === 0) return;

  throw new Error(
    `${configured.join(", ")} cannot be set when NODE_ENV=production; ` +
    "remove the development bearer token bypass before starting Porrima."
  );
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Allow Bearer token auth for CLI/script access (development only)
  const authHeader = req.headers.authorization;
  if (process.env.NODE_ENV !== "production" && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const devToken = getConfiguredDevToken();
    if (devToken && tokenMatches(token, devToken)) {
      return next();
    }
  }

  if (req.session?.authenticated) return next();
  res.status(401).json({ error: "Authentication required" });
}
