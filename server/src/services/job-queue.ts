import type { CreativeDirection } from "./creative-engine.js";
import type { PromptCluster } from "./cluster-storage.js";
import type { ImageCorpusEntry } from "./image-corpus.js";
import { proposeDirections } from "./creative-engine.js";
import { cacheDirections } from "./direction-cache.js";

export type JobStatus = 'pending' | 'running' | 'complete' | 'failed';

export interface DirectionJob {
  id: string;
  type: 'direction-generation';
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  params: {
    limit: number;
    minNovelty: number;
    corpusSize: number;
    clusterCount: number;
    modelId: string;
  };
  result?: {
    directions: CreativeDirection[];
    cacheId: string;
  };
  error?: string;
}

// In-memory job queue
const jobs: Map<string, DirectionJob> = new Map();
const pendingJobs: DirectionJob[] = [];

/**
 * Create a new direction generation job.
 * Returns job ID immediately; client can poll for completion.
 */
export function createDirectionJob(
  clusters: PromptCluster[],
  corpus: ImageCorpusEntry[],
  limit: number,
  minNovelty: number,
  modelId: string
): string {
  const jobId = `job-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  
  const job: DirectionJob = {
    id: jobId,
    type: 'direction-generation',
    status: 'pending',
    createdAt: Date.now(),
    params: {
      limit,
      minNovelty,
      corpusSize: corpus.length,
      clusterCount: clusters.length,
      modelId,
    },
  };
  
  jobs.set(jobId, job);
  pendingJobs.push(job);
  
  console.log(`[job-queue] Created direction job: ${jobId}`);
  return jobId;
}

/**
 * Process the next pending job.
 * Called by the scheduler or manually.
 */
export async function processNextJob(): Promise<DirectionJob | null> {
  if (pendingJobs.length === 0) return null;
  
  const job = pendingJobs.shift()!;
  job.status = 'running';
  job.startedAt = Date.now();
  
  console.log(`[job-queue] Processing job: ${job.id}`);
  
  try {
    // Get current clusters and corpus (may have changed since job creation)
    const { getClusters } = await import("./cluster-storage.js");
    const { getAllCorpusEntries } = await import("./image-corpus.js");
    
    const clusterMap = await getClusters();
    const corpus = await getAllCorpusEntries();
    
    if (!clusterMap) {
      throw new Error("No clusters available");
    }
    
    // Generate directions (bypass internal cache — this is a fresh generation)
    const directions = await proposeDirections(
      clusterMap.clusters,
      corpus,
      { limit: job.params.limit, minNovelty: job.params.minNovelty, useCache: false, modelId: job.params.modelId }
    );

    // Unload Ollama model after LLM work to free VRAM for any subsequent ComfyUI work
    try {
      await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: job.params.modelId, prompt: "", keep_alive: "0s" }),
      });
    } catch {}

    // Cache the results (only if non-empty)
    let cacheId = "";
    if (directions.length > 0) {
      cacheId = await cacheDirections(
        directions,
        corpus.length,
        clusterMap.clusters.length,
        job.params.modelId
      );
    }
    
    job.status = 'complete';
    job.completedAt = Date.now();
    job.result = {
      directions,
      cacheId,
    };
    
    console.log(`[job-queue] Job ${job.id} complete: ${directions.length} directions`);
    
    // Update in map
    jobs.set(job.id, job);
    
    return job;
  } catch (err: any) {
    job.status = 'failed';
    job.completedAt = Date.now();
    job.error = err.message || "Unknown error";
    
    console.error(`[job-queue] Job ${job.id} failed:`, err);
    
    jobs.set(job.id, job);
    return job;
  }
}

/**
 * Get job status by ID.
 */
export function getJob(jobId: string): DirectionJob | undefined {
  return jobs.get(jobId);
}

/**
 * Get all jobs (for debugging/admin).
 */
export function getAllJobs(): DirectionJob[] {
  return Array.from(jobs.values());
}

/**
 * Clean up old jobs (older than 7 days).
 */
export function cleanupOldJobs(): void {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  
  let cleaned = 0;
  for (const [id, job] of jobs.entries()) {
    if (job.completedAt && job.completedAt < sevenDaysAgo) {
      jobs.delete(id);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`[job-queue] Cleaned up ${cleaned} old jobs`);
  }
}

/**
 * Trigger background processing of pending jobs.
 * Call this from scheduler or on startup.
 */
export async function processPendingJobs(): Promise<void> {
  if (pendingJobs.length === 0) return;
  
  console.log(`[job-queue] Processing ${pendingJobs.length} pending job(s)`);
  
  while (pendingJobs.length > 0) {
    await processNextJob();
    // Small delay between jobs to avoid overwhelming LLM
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
