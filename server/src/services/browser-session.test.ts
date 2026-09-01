// Session-layer integration test: launches a real headless Chrome against a
// local static fixture whose interactions are hover-first — the exact class
// of UI browser_hover exists to drive. Also covers the walker's
// pointer-events:none filter. Requires a Chrome/Chromium on PATH candidates.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getBrowserSession,
  navigateTo,
  snapshotPage,
  hoverRef,
  clickRef,
  closeBrowserSession,
  type BrowserSession,
} from "./browser-session.js";

const CHAT_ID = "browser-session-test";
const PORT = 8377;

const PAGE = `<!doctype html>
<html><head><title>hover fixture</title></head>
<body style="margin:0">
  <button id="trigger">Pick a thing</button>
  <div id="menu" hidden>
    <button id="opt-a">Alpha option</button>
    <button id="opt-b">Beta option</button>
  </div>
  <button id="ghost" style="pointer-events:none">Ghost option</button>
  <script>
    const t = document.getElementById("trigger");
    const m = document.getElementById("menu");
    let timer = 0;
    const show = () => { clearTimeout(timer); m.hidden = false; };
    const hide = () => { timer = setTimeout(() => { m.hidden = true; }, 300); };
    t.addEventListener("pointerenter", show);
    t.addEventListener("pointerleave", hide);
    m.addEventListener("pointerenter", show);
    m.addEventListener("pointerleave", hide);
    window.__picked = null;
    document.getElementById("opt-a").addEventListener("click", () => { window.__picked = "alpha"; });
    document.getElementById("opt-b").addEventListener("click", () => { window.__picked = "beta"; });
  </script>
</body></html>`;

function refByName(session: BrowserSession, name: string): number | undefined {
  for (const [ref, el] of session.refs) {
    if (el.name === name) return ref;
  }
  return undefined;
}

describe("browser session: hover-driven UI", () => {
  let server: ReturnType<typeof spawn>;
  let session: BrowserSession;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-hover-"));
    writeFileSync(join(dir, "index.html"), PAGE);
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", dir], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    session = await getBrowserSession(CHAT_ID);
    await navigateTo(session, `http://127.0.0.1:${PORT}/`, 20000);
  }, 30000);

  it("resting snapshot shows the trigger, hides hover-revealed options, drops pointer-events:none ghosts", async () => {
    const snap = await snapshotPage(session);
    expect(snap.text).toContain("Pick a thing");
    expect(snap.text).not.toContain("Alpha option");
    expect(snap.text).not.toContain("Beta option");
    expect(snap.text).not.toContain("Ghost option");
    expect(refByName(session, "Pick a thing")).toBeDefined();
  }, 10000);

  it("hover reveals the menu and invalidates the pre-hover refs", async () => {
    const triggerRef = refByName(session, "Pick a thing");
    expect(triggerRef).toBeDefined();
    await hoverRef(session, triggerRef!);
    expect(session.refs.size, "hover must invalidate the ref map").toBe(0);
    const snap = await snapshotPage(session);
    expect(snap.text).toContain("Alpha option");
    expect(snap.text).toContain("Beta option");
    expect(refByName(session, "Beta option")).toBeDefined();
  }, 10000);

  it("click works on an element revealed by hover", async () => {
    const betaRef = refByName(session, "Beta option");
    expect(betaRef).toBeDefined();
    await clickRef(session, betaRef!);
    const picked = await session.page.evaluate(() => (window as any).__picked);
    expect(picked).toBe("beta");
  }, 10000);

  afterAll(async () => {
    await closeBrowserSession(CHAT_ID).catch(() => {});
    server.kill();
  });
});
