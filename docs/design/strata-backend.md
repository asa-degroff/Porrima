# Strata Inference Backend

**Status:** implemented — backend seam, turn path, stream-fed prefill,
seeding warm, single-slot parking, settings surfaces, the external-server
row on the llama-servers panel, and the smoke script (§3–§11) are live. The
API contract is verified against a running Strata host (engine 0.1.45.3);
end-to-end Porrima turns await a backend switch. Follow-ups named in
§5/§7: unified progress source on llama.cpp, first-class llama.cpp
single-slot parking.

This document adds a second backend for the inference slot
(`LlamaServerId = "inference"`). Strata is an external OpenAI-compatible
server built on a custom engine plus ggml parts. It is not `llama-server`.
It records the API contract Porrima consumes, the dispatch seam,
and the per-subsystem behavior changes.

## 1. Problem

Porrima's inference slot talks to llama.cpp as an OpenAI-compatible server
**plus** a set of native control endpoints (`/completion`, `/apply-template`,
`/tokenize`, `/detokenize`, `/slots/<id>?action=…`, `/models/load`,
`/models/unload`). See [llama-cpp-api-surface.md](../llama-cpp-api-surface.md).
Strata runs a large MoE model on consumer hardware and exposes only the
OpenAI-compatible surface, with llama.cpp-compatible **field names** where it
matters (`timings`, `n_prompt_tokens`, `prompt_progress`, slot save/restore
results). Its engine replaces the native endpoints' purpose: it maintains a
checkpoint conversation cache automatically, so byte-identical prefixes are
reused without a warm pass.

Goal: run all inference-slot traffic — agent chats, system chats, synthesis,
wake cycles, automations, and vision — against either backend, selected in
Settings. Non-goals:

- **Strata as a supervisor target.** Strata is launched and updated by the
  user (`strata launch` or its app). Porrima probes HTTP only.
- **Strata for the other slots.** extraction, reranker, embedding, and
  title-generation stay on llama.cpp. Strata serves one loaded model; it has
  no `/v1/rerank` or `/v1/embeddings`.
- **Router features.** No per-model child ports, no `/models/load` args, no
  model switching over HTTP. Model choice is a Strata-side operation.

## 2. Consumed API Contract (verified against Strata serve/server.py)

Base URL default: `http://127.0.0.1:8080`. Porrima consumes:

| Endpoint | Strata behavior Porrima relies on |
| --- | --- |
| `GET /health` | 200 JSON with `loaded`, `max_context`, `model`. Porrima reads HTTP status, plus `loaded` for restart/idle-unload detection. |
| `GET /v1/models` | `data[].id`, `data[].meta.n_ctx`, `architecture.input_modalities` / `output_modalities`. `data[].status.value` (`loaded`/`unloaded`) appears only when idle-unload is configured; single-model serving omits `status`. No `status.args`, no `max_model_len`. An Ollama-style `models[]` list with `capabilities` is also present on live builds. |
| `GET /props` | `default_generation_settings.n_ctx`, `model_alias`, `modalities.vision`, `total_slots`, `is_sleeping`, `chat_template_caps`, `model_path`, `build_info`. No top-level `n_ctx`, no `max_instances`. `?model=<id>` must match the loaded name or an alias, else 404. `build_info` carries a llama.cpp-style tag (`b11669-...`). |
| `GET /slots` | Array of `{id, n_ctx, is_processing, n_prompt_tokens}`; one entry unless `--batch`. `n_prompt_tokens` is the running request's prompt size and is kept after the request. Live builds also carry `n_prompt_tokens_processed` / `n_prompt_tokens_cache`, but idle values can read 0 while the engine reports cached tokens — do not trust the cache alias. Returns `[]` when the engine is down. |
| `POST /slots/0?action=save\|restore` | Body key `filename`; result keys `n_saved`/`n_written`/`n_restored`/`n_read`/`timings`. Slot 0 only. No `erase` action. Needs Strata's `slot_save_path` launch config (`501` without it, and with `--batch`). Files are Strata's own format, bound to a model+config fingerprint. |
| `POST /v1/chat/completions` | Full stream and non-stream; `tools` with `tool_calls` and correct `finish_reason`; image parts; `reasoning_content` deltas; `chat_template_kwargs.enable_thinking` honored; `reasoning_effort` honored. |

Response accounting that keeps Porrima's pipeline intact:

