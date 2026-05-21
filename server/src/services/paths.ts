import { existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
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
