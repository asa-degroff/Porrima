/**
 * Cookie attributes for the express-session middleware.
 *
 * `secure: "auto"` is decided per request by express-session: it resolves to the
 * security of the connection, which under `trust proxy` (set in production) means
 * the value of `X-Forwarded-Proto`. That is what makes both supported deployments
 * work at once — the Cloudflare-fronted origin gets a Secure cookie, and the
 * documented local-only setup (NODE_ENV=production + http://localhost:<port>)
 * still receives one it can actually send back.
 *
 * The history: this value was `isProd`, which broke the local-only path silently.
 * Browsers drop Secure cookies received over plain HTTP, so the session was never
 * persisted and /register/verify 400'd with "No challenge in session". Both
 * directions are now asserted end-to-end in `session-cookie-config.test.ts`
 * (plain HTTP gets no Secure attribute, a proxied-HTTPS request does), because
 * "auto" moves the decision to request time and a regression in `trust proxy`
 * would otherwise be invisible in the suite.
 *
 * One caveat to know before exposing the same hostname over both HTTP and HTTPS:
 * once a session cookie is emitted with Secure, it is never sent back over plain
 * HTTP for that session, and the local-only failure mode returns. Non-local HTTP
 * origins are rejected upstream by `validateWebAuthnEnv` in routes/auth.ts, so a
 * misconfigured public deploy fails loudly at startup rather than silently
 * downgrading sessions.
 */
export function getSessionCookieConfig(): import("express-session").CookieOptions {
  return {
    httpOnly: true,
    // "auto" follows the connection security the app detects: proxied HTTPS
    // gets the Secure attribute, while the documented http://localhost setup
    // still receives a cookie. Production sets `trust proxy`, so the
    // Cloudflare-forwarded scheme is what gets evaluated.
    secure: "auto",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
}
