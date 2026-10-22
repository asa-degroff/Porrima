import { Router } from "express";
import type { Response } from "express";
import { readFile } from "fs/promises";
import { appDataPath } from "../services/paths.js";
import { isNumericVersion, resolveWithin } from "../utils/safe-path.js";

const router = Router();
const VISUALS_DIR = appDataPath("visuals");

/**
 * Visuals execute model-authored JavaScript. A sandbox CSP gives direct
 * navigation an opaque origin; the in-app preview loads a blob and is
 * unaffected because blob documents do not inherit response headers.
 */
const VISUAL_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

function sendHtml(res: Response, content: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", VISUAL_CSP);
  res.send(content);
}

// Serve latest version of a visual.
router.get("/:id", async (req, res) => {
  const metadataPath = resolveWithin(VISUALS_DIR, req.params.id, "metadata.json");
  if (!metadataPath) {
    return res.status(404).json({ error: "Visual not found" });
  }
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    const latestVersion = String(metadata.currentVersion);
    const filePath = isNumericVersion(latestVersion)
      ? resolveWithin(VISUALS_DIR, req.params.id, "versions", latestVersion, "index.html")
      : null;
    if (!filePath) throw new Error("Invalid visual version");
    return sendHtml(res, await readFile(filePath, "utf-8"));
  } catch {
    try {
      // Backward compatibility for older visuals persisted as <id>.html.
      const filePath = resolveWithin(VISUALS_DIR, `${req.params.id}.html`);
      if (!filePath) throw new Error("Invalid visual id");
      sendHtml(res, await readFile(filePath, "utf-8"));
    } catch {
      res.status(404).json({ error: "Visual not found" });
    }
  }
});

// Serve a specific visual version.
router.get("/:id/versions/:version", async (req, res) => {
  const filePath = isNumericVersion(req.params.version)
    ? resolveWithin(VISUALS_DIR, req.params.id, "versions", req.params.version, "index.html")
    : null;
  if (!filePath) {
    return res.status(404).json({ error: "Version not found" });
  }
  try {
    sendHtml(res, await readFile(filePath, "utf-8"));
  } catch {
    res.status(404).json({ error: "Version not found" });
  }
});

// Get visual metadata.
router.get("/:id/metadata", async (req, res) => {
  const metadataPath = resolveWithin(VISUALS_DIR, req.params.id, "metadata.json");
  if (!metadataPath) {
    return res.status(404).json({ error: "Visual not found" });
  }
  try {
    res.json(JSON.parse(await readFile(metadataPath, "utf-8")));
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

// List all visual versions.
router.get("/:id/versions", async (req, res) => {
  const metadataPath = resolveWithin(VISUALS_DIR, req.params.id, "metadata.json");
  if (!metadataPath) {
    return res.status(404).json({ error: "Visual not found" });
  }
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    res.json(metadata.versions);
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

export default router;