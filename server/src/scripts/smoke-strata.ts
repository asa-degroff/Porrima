/**
 * Smoke test for the Strata inference backend (docs/design/strata-backend.md
 * §11). Ordered like the llama.cpp upgrade checklist: request-path checks,
 * then observability, then parking.
 *
 *   npx tsx src/scripts/smoke-strata.ts
 *
 * Default mode is READ-ONLY: health, model/props parsing, router-endpoint
 * absence, slots shape. It never loads or evicts server state.
 *
 * Opt-in suites (each disturbs the live session — run while it is quiet):
 *   STRATA_SMOKE_GENERATION=1   native-mirror audit (/apply-template,
 *                               /tokenize, /detokenize, /completion — these
 *                               exist on live builds and touch engine
 *                               state), streaming usage/timings/
 *                               prompt_progress, tool round-trip, cache
 *                               reuse on replay.
 *   STRATA_SMOKE_PARKING=1      slot-0 save/restore round trip against the
 *                               configured slot_save_path (restore replaces
 *                               the engine's live session by design).
 *
 * Env overrides:
 *   STRATA_SMOKE_BASE_URL   default http://localhost:8080
 *   STRATA_SMOKE_API_KEY    bearer key when the server has api_key set
 *   STRATA_SMOKE_MODEL      default: first text-output id from /v1/models
 *   STRATA_SMOKE_TOKENS     synthetic prompt size for progress checks,
 *                           default 4000
 *   STRATA_SMOKE_SAVE_DIR   slot_save_path directory, default
 *                           ~/.porrima/kv-cache
 *
 * The script never touches the app database.
 */
