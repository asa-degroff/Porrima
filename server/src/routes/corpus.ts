import { Router } from "express";
import {
  getClusters,
  getClusterById,
} from "../services/cluster-storage.js";
import { buildClusters } from "../services/cluster-engine.js";
import { getAllCorpusEntries } from "../services/image-corpus.js";

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

export default router;
