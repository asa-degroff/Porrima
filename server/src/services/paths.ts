import { existsSync, mkdirSync, renameSync } from "fs";
import { join, sep } from "path";
import { homedir } from "os";

export const APP_DATA_DIR_NAME = ".porrima";
export const LEGACY_APP_DATA_DIR_NAME = ".quje-agent";

export const APP_DATA_DIR = process.env.PORRIMA_DATA_DIR || join(homedir(), APP_DATA_DIR_NAME);
export const LEGACY_APP_DATA_DIR = process.env.QUJE_DATA_DIR || join(homedir(), LEGACY_APP_DATA_DIR_NAME);

function migrateLegacyDataDir(): void {
  if (process.env.PORRIMA_DATA_DIR) return;
  if (!existsSync(LEGACY_APP_DATA_DIR) || existsSync(APP_DATA_DIR)) return;
  try {
    renameSync(LEGACY_APP_DATA_DIR, APP_DATA_DIR);
    console.log(`[paths] Migrated data directory ${LEGACY_APP_DATA_DIR} -> ${APP_DATA_DIR}`);
  } catch (error: any) {
    console.warn(`[paths] Failed to migrate legacy data directory: ${error?.message || error}`);
    mkdirSync(APP_DATA_DIR, { recursive: true });
  }
}

function migrateLegacyDataFiles(): void {
  const legacyStatsDb = join(APP_DATA_DIR, "quje-agent.db");
  const statsDb = join(APP_DATA_DIR, "porrima.db");
  if (existsSync(legacyStatsDb) && !existsSync(statsDb)) {
    try {
      renameSync(legacyStatsDb, statsDb);
    } catch (error: any) {
      console.warn(`[paths] Failed to migrate legacy stats database: ${error?.message || error}`);
    }
  }
}

migrateLegacyDataDir();
migrateLegacyDataFiles();

export function appDataPath(...parts: string[]): string {
  return join(APP_DATA_DIR, ...parts);
}

/**
 * Directory holding llama.cpp KV snapshot files written by the
 * `/slots/{id}?action=save` API (see docs/design/kv-snapshot-parking.md).
 * llama.cpp concatenates `--slot-save-path` with the requested filename
 * WITHOUT inserting a separator, so flag rendering must always use
 * `kvCacheFlagPath()` — passing the bare dir produces sibling files next
 * to it (or a not-found error) instead of paths inside it.
 */
export const KV_CACHE_DIR = join(APP_DATA_DIR, "kv-cache");

/** The `--slot-save-path` value: KV_CACHE_DIR with a trailing separator. */
export function kvCacheFlagPath(): string {
  return KV_CACHE_DIR.endsWith(sep) ? KV_CACHE_DIR : `${KV_CACHE_DIR}${sep}`;
}

/** Idempotent; called before rendering a launch config that references it. */
export function ensureKvCacheDir(): void {
  try {
    mkdirSync(KV_CACHE_DIR, { recursive: true });
  } catch (error: any) {
    console.warn(`[paths] Failed to create KV cache dir: ${error?.message || error}`);
  }
}

// Same import-time guarantee as the legacy migrations above: any process that
// loads path data has the snapshot dir ready before a managed unit can
// reference it. llama-server only needs the directory to exist at save time,
// but creating it eagerly also lets `/slots ?action=save` work by hand.
ensureKvCacheDir();
