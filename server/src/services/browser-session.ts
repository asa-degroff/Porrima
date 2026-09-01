import puppeteer, { type Browser, type Page, type ElementHandle } from "puppeteer-core";
import sharp from "sharp";
import { findChromePath } from "./chrome.js";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_FULLPAGE_HEIGHT = 16384;
const DEFAULT_SNAPSHOT_LIMIT = 120;
const MAX_SNAPSHOT_LIMIT = 300;
const WALKER_HARD_CAP = 500;

export interface SnapshotElement {
  ref: number;
  tag: string;
  role: string;
  name: string;
  href?: string;
  value?: string;
  states: string[];
  xpath: string;
}

export interface BrowserSession {
  chatId: string;
  browser: Browser;
  page: Page;
  refs: Map<number, SnapshotElement>;
  lastUsed: number;
  dialogs: string[];
}

const sessions = new Map<string, BrowserSession>();
const launching = new Map<string, Promise<BrowserSession>>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function touch(session: BrowserSession): void {
  session.lastUsed = Date.now();
}

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, session] of sessions) {
      if (now - session.lastUsed > IDLE_TIMEOUT_MS) {
        closeBrowserSession(chatId).catch(() => {});
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export async function closeBrowserSession(chatId: string): Promise<void> {
  const session = sessions.get(chatId);
  sessions.delete(chatId);
  if (session) {
    await session.browser.close().catch(() => {});
  }
}

export async function closeAllBrowserSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeBrowserSession(id)));
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function attachDialogHandler(session: BrowserSession, page: Page): void {
  page.on("dialog", async (dialog) => {
    session.dialogs.push(`${dialog.type()}: ${dialog.message()}`.slice(0, 200));
    if (session.dialogs.length > 5) session.dialogs.shift();
    await dialog.dismiss().catch(() => {});
  });
}

async function launchSession(chatId: string): Promise<BrowserSession> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error("No Chrome/Chromium installation found on this machine.");
  }
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: process.env.PORRIMA_BROWSER_HEADLESS !== "0",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport(DEFAULT_VIEWPORT);
  const session: BrowserSession = { chatId, browser, page, refs: new Map(), lastUsed: Date.now(), dialogs: [] };
  attachDialogHandler(session, page);
  sessions.set(chatId, session);
  startSweeper();
  return session;
}

export async function getBrowserSession(chatId: string): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) {
    if (existing.browser.connected) {
      touch(existing);
      return existing;
    }
    sessions.delete(chatId);
    await existing.browser.close().catch(() => {});
  }
  const pending = launching.get(chatId);
  if (pending) return pending;
  const promise = launchSession(chatId).finally(() => launching.delete(chatId));
  launching.set(chatId, promise);
  return promise;
}

/** After navigation/clicks, adopt the most recently opened page (e.g. target=_blank popups). */
async function syncActivePage(session: BrowserSession): Promise<boolean> {
  const pages = await session.browser.pages();
  const newest = pages[pages.length - 1];
  if (!newest || newest === session.page) return false;
  session.page = newest;
  attachDialogHandler(session, newest);
  await newest.setViewport(DEFAULT_VIEWPORT).catch(() => {});
  return true;
}

export function drainDialogNotes(session: BrowserSession): string {
  if (session.dialogs.length === 0) return "";
  const notes = session.dialogs.map((d) => `- ${d}`).join("\n");
  session.dialogs = [];
  return `\n\nPage dialogs were auto-dismissed:\n${notes}`;
}

// --- Navigation ---

export async function navigateTo(session: BrowserSession, url: string, timeoutMs: number): Promise<{ title: string; finalUrl: string }> {
  session.refs.clear();
  await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await session.page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
  await syncActivePage(session);
  touch(session);
  return { title: await session.page.title(), finalUrl: session.page.url() };
}

// --- Snapshot ---