import { randomUUID } from "crypto";
import { existsSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const BASE = (process.env.STRATA_SMOKE_BASE_URL || "http://localhost:8080").replace(/\/+$/, "");
const API_KEY = process.env.STRATA_SMOKE_API_KEY || "";
const MODEL_OVERRIDE = process.env.STRATA_SMOKE_MODEL || "";
const TOKENS = Number(process.env.STRATA_SMOKE_TOKENS || 4000);
const SAVE_DIR = process.env.STRATA_SMOKE_SAVE_DIR || join(homedir(), ".porrima", "kv-cache");
const GENERATION = process.env.STRATA_SMOKE_GENERATION === "1";
const PARKING = process.env.STRATA_SMOKE_PARKING === "1";
const FILENAME = `smoke-strata-${randomUUID().replace(/-/g, "").slice(0, 12)}.bin`;

let failures = 0;
function check(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  ok: ${msg}`);
  } else {
    failures++;
    console.error(`  FAIL: ${msg}`);
  }
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (API_KEY) h.Authorization = `Bearer ${API_KEY}`;
  return h;
}

async function getJson(path: string): Promise<{ status: number; body: any } | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err: any) {
    console.error(`  request failed: GET ${path}: ${err?.message || err}`);
    return null;
  }
}

function fillerTokens(n: number): string {
  // Reproducible near-token filler; ~4 chars/token is close enough for a
  // prefill-size smoke target and never matches a real conversation prefix.
  const words = ("porrima strata smoke filler sequence alpha bravo charlie delta echo foxtrot golf hotel india juliet "
    + "kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ").split(" ");
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(words[i % words.length]);
  return out.join(" ");
}

let MODEL = MODEL_OVERRIDE;

async function stepDiscovery(): Promise<void> {
  console.log(`\n[1] health — GET ${BASE}/health`);
  const health = await getJson("/health");
  check(health?.status === 200, "/health answers 200");
  if (health?.body && typeof health.body === "object") {
    console.log(`      status=${health.body.status} loaded=${health.body.loaded} model=${health.body.model} max_context=${health.body.max_context}`);
  }

  console.log("\n[2] /v1/models — parse what Porrima discovery reads");
  const models = await getJson("/v1/models");
  check(models?.status === 200, "/v1/models answers 200");
  const data: any[] = Array.isArray(models?.body?.data) ? models.body.data : [];
  check(data.length > 0, "data[] non-empty (server lists at least one model)");
  if (!MODEL) MODEL = data.find((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))?.id || data[0]?.id || "";
  const entry = data.find((m) => m.id === MODEL) || data[0];
  check(!!entry?.id, `model id: ${entry?.id}`);
  check(typeof entry?.meta?.n_ctx === "number", `meta.n_ctx present (${entry?.meta?.n_ctx})`);
  console.log(`      status.value=${entry?.status?.value ?? "(absent — single-model listing)"} input_modalities=${JSON.stringify(entry?.architecture?.input_modalities ?? [])}`);

  console.log("\n[3] /props — alias, vision, context, slots");
  const props = await getJson("/props");
  check(props?.status === 200, "/props answers 200");
  check(typeof props?.body?.model_alias === "string", `model_alias=${props?.body?.model_alias}`);
  check(typeof props?.body?.modalities?.vision === "boolean", `modalities.vision=${props?.body?.modalities?.vision}`);
  check(typeof props?.body?.default_generation_settings?.n_ctx === "number", `default_generation_settings.n_ctx=${props?.body?.default_generation_settings?.n_ctx}`);
  console.log(`      total_slots=${props?.body?.total_slots} is_sleeping=${props?.body?.is_sleeping} build_info=${props?.body?.build_info}`);
  const perModel = await getJson(`/props?model=${encodeURIComponent(props?.body?.model_alias || MODEL)}`);
  check(perModel?.status === 200, "?model=<loaded alias> resolves (unknown names 404 by design)");
}

async function stepNativeAbsence(): Promise<void> {
  console.log("\n[4] router control endpoints are absent (404 expected, harmless probe)");
  for (const [method, path, body] of [
    ["POST", "/models/load", { model: MODEL || "x" }],
    ["POST", "/models/unload", { model: MODEL || "x" }],
  ] as Array<[string, string, any]>) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: headers(true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      check(res.status === 404 || res.status === 405, `${method} ${path} → ${res.status}`);
    } catch (err: any) {
      check(false, `${method} ${path} unreachable: ${err?.message || err}`);
    }
  }
  console.log("      note: /completion, /apply-template, /tokenize, /detokenize exist on live");
  console.log("      builds (0.1.45+) and touch engine state — audited in the GENERATION suite.");
}

async function stepSlots(): Promise<void> {
  console.log("\n[5] /slots — capacity + cold-gate field");
  const slots = await getJson("/slots");
  check(slots?.status === 200, "/slots answers 200");
  const arr = Array.isArray(slots?.body) ? slots.body : Array.isArray(slots?.body?.slots) ? slots.body.slots : null;
  check(arr !== null, "array (or {slots:[]}) shape");
  if (arr && arr.length > 0) {
    const s = arr[0];
    check(typeof s.is_processing === "boolean", `is_processing=${s.is_processing}`);
    check(typeof s.n_prompt_tokens === "number", `n_prompt_tokens=${s.n_prompt_tokens}`);
    console.log(`      entries=${arr.length} n_ctx=${s.n_ctx} processed=${s.n_prompt_tokens_processed ?? "(absent)"} cached=${s.n_prompt_tokens_cache ?? "(absent)"}`);
  }
}

async function postChat(payload: any): Promise<Response> {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
}

async function stepGeneration(): Promise<void> {
  console.log("\n[6] native-mirror endpoint audit (they exist on live builds; each call reads engine state)");
  const at = await fetch(`${BASE}/apply-template`, {
    method: "POST", headers: headers(true), signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "ping test" }] }),
  });
  const atBody: any = await at.json().catch(() => null);
  check(at.ok && typeof atBody?.prompt === "string" && atBody.prompt.length > 0,
    `apply-template → ${at.status}, prompt ${atBody?.prompt?.length ?? 0} chars`);
  const tk = await fetch(`${BASE}/tokenize`, {
    method: "POST", headers: headers(true), signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ model: MODEL, content: "hello world smoke probe", add_special: false }),
  });
  const tkBody: any = await tk.json().catch(() => null);
  check(tk.ok && Array.isArray(tkBody?.tokens) && tkBody.tokens.every((t: unknown) => typeof t === "number"),
    `tokenize → ${tk.status}, tokens=${JSON.stringify(tkBody?.tokens ?? [])}`);
  const dt = await fetch(`${BASE}/detokenize`, {
    method: "POST", headers: headers(true), signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ model: MODEL, tokens: (tkBody?.tokens ?? []).slice(0, 2) }),
  });
  const dtBody: any = await dt.json().catch(() => null);
  check(dt.ok && typeof dtBody?.content === "string", `detokenize → ${dt.status}, round-trips tokenize prefix`);
  const cm = await fetch(`${BASE}/completion`, {
    method: "POST", headers: headers(true), signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model: MODEL, prompt: "x", n_predict: 0, cache_prompt: true, return_tokens: false }),
  });
  const cmBody: any = await cm.json().catch(() => null);
  check(cm.ok && typeof cmBody?.tokens_evaluated === "number" && cmBody?.timings,
    `completion n_predict:0 → ${cm.status}, evaluated=${cmBody?.tokens_evaluated} predicted=${cmBody?.tokens_predicted} timings.cache_n=${cmBody?.timings?.cache_n}`);
  console.log("      note: n_predict:0 still predicts one token on Strata — the native warm chain");
  console.log("      would work but Porrima's seeding warm is the supported path (design §6).");

  console.log("\n[7] streaming chat — usage, timings, prompt_progress (STRATA_SMOKE_GENERATION=1)");
  const longPrompt = fillerTokens(TOKENS);
  const res = await postChat({
    model: MODEL,
    messages: [
      { role: "system", content: `You are a cache smoke probe. Reply with OK after reading. ${longPrompt}` },
      { role: "user", content: "Reply with exactly: OK" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    return_progress: true,
    max_tokens: 8,
  });
  check(res.ok && res.body, `POST /v1/chat/completions stream → ${res.status}`);

  let sawProgress = false;
  let sawUsage = false;
  let sawTimings = false;
  let sawFinish = false;
  let cached: number | undefined;
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.prompt_progress) {
          sawProgress = true;
          const p = chunk.prompt_progress;
          if (typeof p.total === "number" && p.total > 0 && typeof p.processed === "number") {
            console.log(`      prompt_progress total=${p.total} cache=${p.cache} processed=${p.processed} time_ms=${p.time_ms}`);
          }
        }
        if (chunk.usage) {
          sawUsage = true;
          cached = chunk.usage.prompt_tokens_details?.cached_tokens;
          console.log(`      usage prompt=${chunk.usage.prompt_tokens} completion=${chunk.usage.completion_tokens} cached=${cached}`);
        }
        if (chunk.timings) {
          sawTimings = true;
          console.log(`      timings cache_n=${chunk.timings.cache_n} prompt_n=${chunk.timings.prompt_n} prompt_ms=${chunk.timings.prompt_ms} predicted_n=${chunk.timings.predicted_n}`);
        }
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) sawFinish = true;
      }
    }
  }
  check(sawFinish, "final chunk carries finish_reason");
  check(sawUsage, "usage on the final chunk");
  check(sawTimings, "timings on the final chunk");
  check(typeof cached === "number", "usage.prompt_tokens_details.cached_tokens is a number");
  if (!sawProgress) {
    console.log("      note: no prompt_progress chunk — prompts shorter than one --prefill chunk send none by design");
  }

  console.log("\n[8] tool round-trip");
  const toolRes = await postChat({
    model: MODEL,
    messages: [{ role: "user", content: "Call the smoke_ping tool with message 'ping'. No prose." }],
    stream: false,
    tools: [{
      type: "function",
      function: {
        name: "smoke_ping",
        description: "Ping the smoke probe.",
        parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    }],
    max_tokens: 64,
  });
  const toolBody: any = await toolRes.json().catch(() => null);
  const call = toolBody?.choices?.[0]?.message?.tool_calls?.[0];
  check(toolRes.ok && call?.function?.name === "smoke_ping", `tool_calls returned (${toolBody?.choices?.[0]?.finish_reason})`);
  try { JSON.parse(call?.function?.arguments || "{}"); check(true, "tool arguments are JSON"); }
  catch { check(false, `tool arguments not JSON: ${call?.function?.arguments}`); }

  console.log("\n[9] cache reuse — replay extended prefix");
  const replay = await postChat({
    model: MODEL,
    messages: [
      { role: "system", content: `You are a cache smoke probe. Reply with OK after reading. ${longPrompt}` },
      { role: "user", content: "Reply with exactly: OK" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Reply with exactly: OK again" },
    ],
    stream: false,
    max_tokens: 8,
  });
  const replayBody: any = await replay.json().catch(() => null);
  const replayCached = replayBody?.usage?.prompt_tokens_details?.cached_tokens;
  check(typeof replayCached === "number", `replay reports cached_tokens=${replayCached}`);
  if (typeof replayCached === "number" && replayCached === 0) {
    console.log("      note: replay read cold (engine swapped session or checkpoints rotated) — informational");
  }
}

async function stepParking(): Promise<void> {
  console.log("\n[10] slot-0 save/restore (STRATA_SMOKE_PARKING=1)");
  const saveRes = await fetch(`${BASE}/slots/0?action=save`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ filename: FILENAME }),
    signal: AbortSignal.timeout(600_000),
  });
  const saveBody: any = await saveRes.json().catch(() => null);
  if (saveRes.status === 501) {
    check(true, `save 501 = unsupported as designed (no slot_save_path, or --batch): ${saveBody?.error?.message || saveBody?.error || saveBody?.message || ""}`);
    console.log("      parking would report 'unsupported' and stay off on this server");
    return;
  }
  check(saveRes.ok && !saveBody?.error, `save → ${saveRes.status}`);
  check(typeof saveBody?.n_saved === "number", `n_saved=${saveBody?.n_saved}`);
  check(typeof saveBody?.n_written === "number", `n_written=${saveBody?.n_written}`);
  check(typeof saveBody?.timings?.save_ms === "number", `timings.save_ms=${saveBody?.timings?.save_ms}`);
  const path = join(SAVE_DIR, FILENAME);
  check(existsSync(path), `file exists at ${path} (Porrima prune unlinks from here)`);
  const bytes = existsSync(path) ? statSync(path).size : 0;
  check(bytes === saveBody?.n_written, `file bytes (${bytes}) match n_written`);

  const restoreRes = await fetch(`${BASE}/slots/0?action=restore`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({ filename: FILENAME }),
    signal: AbortSignal.timeout(600_000),
  });
  const restoreBody: any = await restoreRes.json().catch(() => null);
  check(restoreRes.ok && !restoreBody?.error, `restore → ${restoreRes.status}`);
  check(restoreBody?.n_restored === saveBody?.n_saved, `n_restored=${restoreBody?.n_restored} equals n_saved=${saveBody?.n_saved}`);
  check(typeof restoreBody?.timings?.restore_ms === "number", `timings.restore_ms=${restoreBody?.timings?.restore_ms}`);
  cleanupParking();
}

function cleanupParking(): void {
  try {
    const path = join(SAVE_DIR, FILENAME);
    if (existsSync(path)) {
      unlinkSync(path);
      console.log(`      cleaned ${path}`);
    }
  } catch (err: any) {
    console.error(`      cleanup failed (Strata has no erase action; file ${FILENAME} must go by hand):`, err?.message || err);
  }
}

async function main(): Promise<void> {
  console.log(`Strata backend smoke — ${BASE}${MODEL_OVERRIDE ? ` model=${MODEL_OVERRIDE}` : ""}`);
  if (!GENERATION && !PARKING) {
    console.log("read-only mode (set STRATA_SMOKE_GENERATION=1 and/or STRATA_SMOKE_PARKING=1 for the state-touching suites)");
  }
  await stepDiscovery();
  await stepNativeAbsence();
  await stepSlots();
  if (GENERATION) await stepGeneration();
  if (PARKING) await stepParking();

  if (failures > 0) {
    console.error(`\nFAILED: ${failures} check(s)`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error("smoke aborted:", err);
  process.exit(1);
});
