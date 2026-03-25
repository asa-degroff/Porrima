/**
 * Image cache using the Cache API.
 * Stores image responses in a versioned cache for fast subsequent loads.
 */

import { useState, useEffect } from "react";

const CACHE_VERSION = "v1";
const CACHE_NAME = `quje-images-${CACHE_VERSION}`;

// Track in-flight requests to avoid duplicates
const inFlightRequests = new Map<string, Promise<Response>>();

/**
 * Get an image from cache, falling back to network.
 * Returns a Blob URL that can be used as an image src.
 * 
 * @param imageId - Unique identifier for the image
 * @param imageUrl - Full URL to fetch
 * @param priority - If true, this request takes precedence over others
 */
export async function getCachedImage(imageId: string, imageUrl: string, priority = false): Promise<string> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(imageUrl);

    if (cachedResponse) {
      // Serve from cache
      const blob = await cachedResponse.blob();
      return URL.createObjectURL(blob);
    }

    // Check if there's already an in-flight request for this URL
    let response: Response;
    if (inFlightRequests.has(imageUrl)) {
      // Wait for the existing request
      response = await inFlightRequests.get(imageUrl)!;
    } else {
      // Start a new fetch request
      const fetchPromise = fetch(imageUrl, { 
        credentials: "include",
        priority: priority ? 'high' : 'auto' as RequestPriority,
      });
      inFlightRequests.set(imageUrl, fetchPromise);
      
      try {
        response = await fetchPromise;
      } finally {
        // Clean up the in-flight tracking
        inFlightRequests.delete(imageUrl);
      }
    }

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
 * Pre-cache multiple images in the background with low priority.
 * Does not return blob URLs - just ensures they're in cache.
 */
export async function precacheImages(imageUrls: string[]): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);

    // Process in batches to avoid overwhelming the network
    const BATCH_SIZE = 5;
    for (let i = 0; i < imageUrls.length; i += BATCH_SIZE) {
      const batch = imageUrls.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(async (url) => {
          // Check if already cached
          const cached = await cache.match(url);
          if (cached) return;

          try {
            // Use low priority for background pre-caching
            const response = await fetch(url, { 
              credentials: "include",
              priority: 'low' as RequestPriority,
            });
            if (response.ok) {
              await cache.put(url, response.clone());
            }
          } catch {
            // Ignore individual fetch errors
          }
        })
      );
      
      // Small delay between batches to yield to higher-priority requests
      if (i + BATCH_SIZE < imageUrls.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
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
