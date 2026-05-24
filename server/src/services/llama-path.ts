import { readlink, readdir, stat, symlink, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const LLAMA_CURRENT_LINK = join(process.env.HOME || "/home/asa", "bin", "llama-current");
const SYSTEMCTL = "systemctl";
const SERVICE_NAMES = ["llama-server.service", "reranker.service", "extraction-model.service", "title-generation.service"];

// How long to wait for each service to come up after restart
const HEALTH_CHECK_TIMEOUT_MS = 8000;
const HEALTH_POLL_INTERVAL_MS = 500;

export interface LlamaPathInfo {
  /** Resolved absolute path the symlink points to (e.g. /home/asa/bin/llama-b8763) */
  currentPath: string;
  /** Build number extracted from the binary --version output */
  version: string;
  /** Whether the symlink exists and resolves */
  valid: boolean;
}

export interface LlamaPathUpdateResult {
  previousPath: string;
  currentPath: string;
  version: string;
  services: Record<string, "active" | "failed" | "unknown">;
  rolledBack: boolean;
}

/**
 * Read the current llama-current symlink target and query the binary version.
 */
export async function getLlamaPathInfo(): Promise<LlamaPathInfo> {
  try {
    if (!existsSync(LLAMA_CURRENT_LINK)) {
      return { currentPath: "", version: "", valid: false };
    }

    const target = await readlink(LLAMA_CURRENT_LINK);
    const resolved = resolve(join(LLAMA_CURRENT_LINK, ".."), target);

    // Try to get version from the binary
    const binaryPath = join(resolved, "llama-server");
    if (!existsSync(binaryPath)) {
      return { currentPath: resolved, version: "", valid: false };
    }

    let version = "";
    try {
      const { stdout, stderr } = await execFileAsync(binaryPath, ["--version"], {
        timeout: 5000,
        env: { ...process.env, LD_LIBRARY_PATH: resolved },
      });
      // llama-server --version writes to stderr, not stdout
      const output = stderr || stdout;
      const match = output.match(/version:\s*(\d+)/);
      if (match) version = match[1];
    } catch {
      // Binary might not respond to --version; that's okay
    }

    return { currentPath: resolved, version, valid: true };
  } catch {
    return { currentPath: "", version: "", valid: false };
  }
}

/**
 * Validate that a candidate path looks like a usable llama.cpp build directory.
 */
export async function validateLlamaPath(dirPath: string): Promise<{ valid: boolean; error?: string }> {
  // Must be an absolute path
  if (!dirPath.startsWith("/")) {
    return { valid: false, error: "Path must be absolute" };
  }

  // Must exist as a directory
  try {
    const s = await stat(dirPath);
    if (!s.isDirectory()) {
      return { valid: false, error: "Not a directory" };
    }
  } catch (e: any) {
    return { valid: false, error: "Directory does not exist" };
  }

  // Must contain llama-server binary
  const binaryPath = join(dirPath, "llama-server");
  if (!existsSync(binaryPath)) {
    return { valid: false, error: "No llama-server binary found in directory" };
  }

  // Binary must be executable
  try {
    await stat(binaryPath);
    // Check execute permission (rough check)
    const { stdout } = await execFileAsync("test", ["-x", binaryPath], { timeout: 2000 });
  } catch (e: any) {
    // test command returns 0 on success, 1 on failure — execFile throws on non-zero
    if (e.code === 1) {
      return { valid: false, error: "llama-server binary is not executable" };
    }
    // Other errors (e.g. test not found) — skip this check
  }

  return { valid: true };
}

/**
 * Poll systemctl until a service reaches active/failed or timeout.
 */
async function waitForService(
  serviceName: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS
): Promise<"active" | "failed" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(SYSTEMCTL, ["--user", "is-active", serviceName], {
        timeout: 3000,
      });
      const status = stdout.trim();
      if (status === "active") return "active";
      if (status === "failed") return "failed";
    } catch (e: any) {
      // systemctl returns non-zero for inactive/failed states
      const stderr = (e.stderr || "").trim();
      if (stderr.includes("failed")) return "failed";
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return "unknown";
}

/**
 * Update the llama-current symlink to point at a new build directory,
 * then restart all llama.cpp services and verify they come up healthy.
 * Rolls back if services fail.
 */
