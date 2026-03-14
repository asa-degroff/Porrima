import { execFile } from "child_process";
import { writeFile, mkdir, unlink, access, rm as rmDir, stat } from "fs/promises";
import { join, relative } from "path";
import { tmpdir, homedir } from "os";
import { v4 as uuid } from "uuid";

const ARTIFACTS_DIR = join(homedir(), ".quje-agent", "artifacts");
const VISUALS_DIR = join(homedir(), ".quje-agent", "visuals");
const WORKSPACE_DIR = join(homedir(), ".quje-agent", "workspace");

// Persistent sandbox sessions: sessionId -> { dir, createdAt, lastUsed }
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
  
  // Also enforce max sessions by removing oldest
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
        console.error(`[sandbox] Failed to cleanup session ${sessionId}:`, e);
      }
      persistentSessions.delete(sessionId);
      console.log(`[sandbox] Cleaned up stale session: ${sessionId}`);
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

// Sensitive env var patterns to strip from sandbox environment
const SENSITIVE_ENV_PATTERNS = [
  /^SSH_/,
  /^AWS_/,
  /^GOOGLE_/,
  /^AZURE_/,
  /^GH_TOKEN$/,
  /^GITHUB_TOKEN$/,
  /^GITLAB_/,
  /^NPM_TOKEN$/,
  /^NODE_AUTH_TOKEN$/,
  /^DOCKER_/,
  /^KUBECONFIG$/,
  /^OPENAI_/,
  /^ANTHROPIC_/,
  /^API_KEY$/,
  /^SECRET/,
  /TOKEN$/,
  /^CREDENTIAL/,
  /PASSWORD/,
];

function makeSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERNS.some((p) => p.test(key))) continue;
    env[key] = value;
  }
  // Override HOME to sandbox dir so scripts can't access ~/.ssh etc.
  env.HOME = tmpdir();
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

let bwrapAvailable: boolean | null = null;

async function checkBwrap(): Promise<boolean> {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    await access("/usr/bin/bwrap");
    bwrapAvailable = true;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

function buildBwrapArgs(scriptPath: string, sandboxDir: string): string[] {
  return [
    // New PID and network namespace (disables network access)
    "--unshare-net",
    "--unshare-pid",
    // Mount /usr read-only (contains all binaries/libraries)
    "--ro-bind", "/usr", "/usr",
    // Recreate standard symlinks (lib, lib64, bin, sbin -> /usr/*)
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    // Minimal /etc for Python
    "--ro-bind", "/etc/alternatives", "/etc/alternatives",
    // Python needs /proc
    "--proc", "/proc",
    // Writable sandbox directory
    "--bind", sandboxDir, sandboxDir,
    // Writable /tmp inside sandbox
    "--tmpfs", "/tmp",
    // Mount the script read-only
    "--ro-bind", scriptPath, scriptPath,
    // Set HOME to sandbox
    "--setenv", "HOME", sandboxDir,
    "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
    // Drop to sandbox dir
    "--chdir", sandboxDir,
    // Run python
    "python3", scriptPath,
  ];
}

/**
 * Execute Python code with optional persistent session.
 * 
 * @param code - Python code to execute
 * @param timeout - Timeout in seconds (default 30)
 * @param sessionId - Optional session ID for persistent workspace. If provided,
 *   the sandbox directory persists between calls, allowing file I/O across executions.
 *   If not provided, a temporary sandbox is created and destroyed.
 */
export async function executePython(
  code: string,
  timeout: number = 30,
  sessionId?: string
): Promise<ExecutionResult> {
  let sandboxDir: string;
  let isPersistent = false;

  if (sessionId) {
    // Use persistent session
    const existing = persistentSessions.get(sessionId);
    if (existing) {
      sandboxDir = existing.dir;
      existing.lastUsed = Date.now();
      isPersistent = true;
      console.log(`[sandbox] Reusing persistent session: ${sessionId}`);
    } else {
      // Create new persistent session
      sandboxDir = join(WORKSPACE_DIR, `session-${sessionId}`);
      await mkdir(sandboxDir, { recursive: true });
      persistentSessions.set(sessionId, {
        dir: sandboxDir,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
      isPersistent = true;
      console.log(`[sandbox] Created persistent session: ${sessionId} at ${sandboxDir}`);
    }
  } else {
    // Ephemeral session (original behavior)
    const sandboxId = uuid();
    sandboxDir = join(tmpdir(), `quje-sandbox-${sandboxId}`);
    await mkdir(sandboxDir, { recursive: true });
  }

  const tempFile = join(sandboxDir, "script.py");

  try {
    await writeFile(tempFile, code, "utf-8");

    const useBwrap = await checkBwrap();

    const cmd = useBwrap ? "/usr/bin/bwrap" : "python3";
    const args = useBwrap
      ? buildBwrapArgs(tempFile, sandboxDir)
      : [tempFile];
    const env = useBwrap ? process.env as Record<string, string> : makeSafeEnv();

    console.log(`[sandbox] Executing Python (${useBwrap ? "bwrap" : "restricted"})${isPersistent ? ` [session: ${sessionId}]` : ""}`);

    return await new Promise<ExecutionResult>((resolve) => {
      execFile(
        cmd,
        args,
        {
          timeout: timeout * 1000,
          maxBuffer: 1024 * 1024,
          cwd: useBwrap ? undefined : sandboxDir,
          env,
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
    // Only clean up ephemeral sessions
    if (!isPersistent) {
      const { rm } = await import("fs/promises");
      rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
    } else {
      // Clean up just the script file in persistent sessions
      unlink(tempFile).catch(() => {});
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

export async function createVisual(
  id: string,
  html: string
): Promise<string> {
  await mkdir(VISUALS_DIR, { recursive: true });

  // Inject scrollbar styling to match parent UI
  let styledHtml = html;
  if (html.includes("</head>")) {
    styledHtml = html.replace("</head>", `${SCROLLBAR_STYLES}\n</head>`);
  } else if (html.includes("<body")) {
    styledHtml = html.replace("<body", `${SCROLLBAR_STYLES}\n<body`);
  } else {
    styledHtml = SCROLLBAR_STYLES + "\n" + html;
  }

  await writeFile(join(VISUALS_DIR, `${id}.html`), styledHtml, "utf-8");
  return `/api/visuals/${id}`;
}

export async function createArtifact(
  id: string,
  html: string
): Promise<string> {
  const artifactDir = join(ARTIFACTS_DIR, id);
  await mkdir(artifactDir, { recursive: true });

  // Inject scrollbar styling so artifacts match the parent UI
  let styledHtml = html;
  if (html.includes("</head>")) {
    styledHtml = html.replace("</head>", `${SCROLLBAR_STYLES}\n</head>`);
  } else if (html.includes("<body")) {
    styledHtml = html.replace("<body", `${SCROLLBAR_STYLES}\n<body`);
  } else {
    styledHtml = SCROLLBAR_STYLES + "\n" + html;
  }

  await writeFile(join(artifactDir, "index.html"), styledHtml, "utf-8");
  return `/api/artifacts/${id}`;
}
