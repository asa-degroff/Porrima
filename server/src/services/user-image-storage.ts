import { writeFile, mkdir, access, rm, readFile } from "fs/promises";
import { join } from "path";
import sharp from "sharp";
import type { ImageAttachment } from "../types.js";
import { appDataPath } from "./paths.js";

const USER_IMAGES_DIR = appDataPath("user-images");
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

function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  return map[ext.toLowerCase()] || "image/png";
}

function imageExtensionFromUrl(url?: string): string | undefined {
  const match = url?.match(/\/image\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
  return match?.[1]?.toLowerCase();
}

export function stripImageAttachmentData(image: ImageAttachment): ImageAttachment {
  const { data: _data, ...rest } = image;
  return rest;
}

export async function hydrateUserImageAttachment(image: ImageAttachment): Promise<ImageAttachment> {
  if (image.data || !image.id) return image;

  const imageDir = getUserImageDir(image.id);
  const candidates = [
    imageExtensionFromUrl(image.url),
    mimeTypeToExt(image.mimeType),
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
  ].filter((ext, index, all): ext is string => Boolean(ext) && all.indexOf(ext) === index);

  for (const ext of candidates) {
    try {
      const buffer = await readFile(join(imageDir, `image.${ext}`));
      return {
        ...image,
        data: buffer.toString("base64"),
        mimeType: image.mimeType || extToMimeType(ext),
      };
    } catch {
      // Try the next plausible persisted extension.
    }
  }

  return image;
}

export async function hydrateUserImageAttachments(images?: ImageAttachment[]): Promise<ImageAttachment[] | undefined> {
  if (!images?.length) return images;
  return Promise.all(images.map((image) => hydrateUserImageAttachment(image)));
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
