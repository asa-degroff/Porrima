import { execFile } from "child_process";
import { writeFile, mkdir, unlink, rm as rmDir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { v4 as uuid } from "uuid";

const ARTIFACTS_DIR = join(homedir(), ".quje-agent", "artifacts");
const VISUALS_DIR = join(homedir(), ".quje-agent", "visuals");
const WORKSPACE_DIR = join(homedir(), ".quje-agent", "workspace");

// Persistent workspace sessions: sessionId -> { dir, createdAt, lastUsed }
const persistentSessions = new Map<string, { dir: string; createdAt: number; lastUsed: number }>();

// Session cleanup: remove sessions older than 24 hours
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 10;

async function cleanupOldSessions() {
  const now = Date.now();
  const toRemove: string[] = [];

  for (const [sessionId, session] of persistentSessions) {
    if (now - session.lastUsed > SESSION_TTL_MS) {
      toRemove.push(sessionId);
    }
  }

  // Enforce max sessions by removing oldest
  if (persistentSessions.size - toRemove.length >= MAX_SESSIONS) {
    const sorted = Array.from(persistentSessions.entries())
      .filter(([id]) => !toRemove.includes(id))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    const excessCount = sorted.length - MAX_SESSIONS + 1;
    for (let i = 0; i < excessCount; i++) {
      toRemove.push(sorted[i][0]);
    }
  }

  for (const sessionId of toRemove) {
    const session = persistentSessions.get(sessionId);
    if (session) {
      try {
        await rmDir(session.dir, { recursive: true, force: true });
      } catch (e) {
        console.error(`[python] Failed to cleanup session ${sessionId}:`, e);
      }
      persistentSessions.delete(sessionId);
      console.log(`[python] Cleaned up stale session: ${sessionId}`);
    }
  }
}

// Run cleanup on module load and every hour
cleanupOldSessions();
setInterval(cleanupOldSessions, 60 * 60 * 1000);

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute Python code in a clean workspace directory.
 *
 * No longer sandboxed — runs with full system access, matching the agent's
 * bash tool. The workspace directory provides clean isolation from the project
 * tree and auto-cleanup, not a security boundary.
 *
 * @param code - Python code to execute
 * @param timeout - Timeout in seconds (default 30)
 * @param sessionId - Optional session ID for a persistent workspace. If provided,
 *   the directory persists between calls, allowing file I/O across executions.
 *   If not provided, a temporary workspace is created and destroyed after execution.
 */
export async function executePython(
  code: string,
  timeout: number = 30,
  sessionId?: string
): Promise<ExecutionResult> {
  let workspaceDir: string;
  let isPersistent = false;

  if (sessionId) {
    const existing = persistentSessions.get(sessionId);
    if (existing) {
      workspaceDir = existing.dir;
      existing.lastUsed = Date.now();
      isPersistent = true;
      console.log(`[python] Reusing session: ${sessionId}`);
    } else {
      workspaceDir = join(WORKSPACE_DIR, `session-${sessionId}`);
      await mkdir(workspaceDir, { recursive: true });
      persistentSessions.set(sessionId, {
        dir: workspaceDir,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
      isPersistent = true;
      console.log(`[python] Created session: ${sessionId} at ${workspaceDir}`);
    }
  } else {
    const sandboxId = uuid();
    workspaceDir = join(tmpdir(), `quje-python-${sandboxId}`);
    await mkdir(workspaceDir, { recursive: true });
  }

  const scriptPath = join(workspaceDir, "script.py");

  try {
    await writeFile(scriptPath, code, "utf-8");

    console.log(`[python] Executing${isPersistent ? ` [session: ${sessionId}]` : " [ephemeral]"}`);

    return await new Promise<ExecutionResult>((resolve) => {
      execFile(
        "python3",
        [scriptPath],
        {
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024,
          cwd: workspaceDir,
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout, stderr) => {
          if (error) {
            if (error.killed) {
              resolve({
                stdout: stdout || "",
                stderr: `Execution timed out after ${timeout}s\n${stderr || ""}`,
                exitCode: 124,
              });
            } else {
              resolve({
                stdout: stdout || "",
                stderr: stderr || error.message,
                exitCode: error.code ? Number(error.code) : 1,
              });
            }
          } else {
            resolve({
              stdout: stdout || "",
              stderr: stderr || "",
              exitCode: 0,
            });
          }
        }
      );
    });
  } finally {
    if (!isPersistent) {
      rmDir(workspaceDir, { recursive: true, force: true }).catch(() => {});
    } else {
      unlink(scriptPath).catch(() => {});
    }
  }
}

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

export async function getArtifactMetadata(id: string): Promise<ArtifactMetadata | null> {
  try {
    const metadataPath = join(ARTIFACTS_DIR, id, "metadata.json");
    const content = await readFile(metadataPath, "utf-8");
    return JSON.parse(content) as ArtifactMetadata;
  } catch {
    return null;
  }
}
