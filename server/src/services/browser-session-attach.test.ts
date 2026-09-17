// Attach-path integration test: spawns a real Chrome with remote debugging on
// a non-default profile (required since Chrome 136), points discovery at it,
// and verifies the session layer attaches, drives it, then disconnects without
// closing the browser or leaving its own tab behind.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromePath, readDevToolsActivePort } from "./chrome.js";
import {
  closeBrowserSession,
  getBrowserSession,
  navigateTo,
  snapshotPage,
  type BrowserSession,
} from "./browser-session.js";

const CHAT_ID = "browser-attach-test";
const chromePath = findChromePath();

async function waitForDevToolsEndpoint(userDataDir: string, timeoutMs = 20000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = readDevToolsActivePort(userDataDir);
    if (target) {
      try {
        const res = await fetch(`http://127.0.0.1:${target.port}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return target.port;
      } catch {
        // Chrome has written the file but is not accepting connections yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chrome remote debugging endpoint did not come up");
}

describe.skipIf(!chromePath)("browser session: attach to a running Chrome", () => {
  let chrome: ChildProcess;
  let userDataDir: string;
  let port: number;
  let session: BrowserSession;
  const originalUserDataDirEnv = process.env.PORRIMA_BROWSER_USER_DATA_DIR;
  const originalAttachEnv = process.env.PORRIMA_BROWSER_ATTACH;

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), "porrima-attach-"));
    chrome = spawn(chromePath!, [
      "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ], { stdio: "ignore" });
    port = await waitForDevToolsEndpoint(userDataDir);
    process.env.PORRIMA_BROWSER_USER_DATA_DIR = userDataDir;
    delete process.env.PORRIMA_BROWSER_ATTACH;
    session = await getBrowserSession(CHAT_ID);
  }, 40000);

  it("attaches instead of launching a private browser", () => {
    expect(session.mode).toBe("attached");
    expect(session.browser.connected).toBe(true);
  });

  it("drives the attached browser without imposing a viewport", async () => {
    const url = `data:text/html,${encodeURIComponent("<title>attached fixture</title><button>Press me</button>")}`;
    const result = await navigateTo(session, url, 20000);
    expect(result.title).toBe("attached fixture");
    const snap = await snapshotPage(session);
    expect(snap.text).toContain("Press me");
    expect(snap.text).toContain("Viewport native");
  }, 30000);

  it("tears down by closing only its own tab and disconnecting", async () => {
    await closeBrowserSession(CHAT_ID);
    expect(session.browser.connected).toBe(false);
    expect(chrome.exitCode).toBeNull();

    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    expect(listRes.ok).toBe(true);
    const targets = (await listRes.json()) as Array<{ title?: string }>;
    expect(targets.some((target) => target.title === "attached fixture")).toBe(false);
  }, 20000);

  afterAll(async () => {
    if (originalUserDataDirEnv === undefined) delete process.env.PORRIMA_BROWSER_USER_DATA_DIR;
    else process.env.PORRIMA_BROWSER_USER_DATA_DIR = originalUserDataDirEnv;
    if (originalAttachEnv === undefined) delete process.env.PORRIMA_BROWSER_ATTACH;
    else process.env.PORRIMA_BROWSER_ATTACH = originalAttachEnv;
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise<void>((resolve) => chrome.once("exit", () => resolve()));
      chrome.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
    rmSync(userDataDir, { recursive: true, force: true });
  });
});
