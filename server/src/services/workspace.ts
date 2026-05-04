import { execFile } from "child_process";
import { access, mkdir, readFile, readdir, writeFile, stat, unlink } from "fs/promises";
import { constants } from "fs";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { glob } from "fs/promises";
import type { Project, ProjectLocationType, SshConnection } from "../types.js";
import { getSshConnection } from "./chat-storage.js";

const HOME = homedir();
const QUJE_DIR = join(HOME, ".quje-agent");
const SSH_MUX_DIR = join(QUJE_DIR, "ssh-mux");
const SSH_KNOWN_HOSTS = join(QUJE_DIR, "ssh-known-hosts");

/**
 * Initialize SSH infrastructure: create mux directory and clean stale sockets.
 * Call once at server startup.
 */
export async function initSshMux(): Promise<void> {
  try {
    await mkdir(SSH_MUX_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory already exists or permission issue — non-fatal.
  }

  // Clean up stale sockets from previous runs.
  try {
    const entries = await readdir(SSH_MUX_DIR);
    for (const entry of entries) {
      if (entry.endsWith(".sock")) {
        const fullPath = join(SSH_MUX_DIR, entry);
        try {
          const s = await stat(fullPath);
          // Only delete if it's actually a socket and stale (>5 min old).
          if (s.isSocket() && Date.now() - s.mtimeMs > 5 * 60 * 1000) {
            await unlink(fullPath);
          }
        } catch {
          // stat/unlink failure — ignore.
        }
      }
    }
  } catch {
    // readdir failure — non-fatal, mux will work fine without cleanup.
  }
}

export interface WorkspaceValidationResult {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isReadable: boolean;
  canCreate?: boolean;
  error?: string;
  hasAgentsMd?: boolean;
}

export interface WorkspaceReadFileOptions {
  defaultLines?: number;
  maxBytes?: number;
}

export interface WorkspaceAdapter {
  readonly label: string;
  readFile(args: Record<string, any>, opts?: WorkspaceReadFileOptions): Promise<{ content: string; isError: boolean }>;
  writeFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }>;
  editFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }>;
  listFiles(args: Record<string, any>): Promise<{ content: string; isError: boolean }>;
  bash(args: Record<string, any>): Promise<{ content: string; isError: boolean }>;
  readAgentsMd(): Promise<string | null>;
  validateRoot(): Promise<WorkspaceValidationResult>;
  createRootDirectory(): Promise<{ success: boolean; alreadyExists?: boolean; path?: string; error?: string }>;
}

