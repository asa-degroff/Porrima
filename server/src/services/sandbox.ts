import { execFile } from "child_process";
import { writeFile, mkdir, unlink, access } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { v4 as uuid } from "uuid";

const ARTIFACTS_DIR = join(homedir(), ".quje-agent", "artifacts");

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

export async function executePython(
  code: string,
  timeout: number = 30
): Promise<ExecutionResult> {
  const sandboxId = uuid();
  const sandboxDir = join(tmpdir(), `quje-sandbox-${sandboxId}`);
  const tempFile = join(sandboxDir, "script.py");

  await mkdir(sandboxDir, { recursive: true });

  try {
    await writeFile(tempFile, code, "utf-8");

    const useBwrap = await checkBwrap();

    const cmd = useBwrap ? "/usr/bin/bwrap" : "python3";
    const args = useBwrap
      ? buildBwrapArgs(tempFile, sandboxDir)
      : [tempFile];
    const env = useBwrap ? process.env as Record<string, string> : makeSafeEnv();

    console.log(`[sandbox] Executing Python (${useBwrap ? "bwrap" : "restricted"}): ${sandboxId}`);

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
    // Clean up the entire sandbox directory
    const { rm } = await import("fs/promises");
    rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

const SCROLLBAR_STYLES = `<style>
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent; }
</style>`;

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
