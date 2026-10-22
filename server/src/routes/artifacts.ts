import { Router } from "express";
import type { Response } from "express";
import { readFile } from "fs/promises";
import { lookup } from "../utils/mime.js";
import { appDataPath } from "../services/paths.js";
import { isNumericVersion, resolveWithin } from "../utils/safe-path.js";

const router = Router();
const ARTIFACTS_DIR = appDataPath("artifacts");
const VISUALS_DIR = appDataPath("visuals");

/**
 * Artifacts execute model-authored JavaScript. Serving them with a sandbox CSP
 * means a direct link to `/api/artifacts/...` renders in an opaque origin
 * instead of the app origin, so it cannot read the session or call `/api/*`.
 * The in-app preview is unaffected: it fetches the HTML and loads a blob, which
 * does not inherit response headers.
 */
const ARTIFACT_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

function sendHtml(res: Response, content: string): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", ARTIFACT_CSP);
  res.send(content);
}

/** Express 5 exposes wildcard params as an array of decoded segments. */
function subSegments(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : [value ?? ""];
  return parts.flatMap((part) => String(part).split("/")).filter((part) => part.length > 0);
}

async function readMetadata(dir: string, name: string) {
  const metadataPath = resolveWithin(dir, name, "metadata.json");
  if (!metadataPath) return null;
  try {
    return JSON.parse(await readFile(metadataPath, "utf-8"));
  } catch {
    return null;
  }
}

// Serve latest version of artifact (backward compat + convenience)
router.get("/:id", async (req, res) => {
  const metadata = await readMetadata(ARTIFACTS_DIR, req.params.id);
  const latestVersion = metadata ? String(metadata.currentVersion) : "";
  const filePath = isNumericVersion(latestVersion)
    ? resolveWithin(ARTIFACTS_DIR, req.params.id, "versions", latestVersion, "index.html")
    : null;
  if (!filePath) {
    return res.status(404).json({ error: "Artifact not found" });
  }
  try {
    sendHtml(res, await readFile(filePath, "utf-8"));
  } catch {
    res.status(404).json({ error: "Artifact not found" });
  }
});

// Serve specific version
router.get("/:id/versions/:version", async (req, res) => {
  const filePath = isNumericVersion(req.params.version)
    ? resolveWithin(ARTIFACTS_DIR, req.params.id, "versions", req.params.version, "index.html")
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

// Get artifact metadata (version history)
router.get("/:id/metadata", async (req, res) => {
  const metadata = await readMetadata(ARTIFACTS_DIR, req.params.id);
  if (!metadata) {
    return res.status(404).json({ error: "Artifact not found" });
  }
  res.json(metadata);
});

// List all versions for an artifact
router.get("/:id/versions", async (req, res) => {
  const metadata = await readMetadata(ARTIFACTS_DIR, req.params.id);
  if (!metadata) {
    return res.status(404).json({ error: "Artifact not found" });
  }
  res.json(metadata.versions);
});

// Serve sub-files from a specific version (CSS, images, JS, etc.)
router.get("/:id/versions/:version/*subpath", async (req, res) => {
  const parts = subSegments((req.params as any).subpath);
  const filePath = isNumericVersion(req.params.version) && parts.length > 0
    ? resolveWithin(ARTIFACTS_DIR, req.params.id, "versions", req.params.version, ...parts)
    : null;
  if (!filePath) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const content = await readFile(filePath);
    const mimeType = lookup(filePath);
    res.setHeader("Content-Type", mimeType);
    if (mimeType.startsWith("text/html")) {
      res.setHeader("Content-Security-Policy", ARTIFACT_CSP);
    }
    res.send(content);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// Legacy subpath route (for backward compat with old artifacts)
router.get("/:id/*subpath", async (req, res) => {
  const parts = subSegments((req.params as any).subpath);
  const filePath = parts.length > 0
    ? resolveWithin(ARTIFACTS_DIR, req.params.id, ...parts)
    : null;
  if (!filePath) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const content = await readFile(filePath);
    const mimeType = lookup(filePath);
    res.setHeader("Content-Type", mimeType);
    if (mimeType.startsWith("text/html")) {
      res.setHeader("Content-Security-Policy", ARTIFACT_CSP);
    }
    res.send(content);
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

// === Visuals routes (same structure as artifacts) ===

// Serve latest version of visual
router.get("/visuals/:id", async (req, res) => {
  const metadata = await readMetadata(VISUALS_DIR, req.params.id);
  const latestVersion = metadata ? String(metadata.currentVersion) : "";
  const filePath = isNumericVersion(latestVersion)
    ? resolveWithin(VISUALS_DIR, req.params.id, "versions", latestVersion, "index.html")
    : null;
  if (filePath) {
    try {
      return sendHtml(res, await readFile(filePath, "utf-8"));
    } catch {
      // Fall through to the legacy single-file layout.
    }
  }
  // Backward compatibility for older visuals persisted as <id>.html.
  const legacyPath = resolveWithin(VISUALS_DIR, `${req.params.id}.html`);
  if (!legacyPath) {
    return res.status(404).json({ error: "Visual not found" });
  }
  try {
    sendHtml(res, await readFile(legacyPath, "utf-8"));
  } catch {
    res.status(404).json({ error: "Visual not found" });
  }
});

// Serve specific visual version
router.get("/visuals/:id/versions/:version", async (req, res) => {
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

// Get visual metadata
router.get("/visuals/:id/metadata", async (req, res) => {
  const metadata = await readMetadata(VISUALS_DIR, req.params.id);
  if (!metadata) {
    return res.status(404).json({ error: "Visual not found" });
  }
  res.json(metadata);
});

// List all versions for a visual
router.get("/visuals/:id/versions", async (req, res) => {
  const metadata = await readMetadata(VISUALS_DIR, req.params.id);
  if (!metadata) {
    return res.status(404).json({ error: "Visual not found" });
  }
  res.json(metadata.versions);
});

export default router;