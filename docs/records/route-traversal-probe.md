# Route Traversal Probe — Route-Layer Referee

Run date: 2026-10-22. Results record for the route-layer guards added in `cd7f403d`
and the follow-up validation in `utils/ssh-target.ts`. The permanent harness is
`server/src/__tests__/route-traversal-guards.test.ts`; the secret-merge half lives in
`server/src/__tests__/settings-secret-merge.test.ts`.

## Why a route-layer harness was needed

The unit guards had tests (`path-traversal-guards.test.ts` covers `utils/safe-path.ts`
and service-level asserts), but no test exercised an Express handler. Two things could
only be measured at the route layer:

1. Whether a route actually applies the guard before touching the filesystem. The bug
   class is "a request-derived value becomes a filesystem key", and the bug lives in the
   wiring between a route and a storage service, not in either one alone.
2. How Express 5 decodes route params. `..%2F..` in a URL arrives at a handler as
   `../..`. A guard written against the un-decoded string would appear correct and be
   ineffective.

## Harness

`server/src/__tests__/route-traversal-guards.test.ts` mounts the real compiled routers —
`artifacts`, `visuals`, `tool-result-images`, `user-images`, `chats`, `settings` — in a
scratch Express app. Auth is not part of the routers (`index.ts` applies
`app.use("/api", requireAuth)`), so the routers mount bare. `PORRIMA_DATA_DIR` is set to
a temp directory **before** the router imports, because `APP_DATA_DIR` is captured at
module-import time. Legitimate fixtures are seeded under each root, and canaries are
planted outside them: one in a directory no route should ever reach, one readable image
inside an escape target, and one in a *sibling* of the artifacts root.

17 tests, all passing.

## Results (guarded code)

| Probe | Route | Result |
| --- | --- | --- |
| `%2e%2e%2fcanary` in a version subpath | `GET /api/artifacts/:id/versions/:version/*` | rejected; canary intact |
| `%2e%2e%2fcanary` as the artifact id | `GET /api/artifacts/:id` and `…/versions/1/index.html` | rejected |
| `..` as a version segment | `GET /api/artifacts/:id/versions/:version/index.html` | rejected |
| `%2e%2e%2fcanary` on the legacy subpath route | `GET /api/artifacts/:id/*` | rejected |
| `good/../../artifacts-canary/keep.txt` (encoded) | `GET /api/artifacts/:id/*` | rejected; **sibling canary intact** |
| `%2e%2e%2fcanary` as the visual id | `GET /api/visuals/:id` | rejected |
| `%2e%2e%2fcanary` as a tool-result image id | `GET /api/tool-result-images/:id/image.png` | rejected; escape-target image not served |
| `%2e%2e%2fcanary` as a user image id | thumb, full image, and delete | rejected |
| `%2e%2e%2fcanary` as a chat id | `DELETE /api/chats/:id` | rejected; canary directories intact |
| `{"id": "../../escape"}` | `POST /api/chats` | 400 |
| `-oProxyCommand=…` as `host` | `POST /api/settings/ssh-connections` | 400 |
| `-oProxyCommand=…` and a newline-bearing value as `identityFile` | `POST` and `PATCH /api/settings/ssh-connections` | 400; stored value unchanged |
| legitimate artifacts, visuals, images, chats, ssh connections | various | 200/201 |

CSP behavior confirmed alongside the guards: artifact and visual HTML carries
`Content-Security-Policy: sandbox …`, a CSS subresource of the same artifact does not.

## Witnesses

Each set of tests was run against deliberately neutered code, so the harness is known to
catch the failure it claims to catch.

**Witness 1 — containment reverted to `startsWith(root)`.** `resolveWithin` was replaced
with `resolve(base, ...segments)` + `target.startsWith(base)`, and `isSafePathSegment`
was reduced to a type check. 5 of 17 tests failed:

- the sibling-directory probe returned **200 and served the sibling file** — the exact
  shape that a `startsWith(root)` check waves through, and the reason `resolveWithin`
  compares against `root + sep`;
- tool-result and user-image traversal were no longer rejected (500 instead of 400);
- `DELETE /api/chats/../../canary` **actually deleted the canary directory**, and the
  test caught it by finding the canary gone;