- Final chunk carries `usage` with `prompt_tokens`, `completion_tokens`,
  `total_tokens`, and `usage.prompt_tokens_details.cached_tokens`.
- Final chunk carries `timings` in llama.cpp names: `cache_n`, `prompt_n`,
  `prompt_ms`, `prompt_per_token_ms`, `prompt_per_second`, `predicted_n`,
  `predicted_ms`, `predicted_per_token_ms`, `predicted_per_second`.
  `load_ms` and `sample_ms` do not exist; both are optional consumers.
- With `"return_progress": true` in the request body, chunks with an empty
  delta carry `prompt_progress {total, cache, processed, time_ms}` with
  llama.cpp semantics: timed progress is `(processed - cache) / (total - cache)`.

Fields Porrima may send that Strata ignores (verified: no rejection of
unknown body fields): `cache_prompt`, `stream_options`, `id_slot`,
`chat_template_kwargs.preserve_thinking`. Porrima omits `id_slot` and
`cache_prompt` for this backend instead of relying on ignore behavior.

Endpoints that do not exist on Strata: `/models/load`, `/models/unload`,
`/infill`, `/predict`, `/v1/embeddings`, `/v1/rerank`. Strata's equivalents,
when needed: `/load` + `/unload` (process-level, not per model),
`/status` + `/v1/status` (busy stage), `/metrics` (engine telemetry),
`/v1/messages/count_tokens` (Anthropic-shaped, unused by Porrima).

Native-mirror note (live-verified against engine 0.1.45.3, build
b11669): `/completion`, `/apply-template`, `/tokenize`, and `/detokenize`
**do** answer on current Strata builds under llama.cpp's field names
(`prompt`, `tokens`, `content`, `tokens_evaluated`, `timings.cache_n`), even
though Strata's own API table does not document them. Two divergences keep
them out of Porrima's supported path: `n_predict: 0` still predicts one
token, and the mirrors are undocumented surface — free to change. The
seeding warm (§6) and the stream-fed prefill (§5) stay the contract. Hosts
may use the mirrors for external tooling.

## 3. Backend Resolution and Dispatch

`types.ts`:

- `export type InferenceProvider = "llamacpp" | "strata";`
- New settings keys (§9). `inferenceBackend` defaults to `"llamacpp"`; no
  env gate.

`llama-ports.ts`: add `STRATA_DEFAULT_PORT = 8080` and
`getDefaultStrataUrl()`. Resolution idiom stays
`settings.strataUrl || getDefaultStrataUrl()` when the backend is strata;
`llamacppUrl` keeps its meaning for llama.cpp.

`llm-provider.ts`: register the provider entry list with both ids. The api
function stays `streamOpenAICompat` for both; behavior branches on
`model.provider` inside the provider module. `createPiModelFromProvider`
copies the backend id onto each model so downstream gates read
`model.provider` as they already do today.

Provider gates. Each current `provider === "llamacpp"` check becomes an
explicit decision:

| Site | llama.cpp behavior | Strata behavior |
| --- | --- | --- |
| `routes/chat.ts:2162`, `chat-turn-runner.ts:854` (lease acquire) | lease when enforced | no lease; §7 |
| `routes/chat.ts:2914` (exact token capability) | `exact: true` | `exact: false` — char estimates |
| `routes/chat.ts:3995` and warm trigger sites | native warm | seed warm (§6) |

Shared helpers `isLlamaNativeBackend(model)` (router, native endpoints) and
`isLocalInferenceBackend(model)` (both) replace the boolean gates.

## 4. Turn Path Changes in `openai-compat-provider.ts`

- **Router dance skipped.** `ensureModelLoaded`, `waitForModelReady`,
  `unloadModel`, and the stale-child retry never run when
  `model.provider === "strata"`. Today they are already 404-tolerant; the
  skip removes three dead HTTP calls per turn and the `--ctx-size` reload
  logic, which has no Strata meaning.
- **Request body policy.** Keep `stream`, `stream_options.include_usage`
  (harmless), `max_tokens`, `temperature`, `tools`, `messages`,
  `chat_template_kwargs.enable_thinking`, and `preserve_thinking` (ignored
  server-side; Strata preserves `reasoning_content` in replayed history by
  design). Drop `id_slot` and `cache_prompt`. Add `return_progress: true`
  when the prefill monitor is active (§5).
