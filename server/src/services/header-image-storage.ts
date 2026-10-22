import { writeFile, mkdir, access, rm, stat } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { appDataPath } from "./paths.js";

const HEADER_IMAGE_DIR = appDataPath("header-image");
const HEADER_SIZE = 96;
const HEADER_QUALITY = 85;

/** Formats we are willing to persist and serve. SVG is deliberately excluded:
 *  it is executable when served from the app origin. */
const FORMAT_TO_EXT: Record<string, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
  avif: "avif",
};

export interface HeaderImageInfo {
  url: string;
  thumbUrl: string;
  mimeType: string;
  exists: boolean;
  version?: string;
}

const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "jxl"] as const;

function appendVersion(url: string, version: string): string {
  return `${url}?v=${encodeURIComponent(version)}`;
}

async function getHeaderImageVersion(): Promise<string> {
  const thumbPath = join(HEADER_IMAGE_DIR, "thumb.webp");
  const stats = await stat(thumbPath);
  return String(Math.trunc(stats.mtimeMs));
}

/**
 * Save the header image. Creates a thumbnail optimized for the header icon size.
 */
export async function saveHeaderImage(
  imageBuffer: Buffer,
  _mimeType: string
): Promise<HeaderImageInfo> {
  await mkdir(HEADER_IMAGE_DIR, { recursive: true });

  // Decode before writing: sharp validates the bytes, and its reported format —
  // not the client-declared Content-Type — decides the extension we serve.
  // Rejecting here leaves the previous header image untouched.
  const meta = await sharp(imageBuffer).metadata();
  const ext = meta.format ? FORMAT_TO_EXT[meta.format] : undefined;
  if (!ext) {
    throw new Error(`Unsupported image format: ${meta.format || "unknown"}`);
  }

  const size = Math.min(meta.width ?? 96, meta.height ?? 96);
  const thumbBuffer = await sharp(imageBuffer)
    .extract({
      left: Math.floor(((meta.width ?? 96) - size) / 2),
      top: Math.floor(((meta.height ?? 96) - size) / 2),
      width: size,
      height: size,
    })
    .resize(HEADER_SIZE, HEADER_SIZE)
    .webp({ quality: HEADER_QUALITY })
    .toBuffer();

  await Promise.all(
    IMAGE_EXTS.map((existingExt) => rm(join(HEADER_IMAGE_DIR, `image.${existingExt}`), { force: true })),
  );

  const originalPath = join(HEADER_IMAGE_DIR, `image.${ext}`);
  await writeFile(originalPath, imageBuffer);

  const thumbPath = join(HEADER_IMAGE_DIR, "thumb.webp");
  await writeFile(thumbPath, thumbBuffer);
  const version = await getHeaderImageVersion();

  return {
    url: appendVersion(`/api/settings/header-image/image.${ext}`, version),
    thumbUrl: appendVersion(`/api/settings/header-image/thumb`, version),
    mimeType: ext === "jpg" ? "image/jpeg" : `image/${ext}`,
    exists: true,
    version,
  };
}

/**
 * Check if a header image exists.
 */
export async function headerImageExists(): Promise<boolean> {
  const thumbPath = join(HEADER_IMAGE_DIR, "thumb.webp");
  try {
    await access(thumbPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get info about the current header image.
 */
export async function getHeaderImageInfo(): Promise<HeaderImageInfo> {
  const exists = await headerImageExists();
  if (!exists) {
    return { url: "", thumbUrl: "", mimeType: "", exists: false };
  }

  // Find the original image extension
  const version = await getHeaderImageVersion();
  for (const ext of IMAGE_EXTS) {
    try {
      await access(join(HEADER_IMAGE_DIR, `image.${ext}`));
      const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return {
        url: appendVersion(`/api/settings/header-image/image.${ext}`, version),
        thumbUrl: appendVersion(`/api/settings/header-image/thumb`, version),
        mimeType: contentType,
        exists: true,
        version,
      };
    } catch {
      // try next
    }
  }

  return {
    url: "",
    thumbUrl: appendVersion(`/api/settings/header-image/thumb`, version),
    mimeType: "image/webp",
    exists: true,
    version,
  };
}

/**
 * Delete the header image.
 */
export async function deleteHeaderImage(): Promise<boolean> {
  try {
    await access(HEADER_IMAGE_DIR);
    await rm(HEADER_IMAGE_DIR, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function getHeaderImagePath(filename: string): string {
  return join(HEADER_IMAGE_DIR, filename);
}
