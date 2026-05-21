import { Router, Request, Response } from "express";
import { join } from "path";
import { readFile } from "fs/promises";
import { lookup } from "../utils/mime.js";
import { appDataPath } from "../services/paths.js";

const router = Router();
const ARTIFACTS_DIR = appDataPath("artifacts");
const VISUALS_DIR = appDataPath("visuals");

// Serve latest version of artifact (backward compat + convenience)
router.get("/:id", async (req, res) => {
  try {
    const metadataPath = join(ARTIFACTS_DIR, req.params.id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    const latestVersion = metadata.currentVersion;
    const filePath = join(ARTIFACTS_DIR, req.params.id, "versions", String(latestVersion), "index.html");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Artifact not found" });
  }
});

// Serve specific version
router.get("/:id/versions/:version", async (req, res) => {
  try {
    const filePath = join(ARTIFACTS_DIR, req.params.id, "versions", req.params.version, "index.html");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Version not found" });
  }
});

// Get artifact metadata (version history)
router.get("/:id/metadata", async (req, res) => {
  try {
    const metadataPath = join(ARTIFACTS_DIR, req.params.id, "metadata.json");
    const metadata = await readFile(metadataPath, "utf-8");
    res.json(JSON.parse(metadata));
  } catch {
    res.status(404).json({ error: "Artifact not found" });
  }
});

// List all versions for an artifact
router.get("/:id/versions", async (req, res) => {
  try {
    const metadataPath = join(ARTIFACTS_DIR, req.params.id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    res.json(metadata.versions);
  } catch {
    res.status(404).json({ error: "Artifact not found" });
  }
});

// Serve sub-files from a specific version (CSS, images, JS, etc.)
router.get("/:id/versions/:version/*subpath", async (req, res) => {
  try {
    const subPath = (req.params as any).subpath || "";
    const filePath = join(ARTIFACTS_DIR, req.params.id, "versions", req.params.version, subPath);

    // Prevent path traversal
    if (!filePath.startsWith(ARTIFACTS_DIR)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const content = await readFile(filePath);
    const mimeType = lookup(filePath);
    res.setHeader("Content-Type", mimeType);
    res.send(content);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// Legacy subpath route (for backward compat with old artifacts)
router.get("/:id/*subpath", async (req, res) => {
  try {
    const subPath = (req.params as any).subpath || "";
    const filePath = join(ARTIFACTS_DIR, req.params.id, subPath);

    // Prevent path traversal
    if (!filePath.startsWith(ARTIFACTS_DIR)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const content = await readFile(filePath);
    const mimeType = lookup(filePath);
    res.setHeader("Content-Type", mimeType);
    res.send(content);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// === Visuals routes (same structure as artifacts) ===

// Serve latest version of visual
router.get("/visuals/:id", async (req, res) => {
  try {
    const metadataPath = join(VISUALS_DIR, req.params.id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    const latestVersion = metadata.currentVersion;
    const filePath = join(VISUALS_DIR, req.params.id, "versions", String(latestVersion), "index.html");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

// Serve specific visual version
router.get("/visuals/:id/versions/:version", async (req, res) => {
  try {
    const filePath = join(VISUALS_DIR, req.params.id, "versions", req.params.version, "index.html");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Version not found" });
  }
});

// Get visual metadata
router.get("/visuals/:id/metadata", async (req, res) => {
  try {
    const metadataPath = join(VISUALS_DIR, req.params.id, "metadata.json");
    const metadata = await readFile(metadataPath, "utf-8");
    res.json(JSON.parse(metadata));
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

// List all versions for a visual
router.get("/visuals/:id/versions", async (req, res) => {
  try {
    const metadataPath = join(VISUALS_DIR, req.params.id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    res.json(metadata.versions);
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

export default router;
