// Regression test for the attach consent window: a Chrome endpoint that
// accepts the TCP connection but never completes the WebSocket handshake —
// the shape of Chrome's per-connection "allow remote debugging" prompt — must
// fail within the consent window and fall back to a private browser.
//
// Before the fix, puppeteer.connect() waited forever: its `timeout` option is
// not applied to the WS handshake in puppeteer-core 25.x, so an unanswered
// consent prompt wedged the attach (and the whole agent turn) indefinitely.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeBrowserSession, getBrowserSession } from "./browser-session.js";

const CHAT_ID = "browser-consent-test";

describe("browser session: consent handshake timeout", () => {
  let server: Server;
  let userDataDir: string;
  // Track accepted sockets so teardown cannot be wedged by a lingering
  // connection. (net.Server has no closeAllConnections — that is an
  // http.Server method; the accepted-socket set is the type-correct form.)
  const sockets = new Set<Socket>();
  const originalUserDataDirEnv = process.env.PORRIMA_BROWSER_USER_DATA_DIR;
  const originalConsentEnv = process.env.PORRIMA_BROWSER_CONSENT_TIMEOUT_MS;
  const originalAttachEnv = process.env.PORRIMA_BROWSER_ATTACH;

  beforeAll(async () => {
    // Accept connections but never answer the upgrade request: the browser
    // side of a pending consent dialog.
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    userDataDir = mkdtempSync(join(tmpdir(), "porrima-consent-"));
    writeFileSync(join(userDataDir, "DevToolsActivePort"), `${port}\n/devtools/browser/consent\n`);
    process.env.PORRIMA_BROWSER_USER_DATA_DIR = userDataDir;
    process.env.PORRIMA_BROWSER_CONSENT_TIMEOUT_MS = "400";
    delete process.env.PORRIMA_BROWSER_ATTACH;
  });

  it("falls back to a private browser after the consent window instead of hanging", async () => {
    const started = Date.now();
    const session = await getBrowserSession(CHAT_ID);
    expect(session.mode).toBe("launched");
    expect(Date.now() - started).toBeLessThan(15000);
  }, 30000);

  afterAll(async () => {
    await closeBrowserSession(CHAT_ID).catch(() => {});
    if (originalUserDataDirEnv === undefined) delete process.env.PORRIMA_BROWSER_USER_DATA_DIR;
    else process.env.PORRIMA_BROWSER_USER_DATA_DIR = originalUserDataDirEnv;
    if (originalConsentEnv === undefined) delete process.env.PORRIMA_BROWSER_CONSENT_TIMEOUT_MS;
    else process.env.PORRIMA_BROWSER_CONSENT_TIMEOUT_MS = originalConsentEnv;
    if (originalAttachEnv === undefined) delete process.env.PORRIMA_BROWSER_ATTACH;
    else process.env.PORRIMA_BROWSER_ATTACH = originalAttachEnv;
    for (const socket of sockets) socket.destroy();
    server?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });
});
