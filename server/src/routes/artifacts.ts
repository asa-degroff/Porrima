import { Router } from "express";
import { join } from "path";
import { homedir } from "os";
import { readFile } from "fs/promises";
import { lookup } from "../utils/mime.js";

const router = Router();
const ARTIFACTS_DIR = join(homedir(), ".quje-agent", "artifacts");

// Serve artifact index.html
router.get("/:id", async (req, res) => {
  try {
    const filePath = join(ARTIFACTS_DIR, req.params.id, "index.html");
    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Artifact not found" });
  }
});

// Serve sub-files (CSS, images, JS, etc.)
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

export default router;