export async function updateLlamaPath(newPath: string): Promise<LlamaPathUpdateResult> {
  // Validate the new path
  const validation = await validateLlamaPath(newPath);
  if (!validation.valid) {
    throw new Error(`Invalid path: ${validation.error}`);
  }

  // Read the current target for rollback
  let previousPath = "";
  try {
    const target = await readlink(LLAMA_CURRENT_LINK);
    previousPath = resolve(join(LLAMA_CURRENT_LINK, ".."), target);
  } catch {
    // No existing symlink — no rollback possible
  }

  // Update the symlink atomically
  await unlink(LLAMA_CURRENT_LINK).catch(() => {}); // Remove old if exists
  await symlink(newPath, LLAMA_CURRENT_LINK); // Create new

  // Reload systemd (in case service files changed) and restart services
  try {
    await execFileAsync(SYSTEMCTL, ["--user", "daemon-reload"], { timeout: 5000 });
  } catch {
    // Non-fatal — the symlink changed but service files didn't
  }

  try {
    await execFileAsync(SYSTEMCTL, ["--user", "restart", ...SERVICE_NAMES], {
      timeout: 15000,
    });
  } catch (e: any) {
    // Restart command itself failed — rollback
    if (previousPath) {
      await unlink(LLAMA_CURRENT_LINK).catch(() => {});
      await symlink(previousPath, LLAMA_CURRENT_LINK);
      try {
        await execFileAsync(SYSTEMCTL, ["--user", "restart", ...SERVICE_NAMES], { timeout: 15000 });
      } catch {}
    }
    throw new Error(`Failed to restart services: ${e.message}`);
  }

  // Wait for services and check health
  const serviceResults: Record<string, "active" | "failed" | "unknown"> = {};
  const healthChecks = SERVICE_NAMES.map(async (name) => {
    const status = await waitForService(name);
    serviceResults[name] = status;
    return { name, status };
  });
  await Promise.all(healthChecks);

  // If any service failed, roll back
  const anyFailed = SERVICE_NAMES.some((name) => serviceResults[name] === "failed");
  let rolledBack = false;

  if (anyFailed && previousPath) {
    rolledBack = true;
    await unlink(LLAMA_CURRENT_LINK).catch(() => {});
    await symlink(previousPath, LLAMA_CURRENT_LINK);
    try {
      await execFileAsync(SYSTEMCTL, ["--user", "daemon-reload"], { timeout: 5000 });
      await execFileAsync(SYSTEMCTL, ["--user", "restart", ...SERVICE_NAMES], { timeout: 15000 });
    } catch {}
    // Re-check after rollback (best effort, don't block on it)
    for (const name of SERVICE_NAMES) {
      serviceResults[name] = await waitForService(name, 5000);
    }
  }

  // Get version from the new binary (or old if rolled back)
  const info = await getLlamaPathInfo();

  return {
    previousPath,
    currentPath: info.currentPath,
    version: info.version,
    services: serviceResults,
    rolledBack,
  };
}

/**
 * Scan ~/bin/ for directories containing a llama-server binary.
 * Returns path, version, and whether it's the default (llama-current symlink target).
 */
export async function listLlamaBinaries(): Promise<Array<{ path: string; version: string; isDefault: boolean }>> {
  const binDir = join(process.env.HOME || "/home/asa", "bin");
  const results: Array<{ path: string; version: string; isDefault: boolean }> = [];

  // Get the current default target
  let defaultTarget = "";
  try {
    const target = await readlink(LLAMA_CURRENT_LINK);
    defaultTarget = resolve(join(LLAMA_CURRENT_LINK, ".."), target);
  } catch { /* no symlink */ }

  try {
    const entries = await readdir(binDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = join(binDir, entry.name);
      // Skip the symlink itself — we already have its target
      if (entry.name === "llama-current") continue;
      const binaryPath = join(dirPath, "llama-server");
      if (!existsSync(binaryPath)) continue;

      // Extract version
      let version = "";
      try {
        const { stdout, stderr } = await execFileAsync(binaryPath, ["--version"], {
          timeout: 5000,
          env: { ...process.env, LD_LIBRARY_PATH: dirPath },
        });
        // llama-server --version writes to stderr, not stdout
        const output = stderr || stdout;
        const match = output.match(/version:\s*(\d+)/);
        if (match) version = match[1];
      } catch { /* version optional */ }

      results.push({
        path: dirPath,
        version,
        isDefault: dirPath === defaultTarget,
      });
    }
  } catch { /* binDir doesn't exist or unreadable */ }

  // Sort: default first, then by version descending
  results.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (!a.isDefault && b.isDefault) return 1;
    // Try numeric sort by version
    const va = Number.parseInt(a.version) || 0;
    const vb = Number.parseInt(b.version) || 0;
    return vb - va;
  });

  return results;
}

/**
 * Get the status of all llama.cpp systemd services.
 */
export async function getLlamaServicesStatus(): Promise<Record<string, "active" | "inactive" | "failed" | "unknown">> {
  const results: Record<string, "active" | "inactive" | "failed" | "unknown"> = {};
  for (const name of SERVICE_NAMES) {
    try {
      const { stdout } = await execFileAsync(SYSTEMCTL, ["--user", "is-active", name], { timeout: 3000 });
      const status = stdout.trim();
      if (status === "active") results[name] = "active";
      else if (status === "failed") results[name] = "failed";
      else if (status === "inactive") results[name] = "inactive";
      else results[name] = "unknown";
    } catch (e: any) {
      const stderr = (e.stderr || e.stdout || "").trim();
      if (stderr.includes("failed")) results[name] = "failed";
      else if (stderr.includes("inactive")) results[name] = "inactive";
      else results[name] = "unknown";
    }
  }
  return results;
}