const WALKER_SRC = `() => {
  const MAX = ${WALKER_HARD_CAP};
  const interactiveSelector = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=checkbox]",
    "[role=radio]", "[role=combobox]", "[role=searchbox]", "[role=switch]", "[role=textbox]",
    "[role=option]", "[role=slider]", "[contenteditable=true]", "[contenteditable='']", "[onclick]",
  ].join(",");
  const seen = new Set();
  for (const el of document.querySelectorAll(interactiveSelector)) {
    seen.add(el);
    if (seen.size >= MAX) break;
  }
  for (const el of document.querySelectorAll("h1,h2,h3")) {
    if (seen.size >= MAX) break;
    seen.add(el);
  }
  const ordered = [...seen].sort((a, b) =>
    (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);

  const roleFor = (el, tag) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[123]$/.test(tag)) return "heading";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    return "generic";
  };

  const xpathOf = (el) => {
    const id = el.id;
    if (id && /^[A-Za-z0-9_-]+$/.test(id) && document.querySelectorAll("#" + id).length === 1) {
      return '//*[@id="' + id + '"]';
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node.tagName !== "HTML") {
      let index = 1;
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === node.tagName) index++;
      }
      parts.unshift(node.tagName.toLowerCase() + "[" + index + "]");
      node = node.parentElement;
    }
    return "/html/" + parts.join("/");
  };

  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const elements = [];
  for (const el of ordered) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0 || cs.pointerEvents === "none") continue;
    const tag = el.tagName.toLowerCase();
    const text = clean(el.innerText).slice(0, 80);
    const name = clean(
      el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") ||
      el.getAttribute("title") || (tag === "select" && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : "") || text
    ).slice(0, 80);
    const states = [];
    if (el.disabled) states.push("disabled");
    if (el.checked) states.push("checked");
    if (el.getAttribute("aria-expanded") === "true" || (tag === "details" && el.open)) states.push("expanded");
    elements.push({
      tag,
      role: roleFor(el, tag),
      name,
      href: tag === "a" ? el.href : undefined,
      value: (tag === "input" || tag === "textarea") ? String(el.value || "").slice(0, 60) : undefined,
      states,
      xpath: xpathOf(el),
    });
  }
  return {
    url: location.href,
    title: document.title,
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    elements,
  };
}`;

interface RawSnapshot {
  url: string;
  title: string;
  scrollY: number;
  scrollHeight: number;
  innerHeight: number;
  elements: Array<Omit<SnapshotElement, "ref">>;
}

export interface SnapshotResult {
  text: string;
  total: number;
  shown: number;
}

export function formatElementLine(el: SnapshotElement): string {
  const parts = [`[e${el.ref}] ${el.role}`];
  if (el.name) parts.push(`"${el.name}"`);
  if (el.value) parts.push(`value="${el.value}"`);
  if (el.states.length) parts.push(`(${el.states.join(", ")})`);
  if (el.href) parts.push(`→ ${el.href.length > 100 ? el.href.slice(0, 100) + "…" : el.href}`);
  return parts.join(" ");
}

export async function snapshotPage(session: BrowserSession, query?: string, limit?: number): Promise<SnapshotResult> {
  const raw = await session.page.evaluate(`(${WALKER_SRC})()`) as unknown as RawSnapshot;
  session.refs.clear();

  const q = query?.toLowerCase();
  const matched = q
    ? raw.elements.filter((el) =>
        `${el.name} ${el.role} ${el.href ?? ""}`.toLowerCase().includes(q))
    : raw.elements;

  const cap = Math.min(Math.max(limit ?? DEFAULT_SNAPSHOT_LIMIT, 10), MAX_SNAPSHOT_LIMIT);
  const shown: SnapshotElement[] = matched.slice(0, cap).map((el, i) => ({ ...el, ref: i + 1 }));
  for (const el of shown) {
    session.refs.set(el.ref, el);
  }

  const scrollPct = raw.scrollHeight > raw.innerHeight
    ? Math.round((raw.scrollY / (raw.scrollHeight - raw.innerHeight)) * 100)
    : 0;
  const header = `${raw.url} — "${raw.title}"\nViewport ${DEFAULT_VIEWPORT.width}x${DEFAULT_VIEWPORT.height} · scroll ${scrollPct}% · ${matched.length} element${matched.length === 1 ? "" : "s"}`;
  const lines = shown.map(formatElementLine);
  if (matched.length > shown.length) {
    lines.push(`… ${matched.length - shown.length} more element(s) omitted — filter with query or raise limit (max ${MAX_SNAPSHOT_LIMIT}).`);
  }
  lines.push("\nUse browser_click/browser_type with a ref. Refs are invalidated by navigation — re-snapshot after the page changes.");
  touch(session);
  return { text: `${header}\n\n${lines.join("\n")}`, total: matched.length, shown: shown.length };
}

// --- Actions ---

