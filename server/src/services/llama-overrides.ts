import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const OVERRIDE_FILENAME = "porrima-model.conf";

const HEADER = [
  "# Managed by Porrima — written by the Models settings UI.",
  "# To change the model, use Settings → Models. To revert to the unit's",
  "# default, delete this file or use the \"Reset to default\" action.",
].join("\n");

function overridePath(unitName: string): string {
  return path.join(SYSTEMD_USER_DIR, `${unitName}.d`, OVERRIDE_FILENAME);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export interface OverrideInfo {
  exists: boolean;
  path: string;
  contents?: string;
}

export async function readOverride(unitName: string): Promise<OverrideInfo> {
  const target = overridePath(unitName);
  try {
    const contents = await fs.readFile(target, "utf-8");
    return { exists: true, path: target, contents };
  } catch {
    return { exists: false, path: target };
  }
}

/**
 * Extract the model file path from an override's ExecStart, if present. Used
 * to surface the active override model in the UI. Looks for the LAST `-m
 * <path>` token in the override (matching how the launch templates render it).
 */
export function extractOverrideModelPath(contents: string | undefined): string | null {
  if (!contents) return null;
  // Strip line continuations to make matching simpler.
  const flat = contents.replace(/\\\n\s*/g, " ");
  // Match -m '...' or -m "..." or -m <bareword>
  const match = flat.match(/(?:^|\s)-m\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
  if (!match) return null;
  return match[1] || match[2] || match[3] || null;
}

export interface WriteOverrideOptions {
  /** Additional Environment= lines to include in the drop-in. */
  environmentLines?: string[];
}

export async function writeOverride(unitName: string, execStart: string, options: WriteOverrideOptions = {}): Promise<string> {
  const target = overridePath(unitName);
  const dir = path.dirname(target);
  await ensureDir(dir);
  const envLines = options.environmentLines?.map((v) => `Environment=${v}`).join("\n");
  const envSection = envLines ? `${envLines}\n` : "";
  const body = `${HEADER}\n[Service]\nExecStart=\n${envSection}ExecStart=${execStart}\n`;
  await fs.writeFile(target, body, "utf-8");
  return target;
}

export async function deleteOverride(unitName: string): Promise<boolean> {
  const target = overridePath(unitName);
  try {
    await fs.unlink(target);
    // Best-effort cleanup of an empty .d directory.
    try {
      await fs.rmdir(path.dirname(target));
    } catch {}
    return true;
  } catch (e: any) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

export async function daemonReload(): Promise<void> {
  await execFileAsync("systemctl", ["--user", "daemon-reload"], {
    timeout: 10000,
    maxBuffer: 1024 * 256,
  });
}

export async function restartUnit(unitName: string): Promise<void> {
  await execFileAsync("systemctl", ["--user", "restart", unitName], {
    timeout: 30000,
    maxBuffer: 1024 * 256,
  });
}

/**
 * Apply a model override and restart the unit atomically:
 *   1. Write override file (creates .d/ if missing)
 *   2. systemctl --user daemon-reload
 *   3. systemctl --user restart <unit>
 *
 * On any failure after the file is written, attempts to delete it so the
 * unit reverts to its default on next manual restart. Re-throws the error.
 */
export async function applyModelOverride(unitName: string, execStart: string, options: WriteOverrideOptions = {}): Promise<{ overridePath: string }> {
  const target = await writeOverride(unitName, execStart, options);
  try {
    await daemonReload();
    await restartUnit(unitName);
  } catch (e) {
    try {
      await deleteOverride(unitName);
      await daemonReload();
    } catch {}
    throw e;
  }
  return { overridePath: target };
}

/**
 * Remove a model override and restart the unit so the original ExecStart
 * (from the unit file in /home/user/.config/systemd/user) takes effect.
 */
export async function clearModelOverride(unitName: string): Promise<{ removed: boolean }> {
  const removed = await deleteOverride(unitName);
  if (!removed) return { removed: false };
  await daemonReload();
  await restartUnit(unitName);
  return { removed: true };
}
