import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import type { ImageAttachment } from "../types.js";
import { appDataPath } from "./paths.js";
import { resolveWithin } from "../utils/safe-path.js";

const TOOL_RESULT_IMAGES_DIR = appDataPath("tool-result-images");

export interface ToolResultImageRecord {
  id: string;
  url: string;
  mimeType: string;
  name: string;
  size: number;
  createdAt: string;
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/jxl": "jxl",
  };
  return map[mimeType] || "bin";
}

function extToMimeType(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    jxl: "image/jxl",
  };
  return map[ext.toLowerCase()] || "application/octet-stream";
}

function imageExtensionFromUrl(url?: string): string | undefined {
  const match = url?.match(/\/image\.([a-zA-Z0-9]+)(?:[?#].*)?$/);
  return match?.[1]?.toLowerCase();
}

/** The image id is a persisted filesystem key, so it is contained here rather
 *  than at each call site — a route that forgets the check should not be able to
 *  read or delete outside the image root. */
export function getToolResultImageDir(id: string): string {
  const dir = resolveWithin(TOOL_RESULT_IMAGES_DIR, id);
  if (!dir) throw new Error("Invalid image id");
  return dir;
}

export function stripToolResultImageData(image: ImageAttachment): ImageAttachment {
  const { data: _data, ...rest } = image;
  return rest;
}

export async function saveToolResultImage(
  id: string,
  imageBuffer: Buffer,
  mimeType: string,
  name: string,
): Promise<ToolResultImageRecord> {
  const imageDir = getToolResultImageDir(id);
  await mkdir(imageDir, { recursive: true });
  const ext = mimeTypeToExt(mimeType);
  await writeFile(join(imageDir, `image.${ext}`), imageBuffer);
  return {
    id,
    url: `/api/tool-result-images/${id}/image.${ext}`,
    mimeType,
    name,
    size: imageBuffer.length,
    createdAt: new Date().toISOString(),
  };
}

export async function hydrateToolResultImageAttachment(image: ImageAttachment): Promise<ImageAttachment> {
  if (image.data || !image.id) return image;
  const imageDir = getToolResultImageDir(image.id);
  const candidates = [
    imageExtensionFromUrl(image.url),
    mimeTypeToExt(image.mimeType),
    "jxl",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bin",
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
      // Try next extension.
    }
  }
  return image;
}

export async function hydrateToolResultImageAttachments(images?: ImageAttachment[]): Promise<ImageAttachment[] | undefined> {
  if (!images?.length) return images;
  return Promise.all(images.map((image) => hydrateToolResultImageAttachment(image)));
}
