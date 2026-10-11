/**
 * Smoke test for KV snapshot parking against a LIVE llama.cpp server
 * (docs/design/kv-snapshot-parking.md §11). Exercises the full disk-tier
 * round trip on a throwaway slot:
 *
 *   cold prefill → save → file on disk → erase → restore → repinned replay
 *
 * Asserts `n_saved == n_restored` and an iteration-1 `cached_tokens` hit on
 * the replay. Then cleans up (erase the slot, unlink the file).
 *
 * Run manually per release — needs a parking-capable server (the managed
 * inference slot, which always renders --slot-save-path) and a GPU host:
 *
 *   npx tsx src/scripts/smoke-kv-snapshot.ts
 *
 * Env overrides:
 *   KV_SMOKE_BASE_URL    default http://localhost:8080
 *   KV_SMOKE_MODEL       default: first model from /v1/models
 *   KV_SMOKE_TOKENS      default 3000 (synthetic prompt size)
 *   KV_SMOKE_SAVE_DIR    default ~/.porrima/kv-cache (the --slot-save-path dir)
 *
 * The script uses one idle slot briefly; run it while the server is quiet.
 * It never touches the app database.
 */
import { randomUUID } from "crypto";
import { existsSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE = process.env.KV_SMOKE_BASE_URL || "http://localhost:8080";
const MODEL = process.env.KV_SMOKE_MODEL || "";
const TOKENS = Number(process.env.KV_SMOKE_TOKENS || 3000);
const SAVE_DIR = process.env.KV_SMOKE_SAVE_DIR || join(homedir(), ".porrima", "kv-cache");
const FILENAME = `smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}.bin`;

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    cleanup();
    process.exit(1);
  }
  console.log("ok:", msg);
}

function cleanup(): void {
  try {
    if (existsSync(join(SAVE_DIR, FILENAME))) unlinkSync(join(SAVE_DIR, FILENAME));
  } catch {
    // best effort
  }
}

const j = async (url: string, init?: RequestInit) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
};

const post = (url: string, body: unknown) =>
  j(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function main(): Promise<void> {
  // 1. Discover the model and an idle slot.
  const models: any = await j(`${BASE}/v1/models`);
  const modelId = MODEL || models?.data?.[0]?.id || models?.models?.[0]?.name;
  assert(typeof modelId === "string" && modelId.length > 0, "model available");

  const slotsBody: any = await j(`${BASE}/slots`);
  const slots: any[] = Array.isArray(slotsBody) ? slotsBody : Array.isArray(slotsBody?.slots) ? slotsBody.slots : [];
  const idle = slots.find((s) => !s.is_processing && (s.n_prompt_tokens ?? 0) === 0);
  assert(idle, "found an idle slot with no prompt tokens");
  const slotId: number = idle.id;
  console.log(`using slot ${slotId}, model ${modelId}, ~${TOKENS} synthetic tokens`);

  // 2. Synthetic prompt: deterministic filler long enough to make the
  //    round trip measurable (a few hundred KB of KV, not terabytes).
  const filler = Array.from({ length: Math.ceil(TOKENS / 20) }, (_, i) =>
    `sentence ${i}: the quick brown fox jumps over the lazy dog near the riverbank`,
  ).join(" ");
  const messages = [
    { role: "system", content: "KV snapshot smoke. Reply with exactly: ok" },
    { role: "user", content: filler },
  ];
  const reqBody = {
    model: modelId,
    messages,
    stream: false,
    max_tokens: 8,
    id_slot: slotId,
  };

  // 3. Cold prefill on the pinned slot.
  const first: any = await post(`${BASE}/v1/chat/completions`, reqBody);
  const promptTokens = first?.usage?.prompt_tokens;
  const firstCached = first?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  assert(typeof promptTokens === "number" && promptTokens >= TOKENS * 0.5, `cold prefill processed ${promptTokens} prompt tokens`);
  assert(firstCached < promptTokens * 0.5, `first request is cold (cached ${firstCached}/${promptTokens})`);

  // 4. Save the slot to the parking directory.
  const save: any = await post(`${BASE}/slots/${slotId}?action=save`, { filename: FILENAME });
  assert(typeof save?.n_saved === "number" && save.n_saved >= promptTokens, `save wrote ${save?.n_saved} tokens (${save?.n_written} bytes)`);
  const filePath = join(SAVE_DIR, FILENAME);
  assert(existsSync(filePath), "snapshot file exists on disk");
  console.log(`ok: file size ${statSync(filePath).size} bytes`);

  // 5. Erase the slot — it must come back empty.
  await post(`${BASE}/slots/${slotId}?action=erase`, {});
  const afterEraseBody: any = await j(`${BASE}/slots`);
  const afterErase: any[] = Array.isArray(afterEraseBody) ? afterEraseBody : Array.isArray(afterEraseBody?.slots) ? afterEraseBody.slots : [];
  const erased = afterErase.find((s: any) => s.id === slotId);
  assert((erased?.n_prompt_tokens ?? 0) === 0, "slot verified empty after erase");

  // 6. Restore from the file.
  const restore: any = await post(`${BASE}/slots/${slotId}?action=restore`, { filename: FILENAME });
  assert(restore?.n_restored === save.n_saved, `restore round trip: n_restored ${restore?.n_restored} == n_saved ${save.n_saved}`);

  // 7. Repinned replay: the same prompt must now hit the restored KV.
  const replay: any = await post(`${BASE}/v1/chat/completions`, reqBody);
  const replayPrompt = replay?.usage?.prompt_tokens;
  const replayCached =
    replay?.usage?.prompt_tokens_details?.cached_tokens ?? replay?.usage?.cacheRead ?? 0;
  assert(
    typeof replayPrompt === "number" && replayPrompt === promptTokens && replayCached >= replayPrompt * 0.9,
    `replay hit the restored KV: cached ${replayCached}/${replayPrompt}`,
  );

  // 8. Cleanup: free the slot and remove the file.
  await post(`${BASE}/slots/${slotId}?action=erase`, {});
  cleanup();
  assert(!existsSync(filePath), "snapshot file removed");

  console.log("\nSMOKE PASSED");
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  cleanup();
  process.exit(1);
});
