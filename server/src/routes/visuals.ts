import { Router } from "express";
import { join } from "path";
import { readFile } from "fs/promises";
import { appDataPath } from "../services/paths.js";

const router = Router();
const VISUALS_DIR = appDataPath("visuals");

// Serve latest version of a visual.
router.get("/:id", async (req, res) => {
  try {
    const metadataPath = join(VISUALS_DIR, req.params.id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    const filePath = join(VISUALS_DIR, req.params.id, "versions", String(metadata.currentVersion), "index.html");

    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    try {
      // Backward compatibility for older visuals persisted as <id>.html.
      const filePath = join(VISUALS_DIR, `${req.params.id}.html`);
      const content = await readFile(filePath, "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(content);
    } catch {
      res.status(404).json({ error: "Visual not found" });
    }
  }
});

// Serve a specific visual version.
router.get("/:id/versions/:version", async (req, res) => {
  try {
    const filePath = join(VISUALS_DIR, req.params.id, "versions", req.params.version, "index.html");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Version not found" });
  }
});

// Get visual metadata.
router.get("/:id/metadata", async (req, res) => {
  try {
    const metadataPath = join(VISUALS_DIR, req.params.id, "metadata.json");
    const metadata = await readFile(metadataPath, "utf-8");
    res.json(JSON.parse(metadata));
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

// List all visual versions.
router.get("/:id/versions", async (req, res) => {
  try {
    const metadataPath = join(VISUALS_DIR, req.params.id, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    res.json(metadata.versions);
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

export default router;
