/**
 * Image cache using the Cache API.
 * Stores image responses in a versioned cache for fast subsequent loads.
 */

import { useState, useEffect } from "react";

const CACHE_VERSION = "v1";
const CACHE_NAME = `quje-images-${CACHE_VERSION}`;

/**
 * Get an image from cache, falling back to network.
 * Returns a Blob URL that can be used as an image src.
 */
export async function getCachedImage(imageId: string, imageUrl: string): Promise<string> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(imageUrl);

    if (cachedResponse) {
      // Serve from cache
      const blob = await cachedResponse.blob();
      return URL.createObjectURL(blob);
    }

    // Fetch from network
    const response = await fetch(imageUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

    // Clone the response so we can cache it and return it
    const responseToCache = response.clone();
    await cache.put(imageUrl, responseToCache);

    const blob = await response.blob();
    return URL.createObjectURL(blob);
  } catch (error) {
    console.warn("[image-cache] error:", error);
    // Return the original URL as fallback
    return imageUrl;
  }
}

/**
 * Pre-cache multiple images in the background.
 * Does not return blob URLs - just ensures they're in cache.
 */
export async function precacheImages(imageUrls: string[]): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);

    await Promise.all(
      imageUrls.map(async (url) => {
        // Check if already cached
        const cached = await cache.match(url);
        if (cached) return;

        try {
          const response = await fetch(url, { credentials: "include" });
          if (response.ok) {
            await cache.put(url, response.clone());
          }
        } catch {
          // Ignore individual fetch errors
        }
      })
    );
  } catch (error) {
    console.warn("[image-cache] precache error:", error);
  }
}

/**
 * Clear the image cache.
 */
export async function clearImageCache(): Promise<void> {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("quje-images-"))
        .map((key) => caches.delete(key))
    );
  } catch (error) {
    console.warn("[image-cache] clear error:", error);
  }
}

/**
 * Clean up old cache versions, keeping only the current one.
 */
export async function cleanupOldCaches(): Promise<void> {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("quje-images-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
  } catch (error) {
    console.warn("[image-cache] cleanup error:", error);
  }
}

/**
 * Create a React hook for cached images.
 * Returns a cached blob URL or the original URL.
 */
export function useCachedImage(imageId: string, imageUrl: string): string {
  const [cachedUrl, setCachedUrl] = useState<string>(imageUrl);

  useEffect(() => {
    let blobUrl: string | null = null;

    getCachedImage(imageId, imageUrl).then((url) => {
      setCachedUrl(url);
    });

    return () => {
      // Clean up blob URL
      if (blobUrl && blobUrl !== imageUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [imageId, imageUrl]);

  return cachedUrl;
}