- `POST /api/chats` accepted `../../escape` as a chat id and created it (201).

**Witness 2 — `preserveStoredSecrets` reduced to a pass-through.** 1 of 5 secret tests
failed: `PUT { deepseekApiKey: null }` wiped the stored key. That localized which
payload the route-level guard is load-bearing for. `saveSettings` independently refuses
to overwrite a non-empty stored string with `""`, so the empty-string case is protected
at the storage layer; `null` is the codebase-wide "clear this field" signal, and it is
the case only the route-level guard intercepts for these five fields.

**Witness 3 — `isValidSshIdentityFile` reduced to `return true`.** Both identityFile tests
failed: the option-shaped value was accepted on create (201) and on patch (200), and the
stored value was overwritten.

**Witness 4 — `secure: "auto"` reverted to `secure: false`.** 2 tests failed in
`session-cookie-config.test.ts`: the config assertion, and the end-to-end assertion that
a request arriving with `X-Forwarded-Proto: https` gets a `Secure` attribute. The
`Set-Cookie` header was emitted without it.

## The settings secret contract

Two protections are stacked, and they cover different payloads:

- `saveSettings` merges against the stored row and refuses to clobber a non-empty stored
  string with `""`.
- `preserveStoredSecrets` in `routes/settings.ts` additionally drops `""`, `undefined`,
  **and `null`** for `braveApiKey`, `exaApiKey`, `tavilyApiKey`, `deepseekApiKey`, and
  `strataApiKey`.

`GET /api/settings` replaces each with `""` (an empty value, not a placeholder string)
and lists the configured field names in `configuredSecrets`, so a client can echo its own
GET body straight back to PUT. `SettingsModal` renders its "Configured — paste a new key
to replace" hint as an input `placeholder`, never as a `value`, so no placeholder text
can be submitted. Confirmed end to end: no response body contains a stored key.

Consequence worth knowing: because `null` — the codebase's explicit-clear signal — is
swallowed for these five fields, **there is no HTTP path that removes a stored provider
key today**. Clearing one means editing `~/.porrima/settings.json`. If a clear path is
wanted, the change is to stop dropping `null` in `preserveStoredSecrets`; the storage
layer already honors it. `settings-secret-merge.test.ts` pins the current behavior,
including the storage-layer convention, so an accidental change is loud.

## Session cookie Secure attribute

`getSessionCookieConfig()` returns `secure: "auto"`, which express-session resolves per
request from connection security (and, with `trust proxy` set in production, from
`X-Forwarded-Proto`). The existing test file asserted the old static `false`, so the
suite was red from the commit that made the change; the assertion now pins `"auto"`, the
test app sets `trust proxy` the way `index.ts` does, and both directions are measured
end-to-end against a real `express-session` mount: plain HTTP → no `Secure` attribute,
proxied HTTPS → `Secure` present.

Known caveat, recorded here because it is invisible until it bites: once a session cookie
is emitted with `Secure`, express-session will not re-send it over plain HTTP for that
session. Exposing the *same hostname* over both HTTP and HTTPS reintroduces the original
"No challenge in session" failure. The supported shapes (public HTTPS origin, direct
`http://localhost`) do not collide.

## Reproducing

```
cd server
npx vitest run src/__tests__/route-traversal-guards.test.ts
npx vitest run src/__tests__/settings-secret-merge.test.ts
npx vitest run src/__tests__/session-cookie-config.test.ts
```

Full suite as of this run: 135 files, 1254 passed, 1 todo. `npx tsc --noEmit` clean on
server and client.

## Still open after this pass

- `renderServiceExecStart` leaves `binaryPath` and `extraArgs` unquoted. The first token
  must pass an `access()` check and llama.cpp has no argument that executes a command, so
  the blast radius is argument injection into a binary the authenticated user already
  selects. Left as a recorded trust decision rather than fixed.
- `POST /api/settings/llama-binaries` still executes any file named `llama-server` under a
  caller-named directory. The CSRF door is closed (POST + JSON only); the primitive
  remains by design so a user can point the scan at their own build directory.
