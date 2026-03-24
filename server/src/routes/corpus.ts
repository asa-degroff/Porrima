import { Router } from "express";
import {
  getClusters,
  getClusterById,
} from "../services/cluster-storage.js";
import { buildClusters } from "../services/cluster-engine.js";
import { getAllCorpusEntries } from "../services/image-corpus.js";
import {
  proposeDirections,
  type CreativeDirection,
} from "../services/creative-engine.js";
import {
  isCacheValid,
  getCachedDirections,
  cacheDirections,
  getCacheMetadata,
  clearCache,
} from "../services/direction-cache.js";
import {
  createDirectionJob,
  getJob,
  getAllJobs,
  processNextJob,
} from "../services/job-queue.js";

const router = Router();

// GET /api/corpus/clusters - Get all clusters
router.get("/clusters", async (req, res) => {
  try {
    const clusterMap = await getClusters();
    res.json(clusterMap || { clusters: [], similarityThreshold: 0.85, lastRebuilt: 0 });
  } catch (err) {
    console.error("[corpus] clusters error:", err);
    res.status(500).json({ error: "Failed to get clusters" });
  }
});

// GET /api/corpus/clusters/:id - Get single cluster with members
router.get("/clusters/:id", async (req, res) => {
  try {
    const cluster = await getClusterById(req.params.id);
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    // Enrich with member details
    const corpus = await getAllCorpusEntries();
    const members = corpus.filter(e => cluster.memberIds.includes(e.id));
    
    res.json({ ...cluster, members });
  } catch (err) {
    console.error("[corpus] cluster detail error:", err);
    res.status(500).json({ error: "Failed to get cluster details" });
  }
});

// POST /api/corpus/rebuild-clusters - Trigger cluster rebuild
router.post("/rebuild-clusters", async (req, res) => {
  try {
    const corpus = await getAllCorpusEntries();
    const clusterMap = await buildClusters(corpus);
    
    // Clear direction cache after rebuild
    await clearCache();
    
    res.json({
      clusters: clusterMap.clusters.length,
      lastRebuilt: clusterMap.lastRebuilt,
      stats: {
        avgSize: clusterMap.clusters.reduce((sum, c) => sum + c.memberIds.length, 0) / Math.max(clusterMap.clusters.length, 1),
        maxSize: Math.max(...clusterMap.clusters.map(c => c.memberIds.length)),
        minSize: Math.min(...clusterMap.clusters.map(c => c.memberIds.length)),
      },
    });
  } catch (err) {
    console.error("[corpus] rebuild error:", err);
    res.status(500).json({ error: "Failed to rebuild clusters" });
  }
});

