import { mkdir } from "fs/promises";
import { join } from "path";
import { APP_DATA_DIR } from "../services/paths.js";
import { getDb } from "../services/chat-storage.js";
import { migrateInlineImagePayloads } from "../services/inline-image-payload-migration.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function numberArg(name: string): number | undefined {
  const prefix = `${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return undefined;
  const value = Number(arg.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

const apply = hasFlag("--apply");
const dryRun = !apply;
const limit = numberArg("--limit");
const persistMissing = !hasFlag("--no-persist-missing");

if (dryRun) {
  console.log("[inline-image-migration] dry run; pass --apply to rewrite rows");
} else {
  const backupDir = join(APP_DATA_DIR, "backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `app-inline-image-payloads-${stamp}.db`);
  await getDb().backup(backupPath);
  console.log(`[inline-image-migration] backup written: ${backupPath}`);
}

const result = await migrateInlineImagePayloads({ dryRun, limit, persistMissing });
console.log(JSON.stringify(result, null, 2));
