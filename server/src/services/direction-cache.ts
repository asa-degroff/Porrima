import type { CreativeDirection } from "./creative-engine.js";
import type { PromptCluster } from "./cluster-storage.js";
import type { ImageCorpusEntry } from "./image-corpus.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 10;

interface CachedDirections {
  directions: CreativeDirection[];
  generatedAt: number;
  corpusSize: number;
  clusterCount: number;
  modelId: string;
}

// In-memory cache
let cache: CachedDirections | null = null;
let cacheGenerationId: string | null = null;

/**
 * Check if cached directions are still valid.
 * Invalidates if corpus has changed significantly.
 */
export function isCacheValid(currentCorpusSize: number, currentClusterCount: number): boolean {
  if (!cache) return false;
  
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
 */
export function getCachedDirections(): CachedDirections | null {
  return cache;
}

/**
 * Store directions in cache.
 */
export function cacheDirections(
  directions: CreativeDirection[],
  corpusSize: number,
  clusterCount: number,
  modelId: string
): string {
  const generationId = `directions-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  
  cache = {
    directions,
    generatedAt: Date.now(),
    corpusSize,
    clusterCount,
    modelId,
  };
  
  cacheGenerationId = generationId;
  
  console.log(`[direction-cache] Cached ${directions.length} directions (ID: ${generationId})`);
  return generationId;
}

/**
 * Clear the cache (e.g., after corpus rebuild).
 */
export function clearCache(): void {
  console.log(`[direction-cache] Clearing cache (${cache?.directions.length ?? 0} directions)`);
  cache = null;
  cacheGenerationId = null;
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
} {
  if (!cache) {
    return {
      hasCache: false,
      age: null,
      corpusSize: null,
      clusterCount: null,
      directionCount: null,
      generationId: null,
    };
  }
  
  return {
    hasCache: true,
    age: Date.now() - cache.generatedAt,
    corpusSize: cache.corpusSize,
    clusterCount: cache.clusterCount,
    directionCount: cache.directions.length,
    generationId: cacheGenerationId,
  };
}
