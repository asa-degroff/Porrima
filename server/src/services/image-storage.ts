import { writeFile, mkdir, readFile, readdir, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import sharp from "sharp";
import type { ImageGenerationParams } from "../types.js";

const IMAGES_DIR = join(homedir(), ".quje-agent", "images");
const THUMB_WIDTH = 384;

interface ImageMetadata {
  params: ImageGenerationParams;
  resolvedSeed: number;
  createdAt: string;
  chatId?: string;
}

export async function saveGeneratedImage(
  id: string,
  imageBuffer: Buffer,
  metadata: ImageMetadata
): Promise<string> {
  const imageDir = join(IMAGES_DIR, id);
  await mkdir(imageDir, { recursive: true });

  const thumbBuffer = await sharp(imageBuffer)
    .resize(THUMB_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  await Promise.all([
    writeFile(join(imageDir, "image.png"), imageBuffer),
    writeFile(join(imageDir, "thumb.webp"), thumbBuffer),
    writeFile(join(imageDir, "metadata.json"), JSON.stringify(metadata, null, 2)),
  ]);

  return `/api/images/${id}`;
}

export function getImagePath(id: string): string {
  return join(IMAGES_DIR, id, "image.png");
}

export function getThumbPath(id: string): string {
  return join(IMAGES_DIR, id, "thumb.webp");
}

/**
 * Generate a thumbnail for an existing image that doesn't have one yet.
 * Returns true if a thumbnail was created, false if it already exists or failed.
 */
export async function ensureThumbnail(id: string): Promise<boolean> {
  const thumbPath = getThumbPath(id);
  try {
    await access(thumbPath);
    return false; // already exists
  } catch {
    // generate it
  }
  try {
    const imagePath = getImagePath(id);
    const imageBuffer = await readFile(imagePath);
    const thumbBuffer = await sharp(imageBuffer)
      .resize(THUMB_WIDTH, undefined, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await writeFile(thumbPath, thumbBuffer);
    return true;
  } catch {
    return false;
  }
}

export async function getImageMetadata(id: string): Promise<ImageMetadata | null> {
  try {
    const raw = await readFile(join(IMAGES_DIR, id, "metadata.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface StoredImage {
  id: string;
  url: string;
  params: ImageGenerationParams;
  resolvedSeed: number;
  createdAt: string;
}

export async function listImages(): Promise<StoredImage[]> {
  let entries: string[];
  try {
    entries = await readdir(IMAGES_DIR);
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (id): Promise<StoredImage | null> => {
      const metadata = await getImageMetadata(id);
      if (!metadata) return null;
      return {
        id,
        url: `/api/images/${id}`,
        params: metadata.params,
        resolvedSeed: metadata.resolvedSeed,
        createdAt: metadata.createdAt,
      };
    })
  );

  return results
    .filter((r): r is StoredImage => r !== null)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}
