import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Route-layer referee for the traversal class.
 *
 * The unit guards in `utils/safe-path.ts` and the service-level asserts are
 * covered elsewhere; nothing there proves that a *route* actually applies them
 * before touching the filesystem. This file mounts the real compiled routers
 * (auth is `app.use("/api", requireAuth)` in `index.ts`, so routers mount bare)
 * against a scratch data dir, plants canaries outside each storage root, and
 * fires traversal payloads at the handlers.
 *
 * Payloads are percent-encoded (`%2e%2e%2f`), not raw `../`. A raw `../` in a
 * URL is normalized by fetch before the request is sent, so a probe written that
 * way passes without ever reaching a handler — the encoded form is what Express 5
 * decodes into a traversal segment inside a single route parameter.
 */

const PAYLOAD_SEGMENT = "%2e%2e%2fcanary";
let scratchHome = "";
let server: import("http").Server;
let base = "";

function writeCanary(...parts: string[]): string {
  const path = join(scratchHome, ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "DO NOT TOUCH");
  return path;
}

beforeAll(async () => {
  scratchHome = mkdtempSync(join(process.env.TMPDIR || "/tmp", "porrima-route-guards-"));
  process.env.PORRIMA_DATA_DIR = scratchHome;

  const roots = ["artifacts", "visuals", "tool-result-images", "user-images", "chats"];
  for (const root of roots) {
    mkdirSync(join(scratchHome, root), { recursive: true });
  }
  // Canaries: one sibling of each root and one escape two levels up.
  writeCanary("canary", "keep.txt");
  writeCanary("canary", "image.png");
  writeCanary("artifacts-canary", "keep.txt");

  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());

  const [{ default: artifacts }, { default: visuals }, { default: toolImages },
    { default: userImages }, { default: chats }, { default: settings }] = await Promise.all([
    import("../routes/artifacts.js"),
    import("../routes/visuals.js"),
    import("../routes/tool-result-images.js"),
    import("../routes/user-images.js"),
    import("../routes/chats.js"),
    import("../routes/settings.js"),
  ]);

  app.use("/api/artifacts", artifacts);
  app.use("/api/visuals", visuals);
  app.use("/api/tool-result-images", toolImages);
  app.use("/api/user-images", userImages);
  app.use("/api/chats", chats);
  app.use("/api/settings", settings);

  // Legit fixtures that must keep working.
  const artifactDir = join(scratchHome, "artifacts", "good");
  mkdirSync(join(artifactDir, "versions", "1"), { recursive: true });
  writeFileSync(join(artifactDir, "metadata.json"), JSON.stringify({ currentVersion: 1, versions: [1] }));
  writeFileSync(join(artifactDir, "versions", "1", "index.html"), "<html>ok</html>");
  writeFileSync(join(artifactDir, "versions", "1", "style.css"), "body{}");

  const visualDir = join(scratchHome, "visuals", "good");
  mkdirSync(join(visualDir, "versions", "1"), { recursive: true });
  writeFileSync(join(visualDir, "metadata.json"), JSON.stringify({ currentVersion: 1, versions: [1] }));
  writeFileSync(join(visualDir, "versions", "1", "index.html"), "<html>visual</html>");

  const toolImageDir = join(scratchHome, "tool-result-images", "good");
  mkdirSync(toolImageDir, { recursive: true });
  writeFileSync(join(toolImageDir, "image.png"), "png");

  const userImageDir = join(scratchHome, "user-images", "good");
  mkdirSync(userImageDir, { recursive: true });
  writeFileSync(join(userImageDir, "thumb.webp"), "webp");
  writeFileSync(join(userImageDir, "image.png"), "png");

  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  delete process.env.PORRIMA_DATA_DIR;
  if (scratchHome) rmSync(scratchHome, { recursive: true, force: true });
});

async function hit(path: string, init?: RequestInit) {
  const res = await fetch(base + path, { redirect: "manual", ...init });
  const body = await res.text();
  return { status: res.status, body, csp: res.headers.get("content-security-policy") };
}

