import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import type { CreativeDirection } from "./creative-engine.js";

const CACHE_DIR = join(homedir(), ".quje-agent", "directions");
const CACHE_FILE = join(CACHE_DIR, "cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CachedDirections {
  directions: CreativeDirection[];
  generatedAt: number;
  corpusSize: number;
  clusterCount: number;
  modelId: string;
}

// In-memory cache (fast access)
let cache: CachedDirections | null = null;
let cacheGenerationId: string | null = null;

/**
 * Ensure cache directory exists.
 */
async function ensureCacheDir(): Promise<void> {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

/**
 * Load cache from disk.
 */
async function loadCacheFromDisk(): Promise<CachedDirections | null> {
  try {
    await ensureCacheDir();
    if (existsSync(CACHE_FILE)) {
      const data = await readFile(CACHE_FILE, "utf-8");
      return JSON.parse(data) as CachedDirections;
    }
  } catch (err) {
    console.error("[direction-cache] Load error:", err);
  }
  return null;
}

/**
 * Save cache to disk.
 */
async function saveCacheToDisk(data: CachedDirections): Promise<void> {
  try {
    await ensureCacheDir();
    await writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
    console.log("[direction-cache] Persisted to disk");
  } catch (err) {
    console.error("[direction-cache] Save error:", err);
  }
}

/**
 * Check if cached directions are still valid.
 * Invalidates if corpus has changed significantly.
 */
export async function isCacheValid(currentCorpusSize: number, currentClusterCount: number): Promise<boolean> {
  // Hydrate from disk if in-memory cache is empty
  if (!cache) {
    const diskCache = await loadCacheFromDisk();
    if (diskCache) {
      cache = diskCache;
      cacheGenerationId = `directions-${diskCache.generatedAt}`;
      console.log(`[direction-cache] Loaded ${diskCache.directions.length} directions from disk`);
    } else {
      return false;
    }
  }

  const age = Date.now() - cache.generatedAt;
  if (age > CACHE_TTL_MS) {
    console.log("[direction-cache] Cache expired (24h TTL)");
    return false;
  }

  // Invalidate if corpus changed by >10%
  const sizeDiff = Math.abs(currentCorpusSize - cache.corpusSize);
  const sizeThreshold = Math.max(10, currentCorpusSize * 0.1);
  if (sizeDiff > sizeThreshold) {
    console.log(`[direction-cache] Corpus size changed by ${sizeDiff} (threshold: ${sizeThreshold})`);
    return false;
  }

  // Invalidate if cluster count changed
  if (currentClusterCount !== cache.clusterCount) {
    console.log(`[direction-cache] Cluster count changed: ${cache.clusterCount} → ${currentClusterCount}`);
    return false;
  }

  return true;
}

/**
 * Get cached directions if valid.
 * Loads from disk if in-memory cache is empty.
 */
export async function getCachedDirections(): Promise<CachedDirections | null> {
  if (cache) return cache;
  
  // Try loading from disk
  const diskCache = await loadCacheFromDisk();
  if (diskCache) {
    cache = diskCache;
    cacheGenerationId = `directions-${diskCache.generatedAt}`;
    console.log(`[direction-cache] Loaded ${diskCache.directions.length} directions from disk`);
    return diskCache;
  }
  
  return null;
}

/**
 * Store directions in cache (memory + disk).
 */
export async function cacheDirections(
  directions: CreativeDirection[],
  corpusSize: number,
  clusterCount: number,
  modelId: string
): Promise<string> {
  const generationId = `directions-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  
  const cacheData: CachedDirections = {
    directions,
    generatedAt: Date.now(),
    corpusSize,
    clusterCount,
    modelId,
  };
  
  // Update in-memory cache
  cache = cacheData;
  cacheGenerationId = generationId;
  
  // Persist to disk
  await saveCacheToDisk(cacheData);
  
  console.log(`[direction-cache] Cached ${directions.length} directions (ID: ${generationId})`);
  return generationId;
}

/**
 * Clear the cache (memory + disk).
 */
export async function clearCache(): Promise<void> {
  console.log(`[direction-cache] Clearing cache (${cache?.directions.length ?? 0} directions)`);
  cache = null;
  cacheGenerationId = null;
  
  try {
    await ensureCacheDir();
    if (existsSync(CACHE_FILE)) {
      await writeFile(CACHE_FILE, JSON.stringify({
        directions: [],
        generatedAt: Date.now(),
        corpusSize: 0,
        clusterCount: 0,
        modelId: "",
      } as CachedDirections));
      console.log("[direction-cache] Cleared disk cache");
    }
  } catch (err) {
    console.error("[direction-cache] Clear error:", err);
  }
}

/**
 * Get cache metadata for debugging.
 */
export function getCacheMetadata(): {
  hasCache: boolean;
  age: number | null;
  corpusSize: number | null;
  clusterCount: number | null;
  directionCount: number | null;
  generationId: string | null;
  persistedToDisk: boolean;
} {
  if (!cache) {
    return {
      hasCache: false,
      age: null,
      corpusSize: null,
      clusterCount: null,
      directionCount: null,
      generationId: null,
      persistedToDisk: false,
    };
  }
  
  return {
    hasCache: true,
    age: Date.now() - cache.generatedAt,
    corpusSize: cache.corpusSize,
    clusterCount: cache.clusterCount,
    directionCount: cache.directions.length,
    generationId: cacheGenerationId,
    persistedToDisk: existsSync(CACHE_FILE),
  };
}
