import { Router } from "express";
import { join } from "path";
import { homedir } from "os";
import { readFile } from "fs/promises";

const router = Router();
const VISUALS_DIR = join(homedir(), ".quje-agent", "visuals");

// Serve visual HTML by ID
router.get("/:id", async (req, res) => {
  try {
    const filePath = join(VISUALS_DIR, `${req.params.id}.html`);

    // Prevent path traversal
    if (!filePath.startsWith(VISUALS_DIR)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const content = await readFile(filePath, "utf-8");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

export default router;
