import { mkdir } from "fs/promises";
import { join } from "path";
import { getDb } from "../services/chat-storage.js";
import { migrateToolResultImagePayloads } from "../services/tool-result-image-payload-migration.js";
import { APP_DATA_DIR } from "../services/paths.js";

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

if (dryRun) {
  console.log("[tool-result-image-migration] dry run; pass --apply to rewrite rows");
} else {
  const backupDir = join(APP_DATA_DIR, "backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `app-tool-result-image-payloads-${stamp}.db`);
  await getDb().backup(backupPath);
  console.log(`[tool-result-image-migration] backup written: ${backupPath}`);
}

const result = await migrateToolResultImagePayloads({ dryRun, limit });
console.log(JSON.stringify(result, null, 2));
