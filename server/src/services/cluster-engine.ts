import crypto from "crypto";
import type { ImageCorpusEntry } from "./image-corpus.js";
import {
  PromptCluster,
  ClusterMap,
  computeCentroid,
  extractDominantElements,
  computeVariance,
  generateClusterName,
  cosineSimilarity,
  getClusters,
  setClusters,
} from "./cluster-storage.js";

const SIMILARITY_THRESHOLD = 0.85;

export interface ClusterEngineOptions {
  threshold?: number;
  minClusterSize?: number;
}

/**
 * Build clusters from corpus using density-based clustering with cosine similarity.
 * 
 * Algorithm:
 * 1. Compute pairwise similarity matrix (O(n²) but fast for 252 images)
 * 2. Group images where similarity > threshold (density-based)
 * 3. Compute cluster properties (centroid, dominant elements, variance)
 * 4. Persist and return cluster map
 */
export async function buildClusters(
  corpus: ImageCorpusEntry[],
  options: ClusterEngineOptions = {}
): Promise<ClusterMap> {
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  const minSize = options.minClusterSize ?? 1;
  
  console.log(`[cluster-engine] building clusters for ${corpus.length} images (threshold: ${threshold})`);
  
  // Filter to images with embeddings
  const validCorpus = corpus.filter(e => e.promptEmbedding && e.promptEmbedding.length > 0);
  console.log(`[cluster-engine] ${validCorpus.length} images with embeddings`);
  
  if (validCorpus.length === 0) {
    const emptyMap: ClusterMap = {
      clusters: [],
      similarityThreshold: threshold,
      lastRebuilt: Date.now(),
      corpusSize: 0,
    };
    await setClusters(emptyMap);
    return emptyMap;
  }
  
  // 1. Compute similarity matrix
  const startTime = Date.now();
  const similarityMatrix = computeSimilarityMatrix(validCorpus);
  const matrixTime = Date.now() - startTime;
  console.log(`[cluster-engine] similarity matrix computed in ${matrixTime}ms`);
  
  // 2. Density-based clustering
  const clusters = densityCluster(validCorpus, similarityMatrix, threshold, minSize);
  
  // 3. Build cluster objects with full metadata
  const clusterObjects: PromptCluster[] = clusters.map((memberIds) => {
    const members = validCorpus.filter(e => memberIds.includes(e.id));
    return {
      id: crypto.randomUUID(),
      name: generateClusterName(members),
      centroid: computeCentroid(members),
      memberIds: memberIds,
      dominantElements: extractDominantElements(members),
      variance: computeVariance(members),
      size: members.length,
      createdAt: Date.now(),
      lastUsed: 0,
    };
  });
  
  // 4. Handle unclustered images (singletons)
  const clusteredIds = new Set(clusterObjects.flatMap(c => c.memberIds));
  const unclustered = validCorpus.filter(e => !clusteredIds.has(e.id));
  
  if (unclustered.length > 0) {
    console.log(`[cluster-engine] ${unclustered.length} unclustered images (creating singletons)`);
    for (const image of unclustered) {
      clusterObjects.push({
        id: crypto.randomUUID(),
        name: generateClusterName([image]),
        centroid: image.promptEmbedding!,
        memberIds: [image.id],
        dominantElements: extractDominantElements([image]),
        variance: 0,
        size: 1,
        createdAt: Date.now(),
        lastUsed: 0,
      });
    }
  }
  
  // 5. Sort by size (largest first)
  clusterObjects.sort((a, b) => b.size - a.size);
  
  // 6. Build and persist cluster map
  const clusterMap: ClusterMap = {
    clusters: clusterObjects,
    similarityThreshold: threshold,
    lastRebuilt: Date.now(),
    corpusSize: validCorpus.length,
  };
  
  await setClusters(clusterMap);
  
  console.log(`[cluster-engine] built ${clusterObjects.length} clusters in ${Date.now() - startTime}ms`);
  console.log(`[cluster-engine] largest cluster: ${clusterObjects[0].size} members`);
  console.log(`[cluster-engine] smallest cluster: ${clusterObjects[clusterObjects.length - 1].size} members`);
  
  return clusterMap;
}