- **Vision.** Skip the llama.cpp mtmd normalization chain
  (`resolveImagePixelBudget`, `normalizeImageForLlamaCpp`, the 28-pixel grid
  assumption) under Strata. Send image parts as stored. Strata runs the
  image reader CPU/GPU-side per its own policy.
- **Loaded-model cache.** For Strata it keys on the single `model_alias`;
  reload-on-5xx behavior stays, since a Strata idle-unload answers requests
  by loading first (no 404/`exited` states to poll).
- **Error surface.** Connection errors and non-2xx remain `llama.cpp API
  error`-shaped strings today; reword the prefix to the backend name.

## 5. Prefill Indicator and Token Accounting

The current prefill monitor polls `GET /slots?model=` every second and reads
processed-token aliases. Strata reports no processed count there. Change the
source instead of the event shape:

- Under Strata, the monitor does not poll. `streamOpenAICompat` parses
  `prompt_progress` chunks and feeds the same progress events through the
  existing channel (`onModelProgress`).
- `total` from the first `prompt_progress` chunk is the exact prefill
  denominator; store it on the run record. Until it arrives, use the char
  estimate (the current last-resort path).
- Prelude chunks never reach the generation-started boundary. Strata puts
  two silent chunk kinds on the stream before the first token: the
  `prompt_progress` frames and the OpenAI role opener
  `{"role":"assistant","content":""}` (llama.cpp sends the opener only with
  its first token, after prefill). The provider feeds progress frames to the
  monitor and skips silent chunks (`isStreamPreludeChunk`), so the
  dual-phase activity spinner (slow prefill / fast decode) stays in the
  prefill state until a chunk carries real signal.
- Cache state: `cache` on the first progress chunk, else
  `usage.prompt_tokens_details.cached_tokens` / `timings.cache_n` after the
  turn. `determineCacheState` keeps its `"unknown"` fallback.
- `return_progress` is llama.cpp's own mechanism — recent builds answer it
  with the same four fields. The stream feed is therefore backend-neutral:
  moving llama.cpp to the same source (poll as fallback for older builds)
  is a follow-up, not a Strata special.

Token accounting needs no change. Strata's `timings` and `cached_tokens`
satisfy `captureLlamaRun`, `recordModelStats`, `resolveCanonicalCachedTokens`
(Strata's `prompt_n` excludes `cache_n`, so the reported-vs-delta rule stays
consistent), `context-high-water`, and the cache-residency ledger. Rename the
ledger's internal "slot" key to `slotId: 0` under Strata; it stays a single
pool keyed by `(baseUrl, modelId)`.

Restart detection: the scheduler's PID check does not apply (no managed
unit). Watch `loaded: true → false` on `GET /health` plus connection-reset
events; on the false→true edge, clear residency and the loaded-model cache,
and mark disk-parked snapshots stale (§7).

## 6. Warm: Seeding Replaces the Native Path

`cache-warm.ts`'s `/apply-template` + sentinel + `/tokenize`/`/detokenize` +
`/completion n_predict:0` chain has no Strata equivalent and is not needed.
Strata takes a checkpoint at every assistant-turn start, every 16K prompt
tokens, and permanently at the system-prompt root (when 2,048 tokens or more)
while the engine is up.

Strata warm design:

- Build the seed body from the same helper that builds the live body
  (the byte-identity contract carries over unchanged, and it is still what
  makes the prefix match).
- `POST /v1/chat/completions` with the chat's stable-prefix message array,
  `max_tokens: 1`, no `strata_checkpoint` field (checkpoints must be saved),
  streamed false. The engine reads the whole prefix and leaves the deepest
  checkpoint at the assistant-turn boundary. The next real turn resumes from
  it; only the tail after the checkpoint is read.
- The one generated token is discarded; it does not enter the checkpoint.
- The queue (`cache-warm-queue.ts`) keeps its schedule, preemption, and
  turn-gate lease behavior. Busy probe changes: `GET {baseUrl}/slots` on the
  main URL (no child `--port` reconstruction from `status.args`), same
  timeout-means-busy rule.
- Warm result accounting: read `usage.prompt_tokens_details.cached_tokens`
  and `timings` from the seed response to fill the residency record and the
  `warmed` flag.
- Baseline warm for new agent chats: same seed with `buildStablePrefix()`.
  Post-synthesis warms and the sleep-cycle prewarm keep their trigger sites;
  only the mechanism swaps.

Failure behavior: seed errors resolve the queue job as `warmed: false` with
the error, as today. No hard-throw chains are reachable on the Strata path.

