import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ImageGenerationParams } from "../types.js";

const IMAGES_DIR = join(homedir(), ".quje-agent", "images");

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

  await Promise.all([
    writeFile(join(imageDir, "image.png"), imageBuffer),
    writeFile(join(imageDir, "metadata.json"), JSON.stringify(metadata, null, 2)),
  ]);

  return `/api/images/${id}`;
}

export function getImagePath(id: string): string {
  return join(IMAGES_DIR, id, "image.png");
}

export async function getImageMetadata(id: string): Promise<ImageMetadata | null> {
  try {
    const raw = await readFile(join(IMAGES_DIR, id, "metadata.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
