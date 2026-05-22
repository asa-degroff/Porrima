import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SYSTEMD_USER_DIR = path.join(os.homedir(), ".config", "systemd", "user");
const OVERRIDE_FILENAME = "zz-porrima-managed.conf";
const OLD_MANAGED_OVERRIDE_FILENAME = "porrima-managed.conf";
const LEGACY_OVERRIDE_FILENAME = "porrima-model.conf";

const HEADER = [
  "# Managed by Porrima — written by the llama.cpp service settings UI.",
  "# To change this service, use Settings → Inference Servers.",
  "# To revert to the unit's default, delete this file or use Reset managed override.",
].join("\n");

function overridePath(unitName: string, filename = OVERRIDE_FILENAME): string {
  return path.join(SYSTEMD_USER_DIR, `${unitName}.d`, filename);
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
  const managed = overridePath(unitName);
  const oldManaged = overridePath(unitName, OLD_MANAGED_OVERRIDE_FILENAME);
  const legacy = overridePath(unitName, LEGACY_OVERRIDE_FILENAME);
  for (const target of [managed, oldManaged, legacy]) {
    try {
      const contents = await fs.readFile(target, "utf-8");
      return { exists: true, path: target, contents };
    } catch {}
  }
  return { exists: false, path: managed };
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
  await fs.unlink(overridePath(unitName, OLD_MANAGED_OVERRIDE_FILENAME)).catch(() => {});
  await fs.unlink(overridePath(unitName, LEGACY_OVERRIDE_FILENAME)).catch(() => {});
  return target;
}

export async function deleteOverride(unitName: string): Promise<boolean> {
  let removed = false;
  for (const target of [overridePath(unitName), overridePath(unitName, OLD_MANAGED_OVERRIDE_FILENAME), overridePath(unitName, LEGACY_OVERRIDE_FILENAME)]) {
    try {
      await fs.unlink(target);
      removed = true;
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
  }
  try {
    // Best-effort cleanup of an empty .d directory.
    await fs.rmdir(path.dirname(overridePath(unitName)));
  } catch {}
  return removed;
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
  const previous = await readOverride(unitName);
  const target = await writeOverride(unitName, execStart, options);
  try {
    await daemonReload();
    await restartUnit(unitName);
  } catch (e) {
    try {
      if (previous.exists && previous.contents) {
        await ensureDir(path.dirname(previous.path));
        await fs.writeFile(previous.path, previous.contents, "utf-8");
        if (previous.path !== target) await fs.unlink(target).catch(() => {});
      } else {
        await deleteOverride(unitName);
      }
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
