import { Router, type Request, type Response } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  isSetupComplete,
  getOrCreateSetupToken,
  verifySetupToken,
  clearSetupToken,
  loadAuthStore,
  addCredential,
  getCredentialById,
  updateCredentialCounter,
} from "../services/auth-storage.js";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

const router = Router();

const rpName = "Porrima";
const setupTokenHeader = "x-porrima-setup-token";
type WebAuthnUserVerification = "preferred" | "required";

interface WebAuthnRequestContext {
  rpID: string;
  expectedOrigin: string;
  configured: boolean;
  userVerification: WebAuthnUserVerification;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLocalhost(hostname: string): boolean {
  return hostname === "localhost";
}

function validateWebAuthnEnv(requireConfigured: boolean): {
  origin?: string;
  rpID?: string;
  errors: string[];
} {
  const errors: string[] = [];
  const origin = (process.env.ORIGIN ?? "").trim();
  const rpID = (process.env.RP_ID ?? "").trim();
  const hasPartialConfig = Boolean(origin || rpID);

  if (requireConfigured) {
    if (!origin) errors.push("ORIGIN is required when NODE_ENV=production");
    if (!rpID) errors.push("RP_ID is required when NODE_ENV=production");
  } else if (hasPartialConfig) {
    if (!origin) errors.push("ORIGIN is required when RP_ID is configured");
    if (!rpID) errors.push("RP_ID is required when ORIGIN is configured");
  }

  let parsedOrigin: URL | null = null;
  if (origin) {
    try {
      parsedOrigin = new URL(origin);
      if (origin !== parsedOrigin.origin) {
        errors.push("ORIGIN must be an origin only, for example https://porrima.example.com");
      }
      const isAllowedLocalOrigin =
        parsedOrigin.protocol === "http:" && isLocalhost(parsedOrigin.hostname);
      if (isProduction() && parsedOrigin.protocol !== "https:" && !isAllowedLocalOrigin) {
        errors.push("ORIGIN must use https except for http://localhost local-only setup");
      }
    } catch {
      errors.push("ORIGIN must be a valid absolute origin");
    }
  }

  if (rpID) {
    if (rpID.includes("://") || rpID.includes("/") || rpID.includes(":")) {
      errors.push("RP_ID must be a hostname without protocol, port, or path");
    }
    if (parsedOrigin && rpID.toLowerCase() !== parsedOrigin.hostname.toLowerCase()) {
      errors.push("RP_ID must match the ORIGIN hostname");
    }
  }

  return {
    origin: origin || undefined,
    rpID: rpID || undefined,
    errors,
  };
}

export function assertProductionWebAuthnConfig(): void {
  if (!isProduction()) return;

  const { errors } = validateWebAuthnEnv(true);
  if (errors.length > 0) {
    throw new Error(`Invalid production WebAuthn configuration: ${errors.join("; ")}`);
  }
}

export function getWebAuthnUserVerification(): WebAuthnUserVerification {
  return isProduction() ? "required" : "preferred";
}

export function shouldRequireUserVerification(req: Request): boolean {
  const expected = req.session?.currentUserVerification ?? getWebAuthnUserVerification();
  return expected === "required";
}

function getRequestRpID(req: Request): string {
  // Use hostname from request (strips port) for local development without explicit env.
  const forwarded = getHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwarded ?? req.hostname;
  return host.split(":")[0];
}

function getRequestExpectedOrigin(req: Request): string {
  // The browser's Origin header reflects the actual page origin (e.g. localhost:5174),
  // not the proxied backend host (localhost:3001).
  const origin = getHeaderValue(req.headers.origin);
  if (origin) return origin;
  const proto = getHeaderValue(req.headers["x-forwarded-proto"]) || req.protocol;
  const host = getHeaderValue(req.headers["x-forwarded-host"]) || req.get("host");
  return `${proto}://${host}`;
}

export function getWebAuthnRequestContext(req: Request): WebAuthnRequestContext {
  const { origin, rpID, errors } = validateWebAuthnEnv(isProduction());
  if (errors.length > 0) {
    throw new Error(`Invalid WebAuthn configuration: ${errors.join("; ")}`);
  }

  const userVerification = getWebAuthnUserVerification();
  if (origin && rpID) {
    return {
      rpID,
      expectedOrigin: origin,
      configured: true,
      userVerification,
    };
  }

  return {
    rpID: getRequestRpID(req),
    expectedOrigin: getRequestExpectedOrigin(req),
    configured: false,
    userVerification,
  };
}

export function assertRegistrationOriginAllowed(
  req: Request,
  context: WebAuthnRequestContext
): void {
  const requestOrigin = getHeaderValue(req.headers.origin);
  if (context.configured && requestOrigin && requestOrigin !== context.expectedOrigin) {
    throw new Error(
      `Registration origin ${requestOrigin} does not match configured ORIGIN ${context.expectedOrigin}`
    );
  }
}

function getSetupToken(req: Request): string | undefined {
  const headerToken = req.get(setupTokenHeader);
  if (headerToken) return headerToken;
  const bodyToken = (req.body as { setupToken?: unknown } | undefined)?.setupToken;
  return typeof bodyToken === "string" ? bodyToken : undefined;
}

export async function authorizeRegistration(req: Request, setupComplete: boolean): Promise<boolean> {
  if (setupComplete) {
    return req.session?.authenticated === true;
  }

  return verifySetupToken(getSetupToken(req));
}

function sendRegistrationDenied(res: Response, setupComplete: boolean) {
  if (setupComplete) {
    res.status(403).json({ error: "Registration not allowed" });
  } else {
    res.status(403).json({ error: "Valid setup token required" });
  }
}

function sendWebAuthnConfigError(res: Response, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[auth] ${message}`);
  res.status(400).json({ error: message });
}

// GET /api/auth/status
router.get("/status", async (_req, res) => {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) {
    await getOrCreateSetupToken({ rotateExpired: false });
  } else {
    await clearSetupToken();
  }
  const authenticated = _req.session?.authenticated === true;
  res.json({ authenticated, setupComplete, setupTokenRequired: !setupComplete });
});

// POST /api/auth/register/options
router.post("/register/options", async (req, res) => {
  const setupComplete = await isSetupComplete();

  if (!(await authorizeRegistration(req, setupComplete))) {
    sendRegistrationDenied(res, setupComplete);
    return;
  }

  let context: WebAuthnRequestContext;
  try {
    context = getWebAuthnRequestContext(req);
    assertRegistrationOriginAllowed(req, context);
  } catch (err) {
    sendWebAuthnConfigError(res, err);
    return;
  }

  const store = await loadAuthStore();
  const excludeCredentials = store.credentials.map((c) => ({
    id: c.id,
    transports: c.transports as AuthenticatorTransportFuture[] | undefined,
  }));

  const options = await generateRegistrationOptions({
    rpName,
    rpID: context.rpID,
    userName: "owner",
    userDisplayName: "Owner",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: context.userVerification,
    },
  });

  req.session!.currentChallenge = options.challenge;
  req.session!.currentUserVerification = context.userVerification;
  res.json(options);
});

// POST /api/auth/register/verify
router.post("/register/verify", async (req, res) => {
  const setupComplete = await isSetupComplete();

  if (!(await authorizeRegistration(req, setupComplete))) {
    sendRegistrationDenied(res, setupComplete);
    return;
  }

  let context: WebAuthnRequestContext;
  try {
    context = getWebAuthnRequestContext(req);
    assertRegistrationOriginAllowed(req, context);
  } catch (err) {
    sendWebAuthnConfigError(res, err);
    return;
  }

  const expectedChallenge = req.session?.currentChallenge;
  if (!expectedChallenge) {
    res.status(400).json({ error: "No challenge in session" });
    return;
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpID,
      requireUserVerification: shouldRequireUserVerification(req),
    });

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "Verification failed" });
      return;
    }

    const { credential } = verification.registrationInfo;

    await addCredential("owner", {
      id: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      createdAt: new Date().toISOString(),
    });

    // Auto-login after registration
    req.session!.authenticated = true;
    delete req.session!.currentChallenge;
    delete req.session!.currentUserVerification;
    await clearSetupToken();

    res.json({ verified: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login/options
router.post("/login/options", async (req, res) => {
  const store = await loadAuthStore();
  const allowCredentials = store.credentials.map((c) => ({
    id: c.id,
    transports: c.transports as AuthenticatorTransportFuture[] | undefined,
  }));

  let context: WebAuthnRequestContext;
  try {
    context = getWebAuthnRequestContext(req);
  } catch (err) {
    sendWebAuthnConfigError(res, err);
    return;
  }

  const options = await generateAuthenticationOptions({
    rpID: context.rpID,
    allowCredentials,
    userVerification: context.userVerification,
  });

  req.session!.currentChallenge = options.challenge;
  req.session!.currentUserVerification = context.userVerification;
  res.json(options);
});

// POST /api/auth/login/verify
router.post("/login/verify", async (req, res) => {
  const expectedChallenge = req.session?.currentChallenge;
  if (!expectedChallenge) {
    res.status(400).json({ error: "No challenge in session" });
    return;
  }

  try {
    const { id } = req.body;
    const stored = await getCredentialById(id);
    if (!stored) {
      res.status(400).json({ error: "Credential not found" });
      return;
    }

    const context = getWebAuthnRequestContext(req);
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: context.expectedOrigin,
      expectedRPID: context.rpID,
      requireUserVerification: shouldRequireUserVerification(req),
      credential: {
        id: stored.id,
        publicKey: isoBase64URL.toBuffer(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports as AuthenticatorTransportFuture[] | undefined,
      },
    });

    if (!verification.verified) {
      res.status(400).json({ error: "Authentication failed" });
      return;
    }

    await updateCredentialCounter(
      stored.id,
      verification.authenticationInfo.newCounter
    );

    req.session!.authenticated = true;
    delete req.session!.currentChallenge;
    delete req.session!.currentUserVerification;

    res.json({ verified: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/logout
router.post("/logout", (req, res) => {
  req.session?.destroy(() => {
    res.json({ ok: true });
  });
});

export default router;
