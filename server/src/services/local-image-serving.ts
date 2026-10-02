import { open, realpath, stat } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, resolve, sep } from "path";
import { listProjects } from "./chat-storage.js";

/**
 * On-demand serving for images referenced by local filesystem path inside
 * markdown (e.g. `![before/after](/tmp/render.png)`).
 *
 * Assistant prose sometimes links images the agent rendered to a scratch
 * path. Those paths are meaningless to the browser, so the client rewrites
 * them to `/api/local-images?path=...` and this module decides what may be
 * served. Nothing is copied or persisted: if the scratch file is later
 * cleaned up (say, /tmp is wiped), the reference simply stops resolving.
 *
 * Safety model: the response must be a real image by magic bytes (the
 * extension is irrelevant), under a size cap, and inside an allowed root
 * (home, the system temp dirs, or a locally-configured project root). The
 * magic-byte gate is what keeps non-image secrets unreadable even when they
 * live under an allowed root.
 */

export const MAX_LOCAL_IMAGE_BYTES = 64 * 1024 * 1024;

const HEADER_SNIFF_BYTES = 32;

export type LocalImageResolution =
  | { ok: true; path: string; mimeType: string; size: number }
  | { ok: false; status: 400 | 403 | 404 | 413 | 415; error: string };

/**
 * Normalize a markdown image src into an absolute filesystem path.
 * Accepts absolute paths, `~/...`, and `file://` URLs. Returns null for
 * anything else (http(s), data URIs, relative paths, protocol-relative
 * URLs) so callers can leave those untouched.
 */
export function expandLocalImagePath(raw: string): string | null {
  let value = raw.trim();
  if (!value || value.includes("\0")) return null;
  // Markdown may wrap destinations containing spaces in angle brackets.
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  if (/^file:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.host && url.host !== "localhost") return null;
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    return isAbsolute(pathname) ? pathname : null;
  }

  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  if (isAbsolute(value)) return value;
  return null;
}

/** True when `realPath` is exactly a root or lives beneath one. */
export function isWithinAnyRoot(realPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const normalizedRoot = root.endsWith(sep) ? root.slice(0, -1) : root;
    return realPath === normalizedRoot || realPath.startsWith(normalizedRoot + sep);
  });
}

/** Detect an allowed image MIME type from the leading bytes of a file. */
export function detectLocalImageMimeType(header: Buffer): string | null {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.length >= 6 && (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return "image/gif";
  }
  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (header.length >= 12 && header.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = header.subarray(8, 12).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  if (header.length >= 2 && header[0] === 0xff && header[1] === 0x0a) {
    return "image/jxl";
  }
  if (
    header.length >= 12 &&
    header[0] === 0x00 &&
    header[1] === 0x00 &&
    header[2] === 0x00 &&
    header[3] === 0x0c &&
    header.subarray(4, 12).toString("ascii") === "JXL "
  ) {
    return "image/jxl";
  }
  return null;
}

/** Roots that may be served: home, system temp dirs, and local project roots. */
export async function allowedLocalImageRoots(): Promise<string[]> {
  const roots = [homedir(), "/tmp", "/var/tmp"];
  try {
    const projects = await listProjects();
    for (const project of projects) {
      if (project.locationType && project.locationType !== "local") continue;
      if (project.path && isAbsolute(project.path)) roots.push(project.path);
    }
  } catch {
    // Project lookup is best-effort — the base roots still apply.
  }
  return roots;
}

async function readHeader(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Resolve a requested local image path to a servable file, enforcing the
 * allowed-root, image-type, and size constraints. `realpath` canonicalizes
 * symlinks before the root check so a link cannot escape an allowed root.
 */
export async function resolveLocalImageRequest(
  rawPath: string,
  roots?: string[],
): Promise<LocalImageResolution> {
  const expanded = expandLocalImagePath(rawPath);
  if (!expanded) {
    return { ok: false, status: 400, error: "Expected an absolute local image path" };
  }

  let realPath: string;
  try {
    realPath = await realpath(expanded);
  } catch {
    return { ok: false, status: 404, error: "Image not found" };
  }

  const effectiveRoots = roots ?? (await allowedLocalImageRoots());
  if (!isWithinAnyRoot(realPath, effectiveRoots)) {
    return { ok: false, status: 403, error: "Path is outside the allowed roots" };
  }

  let stats;
  try {
    stats = await stat(realPath);
  } catch {
    return { ok: false, status: 404, error: "Image not found" };
  }
  if (!stats.isFile()) {
    return { ok: false, status: 404, error: "Image not found" };
  }
  if (stats.size > MAX_LOCAL_IMAGE_BYTES) {
    return { ok: false, status: 413, error: "Image is too large to serve" };
  }

  let mimeType: string | null = null;
  try {
    mimeType = detectLocalImageMimeType(await readHeader(realPath));
  } catch {
    return { ok: false, status: 404, error: "Image not found" };
  }
  if (!mimeType) {
    return { ok: false, status: 415, error: "File is not a supported image" };
  }

  return { ok: true, path: realPath, mimeType, size: stats.size };
}