describe("artifact and visual routes", () => {
  it("serves legitimate artifacts, with the sandbox CSP on HTML only", async () => {
    const latest = await hit("/api/artifacts/good");
    expect(latest.status).toBe(200);
    expect(latest.body).toBe("<html>ok</html>");
    expect(latest.csp).toContain("sandbox");

    const versioned = await hit("/api/artifacts/good/versions/1/index.html");
    expect(versioned.status).toBe(200);
    expect(versioned.csp).toContain("sandbox");

    const css = await hit("/api/artifacts/good/versions/1/style.css");
    expect(css.status).toBe(200);
    expect(css.csp).toBeNull();
  });

  it("rejects encoded traversal in a version subpath", async () => {
    const res = await hit(`/api/artifacts/good/versions/1/${PAYLOAD_SEGMENT}/keep.txt`);
    expect([400, 403, 404]).toContain(res.status);
    expect(existsSync(join(scratchHome, "canary", "keep.txt"))).toBe(true);
  });

  it("rejects encoded traversal in the artifact id", async () => {
    const latest = await hit(`/api/artifacts/${PAYLOAD_SEGMENT}`);
    expect([400, 403, 404]).toContain(latest.status);
    const versioned = await hit(`/api/artifacts/${PAYLOAD_SEGMENT}/versions/1/index.html`);
    expect([400, 403, 404]).toContain(versioned.status);
  });

  it("rejects a non-numeric or traversal version segment", async () => {
    const res = await hit("/api/artifacts/good/versions/%2e%2e/index.html");
    expect([400, 403, 404]).toContain(res.status);
  });

  it("rejects encoded traversal on the legacy subpath route", async () => {
    const res = await hit(`/api/artifacts/good/${PAYLOAD_SEGMENT}/keep.txt`);
    expect([400, 403, 404]).toContain(res.status);
  });

  it("rejects the sibling-directory escape that a startsWith(root) check would allow", async () => {
    // root/artifacts/good/../../artifacts-canary/keep.txt lands on a *sibling*
    // of the artifact root. It still shares the root's prefix, so a containment
    // check written as resolved.startsWith(root) would wave it through —
    // resolveWithin compares against `root + sep`.
    const res = await hit("/api/artifacts/good/%2e%2e%2f%2e%2e%2fartifacts-canary%2fkeep.txt");
    expect([400, 403, 404]).toContain(res.status);
    expect(existsSync(join(scratchHome, "artifacts-canary", "keep.txt"))).toBe(true);
  });

  it("rejects encoded traversal for visuals", async () => {
    const res = await hit(`/api/visuals/${PAYLOAD_SEGMENT}`);
    expect([400, 403, 404]).toContain(res.status);
    expect(existsSync(join(scratchHome, "artifacts-canary", "keep.txt"))).toBe(true);
  });

  it("still serves a legitimate visual", async () => {
    const res = await hit("/api/visuals/good");
    expect(res.status).toBe(200);
    expect(res.body).toBe("<html>visual</html>");
  });
});

describe("image routes", () => {
  it("rejects encoded traversal in a tool-result image id", async () => {
    const res = await hit(`/api/tool-result-images/${PAYLOAD_SEGMENT}/image.png`);
    expect([400, 403, 404]).toContain(res.status);
    expect(res.body).not.toContain("ESCAPED");
    expect(existsSync(join(scratchHome, "canary", "keep.txt"))).toBe(true);
  });

  it("rejects encoded traversal in a user image id, for thumb and full image", async () => {
    const thumb = await hit(`/api/user-images/${PAYLOAD_SEGMENT}/thumb`);
    expect([400, 403, 404]).toContain(thumb.status);
    const full = await hit(`/api/user-images/${PAYLOAD_SEGMENT}/image.png`);
    expect([400, 403, 404]).toContain(full.status);
    const remove = await fetch(`${base}/api/user-images/chat/${PAYLOAD_SEGMENT}/image/x`, { method: "DELETE" });
    expect([400, 403, 404]).toContain(remove.status);
  });

  it("still serves legitimate images", async () => {
    expect((await hit("/api/tool-result-images/good/image.png")).status).toBe(200);
    expect((await hit("/api/user-images/good/thumb")).status).toBe(200);
    expect((await hit("/api/user-images/good/image.png")).status).toBe(200);
  });
});

describe("chat routes", () => {
  it("refuses to delete a chat whose id is not a literal path segment", async () => {
    const res = await fetch(`${base}/api/chats/${PAYLOAD_SEGMENT}`, { method: "DELETE" });
    expect([400, 404]).toContain(res.status);
    // Cleanup derives filesystem paths from the id before the row is checked,
    // so the guard has to fire on the way in.
    expect(existsSync(join(scratchHome, "canary", "keep.txt"))).toBe(true);
    expect(existsSync(join(scratchHome, "artifacts-canary", "keep.txt"))).toBe(true);
  });

  it("refuses a client-supplied chat id that is not a literal path segment", async () => {
    const res = await hit("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "../../escape" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed client-supplied chat id", async () => {
    const res = await hit("/api/chats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "route-guard-test-chat" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("ssh connection routes", () => {
  const optionPayload = "-oProxyCommand=/bin/sh -c 'id > /tmp/porrima-route-pwned'";

  it("rejects option-shaped host and username values on create", async () => {
    const res = await hit("/api/settings/ssh-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "evil", host: optionPayload }),
    });
    expect(res.status).toBe(400);
    expect(res.body).toContain("invalid characters");
    expect(existsSync("/tmp/porrima-route-pwned")).toBe(false);
  });

  it("rejects an option-shaped or control-character identity file on create", async () => {
    for (const identityFile of [optionPayload, "/home/asa/.ssh/id_rsa\nProxyCommand evil", ""]) {
      const res = identityFile === ""
        ? await hit("/api/settings/ssh-connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "ok", host: "example.com", identityFile: "" }),
        })
        : await hit("/api/settings/ssh-connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "evil", host: "example.com", identityFile }),
        });
      expect(res.status, JSON.stringify(identityFile)).toBe(identityFile === "" ? 201 : 400);
    }
  });

  it("rejects an unsafe identity file on patch", async () => {
    const created = await hit("/api/settings/ssh-connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "legit", host: "example.com", identityFile: "/home/asa/.ssh/id_ed25519" }),
    });
    expect(created.status).toBe(201);
    const id = JSON.parse(created.body).id as string;

    const patched = await hit(`/api/settings/ssh-connections/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identityFile: optionPayload }),
    });
    expect(patched.status).toBe(400);

    const unchanged = await hit("/api/settings/ssh-connections");
    const stored = JSON.parse(unchanged.body).find((c: { id: string }) => c.id === id);
    expect(stored.identityFile).toBe("/home/asa/.ssh/id_ed25519");
  });
});
