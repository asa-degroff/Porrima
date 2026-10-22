import { writeFile, mkdir, readFile } from "fs/promises";
import { join } from "path";
import { appDataPath } from "./paths.js";
import { assertSafePathSegment } from "../utils/safe-path.js";

const ARTIFACTS_DIR = appDataPath("artifacts");
const VISUALS_DIR = appDataPath("visuals");

const SCROLLBAR_STYLES = `<style>
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
</style>`;

// Artifact metadata interface
export interface ArtifactMetadata {
  canonicalId: string;
  currentVersion: number;
  versions: Array<{
    version: number;
    createdAt: string;
    changeSummary?: string;
  }>;
}

export async function createVisual(
  id: string,
  html: string,
  title?: string
): Promise<{ url: string; version: number }> {
  assertSafePathSegment(id, "visual id");
  const visualDir = join(VISUALS_DIR, id);
  const versionsDir = join(visualDir, "versions", "1");
  await mkdir(versionsDir, { recursive: true });

  // Inject scrollbar styling to match parent UI
  let styledHtml = html;
  if (html.includes("</head>")) {
    styledHtml = html.replace("</head>", `${SCROLLBAR_STYLES}\n</head>`);
  } else if (html.includes("<body")) {
    styledHtml = html.replace("<body", `${SCROLLBAR_STYLES}\n<body`);
  } else {
    styledHtml = SCROLLBAR_STYLES + "\n" + html;
  }

  await writeFile(join(versionsDir, "index.html"), styledHtml, "utf-8");

  // Create metadata.json
  const metadata: ArtifactMetadata = {
    canonicalId: id,
    currentVersion: 1,
    versions: [{ version: 1, createdAt: new Date().toISOString(), changeSummary: title ? `Created: ${title}` : "Initial version" }],
  };
  await writeFile(join(visualDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

  return { url: `/api/visuals/${id}/versions/1`, version: 1 };
}

export async function updateVisual(
  id: string,
  html: string,
  changeSummary?: string
): Promise<{ url: string; version: number }> {
  assertSafePathSegment(id, "visual id");
  const visualDir = join(VISUALS_DIR, id);
  const metadataPath = join(visualDir, "metadata.json");

  // Read existing metadata
  let metadata: ArtifactMetadata;
  try {
    const existing = await readFile(metadataPath, "utf-8");
    metadata = JSON.parse(existing);
  } catch (e: any) {
    throw new Error(`Visual ${id} not found or has invalid metadata`);
  }

  // Create new version directory
  const newVersion = metadata.currentVersion + 1;
  const versionsDir = join(visualDir, "versions", String(newVersion));
  await mkdir(versionsDir, { recursive: true });

  // Inject scrollbar styling
  let styledHtml = html;
  if (html.includes("</head>")) {
    styledHtml = html.replace("</head>", `${SCROLLBAR_STYLES}\n</head>`);
  } else if (html.includes("<body")) {
    styledHtml = html.replace("<body", `${SCROLLBAR_STYLES}\n<body`);
  } else {
    styledHtml = SCROLLBAR_STYLES + "\n" + html;
  }

  await writeFile(join(versionsDir, "index.html"), styledHtml, "utf-8");

  // Update metadata
  metadata.currentVersion = newVersion;
  metadata.versions.push({
    version: newVersion,
    createdAt: new Date().toISOString(),
    changeSummary: changeSummary || `Version ${newVersion}`,
  });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  return { url: `/api/visuals/${id}/versions/${newVersion}`, version: newVersion };
}

export async function createArtifact(
  id: string,
  html: string,
  title?: string
): Promise<{ url: string; version: number }> {
  assertSafePathSegment(id, "artifact id");
  const artifactDir = join(ARTIFACTS_DIR, id);
  const versionsDir = join(artifactDir, "versions", "1");
  await mkdir(versionsDir, { recursive: true });

  // Inject scrollbar styling so artifacts match the parent UI
  let styledHtml = html;
  if (html.includes("</head>")) {
    styledHtml = html.replace("</head>", `${SCROLLBAR_STYLES}\n</head>`);
  } else if (html.includes("<body")) {
    styledHtml = html.replace("<body", `${SCROLLBAR_STYLES}\n<body`);
  } else {
    styledHtml = SCROLLBAR_STYLES + "\n" + html;
  }

  await writeFile(join(versionsDir, "index.html"), styledHtml, "utf-8");

  // Create metadata.json
  const metadata: ArtifactMetadata = {
    canonicalId: id,
    currentVersion: 1,
    versions: [{ version: 1, createdAt: new Date().toISOString(), changeSummary: title ? `Created: ${title}` : "Initial version" }],
  };
  await writeFile(join(artifactDir, "metadata.json"), JSON.stringify(metadata, null, 2), "utf-8");

  return { url: `/api/artifacts/${id}/versions/1`, version: 1 };
}

export async function updateArtifact(
  id: string,
  html: string,
  changeSummary?: string
): Promise<{ url: string; version: number }> {
  assertSafePathSegment(id, "artifact id");
  const artifactDir = join(ARTIFACTS_DIR, id);
  const metadataPath = join(artifactDir, "metadata.json");

  // Read existing metadata
  let metadata: ArtifactMetadata;
  try {
    const existing = await readFile(metadataPath, "utf-8");
    metadata = JSON.parse(existing);
  } catch (e: any) {
    throw new Error(`Artifact ${id} not found or has invalid metadata`);
  }

  // Create new version directory
  const newVersion = metadata.currentVersion + 1;
  const versionsDir = join(artifactDir, "versions", String(newVersion));
  await mkdir(versionsDir, { recursive: true });

  // Inject scrollbar styling
  let styledHtml = html;
  if (html.includes("</head>")) {
    styledHtml = html.replace("</head>", `${SCROLLBAR_STYLES}\n</head>`);
  } else if (html.includes("<body")) {
    styledHtml = html.replace("<body", `${SCROLLBAR_STYLES}\n<body`);
  } else {
    styledHtml = SCROLLBAR_STYLES + "\n" + html;
  }

  await writeFile(join(versionsDir, "index.html"), styledHtml, "utf-8");

  // Update metadata
  metadata.currentVersion = newVersion;
  metadata.versions.push({
    version: newVersion,
    createdAt: new Date().toISOString(),
    changeSummary: changeSummary || `Version ${newVersion}`,
  });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  return { url: `/api/artifacts/${id}/versions/${newVersion}`, version: newVersion };
}

export async function existsVisual(id: string): Promise<boolean> {
  try {
    const metadataPath = join(VISUALS_DIR, id, "metadata.json");
    await import("fs/promises").then(m => m.access(metadataPath));
    return true;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return false;
    throw e;
  }
}
