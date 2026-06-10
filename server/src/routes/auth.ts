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

function getRpID(req: Request): string {
  if (process.env.RP_ID) return process.env.RP_ID;
  // Use hostname from request (strips port) — works for both localhost and production domains
  const forwarded = req.headers["x-forwarded-host"];
  const host = (typeof forwarded === "string" ? forwarded : req.hostname);
  return host.split(":")[0];
}

function getExpectedOrigin(req: Request): string {
  if (process.env.ORIGIN) return process.env.ORIGIN;
  // The browser's Origin header reflects the actual page origin (e.g. localhost:5174),
  // not the proxied backend host (localhost:3001).
  if (req.headers.origin) return req.headers.origin;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
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

  if (req.session?.registrationSetupAuthorized === true) {
    return true;
  }

  const authorized = await verifySetupToken(getSetupToken(req));
  if (authorized) {
    req.session!.registrationSetupAuthorized = true;
  }
  return authorized;
}

function sendRegistrationDenied(res: Response, setupComplete: boolean) {
  if (setupComplete) {
    res.status(403).json({ error: "Registration not allowed" });
  } else {
    res.status(403).json({ error: "Valid setup token required" });
  }
}

// GET /api/auth/status
router.get("/status", async (_req, res) => {
  const setupComplete = await isSetupComplete();
  if (!setupComplete) {
    await getOrCreateSetupToken();
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

  const store = await loadAuthStore();
  const excludeCredentials = store.credentials.map((c) => ({
    id: c.id,
    transports: c.transports as AuthenticatorTransportFuture[] | undefined,
  }));

  const rpID = getRpID(req);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: "owner",
    userDisplayName: "Owner",
    excludeCredentials,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  req.session!.currentChallenge = options.challenge;
  res.json(options);
});

// POST /api/auth/register/verify
router.post("/register/verify", async (req, res) => {
  const setupComplete = await isSetupComplete();

  if (!(await authorizeRegistration(req, setupComplete))) {
    sendRegistrationDenied(res, setupComplete);
    return;
  }

  const expectedChallenge = req.session?.currentChallenge;
  if (!expectedChallenge) {
    res.status(400).json({ error: "No challenge in session" });
    return;
  }

  try {
    const rpID = getRpID(req);
    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: rpID,
      requireUserVerification: false,
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
    delete req.session!.registrationSetupAuthorized;
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

  const rpID = getRpID(req);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials,
    userVerification: "preferred",
  });

  req.session!.currentChallenge = options.challenge;
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

    const rpID = getRpID(req);
    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: getExpectedOrigin(req),
      expectedRPID: rpID,
      requireUserVerification: false,
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