## 7. Leases and Parking: one target model, per-backend transport

**Slot leases.** `acquire()` returns null when the inference backend is
Strata: `id_slot` is ignored by the server, and `--batch` self-allocates.
`llamacppSlotBindingMode` stays llama-only. Capacity discovery is unused on
the Strata path.

**Parking targets.** The parking policy layer (eligibility gates, debounce,
growth gate, byte budget, TTL, breaker) is backend-agnostic. It operates on
a parking target: one physical slot on one server. Two ways to name one:

- **Leased slot** — llama.cpp with enforced binding. The lease identifies
  `(baseUrl, slotId)`. This is today's behavior and stays byte-identical.
- **Fixed slot 0** — any single-slot server. No lease is required or
  meaningful. Strata is always single-slot. llama.cpp launched with one
  slot has the same shape: single-slot operation is the intended
  resource-efficient configuration on llama.cpp too, and disk parking is
  built around it. The fixed-slot transport below serves both.

Keeping the target abstraction small means the llama.cpp single-slot
follow-up is a capability choice, not a second parking implementation.

**Transport capabilities.** One adapter per backend supplies the endpoint
semantics:

| Capability | llama.cpp | Strata |
| --- | --- | --- |
| save / restore | `POST /slots/<id>?action=save\|restore`, any leased slot | slot 0 only; same body key `filename` and result fields |
| erase | `action=erase` | none. Unlink from `strataSlotSavePath` when the directory is configured; otherwise rely on same-name overwrite and leave files for host cleanup |
| cold probe | `GET /slots` → `n_prompt_tokens` of the target slot | `GET /slots` single entry; the value is kept after the request ends, which matches the held session. A fresh engine returns `[]` or zero |
| server identity | `llama-build-probe` (`/proc` exe + `--version`) | `/props` `build_info` + `model_path`. Strata additionally fingerprints every file against model and config; a `400` invalid-file response marks the row `stale` through the existing path |
| parallel-slot conflict | n/a | `501` when `--batch` is on: the capability probe reports the feature unsupported and parking stays off |

Snapshot rows record the backend kind and target scope, so a file is never
restored across backends or slot models.

**Lifecycle adaptations** (on top of
[design/kv-snapshot-parking.md](kv-snapshot-parking.md)):

- Eligibility replaces the lease requirement with "a target can be named":
  lease present (llama enforced), or single-slot fixed target (Strata;
  llama single-slot later). The rest of the gates are unchanged.
- Save timing: Strata queues save/restore behind the running request. The
  existing post-turn park point (lease-release finally) already runs after
  the turn ends, so this is safe. Restore stays at the pre-dispatch hook
  and keeps the never-throw rule: any non-2xx is a strike on the breaker.
- Disk headroom: the `statfs` check stays; it only means something when
  `strataSlotSavePath` points at the same filesystem (documented). The
  host must launch Strata with `slot_save_path` pointing at the Porrima
  KV cache directory; without it every save answers 501 and parking
  reports itself unsupported (the observed failure mode).
- Backend flip: the registry is wiped and tracked files unlinked
  (`routes/settings.ts` on `inferenceBackend` change). Cross-backend rows
  can never restore — opaque format, pool-key mismatch — and holding them
  steals the disk headroom the new backend budgets against.
- Capability probe once per server identity: a save with a refused short
  name distinguishes 400 (parking works, name rules enforced) from 501
  (no `slot_save_path`, or `--batch` on): 501 disables parking for the URL
  and logs the reason.

## 8. Model Discovery and Supervisor Surfaces

`models.ts` gains a Strata parse path (no `status.args` dependence):

- Context window: `meta.n_ctx`, else `default_generation_settings.n_ctx`
  (single-model; no total-vs-share split exists — the engine context is
  reported directly). Fallback constant stays.
- Vision: `modalities.vision` from `/props`, else
  `architecture.input_modalities` from `/v1/models`.
- Router detection: never probed on this path; `status.value` is read only
  for loaded/unloaded display.
- id filtering: keep `embedding` and `/` filters; Strata ids are plain
  aliases (the default `strata`, plus configured `aliases`). The
  `normalizeRouterModelId` suffix strip is llama-only.

