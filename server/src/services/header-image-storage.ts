import { writeFile, mkdir, access, rm } from "fs/promises";
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
  };
  return map[mimeType] || "png";
}

export interface HeaderImageInfo {
  url: string;
  thumbUrl: string;
  mimeType: string;
  exists: boolean;
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

  return {
    url: `/api/settings/header-image/image.${ext}`,
    thumbUrl: `/api/settings/header-image/thumb`,
    mimeType,
    exists: true,
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
  const exts = ["jpg", "png", "webp", "gif"];
  for (const ext of exts) {
    try {
      await access(join(HEADER_IMAGE_DIR, `image.${ext}`));
      const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      return {
        url: `/api/settings/header-image/image.${ext}`,
        thumbUrl: `/api/settings/header-image/thumb`,
        mimeType: contentType,
        exists: true,
      };
    } catch {
      // try next
    }
  }

  return { url: "", thumbUrl: `/api/settings/header-image/thumb`, mimeType: "image/webp", exists: true };
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
