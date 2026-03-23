import { homedir } from "os";
import { join } from "path";
import { mkdir, writeFile, readFile, access } from "fs/promises";
import { existsSync } from "fs";
import type { ImageCorpusEntry } from "./image-corpus.js";

const CLUSTERS_DIR = join(homedir(), ".quje-agent", "clusters");
const CLUSTERS_FILE = join(CLUSTERS_DIR, "clusters.json");

export interface PromptCluster {
  id: string;
  name: string;
  centroid: number[];
  memberIds: string[];
  dominantElements: {
    themes: string[];
    settings: string[];
    characters: string[];
    concepts: string[];
    styles: string[];
  };
  variance: number;
  size: number;
  createdAt: number;
  lastUsed: number;
}

export interface ClusterMap {
  clusters: PromptCluster[];
  similarityThreshold: number;
  lastRebuilt: number;
  corpusSize: number;
}

// In-memory cache
let clusterCache: ClusterMap | null = null;

async function ensureClustersDir() {
  if (!existsSync(CLUSTERS_DIR)) {
    await mkdir(CLUSTERS_DIR, { recursive: true });
  }
}

async function loadClustersFromDisk(): Promise<ClusterMap | null> {
  try {
    await ensureClustersDir();
    if (existsSync(CLUSTERS_FILE)) {
      const data = await readFile(CLUSTERS_FILE, "utf-8");
      return JSON.parse(data) as ClusterMap;
    }
  } catch (err) {
    console.error("[cluster-storage] load error:", err);
  }
  return null;
}

async function persistClusters(map: ClusterMap): Promise<void> {
  try {
    await ensureClustersDir();
    await writeFile(CLUSTERS_FILE, JSON.stringify(map, null, 2));
    console.log(`[cluster-storage] persisted ${map.clusters.length} clusters`);
  } catch (err) {
    console.error("[cluster-storage] persist error:", err);
  }
}

export async function getClusters(): Promise<ClusterMap | null> {
  if (clusterCache === null) {
    clusterCache = await loadClustersFromDisk();
  }
  return clusterCache;
}

export async function setClusters(map: ClusterMap): Promise<void> {
  clusterCache = map;
  await persistClusters(map);
}

export async function clearClusters(): Promise<void> {
  clusterCache = null;
  try {
    await ensureClustersDir();
    if (existsSync(CLUSTERS_FILE)) {
      await writeFile(CLUSTERS_FILE, JSON.stringify({
        clusters: [],
        similarityThreshold: 0.85,
        lastRebuilt: Date.now(),
        corpusSize: 0,
      } as ClusterMap, null, 2));
    }
  } catch (err) {
    console.error("[cluster-storage] clear error:", err);
  }
}

export async function getClusterById(id: string): Promise<PromptCluster | null> {
  const map = await getClusters();
  if (!map) return null;
  return map.clusters.find(c => c.id === id) || null;
}

export async function getClusterByImageId(imageId: string): Promise<PromptCluster | null> {
  const map = await getClusters();
  if (!map) return null;
  return map.clusters.find(c => c.memberIds.includes(imageId)) || null;
}

export function computeCentroid(members: ImageCorpusEntry[]): number[] {
  if (members.length === 0) return [];
  
  const validMembers = members.filter(m => m.promptEmbedding && m.promptEmbedding.length > 0);
  if (validMembers.length === 0) return [];
  
  const dim = validMembers[0].promptEmbedding!.length;
  const centroid = new Array(dim).fill(0);
  
  for (const member of validMembers) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += member.promptEmbedding![i];
    }
  }
  
  // Average
  for (let i = 0; i < dim; i++) {
    centroid[i] /= validMembers.length;
  }
  
  return centroid;
}

export function extractDominantElements(members: ImageCorpusEntry[]): PromptCluster["dominantElements"] {
  const counters: Record<string, Record<string, number>> = {
    themes: {},
    settings: {},
    characters: {},
    concepts: {},
    styles: {},
  };
  
  for (const member of members) {
    const elements = member.elements || {};
    for (const [category, items] of Object.entries(elements)) {
      if (counters[category] && Array.isArray(items)) {
        for (const item of items) {
          const key = item.toLowerCase();
          counters[category][key] = (counters[category][key] || 0) + 1;
        }
      }
    }
  }
  
  // Get top 5 from each category
  const result = {
    themes: getTopItems(counters.themes, 5),
    settings: getTopItems(counters.settings, 5),
    characters: getTopItems(counters.characters, 5),
    concepts: getTopItems(counters.concepts, 5),
    styles: getTopItems(counters.styles, 5),
  };
  
  return result;
}

function getTopItems(counter: Record<string, number>, limit: number): string[] {
  return Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([item]) => item);
}

export function computeVariance(members: ImageCorpusEntry[]): number {
  if (members.length < 2) return 0;
  
  const validMembers = members.filter(m => m.promptEmbedding && m.promptEmbedding.length > 0);
  if (validMembers.length < 2) return 0;
  
  const centroid = computeCentroid(validMembers);
  let variance = 0;
  
  for (const member of validMembers) {
    const dist = cosineDistance(member.promptEmbedding!, centroid);
    variance += dist;
  }
  
  return variance / validMembers.length;
}

export function generateClusterName(members: ImageCorpusEntry[]): string {
  const dominant = extractDominantElements(members);
  
  // Use top theme + top setting as name
  const theme = dominant.themes[0] || "unknown";
  const setting = dominant.settings[0] || "scene";
  
  // Capitalize
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  
  return `${capitalize(theme)} ${capitalize(setting)}`;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  
  let dot = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}