`routes/models.ts` health: `GET {strataUrl}/health`; `health-all` pings the
Strata URL in place of the llama inference default.
`llama-supervisor.getConfiguredUrl` returns the Strata URL for the
inference slot while that backend is selected, so the row probe, loaded
model list, and health read the live Strata server.
`routes/llama-servers.ts` enforces the same rule server-side: apply-model,
router conversion, unit start/stop/restart, drop-in config writes, and unit
enablement return 409 for inference while Strata is selected, and
`available-models?slot=inference` lists exactly what the Strata server
reports instead of the disk scan. `llama-path` binary-swap restarts exclude
`llama-server.service` while the backend is Strata. The client renders the
inference row as `external (Strata)` with an HTTP-only status chip and a
Configuration tab only (Overview, Advanced, and Logs are not offered). The
disk-model scan for inference is skipped while Strata is selected, the
default-model list comes from the server, and the settings panel adopts the
Strata model as the default; turn resolution already falls back to the
first discovered model. `routes/settings.ts` invalidation rules extend to
`strataUrl` and `inferenceBackend` (model cache clear, baseline warm record
clear, residency reset). Other slots keep their llama unit management.

## 9. Settings

`Settings` additions (`types.ts`, honored without an env gate):

- `inferenceBackend?: "llamacpp" | "strata"` — default `"llamacpp"`.
- `strataUrl?: string` — default `http://127.0.0.1:8080`.
- `strataApiKey?: string` — sent as `Authorization: Bearer` on the metadata
  endpoints (`/props`, `/slots`, `/metrics`) and on chat requests when set;
  Strata requires it there when configured.
- `strataSlotSavePath?: string` — absolute path of Strata's `slot_save_path`
  directory, for prune unlinking (§7). Optional.

The existing `kvSnapshot*`, `preserveThinking`, and image-preset keys are
reused. `kvSnapshotEnabled` keeps its default-off semantics; under Strata it
additionally needs the save-path key for full lifecycle behavior (§7).

Client: the settings page gains a backend dropdown (llama.cpp / Strata), the
Strata URL field, the key field, and the save-path field. Cache-residency
and token-indicator surfaces are unchanged; they read ledger and usage data
that both backends fill.

## 10. Degradations (accepted)

- Exact prompt token counts drop to char estimates for compaction pressure
  and the prefill denominator until the first `prompt_progress` total
  arrives. Strata has no `/tokenize`.
- `/apply-template` prompt rendering for prompt-debug compare is off on the
  Strata path. The request viewer is unaffected: it reads persisted rows.
- `max_tokens` over-length is clamped to the room left by default
  (`fit_max_tokens`), not 400 as llama.cpp strict mode. Porrima budgets
  below the reported context either way; note it if a host sets
  `fit_max_tokens: false`.
- One request at a time unless the host runs `--batch`, and then parking is
  unavailable (§7).

## 11. Verification

`scripts/smoke-strata.ts` (pattern: `smoke-kv-snapshot.ts`), run against a
live Strata server, in order:

1. `/health` 200 and `loaded` true.
2. `/v1/models` parse: id, `meta.n_ctx`, `status.value`.
3. `/props` parse: `model_alias`, `modalities.vision`,
   `default_generation_settings.n_ctx`; `?model=<id>` resolves.
4. Streaming `/v1/chat/completions` with `return_progress: true`: progress
   chunk fields, final chunk `usage` incl.
   `prompt_tokens_details.cached_tokens`, `timings` field set present.
5. Tool round-trip: `tools` sent, `tool_calls` in delta, `finish_reason`
   `tool_calls`.
6. Cache reuse: repeat the request with an extended prefix; second response
   reports non-zero cached tokens.
7. `/slots` entry fields; `is_processing` during a concurrent run.
8. Save/restore round-trip on slot 0 with `slot_save_path` configured;
   confirm `n_saved`/`n_written`/`timings.save_ms` and restore hit; confirm
   501 behavior reports the feature off cleanly.
9. End-to-end Porrima turn: agent chat with tools + an image attachment;
   check model-stats row, residency record, request-log row, and the
   client prefill bar motion.

## 12. Related Documents

- [llama-cpp-api-surface.md](../llama-cpp-api-surface.md) — the contract
  this backend does not consume.
- [design/kv-snapshot-parking.md](kv-snapshot-parking.md) — lifecycle that
  §7 adapts to slot 0.
- [architecture.md](../architecture.md) — LLM provider layer.
- [key-patterns.md](../key-patterns.md) — cache-prompt and context-window
  invariants (cache_prompt becomes backend-scoped).
- [setup.md](../setup.md) — host configuration; Strata hosts need no llama
  inference unit.
