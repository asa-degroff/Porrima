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

export const SIMILARITY_THRESHOLD = 0.97;
export const CLUSTER_ALGORITHM_VERSION = 2;

export interface ClusterEngineOptions {
  threshold?: number;
  minClusterSize?: number;
}

/**
 * Build clusters from corpus using exemplar clustering with cosine similarity.
 * 
 * Algorithm:
 * 1. Compute pairwise similarity matrix (O(n²), acceptable for local corpora)
 * 2. Group images around the densest remaining exemplar above threshold
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
      algorithmVersion: CLUSTER_ALGORITHM_VERSION,
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
  
  // 2. Exemplar clustering
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
    algorithmVersion: CLUSTER_ALGORITHM_VERSION,
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
  corpus: ImageCorpusEntry[],
  expectedThreshold = SIMILARITY_THRESHOLD,
  expectedAlgorithmVersion = CLUSTER_ALGORITHM_VERSION
): boolean {
  if (!clusterMap) return true;
  if (Math.abs(clusterMap.similarityThreshold - expectedThreshold) > 0.000001) return true;
  if (clusterMap.algorithmVersion !== expectedAlgorithmVersion) return true;

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
  const threshold = options.threshold ?? SIMILARITY_THRESHOLD;
  if (!clusterMap || clusterMapNeedsRebuild(clusterMap, corpus, threshold)) {
    console.log("[cluster-engine] cluster map is stale; rebuilding");
    return buildClusters(corpus, options);
  }
  return clusterMap;
}

/**
 * Compute pairwise cosine similarity matrix.
 * O(n²) complexity but acceptable for the local corpus sizes this feature targets.
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
 * Exemplar clustering: repeatedly choose the unassigned image with the most
 * unassigned neighbors above the threshold, then assign that local neighborhood.
 *
 * This keeps the algorithm deterministic while avoiding the old creation-order
 * behavior where a broad recent prompt could absorb most of the corpus.
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
  
  while (assigned.size < n) {
    let bestSeed = -1;
    let bestNeighbors: number[] = [];

    for (let i = 0; i < n; i++) {
      if (assigned.has(i)) continue;

      const neighbors: number[] = [];
      for (let j = 0; j < n; j++) {
        if (!assigned.has(j) && similarityMatrix[i][j] >= threshold) {
          neighbors.push(j);
        }
      }

      if (neighbors.length > bestNeighbors.length) {
        bestSeed = i;
        bestNeighbors = neighbors;
      }
    }

    if (bestSeed === -1) break;

    if (bestNeighbors.length >= minSize) {
      const clusterIds = bestNeighbors.map(idx => corpus[idx].id);
      clusters.push(clusterIds);

      for (const idx of bestNeighbors) {
        assigned.add(idx);
      }
    } else {
      assigned.add(bestSeed);
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
