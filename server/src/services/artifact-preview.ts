import { createServer, type Server } from "http";
import { readFile } from "fs/promises";
import { relative, resolve, sep, join } from "path";
import puppeteer, { type Browser } from "puppeteer-core";
import sharp from "sharp";
import { appDataPath } from "./paths.js";
import { lookup } from "../utils/mime.js";
import { findChromePath } from "./chrome.js";

const ARTIFACTS_DIR = appDataPath("artifacts");
const VISUALS_DIR = appDataPath("visuals");
const DEFAULT_BACKGROUND = "#09090b";
const SCREENSHOT_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 3_000;
const SETTLE_MS = 900;
const MAX_IMAGE_WIDTH = 1280;

export type PreviewObjectKind = "artifact" | "visual";

export interface ArtifactPreviewTarget {
  id: string;
  version: number;
  objectKind: PreviewObjectKind;
}

export interface ArtifactPreviewScreenshot {
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
}

function isSafePreviewId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function versionDirFor(target: ArtifactPreviewTarget): string {
  const baseDir = target.objectKind === "visual" ? VISUALS_DIR : ARTIFACTS_DIR;
  return join(baseDir, target.id, "versions", String(target.version));
}

function viewportFor(kind: PreviewObjectKind): { width: number; height: number } {
  return kind === "visual"
    ? { width: 900, height: 520 }
    : { width: 1280, height: 800 };
}

function isInsideRoot(rootDir: string, filePath: string): boolean {
  const rel = relative(rootDir, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && rel !== ".." && !rel.startsWith(sep));
}

async function startStaticFileServer(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve(rootDir);
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname === "/" || pathname === "") pathname = "/index.html";
      if (pathname.includes("\0")) {
        res.statusCode = 400;
        res.end("Bad request");
        return;
      }

      const requestedPath = resolve(root, pathname.replace(/^\/+/, ""));
      if (!isInsideRoot(root, requestedPath)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      const content = await readFile(requestedPath);
      res.setHeader("Content-Type", lookup(requestedPath));
      res.end(content);
    } catch {
      res.statusCode = 404;
      res.end("Not found");
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (!port) {
    await closeServer(server);
    throw new Error("Failed to start local artifact preview server");
  }

  return {
    url: `http://127.0.0.1:${port}/index.html`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function settlePage(browser: Browser, url: string, viewport: { width: number; height: number }): Promise<Buffer> {
  const page = await browser.newPage();
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: SCREENSHOT_TIMEOUT_MS });
  await page.evaluate(`(async () => {
    if ("fonts" in document && document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch {}
    }
  })()`);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => undefined);
  await page.evaluate(`new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()));
  })`);
  await wait(SETTLE_MS);
  await page.evaluate(`(() => {
    const background = ${JSON.stringify(DEFAULT_BACKGROUND)};
    const transparent = (value) => value === "rgba(0, 0, 0, 0)" || value === "transparent";
    const html = document.documentElement;
    const body = document.body;
    const htmlBg = getComputedStyle(html).backgroundColor;
    const bodyBg = body ? getComputedStyle(body).backgroundColor : "transparent";
    if (transparent(htmlBg) && transparent(bodyBg)) {
      html.style.background = background;
    }
  })()`);
  return Buffer.from(await page.screenshot({ type: "png", fullPage: false }));
}

async function normalizeScreenshot(buffer: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const width = metadata.width || MAX_IMAGE_WIDTH;
  const height = metadata.height || 800;
  const normalized = width > MAX_IMAGE_WIDTH
    ? image.resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true }).png({ compressionLevel: 9 })
    : image.png({ compressionLevel: 9 });
  const output = await normalized.toBuffer();
  const outMetadata = await sharp(output).metadata();
  return {
    buffer: output,
    width: outMetadata.width || Math.min(width, MAX_IMAGE_WIDTH),
    height: outMetadata.height || height,
  };
}

export async function renderArtifactPreviewScreenshot(target: ArtifactPreviewTarget): Promise<ArtifactPreviewScreenshot> {
  if (process.env.PORRIMA_ARTIFACT_REVIEW_SCREENSHOTS === "0") {
    throw new Error("Artifact review screenshots are disabled by PORRIMA_ARTIFACT_REVIEW_SCREENSHOTS=0");
  }
  if (process.env.NODE_ENV === "test" && process.env.PORRIMA_ARTIFACT_REVIEW_SCREENSHOTS !== "1") {
    throw new Error("Artifact review screenshots are disabled during tests");
  }
  if (!isSafePreviewId(target.id)) {
    throw new Error("Invalid artifact id for screenshot preview");
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error("No Chrome/Chromium installation found for artifact preview screenshot");
  }

  const rootDir = versionDirFor(target);
  const server = await startStaticFileServer(rootDir);
  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-unsafe-webgpu",
        "--ignore-gpu-blocklist",
      ],
    });
    const viewport = viewportFor(target.objectKind);
    const raw = await settlePage(browser, server.url, viewport);
    const normalized = await normalizeScreenshot(raw);
    return {
      data: normalized.buffer.toString("base64"),
      mimeType: "image/png",
      width: normalized.width,
      height: normalized.height,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}
