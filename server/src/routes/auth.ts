import { Router, type Request } from "express";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  isSetupComplete,
  loadAuthStore,
  addCredential,
  getCredentialById,
  updateCredentialCounter,
} from "../services/auth-storage.js";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

const router = Router();

const rpName = "qu.je";
const rpID = process.env.RP_ID || "localhost";

function getExpectedOrigin(req: Request): string {
  if (process.env.ORIGIN) return process.env.ORIGIN;
  // The browser's Origin header reflects the actual page origin (e.g. localhost:5174),
  // not the proxied backend host (localhost:3001).
  if (req.headers.origin) return req.headers.origin;
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

// GET /api/auth/status
router.get("/status", async (_req, res) => {
  const setupComplete = await isSetupComplete();
  const authenticated = _req.session?.authenticated === true;
  res.json({ authenticated, setupComplete });
});

// POST /api/auth/register/options
router.post("/register/options", async (req, res) => {
  const setupComplete = await isSetupComplete();

  // If credentials already exist and session is not authenticated, deny
  if (setupComplete && !req.session?.authenticated) {
    res.status(403).json({ error: "Registration not allowed" });
    return;
  }

  const store = await loadAuthStore();
  const excludeCredentials = store.credentials.map((c) => ({
    id: c.id,
    transports: c.transports as AuthenticatorTransportFuture[] | undefined,
  }));

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

  if (setupComplete && !req.session?.authenticated) {
    res.status(403).json({ error: "Registration not allowed" });
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