export function clusterMapNeedsRebuild(
  clusterMap: ClusterMap | null,
  corpus: ImageCorpusEntry[]
): boolean {
  if (!clusterMap) return true;

  const embeddedIds = new Set(
    corpus
      .filter(e => e.promptEmbedding && e.promptEmbedding.length > 0)
      .map(e => e.id)
  );
  const clusteredIds = new Set(clusterMap.clusters.flatMap(c => c.memberIds));

  if (clusterMap.corpusSize !== embeddedIds.size) return true;
  if (clusteredIds.size !== embeddedIds.size) return true;

  for (const id of embeddedIds) {
    if (!clusteredIds.has(id)) return true;
  }

  return false;
}

export async function ensureClustersFresh(
  corpus: ImageCorpusEntry[],
  options: ClusterEngineOptions = {}
): Promise<ClusterMap> {
  const clusterMap = await getClusters();
  if (!clusterMap || clusterMapNeedsRebuild(clusterMap, corpus)) {
    console.log("[cluster-engine] cluster map is stale; rebuilding");
    return buildClusters(corpus, options);
  }
  return clusterMap;
}

/**
 * Compute pairwise cosine similarity matrix.
 * O(n²) complexity but acceptable for n=252 (63,504 comparisons).
 */
export function computeSimilarityMatrix(corpus: ImageCorpusEntry[]): number[][] {
  const n = corpus.length;
  const matrix: number[][] = [];
  
  for (let i = 0; i < n; i++) {
    matrix[i] = new Array(n).fill(0);
  }
  
  for (let i = 0; i < n; i++) {
    matrix[i][i] = 1.0; // Self-similarity
    
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(
        corpus[i].promptEmbedding!,
        corpus[j].promptEmbedding!
      );
      matrix[i][j] = sim;
      matrix[j][i] = sim; // Symmetric
    }
  }
  
  return matrix;
}

/**
 * Density-based clustering: group images where similarity > threshold.
 * Uses a simple greedy approach:
 * 1. Start with unassigned images
 * 2. For each unassigned image, find all neighbors above threshold
 * 3. Create cluster from image + neighbors
 * 4. Repeat until all images assigned
 */
export function densityCluster(
  corpus: ImageCorpusEntry[],
  similarityMatrix: number[][],
  threshold: number,
  minSize: number = 1
): string[][] {
  const n = corpus.length;
  const assigned = new Set<number>();
  const clusters: string[][] = [];
  
  for (let i = 0; i < n; i++) {
    if (assigned.has(i)) continue;
    
    // Find neighbors above threshold
    const neighbors: number[] = [];
    for (let j = 0; j < n; j++) {
      if (!assigned.has(j) && similarityMatrix[i][j] >= threshold) {
        neighbors.push(j);
      }
    }
    
    if (neighbors.length >= minSize) {
      // Create cluster
      const clusterIds = neighbors.map(idx => corpus[idx].id);
      clusters.push(clusterIds);
      
      // Mark as assigned
      for (const idx of neighbors) {
        assigned.add(idx);
      }
    }
  }
  
  return clusters;
}

/**
 * Find the cluster containing a specific image.
 */
export function findClusterForImage(
  clusters: PromptCluster[],
  imageId: string
): PromptCluster | null {
  return clusters.find(c => c.memberIds.includes(imageId)) || null;
}

/**
 * Compute similarity between an embedding and a cluster centroid.
 */
export function similarityToCluster(
  embedding: number[],
  cluster: PromptCluster
): number {
  return cosineSimilarity(embedding, cluster.centroid);
}

/**
 * Check if a new image would join an existing cluster.
 */
export function wouldJoinCluster(
  newEmbedding: number[],
  cluster: PromptCluster,
  threshold: number = SIMILARITY_THRESHOLD
): boolean {
  // Check similarity to centroid
  const centroidSim = similarityToCluster(newEmbedding, cluster);
  
  // Also check similarity to all members
  // (in full implementation, would need corpus access)
  
  return centroidSim >= threshold;
}

/**
 * Get cluster statistics.
 */
export function getClusterStats(clusters: PromptCluster[]): {
  totalClusters: number;
  totalImages: number;
  avgSize: number;
  largestSize: number;
  singletonCount: number;
} {
  const totalImages = clusters.reduce((sum, c) => sum + c.size, 0);
  const singletonCount = clusters.filter(c => c.size === 1).length;
  
  return {
    totalClusters: clusters.length,
    totalImages,
    avgSize: totalImages / clusters.length,
    largestSize: Math.max(...clusters.map(c => c.size)),
    singletonCount,
  };
}