function resolveLocalPath(inputPath: string, baseDir: string = HOME): string {
  if (inputPath.startsWith("~")) {
    return resolve(HOME, inputPath.slice(2));
  }
  if (inputPath.startsWith("/")) {
    return inputPath;
  }
  return resolve(baseDir, inputPath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function formatReadContent(content: string, args: Record<string, any>, opts: WorkspaceReadFileOptions = {}): string {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const defaultLines = opts.defaultLines ?? 1000;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const offset = Math.max(1, args.offset || 1);
  const limitProvided = typeof args.limit === "number" && args.limit > 0;
  const requestedLimit = limitProvided ? args.limit : defaultLines;
  const selected = lines.slice(offset - 1, offset - 1 + requestedLimit);

  let numbered = selected
    .map((line, i) => `${String(offset + i).padStart(6)} | ${line}`)
    .join("\n");

  let byteTruncated = false;
  if (Buffer.byteLength(numbered, "utf-8") > maxBytes) {
    const trimmed = numbered.slice(0, maxBytes);
    const lastNewline = trimmed.lastIndexOf("\n");
    numbered = lastNewline > 0 ? trimmed.slice(0, lastNewline) : trimmed;
    byteTruncated = true;
  }

  const linesShown = numbered ? numbered.split("\n").length : 0;
  const lastShown = offset - 1 + linesShown;
  const hasMore = lastShown < totalLines;

  if (hasMore || byteTruncated) {
    const reason = byteTruncated
      ? `output exceeded the ${(maxBytes / 1024).toFixed(0)}KB byte cap`
      : `default line limit of ${defaultLines} reached`;
    numbered += `\n\n[Truncated: ${reason}. File has ${totalLines} total lines; showing ${offset}-${lastShown}. To read more, call read_file again with offset=${lastShown + 1}.]`;
  }

  return numbered;
}

export class LocalWorkspaceAdapter implements WorkspaceAdapter {
  readonly label: string;

  constructor(private readonly root: string = HOME) {
    this.label = root;
  }

  private resolve(inputPath: string): string {
    return resolveLocalPath(inputPath, this.root);
  }

  async readFile(args: Record<string, any>, opts: WorkspaceReadFileOptions = {}): Promise<{ content: string; isError: boolean }> {
    try {
      const filePath = this.resolve(args.path);
      const content = await readFile(filePath, "utf-8");
      return { content: formatReadContent(content, args, opts), isError: false };
    } catch (e: any) {
      return { content: `Error reading file: ${e.message}`, isError: true };
    }
  }

  async writeFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    try {
      const filePath = this.resolve(args.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content, "utf-8");
      return { content: `File written: ${filePath}`, isError: false };
    } catch (e: any) {
      return { content: `Error writing file: ${e.message}`, isError: true };
    }
  }

  async editFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    try {
      const filePath = this.resolve(args.path);
      const content = await readFile(filePath, "utf-8");
      const occurrences = content.split(args.old_string).length - 1;
      if (occurrences === 0) return { content: "old_string not found in file", isError: true };
      if (occurrences > 1) return { content: `old_string found ${occurrences} times — must be unique. Provide more context.`, isError: true };
      await writeFile(filePath, content.replace(args.old_string, args.new_string), "utf-8");
      return { content: `File edited: ${filePath}`, isError: false };
    } catch (e: any) {
      return { content: `Error editing file: ${e.message}`, isError: true };
    }
  }

  async listFiles(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    try {
      const basePath = this.resolve(args.path || ".");
      if (args.pattern) {
        const matches: string[] = [];
        for await (const entry of glob(args.pattern, { cwd: basePath })) {
          matches.push(entry as string);
          if (matches.length >= 200) break;
        }
        return { content: matches.length ? matches.join("\n") : "No files matched the pattern.", isError: false };
      }
      const entries = await readdir(basePath, { withFileTypes: true });
      const listing = entries.slice(0, 200).map((e) => `${e.isDirectory() ? "d " : "f "} ${e.name}`).join("\n");
      return { content: listing, isError: false };
    } catch (e: any) {
      return { content: `Error listing files: ${e.message}`, isError: true };
    }
  }

  async bash(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    const timeout = (args.timeout || 30) * 1000;
    return new Promise((resolveResult) => {
      execFile("/bin/bash", ["-c", args.command], {
        timeout,
        maxBuffer: 1024 * 1024,
        cwd: this.root,
        env: { ...process.env, HOME },
      }, (error, stdout, stderr) => {
        const output = [stdout ? stdout.trimEnd() : "", stderr ? `[stderr] ${stderr.trimEnd()}` : ""].filter(Boolean).join("\n");
        if (error) {
          resolveResult({ content: error.killed ? `Command timed out after ${args.timeout || 30}s\n${output}` : (output || error.message), isError: true });
        } else {
          resolveResult({ content: output || "(no output)", isError: false });
        }
      });
    });
  }

  async readAgentsMd(): Promise<string | null> {
    for (const filename of ["AGENTS.md", "agents.md"]) {
      try {
        return await readFile(join(this.root, filename), "utf-8");
      } catch {
        // Try the next variant.
      }
    }
    return null;
  }

  async validateRoot(): Promise<WorkspaceValidationResult> {
    try {
      const fs = await import("fs");
      if (!fs.existsSync(this.root)) {
        const parentDir = this.root.substring(0, this.root.lastIndexOf("/"));
        let canCreate = false;
        if (parentDir && fs.existsSync(parentDir)) {
          try {
            const stats = fs.statSync(parentDir);
            if (stats.isDirectory()) {
              fs.accessSync(parentDir, constants.W_OK);
              canCreate = true;
            }
          } catch {
            canCreate = false;
          }
        }
        return { valid: false, exists: false, isDirectory: false, isReadable: false, canCreate, error: "Path does not exist" };
      }
      const stats = fs.statSync(this.root);
      if (!stats.isDirectory()) {
        return { valid: false, exists: true, isDirectory: false, isReadable: false, error: "Path is a file, not a directory" };
      }
      try {
        fs.accessSync(this.root, constants.R_OK);
      } catch {
        return { valid: false, exists: true, isDirectory: true, isReadable: false, error: "Path is not readable" };
      }
      return { valid: true, exists: true, isDirectory: true, isReadable: true, hasAgentsMd: await pathExists(join(this.root, "AGENTS.md")) };
    } catch (e: any) {
      return { valid: false, exists: false, isDirectory: false, isReadable: false, error: e.message };
    }
  }

  async createRootDirectory(): Promise<{ success: boolean; alreadyExists?: boolean; path?: string; error?: string }> {
    try {
      const fs = await import("fs");
      if (fs.existsSync(this.root)) {
        if (fs.statSync(this.root).isDirectory()) return { success: true, alreadyExists: true };
        return { success: false, error: "Path exists but is not a directory" };
      }
      await mkdir(this.root, { recursive: true });
      return { success: true, path: this.root };
    } catch (e: any) {
      return { success: false, error: `Failed to create directory: ${e.message}` };
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pythonLiteral(value: unknown): string {
  return JSON.stringify(value);
}

function sshTarget(connection: SshConnection): string {
  return connection.username ? `${connection.username}@${connection.host}` : connection.host;
}

// ---------------------------------------------------------------------------
// Shared master state — keyed by connection ID so multiple adapters
// (different projects, different chats) sharing the same connection
// coordinate on a single master.
// ---------------------------------------------------------------------------

interface MasterState {
  establishing: Promise<boolean> | null;
}

const masterRegistry = new Map<string, MasterState>();

function getMasterState(connectionId: string): MasterState {
  let state = masterRegistry.get(connectionId);
  if (!state) {
    state = { establishing: null };
    masterRegistry.set(connectionId, state);
  }
  return state;
}

/** Build SSH args for a multiplexed client command.
 *  Client connections inherit all options from the master — only need -S, target, and command. */
function sshClientArgs(controlSocket: string, connection: SshConnection, remoteCommand: string): string[] {
  return [
    "-S", controlSocket,
    sshTarget(connection),
    remoteCommand,
  ];
}

/** Build SSH args for establishing a master connection. */
function sshMasterArgs(controlSocket: string, connection: SshConnection): string[] {
  const strictMode = connection.knownHostsMode === "strict"
    ? "yes"
    : connection.knownHostsMode === "off"
      ? "no"
      : "accept-new";
  const args = [
    "-fMN",
    "-S", controlSocket,
    "-o", "ControlPersist=600",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=2",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", `StrictHostKeyChecking=${strictMode}`,
    "-o", `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    "-p", String(connection.port || 22),
  ];
  if (connection.identityFile) {
    args.push("-i", connection.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(sshTarget(connection));
  return args;
}

/** Build SSH args for a direct (non-multiplexed) connection — used as fallback. */
function sshDirectArgs(connection: SshConnection, remoteCommand: string): string[] {
  const strictMode = connection.knownHostsMode === "strict"
    ? "yes"
    : connection.knownHostsMode === "off"
      ? "no"
      : "accept-new";
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", `StrictHostKeyChecking=${strictMode}`,
    "-o", `UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
    "-p", String(connection.port || 22),
  ];
  if (connection.identityFile) {
    args.push("-i", connection.identityFile, "-o", "IdentitiesOnly=yes");
  }
  args.push(sshTarget(connection), remoteCommand);
  return args;
}

export class SshWorkspaceAdapter implements WorkspaceAdapter {
  readonly label: string;
  private readonly _controlSocket: string;

  constructor(private readonly connection: SshConnection, private readonly root: string) {
    this.label = `ssh:${sshTarget(connection)}:${root}`;
    this._controlSocket = join(SSH_MUX_DIR, `${connection.id}.sock`);
  }

  /** Returns the control socket path (useful for external tooling or debugging). */
  get controlSocket(): string {
    return this._controlSocket;
  }

  /** Check if master connection is alive using exit code (reliable) rather than output parsing. */
  private async masterCheck(): Promise<boolean> {
    return new Promise((resolveResult) => {
      execFile("ssh", [
        "-S", this._controlSocket,
        "-O", "check",
        sshTarget(this.connection),
      ], { timeout: 5000 }, (error) => {
        // ssh -O check exits 0 on success, non-zero on failure
        resolveResult(error?.code === 0 || error === null);
      });
    });
  }

  /** Establish or verify the master connection. Deduplicated via shared state. */
  private async ensureMaster(): Promise<boolean> {
    const state = getMasterState(this.connection.id);

    // If another caller is already establishing, wait on their promise
    if (state.establishing) {
      return state.establishing;
    }

    // Fast path: socket exists and master responds
    if (await this.masterCheck()) {
      return true;
    }

    // Establish — wrap in a promise that all concurrent callers share
    const promise = (async () => {
      try {
        const ok = await new Promise<boolean>((resolve) => {
          execFile("ssh", sshMasterArgs(this._controlSocket, this.connection), {
            timeout: 15000,
          }, (error, _stdout, stderr) => {
            // Master establishment: exit 0 = success, but also check for "remote host key" errors
            const stderrMsg = stderr || "";
            const failed = error !== null && stderrMsg.length > 0
              && (stderrMsg.includes("Connection refused")
                  || stderrMsg.includes("Permission denied")
                  || stderrMsg.includes("No more authentication methods")
                  || stderrMsg.includes("Control master already running"));
            resolve(!failed);
          });
        });

        if (ok) {
          // Give the forked master a moment to establish the socket
          await new Promise((r) => setTimeout(r, 300));
          // Verify it actually came up
          return await this.masterCheck();
        }
        return false;
      } finally {
        state.establishing = null;
      }
    })();

    state.establishing = promise;
    return promise;
  }

  /** Tear down the master connection. */
  async destroyMaster(): Promise<void> {
    const state = getMasterState(this.connection.id);
    state.establishing = null;
    try {
      await new Promise<void>((resolve) => {
        execFile("ssh", [
          "-S", this._controlSocket,
          "-O", "exit",
          sshTarget(this.connection),
        ], { timeout: 5000 }, () => resolve());
      });
    } catch {
      // Teardown failure — non-fatal.
    }
  }

  /** Execute a command over SSH, using the multiplexed connection. */
  exec(remoteCommand: string, timeoutMs = 30000, stdin?: string): Promise<{ content: string; isError: boolean }> {
    if (!this.connection.enabled) {
      return Promise.resolve({ content: `SSH connection "${this.connection.name}" is disabled`, isError: true });
    }

    const runWithMux = async (): Promise<{ content: string; isError: boolean }> => {
      const masterOk = await this.ensureMaster();

      const args = masterOk
        ? sshClientArgs(this._controlSocket, this.connection, remoteCommand)
        : sshDirectArgs(this.connection, remoteCommand);

      return new Promise((resolveResult) => {
        const proc = execFile("ssh", args, {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
          const output = [stdout ? stdout.trimEnd() : "", stderr ? `[stderr] ${stderr.trimEnd()}` : ""].filter(Boolean).join("\n");

          if (error) {
            // If we were using mux and got a socket/connection error, invalidate
            // so the next call retries master establishment
            if (masterOk) {
              const state = getMasterState(this.connection.id);
              state.establishing = null;
            }
            resolveResult({
              content: error.killed
                ? `SSH command timed out after ${Math.round(timeoutMs / 1000)}s\n${output}`
                : (output || error.message),
              isError: true,
            });
          } else {
            resolveResult({ content: output || "(no output)", isError: false });
          }
        });
        if (stdin !== undefined) {
          proc.stdin?.end(stdin);
        }
      });
    };

    return runWithMux();
  }

  private inRoot(command: string, timeoutMs = 30000, stdin?: string): Promise<{ content: string; isError: boolean }> {
    return this.exec(`cd -- ${shellQuote(this.root)} && ${command}`, timeoutMs, stdin);
  }

  private python(script: string, payload: unknown, timeoutMs = 30000): Promise<{ content: string; isError: boolean }> {
    return this.inRoot(`python3 -c ${shellQuote(script)}`, timeoutMs, JSON.stringify(payload));
  }

  async readFile(args: Record<string, any>, opts: WorkspaceReadFileOptions = {}): Promise<{ content: string; isError: boolean }> {
    const script = `
import json
import os
import tempfile
from pathlib import Path
data = json.loads(input())
root = Path(${pythonLiteral(this.root)})
raw = data.get("path") or ""
if raw.startswith("~"):
    target = Path.home() / raw[2:].lstrip("/")
elif raw.startswith("/"):
    if not data.get("allow_absolute"):
        raise SystemExit("Absolute paths are disabled for this SSH connection")
    target = Path(raw)
else:
    target = root / raw
content = target.read_text(encoding="utf-8")
lines = content.split("\\n")
offset = max(1, int(data.get("offset") or 1))
default_lines = int(data.get("default_lines") or 1000)
limit = int(data.get("limit") or default_lines)
max_bytes = int(data.get("max_bytes") or 262144)
selected = lines[offset - 1:offset - 1 + limit]
numbered = "\\n".join(f"{offset + i:6d} | {line}" for i, line in enumerate(selected))
byte_truncated = False
if len(numbered.encode("utf-8")) > max_bytes:
    raw_bytes = numbered.encode("utf-8")[:max_bytes]
    numbered = raw_bytes.decode("utf-8", errors="ignore")
    numbered = numbered.rsplit("\\n", 1)[0] if "\\n" in numbered else numbered
    byte_truncated = True
lines_shown = 0 if not numbered else len(numbered.split("\\n"))
last_shown = offset - 1 + lines_shown
if last_shown < len(lines) or byte_truncated:
    reason = f"output exceeded the {max_bytes // 1024}KB byte cap" if byte_truncated else f"default line limit of {default_lines} reached"
    numbered += f"\\n\\n[Truncated: {reason}. File has {len(lines)} total lines; showing {offset}-{last_shown}. To read more, call read_file again with offset={last_shown + 1}.]"
print(numbered)
`;
    const result = await this.python(script, {
      path: args.path,
      offset: args.offset,
      limit: args.limit,
      default_lines: opts.defaultLines ?? 1000,
      max_bytes: opts.maxBytes ?? 256 * 1024,
      allow_absolute: this.connection.allowAbsolutePaths,
    });
    return result.isError ? { content: `Error reading remote file: ${result.content}`, isError: true } : result;
  }

  async writeFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    if (!this.connection.allowFileWrite) {
      return { content: "File writes are disabled for this SSH connection", isError: true };
    }
    const script = `
import json
from pathlib import Path
data = json.loads(input())
root = Path(${pythonLiteral(this.root)})
raw = data.get("path") or ""
if raw.startswith("~"):
    target = Path.home() / raw[2:].lstrip("/")
elif raw.startswith("/"):
    if not data.get("allow_absolute"):
        raise SystemExit("Absolute paths are disabled for this SSH connection")
    target = Path(raw)
else:
    target = root / raw
target.parent.mkdir(parents=True, exist_ok=True)
fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(data.get("content") or "")
    os.replace(temp_name, target)
except Exception:
    try:
        os.unlink(temp_name)
    except FileNotFoundError:
        pass
    raise
print(f"Remote file written: {target}")
`;
    const result = await this.python(script, { path: args.path, content: args.content, allow_absolute: this.connection.allowAbsolutePaths });
    return result.isError ? { content: `Error writing remote file: ${result.content}`, isError: true } : result;
  }

  async editFile(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    if (!this.connection.allowFileWrite) {
      return { content: "File writes are disabled for this SSH connection", isError: true };
    }
    const script = `
import json
import os
import tempfile
from pathlib import Path
data = json.loads(input())
root = Path(${pythonLiteral(this.root)})
raw = data.get("path") or ""
if raw.startswith("~"):
    target = Path.home() / raw[2:].lstrip("/")
elif raw.startswith("/"):
    if not data.get("allow_absolute"):
        raise SystemExit("Absolute paths are disabled for this SSH connection")
    target = Path(raw)
else:
    target = root / raw
content = target.read_text(encoding="utf-8")
old = data.get("old_string") or ""
new = data.get("new_string") or ""
count = content.count(old)
if count == 0:
    raise SystemExit("old_string not found in file")
if count > 1:
    raise SystemExit(f"old_string found {count} times — must be unique. Provide more context.")
fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
try:
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content.replace(old, new, 1))
    os.replace(temp_name, target)
except Exception:
    try:
        os.unlink(temp_name)
    except FileNotFoundError:
        pass
    raise
print(f"Remote file edited: {target}")
`;
    const result = await this.python(script, {
      path: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      allow_absolute: this.connection.allowAbsolutePaths,
    });
    return result.isError ? { content: `Error editing remote file: ${result.content}`, isError: true } : result;
  }

  async listFiles(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    const script = `
import glob
import json
from pathlib import Path
data = json.loads(input())
root = Path(${pythonLiteral(this.root)})
raw = data.get("path") or "."
if raw.startswith("~"):
    base = Path.home() / raw[2:].lstrip("/")
elif raw.startswith("/"):
    if not data.get("allow_absolute"):
        raise SystemExit("Absolute paths are disabled for this SSH connection")
    base = Path(raw)
else:
    base = root / raw
pattern = data.get("pattern")
if pattern:
    matches = glob.glob(pattern, root_dir=str(base), recursive=True)[:200]
    print("\\n".join(matches) if matches else "No files matched the pattern.")
else:
    entries = []
    for entry in list(base.iterdir())[:200]:
        entries.append(("d " if entry.is_dir() else "f ") + entry.name)
    print("\\n".join(entries))
`;
    const result = await this.python(script, { path: args.path || ".", pattern: args.pattern, allow_absolute: this.connection.allowAbsolutePaths });
    return result.isError ? { content: `Error listing remote files: ${result.content}`, isError: true } : result;
  }

  async bash(args: Record<string, any>): Promise<{ content: string; isError: boolean }> {
    if (!this.connection.allowBash) {
      return { content: "Bash is disabled for this SSH connection", isError: true };
    }
    const timeoutMs = (args.timeout || 30) * 1000;
    return this.inRoot(`/bin/bash -lc ${shellQuote(args.command)}`, timeoutMs);
  }

  async readAgentsMd(): Promise<string | null> {
    const script = `
from pathlib import Path
root = Path(${pythonLiteral(this.root)})
for name in ("AGENTS.md", "agents.md"):
    p = root / name
    if p.exists() and p.is_file():
        print(p.read_text(encoding="utf-8"))
        raise SystemExit(0)
`;
    const result = await this.exec(`python3 -c ${shellQuote(script)}`);
    return result.isError || result.content === "(no output)" ? null : result.content;
  }

  async validateRoot(): Promise<WorkspaceValidationResult> {
    const script = `
import json
import os
from pathlib import Path
p = Path(${pythonLiteral(this.root)})
result = {"valid": False, "exists": p.exists(), "isDirectory": False, "isReadable": False}
if not p.exists():
    parent = p.parent
    result["canCreate"] = parent.exists() and parent.is_dir() and os.access(parent, os.W_OK)
    result["error"] = "Path does not exist"
elif not p.is_dir():
    result.update({"exists": True, "error": "Path is a file, not a directory"})
else:
    readable = os.access(p, os.R_OK)
    result.update({"exists": True, "isDirectory": True, "isReadable": readable, "valid": readable, "hasAgentsMd": (p / "AGENTS.md").exists()})
    if not readable:
        result["error"] = "Path is not readable"
print(json.dumps(result))
`;
    const result = await this.exec(`python3 -c ${shellQuote(script)}`);
    if (result.isError) {
      return { valid: false, exists: false, isDirectory: false, isReadable: false, error: result.content };
    }
    return JSON.parse(result.content) as WorkspaceValidationResult;
  }

  async createRootDirectory(): Promise<{ success: boolean; alreadyExists?: boolean; path?: string; error?: string }> {
    const script = `
import json
from pathlib import Path
p = Path(${pythonLiteral(this.root)})
if p.exists():
    print(json.dumps({"success": p.is_dir(), "alreadyExists": p.is_dir(), "error": None if p.is_dir() else "Path exists but is not a directory"}))
else:
    p.mkdir(parents=True, exist_ok=True)
    print(json.dumps({"success": True, "path": str(p)}))
`;
    const result = await this.exec(`python3 -c ${shellQuote(script)}`);
    if (result.isError) {
      return { success: false, error: result.content };
    }
    return JSON.parse(result.content) as { success: boolean; alreadyExists?: boolean; path?: string; error?: string };
  }
}

export async function getWorkspaceForProject(project?: Project | string | null): Promise<WorkspaceAdapter> {
  if (!project) return new LocalWorkspaceAdapter(HOME);
  if (typeof project === "string") return new LocalWorkspaceAdapter(project);
  if (project.locationType === "ssh") {
    if (!project.sshConnectionId) throw new Error("Remote project is missing sshConnectionId");
    const connection = await getSshConnection(project.sshConnectionId);
    if (!connection) throw new Error(`SSH connection not found: ${project.sshConnectionId}`);
    return new SshWorkspaceAdapter(connection, project.path);
  }
  return new LocalWorkspaceAdapter(project.path);
}

export async function getWorkspaceForLocation(locationType: ProjectLocationType | undefined, path: string, sshConnectionId?: string): Promise<WorkspaceAdapter> {
  if (locationType === "ssh") {
    if (!sshConnectionId) throw new Error("sshConnectionId is required for remote projects");
    const connection = await getSshConnection(sshConnectionId);
    if (!connection) throw new Error(`SSH connection not found: ${sshConnectionId}`);
    return new SshWorkspaceAdapter(connection, path);
  }
  return new LocalWorkspaceAdapter(resolveLocalPath(path, HOME));
}

/**
 * Tear down all active SSH master connections. Call on process shutdown.
 */
export async function destroyAllMasters(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const connectionId of masterRegistry.keys()) {
    // Reconstruct enough to call destroy — we need the connection details
    // but we can just use the socket path directly via ssh -O exit
    const socketPath = join(SSH_MUX_DIR, `${connectionId}.sock`);
    // We don't have the target handy here, so use ssh -O exit with a placeholder
    // Actually, ssh -O exit needs the same target. Let's fetch from storage.
    try {
      const conn = await getSshConnection(connectionId);
      if (conn) {
        promises.push(new Promise<void>((resolve) => {
          execFile("ssh", [
            "-S", socketPath,
            "-O", "exit",
            sshTarget(conn),
          ], { timeout: 5000 }, () => resolve());
        }));
      }
    } catch {
      // Connection record gone — non-fatal
    }
  }
  await Promise.allSettled(promises);
  masterRegistry.clear();
}

export async function testSshConnection(connection: SshConnection): Promise<{ ok: boolean; output: string }> {
  const adapter = new SshWorkspaceAdapter(connection, ".");
  const result = await adapter.exec("printf quje-ssh-ok", 15000);
  return { ok: !result.isError && result.content.includes("quje-ssh-ok"), output: result.content };
}
