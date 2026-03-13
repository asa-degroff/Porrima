import { writeFile, mkdir, access, rm } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import sharp from "sharp";

const USER_IMAGES_DIR = join(homedir(), ".quje-agent", "user-images");
const THUMB_WIDTH = 384;
const THUMB_QUALITY = 80;

export interface UserImageRecord {
  id: string;
  url: string;
  thumbUrl: string;
  mimeType: string;
  name: string;
  size: number;
  createdAt: string;
}

/**
 * Save a user-attached image, creating a thumbnail for chat view.
 * Returns URLs for both full image and thumbnail.
 */
export async function saveUserImage(
  id: string,
  imageBuffer: Buffer,
  mimeType: string,
  name: string
): Promise<UserImageRecord> {
  const imageDir = join(USER_IMAGES_DIR, id);
  await mkdir(imageDir, { recursive: true });

  const ext = mimeTypeToExt(mimeType);

  // Save original
  const originalPath = join(imageDir, `image.${ext}`);
  await writeFile(originalPath, imageBuffer);

  // Create thumbnail
  const thumbBuffer = await sharp(imageBuffer)
    .resize(THUMB_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  const thumbPath = join(imageDir, "thumb.webp");
  await writeFile(thumbPath, thumbBuffer);

  return {
    id,
    url: `/api/user-images/${id}/image.${ext}`,
    thumbUrl: `/api/user-images/${id}/thumb`,
    mimeType,
    name,
    size: imageBuffer.length,
    createdAt: new Date().toISOString(),
  };
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[mimeType] || "png";
}

export function getUserImageDir(id: string): string {
  return join(USER_IMAGES_DIR, id);
}

export async function deleteUserImage(id: string): Promise<boolean> {
  const imageDir = join(USER_IMAGES_DIR, id);
  try {
    await access(imageDir);
    await rm(imageDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
