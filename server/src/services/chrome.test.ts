// Unit tests for Chrome profile discovery and DevToolsActivePort parsing —
// no browser process involved.
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeUserDataDirs,
  discoverDevToolsTarget,
  parseDevToolsActivePort,
  readDevToolsActivePort,
} from "./chrome.js";

const ENV_KEY = "PORRIMA_BROWSER_USER_DATA_DIR";
const originalEnv = process.env[ENV_KEY];
const tempDirs: string[] = [];
const servers: Server[] = [];

function makeUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "porrima-chrome-"));
  tempDirs.push(dir);
  return dir;
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not expose a port");
  return address.port;
}

afterEach(async () => {
  if (originalEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnv;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDevToolsActivePort", () => {
  it("parses port and browser websocket path", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/8f3a\n", "/tmp/profile")).toEqual({
      userDataDir: "/tmp/profile",
      port: 9222,
      webSocketPath: "/devtools/browser/8f3a",
    });
  });

  it("tolerates blank lines around the two entries", () => {
    expect(parseDevToolsActivePort("\n12345\n\n/devtools/browser/x\n\n", "/tmp/p")?.port).toBe(12345);
  });

  it("rejects malformed files", () => {
    expect(parseDevToolsActivePort("", "/tmp/p")).toBeNull();
    expect(parseDevToolsActivePort("9222", "/tmp/p")).toBeNull();
    expect(parseDevToolsActivePort("not-a-port\n/devtools/browser/x", "/tmp/p")).toBeNull();
    expect(parseDevToolsActivePort("0\n/devtools/browser/x", "/tmp/p")).toBeNull();
    expect(parseDevToolsActivePort("70000\n/devtools/browser/x", "/tmp/p")).toBeNull();
    expect(parseDevToolsActivePort("9222\ndevtools/browser/x", "/tmp/p")).toBeNull();
  });
});

describe("readDevToolsActivePort", () => {
  it("returns null when the file is missing", () => {
    expect(readDevToolsActivePort(makeUserDataDir())).toBeNull();
  });

  it("reads a written file", () => {
    const dir = makeUserDataDir();
    writeFileSync(join(dir, "DevToolsActivePort"), "4567\n/devtools/browser/abc\n");
    expect(readDevToolsActivePort(dir)).toMatchObject({ port: 4567, webSocketPath: "/devtools/browser/abc" });
  });
});

describe("chromeUserDataDirs", () => {
  it("honors the path-delimiter separated env override", () => {
    const a = makeUserDataDir();
    const b = makeUserDataDir();
    process.env[ENV_KEY] = `${a}:${b}`;
    expect(chromeUserDataDirs()).toEqual([a, b]);
  });
});

describe("discoverDevToolsTarget", () => {
  it("returns the target advertised by DevToolsActivePort — liveness belongs to the connect, not discovery", async () => {
    const dir = makeUserDataDir();
    // A port with nothing listening is fine at discovery time: the attach
    // attempt fails fast (connection refused) and falls back to launch.
    const port = 49_999;
    writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/live\n`);
    process.env[ENV_KEY] = dir;

    expect(await discoverDevToolsTarget()).toEqual({
      userDataDir: dir,
      port,
      webSocketPath: "/devtools/browser/live",
    });
  });

  it("finds a WebSocket-only consent-mode endpoint (404 on /json/version)", async () => {
    const dir = makeUserDataDir();
    // Chrome 152 consent mode: the legacy HTTP surface answers 404, only the
    // WS path works, and the handshake waits for the user's approval.
    // Discovery must NOT classify that endpoint as dead — this is the
    // production case the old /json/version probe misclassified (09-18).
    const port = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/consent\n`);
    process.env[ENV_KEY] = dir;

    expect(await discoverDevToolsTarget()).toEqual({
      userDataDir: dir,
      port,
      webSocketPath: "/devtools/browser/consent",
    });
  });

  it("returns null when no user-data dir has a parseable DevToolsActivePort", async () => {
    process.env[ENV_KEY] = makeUserDataDir();
    expect(await discoverDevToolsTarget()).toBeNull();
  });
});
