import { Router } from "express";
import { buildClusters, ensureClustersFresh } from "../services/cluster-engine.js";
import { getAllCorpusEntries, cleanupOrphanedEntries } from "../services/image-corpus.js";

const router = Router();

// GET /api/corpus/clusters - Get all clusters
router.get("/clusters", async (req, res) => {
  try {
    const corpus = await getAllCorpusEntries();
    const clusterMap = await ensureClustersFresh(corpus);
    res.json(clusterMap);
  } catch (err) {
    console.error("[corpus] clusters error:", err);
    res.status(500).json({ error: "Failed to get clusters" });
  }
});

// GET /api/corpus/clusters/:id - Get single cluster with members
router.get("/clusters/:id", async (req, res) => {
  try {
    const corpus = await getAllCorpusEntries();
    const clusterMap = await ensureClustersFresh(corpus);
    const cluster = clusterMap.clusters.find(c => c.id === req.params.id);
    if (!cluster) {
      return res.status(404).json({ error: "Cluster not found" });
    }
    
    // Enrich with member details
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

// GET /api/corpus/visualization - Get force-graph HTML (public, no auth required for iframe)
router.get("/visualization", async (req, res) => {
  try {
    const { generateForceGraphHTML } = await import("../services/visualization.js");
    const corpus = await getAllCorpusEntries();
    const clusterMap = await ensureClustersFresh(corpus);
    
    const html = generateForceGraphHTML(clusterMap, corpus);
    
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
    const clusterMap = await ensureClustersFresh(corpus);
    
    res.json({
      total: corpus.length,
      enriched: corpus.filter(e => e.elements && Object.keys(e.elements).length > 0).length,
      clusters: clusterMap.clusters.length,
      lastRebuilt: clusterMap.lastRebuilt,
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
    const clusterMap = await ensureClustersFresh(corpus);
    
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
      clusters: clusterMap.clusters.length,
      lastRebuilt: clusterMap.lastRebuilt,
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

// POST /api/corpus/cleanup - Clean up orphaned corpus entries
router.post("/cleanup", async (_req, res) => {
  try {
    const report = await cleanupOrphanedEntries();
    res.json({
      success: true,
      ...report,
      message: `Cleaned up ${report.orphanedCount} orphaned entries (${report.generatedOrphans} generated, ${report.analyzedOrphans} analyzed)`,
    });
  } catch (err: any) {
    console.error("[corpus] cleanup error:", err);
    res.status(500).json({ error: "Failed to cleanup orphans", details: err.message });
  }
});

// GET /api/corpus/cleanup/dry-run - Preview orphaned entries without deleting
router.get("/cleanup/dry-run", async (_req, res) => {
  try {
    const { access } = await import("fs/promises");
    const { join } = await import("path");
    const { homedir } = await import("os");
    const { getAllCorpusEntries } = await import("../services/image-corpus.js");
    
    const BASE_DIR = join(homedir(), ".quje-agent");
    const IMAGES_DIR = join(BASE_DIR, "images");
    const VISION_DIR = join(BASE_DIR, "vision");
    
    const entries = await getAllCorpusEntries();
    const orphans: Array<{ id: string; type: string; reason: string; imagePath: string }> = [];
    
    for (const entry of entries) {
      let fileExists = false;
      let checkPath = "";
      
      if (entry.type === "generated") {
        const jxlPath = join(IMAGES_DIR, entry.imagePath, "image.jxl");
        const pngPath = join(IMAGES_DIR, entry.imagePath, "image.png");
        checkPath = jxlPath;
        
        try {
          await access(jxlPath);
          fileExists = true;
        } catch {
          try {
            await access(pngPath);
            fileExists = true;
            checkPath = pngPath;
          } catch {}
        }
      } else if (entry.type === "analyzed") {
        const visionId = entry.visionId || entry.imagePath.split("/")[2];
        checkPath = join(VISION_DIR, "images", visionId, "metadata.json");
        
        try {
          await access(checkPath);
          fileExists = true;
        } catch {}
      } else if (entry.type === "uploaded") {
        checkPath = join(BASE_DIR, entry.imagePath);
        try {
          await access(checkPath);
          fileExists = true;
        } catch {}
      }
      
      if (!fileExists) {
        orphans.push({ 
          id: entry.id, 
          type: entry.type, 
          reason: "File not found",
          imagePath: checkPath,
        });
      }
    }
    
    res.json({
      totalScanned: entries.length,
      orphanedCount: orphans.length,
      wouldDelete: orphans.map(o => o.id),
      details: orphans,
    });
  } catch (err: any) {
    console.error("[corpus] dry-run error:", err);
    res.status(500).json({ error: "Failed to scan for orphans", details: err.message });
  }
});

export default router;
