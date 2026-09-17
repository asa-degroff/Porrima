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
  it("finds a live endpoint advertised by DevToolsActivePort", async () => {
    const dir = makeUserDataDir();
    const port = await listen((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Browser: "Chrome/152" }));
    });
    writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/live\n`);
    process.env[ENV_KEY] = dir;

    expect(await discoverDevToolsTarget()).toEqual({
      userDataDir: dir,
      port,
      webSocketPath: "/devtools/browser/live",
    });
  });

  it("skips a stale DevToolsActivePort when nothing is listening", async () => {
    const dir = makeUserDataDir();
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
    const address = dead.address();
    if (!address || typeof address === "string") throw new Error("server did not expose a port");
    const deadPort = address.port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    writeFileSync(join(dir, "DevToolsActivePort"), `${deadPort}\n/devtools/browser/stale\n`);
    process.env[ENV_KEY] = dir;

    expect(await discoverDevToolsTarget()).toBeNull();
  });
});