// GET /api/corpus/visualization - Get force-graph HTML (public, no auth required for iframe)
router.get("/visualization", async (req, res) => {
  try {
    const { generateForceGraphHTML } = await import("../services/visualization.js");
    const clusterMap = await getClusters();
    const corpus = await getAllCorpusEntries();
    
    const html = generateForceGraphHTML(clusterMap || { clusters: [], similarityThreshold: 0.85, lastRebuilt: 0, corpusSize: 0 }, corpus);
    
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (err) {
    console.error("[corpus] visualization error:", err);
    res.status(500).json({ error: "Failed to generate visualization" });
  }
});

// GET /api/corpus/stats-public - Corpus statistics (public, no auth required)
router.get("/stats-public", async (req, res) => {
  try {
    const corpus = await getAllCorpusEntries();
    const clusterMap = await getClusters();
    
    res.json({
      total: corpus.length,
      enriched: corpus.filter(e => e.elements && Object.keys(e.elements).length > 0).length,
      clusters: clusterMap?.clusters.length || 0,
      lastRebuilt: clusterMap?.lastRebuilt || 0,
    });
  } catch (err) {
    console.error("[corpus] stats error:", err);
    res.status(500).json({ error: "Failed to get corpus stats" });
  }
});

// GET /api/corpus/stats - Corpus statistics
router.get("/stats", async (req, res) => {
  try {
    const corpus = await getAllCorpusEntries();
    const clusterMap = await getClusters();
    
    const enriched = corpus.filter(e => e.elements && Object.keys(e.elements).length > 0);
    const withEmbeddings = corpus.filter(e => e.promptEmbedding && e.promptEmbedding.length > 0);
    
    // Theme distribution
    const themeCounts: Record<string, number> = {};
    for (const entry of enriched) {
      for (const theme of entry.elements?.themes || []) {
        themeCounts[theme] = (themeCounts[theme] || 0) + 1;
      }
    }
    
    // Mood distribution
    const moodCounts: Record<string, number> = {};
    for (const entry of enriched) {
      for (const mood of entry.elements?.mood || []) {
        moodCounts[mood] = (moodCounts[mood] || 0) + 1;
      }
    }
    
    res.json({
      total: corpus.length,
      enriched: enriched.length,
      withEmbeddings: withEmbeddings.length,
      clusters: clusterMap?.clusters.length || 0,
      lastRebuilt: clusterMap?.lastRebuilt || 0,
      topThemes: Object.entries(themeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([theme, count]) => ({ theme, count })),
      topMoods: Object.entries(moodCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([mood, count]) => ({ mood, count })),
    });
  } catch (err) {
    console.error("[corpus] stats error:", err);
    res.status(500).json({ error: "Failed to get corpus stats" });
  }
});

// GET /api/corpus/directions - Get creative direction suggestions (with caching)
router.get("/directions", async (req, res) => {
  try {
    const clusterMap = await getClusters();
    const corpus = await getAllCorpusEntries();
    
    if (!clusterMap || clusterMap.clusters.length === 0) {
      return res.json({ directions: [], message: "No clusters available" });
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 5;
    const minNovelty = req.query.minNovelty ? parseFloat(req.query.minNovelty as string) : 0.3;
    const useCache = req.query.cached !== 'false'; // Default to using cache
    const forceRefresh = req.query.refresh === 'true';
    
    // Check cache first
    if (useCache && !forceRefresh) {
      if (await isCacheValid(corpus.length, clusterMap.clusters.length)) {
        const cached = await getCachedDirections();
        if (cached) {
          console.log(`[corpus] Returning cached directions (${cached.directions.length})`);
          return res.json({
            directions: cached.directions,
            cached: true,
            cacheAge: Date.now() - cached.generatedAt,
            generated: cached.directions.length,
          });
        }
      }
    }
    
    // Check if there's a completed job with results
    const recentJobs = getAllJobs().filter(j =>
      j.status === 'complete' || 
      j.status === 'running' || 
      (j.status === 'pending' && Date.now() - j.createdAt < 60000)
    );
    
    // Return completed job results immediately
    const completedJob = recentJobs.find(j => j.status === 'complete' && j.result?.directions?.length);
    if (completedJob && (useCache || forceRefresh)) {
      console.log(`[corpus] Returning directions from completed job ${completedJob.id}`);
      return res.json({
        directions: completedJob.result!.directions,
        cached: false,
        fromJob: true,
        jobId: completedJob.id,
        generated: completedJob.result!.directions.length,
      });
    }
    
    // If job is running, report status
    const runningJob = recentJobs.find(j => j.status === 'running' || j.status === 'pending');
    if (runningJob && useCache && !forceRefresh) {
      return res.json({
        directions: [],
        jobRunning: true,
        jobId: runningJob.id,
        jobStatus: runningJob.status,
        message: "Direction generation in progress",
      });
    }
    
    // Queue background generation instead of blocking the request
    const jobId = createDirectionJob(
      clusterMap.clusters,
      corpus,
      limit,
      minNovelty,
      "qwen3.5:9b"
    );

    processNextJob().catch((err: unknown) => console.error("[corpus] Job processing failed:", err));

    res.json({
      directions: [],
      jobRunning: true,
      jobId,
      jobStatus: "pending",
      message: "Direction generation started",
    });
  } catch (err) {
    console.error("[corpus] directions error:", err);
    res.status(500).json({ error: "Failed to generate directions" });
  }
});

// POST /api/corpus/directions/generate - Queue direction generation as background job
router.post("/directions/generate", async (req, res) => {
  try {
    const clusterMap = await getClusters();
    const corpus = await getAllCorpusEntries();
    
    if (!clusterMap) {
      return res.status(400).json({ error: "No clusters available" });
    }
    
    const limit = req.body.limit || 5;
    const minNovelty = req.body.minNovelty || 0.3;
    
    // Create background job
    const jobId = createDirectionJob(
      clusterMap.clusters,
      corpus,
      limit,
      minNovelty,
      "qwen3.5:4b"
    );
    
    // Start processing
    processNextJob().catch((err: unknown) => console.error("[corpus] Job processing failed:", err));
    
    res.json({
      jobId,
      status: 'pending',
      message: "Direction generation queued",
    });
  } catch (err) {
    console.error("[corpus] job creation error:", err);
    res.status(500).json({ error: "Failed to create direction job" });
  }
});

// GET /api/corpus/directions/job/:id - Get job status
router.get("/directions/job/:id", async (req, res) => {
  try {
    const job = getJob(req.params.id);
    
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    
    res.json(job);
  } catch (err) {
    console.error("[corpus] job status error:", err);
    res.status(500).json({ error: "Failed to get job status" });
  }
});

// GET /api/corpus/gaps - Analyze underrepresented themes
router.get("/gaps", async (req, res) => {
  try {
    const clusterMap = await getClusters();
    const corpus = await getAllCorpusEntries();
    
    if (!clusterMap) {
      return res.json({ gaps: [], message: "No clusters available" });
    }

    const { analyzeGaps } = await import("../services/creative-engine.js");
    const gaps = analyzeGaps(clusterMap.clusters, corpus);
    res.json({ gaps });
  } catch (err) {
    console.error("[corpus] gaps error:", err);
    res.status(500).json({ error: "Failed to analyze gaps" });
  }
});

// POST /api/corpus/remix - Generate remix from specific clusters
router.post("/remix", async (req, res) => {
  try {
    const { sourceClusters, directionType }: { sourceClusters: string[]; directionType?: string } = req.body;
    const clusterMap = await getClusters();
    const corpus = await getAllCorpusEntries();
    
    if (!clusterMap) {
      return res.status(400).json({ error: "No clusters available" });
    }

    const selectedClusters = clusterMap.clusters.filter(c => sourceClusters.includes(c.id));
    if (selectedClusters.length >= 2 || directionType !== "remix") {
      // Generate a single direction based on the request
      const { proposeDirections } = await import("../services/creative-engine.js");
      const directions = await proposeDirections(selectedClusters.length ? selectedClusters : clusterMap.clusters, corpus, { limit: 1, minNovelty: 0.3 });
      
      if (directions.length === 0) {
        return res.status(400).json({ error: "Could not generate novel direction" });
      }

      res.json({ direction: directions[0] });
    } else {
      return res.status(400).json({ error: "Need at least 2 clusters for remix" });
    }
  } catch (err) {
    console.error("[corpus] remix error:", err);
    res.status(500).json({ error: "Failed to generate remix" });
  }
});

// GET /api/corpus/cache - Get cache metadata (debugging)
router.get("/cache", async (_req, res) => {
  try {
    const metadata = getCacheMetadata();
    res.json(metadata);
  } catch (err) {
    console.error("[corpus] cache metadata error:", err);
    res.status(500).json({ error: "Failed to get cache metadata" });
  }
});

// POST /api/corpus/cache/clear - Clear direction cache
router.post("/cache/clear", async (_req, res) => {
  try {
    await clearCache();
    res.json({ message: "Cache cleared" });
  } catch (err) {
    console.error("[corpus] cache clear error:", err);
    res.status(500).json({ error: "Failed to clear cache" });
  }
});

// POST /api/corpus/execute - Execute a creative direction (generate image)
// Returns immediately with generationId; client subscribes to SSE for progress.
router.post("/execute", async (req, res) => {
  try {
    const { directionId, chatId }: { directionId: string; chatId: string } = req.body;

    if (!directionId || !chatId) {
      return res.status(400).json({ error: "directionId and chatId required" });
    }

    // Get the direction from cache
    const { getCachedDirections } = await import("../services/direction-cache.js");
    const cached = await getCachedDirections();

    let direction;
    if (cached) {
      direction = cached.directions.find((d: any) => d.id === directionId);
    }

    if (!direction) {
      return res.status(404).json({ error: "Direction not found" });
    }

    // Create generation state immediately so client can subscribe to progress.
    // executeDirection will detect the existing state and use it.
    const { createGeneration } = await import("../services/image-generation.js");
    const genState = createGeneration({
      positivePrompt: direction.proposedPrompt,
      model: "z-image-BF16.gguf",
      steps: 35,
      cfgScale: 4.0,
      width: 1024,
      height: 1365,
    }, chatId);

    // Return immediately with the generationId so client can subscribe to SSE progress
    res.json({
      success: true,
      generationId: genState.id,
      directionId,
      generatedBy: 'agent',
    });

    // Execute generation in the background
    const { executeDirection, DEFAULT_AUTONOMOUS_CONFIG } = await import("../services/autonomous-generation.js");
    executeDirection(direction, chatId, DEFAULT_AUTONOMOUS_CONFIG, genState.id).catch((err: any) => {
      console.error("[corpus] background execute error:", err);
    });
  } catch (err: any) {
    console.error("[corpus] execute error:", err);
    res.status(500).json({ error: "Failed to execute direction", details: err.message });
  }
});

export default router;