export async function resolveRef(session: BrowserSession, ref: number): Promise<{ element: ElementHandle; descriptor: SnapshotElement }> {
  const descriptor = session.refs.get(ref);
  if (!descriptor) {
    throw new Error(`Ref e${ref} is not in the current snapshot (refs are invalidated by navigation and new snapshots). Call browser_snapshot to get fresh refs.`);
  }
  const element = await session.page.$(`xpath/${descriptor.xpath}`);
  if (!element) {
    throw new Error(`Ref e${ref} ("${descriptor.name || descriptor.role}") no longer resolves — the page likely changed. Call browser_snapshot to get fresh refs.`);
  }
  return { element, descriptor };
}

export async function clickRef(session: BrowserSession, ref: number): Promise<{ clicked: string; urlBefore: string; urlAfter: string; title: string; switchedPage: boolean }> {
  const { element, descriptor } = await resolveRef(session, ref);
  const urlBefore = session.page.url();
  await element.scrollIntoView().catch(() => {});
  const navigation = session.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => null);
  await element.click();
  await navigation;
  await session.page.waitForNetworkIdle({ idleTime: 500, timeout: 2000 }).catch(() => {});
  const switchedPage = await syncActivePage(session);
  session.refs.clear();
  touch(session);
  return {
    clicked: formatElementLine(descriptor),
    urlBefore,
    urlAfter: session.page.url(),
    title: await session.page.title().catch(() => ""),
    switchedPage,
  };
}

export async function typeIntoRef(session: BrowserSession, ref: number, text: string, submit: boolean): Promise<{ typed: string; submitted: boolean }> {
  const { element, descriptor } = await resolveRef(session, ref);
  await element.scrollIntoView().catch(() => {});
  if (descriptor.tag === "input" || descriptor.tag === "textarea") {
    // React-safe: write through the native setter and fire bubbling events so
    // controlled components keep the value. String-form evaluate takes no
    // arguments, so xpath/value are embedded as JSON literals.
    const fillScript = `(() => {
      const el = document.evaluate(${JSON.stringify(descriptor.xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      if (!el) return false;
      const value = ${JSON.stringify(text)};
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`;
    const ok = await session.page.evaluate(fillScript);
    if (!ok) {
      throw new Error(`Ref e${ref} ("${descriptor.name || descriptor.role}") no longer resolves — the page likely changed. Call browser_snapshot to get fresh refs.`);
    }
  } else {
    await element.click().catch(() => {});
    await session.page.keyboard.type(text);
  }

  if (submit) {
    await session.page.keyboard.press("Enter");
    await session.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => null);
    await session.page.waitForNetworkIdle({ idleTime: 500, timeout: 2000 }).catch(() => {});
    await syncActivePage(session);
    session.refs.clear();
  }
  touch(session);
  return { typed: formatElementLine(descriptor), submitted: submit };
}

export async function hoverRef(session: BrowserSession, ref: number): Promise<{ descriptor: SnapshotElement }> {
	const { element, descriptor } = await resolveRef(session, ref);
	await element.scrollIntoView().catch(() => {});
	const box = await element.boundingBox().catch(() => null);
	if (!box) {
		throw new Error(`Ref e${ref} ("${descriptor.name || descriptor.role}") no longer resolves — the page likely changed. Call browser_snapshot to get fresh refs.`);
	}
	await session.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	// The pointer stays where it is. Hover can reveal elements (menus, popups,
	// tooltips), so the pre-hover ref map no longer describes the page —
	// invalidate it like any other action.
	session.refs.clear();
	touch(session);
	return { descriptor };
}

// --- Screenshot ---

export async function screenshotPage(session: BrowserSession, fullPage: boolean): Promise<{ data: string; mimeType: string; width: number; height: number; url: string; title: string }> {
  const raw = Buffer.from(await session.page.screenshot({ type: "png", fullPage }));
  const pipeline = fullPage
    ? sharp(raw).resize({ width: MAX_SCREENSHOT_WIDTH, height: MAX_FULLPAGE_HEIGHT, fit: "inside", withoutEnlargement: true })
    : sharp(raw).resize({ width: MAX_SCREENSHOT_WIDTH, withoutEnlargement: true });
  const png = await pipeline.png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(png).metadata();
  touch(session);
  return {
    data: png.toString("base64"),
    mimeType: "image/png",
    width: meta.width ?? DEFAULT_VIEWPORT.width,
    height: meta.height ?? DEFAULT_VIEWPORT.height,
    url: session.page.url(),
    title: await session.page.title().catch(() => ""),
  };
}
