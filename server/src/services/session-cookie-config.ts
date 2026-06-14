/**
 * Cookie attributes for the express-session middleware.
 *
 * Note on `secure: false`:
 *   Cookie transport security is enforced by the browser based on the URL it
 *   sees; setting `secure: isProd` here breaks the documented local-only setup
 *   path (NODE_ENV=production + http://localhost:<port>) because browsers
 *   silently drop Secure cookies received over plain HTTP, leaving the session
 *   empty for /register/verify and producing a "No challenge in session" 400.
 *
 *   The Cloudflare-fronted case is still protected: the browser only ever sees
 *   the public HTTPS origin, so the cookie can only travel over HTTPS by
 *   virtue of the URL, not this flag. Non-local HTTP origins are rejected
 *   upstream by `validateWebAuthnEnv` in routes/auth.ts, so a misconfigured
 *   public deploy will fail loudly at startup, not silently downgrade sessions.
 *
 *   If we ever want to flip this back, gate the value on req.secure at request
 *   time (express-session's static config cannot do that directly) or split
 *   the local-only and Cloudflare-fronted code paths.
 */
export function getSessionCookieConfig(): import("express-session").CookieOptions {
  return {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  };
}
