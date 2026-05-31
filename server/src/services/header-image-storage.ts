import { writeFile, mkdir, access, rm, stat } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import { appDataPath } from "./paths.js";

const HEADER_IMAGE_DIR = appDataPath("header-image");
const HEADER_SIZE = 96;
const HEADER_QUALITY = 85;

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/jxl": "jxl",
  };
  return map[mimeType] || "png";
}

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
  mimeType: string
): Promise<HeaderImageInfo> {
  await mkdir(HEADER_IMAGE_DIR, { recursive: true });

  const ext = mimeTypeToExt(mimeType);

  await Promise.all(
    IMAGE_EXTS.map((existingExt) => rm(join(HEADER_IMAGE_DIR, `image.${existingExt}`), { force: true })),
  );

  // Save original
  const originalPath = join(HEADER_IMAGE_DIR, `image.${ext}`);
  await writeFile(originalPath, imageBuffer);

  // Create a square thumbnail cropped from center
  const meta = await sharp(imageBuffer).metadata();
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

  const thumbPath = join(HEADER_IMAGE_DIR, "thumb.webp");
  await writeFile(thumbPath, thumbBuffer);
  const version = await getHeaderImageVersion();

  return {
    url: appendVersion(`/api/settings/header-image/image.${ext}`, version),
    thumbUrl: appendVersion(`/api/settings/header-image/thumb`, version),
    mimeType,
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
