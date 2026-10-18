# llama.cpp Server API Surface

This document lists every llama.cpp HTTP endpoint that Porrima calls. It records
what each endpoint is used for, the request fields Porrima sends, the response
fields Porrima reads, and what happens when a field is missing. Use it as the
contract to check when you upgrade the llama.cpp binary.

Porrima treats llama.cpp as an OpenAI-compatible server plus a set of native
control endpoints. It does not link against llama.cpp as a library. All
communication is HTTP/JSON over loopback.

## Scope

This document covers the surface Porrima consumes. It does not document every
endpoint llama.cpp exposes. Endpoints such as `/infill`, `/predict`, and
`/v1/completions` (the non-chat text form) are not used.

For design rationale on slot KV, see
[design/kv-snapshot-parking.md](design/kv-snapshot-parking.md). For the LLM
provider layer, see [architecture.md](architecture.md).

## Deployment Topology

Porrima runs against several separate `llama-server` processes. Each is a
distinct API target with its own port and its own endpoint set.

| Slot id | Port | Purpose | Endpoints used |
| --- | --- | --- | --- |
| inference | 32100 | Agent and system chat, vision | `/v1/chat/completions`, `/completion`, `/apply-template`, `/tokenize`, `/detokenize`, `/slots`, `/props`, `/v1/models`, `/health`, `/models/load`, `/models/unload` |
| extraction | 32101 | Memory extraction | `/v1/chat/completions`, `/props`, `/v1/models`, `/models/load`, `/models/unload` |
| reranker | 32102 | Memory retrieval rerank | `/v1/rerank`, `/health` |
| embedding | 32103 | Memory embeddings | `/v1/embeddings`, `/health` |
| title-generation | 32104 | Chat titles, recaps | `/v1/chat/completions`, `/models/load`, `/models/unload` |

Default URLs come from `llama-ports.ts`. Settings can override each base URL.

### Router Mode Versus Single-Model Mode

A server started with `--models-dir` is a router. It lists many models on
`/v1/models` and loads or unloads them over HTTP with `/models/load` and
`/models/unload`. A server started with one `--model` is single-model. It does
not expose those two control endpoints and returns `404` for them.

Code branches on this difference:

- `/models/load` returning `404` means "not a router". The caller then sends
  the request unchanged.
- `/props` on a router reports `n_ctx: 0` at the top level. Per-model props at
  `GET /props?model=<id>` are the reliable source. See `/props` below.
- Model ids differ. A single-model server defaults the id to the GGUF filename
  with a `.gguf` suffix. A router lists the directory name with no suffix.
  `normalizeRouterModelId()` strips the suffix before any load or completion.

## Endpoint Reference

### GET /health

- Used by: `llama-supervisor.ts`.
- Purpose: liveness probe and server-restart detection.
- Request: none.
- Response used: HTTP status only. A non-2xx status means "unavailable".
- Fallback: on failure the supervisor reports `status: "unavailable"`.
- Note: `/health` can answer fast while `/slots` stalls during a long prefill.
  Do not use health as a busy signal. Use `/slots` for that.

### GET /v1/models

- Used by: `models.ts`, `cache-warm-queue.ts`, `llama-router-client.ts`,
  `llama-supervisor.ts`, `extraction-settings.ts`.
- Purpose: model discovery, load-state probing, router detection, capability
  advertising.
- Request fields: none.
- Response fields read:
  - `data[].id` — model id.
  - `data[].status.value` — one of `loaded`, `unloaded`, or a transitioning
    state. Missing on single-model servers.
  - `data[].status.args` — launch argument list. Porrima reads `--ctx-size`,
    `--mmproj`, `--port`, `--host`, and `-p`/`-h` from it.
  - `data[].status.preset` — preset text; checked for `mmproj`.
  - `data[].meta.n_ctx` — context size for the model.
  - `data[].max_model_len` — context size fallback.
  - `models[]` — an Ollama-compatible list with `capabilities[]`. Porrima reads
    `multimodal`, `vision`, and `image` to detect vision support.
- Fallback: Porrima filters out ids that contain `/` (Hugging Face presets) and
  ids that contain `embedding`. When `data[].status` is absent, the server is
  single-model and the top-level `/props` is authoritative for that one model.
- Fragility: router detection relies on `status` being an object. If a future
  build drops `status` on a router, Porrima reads the server as single-model.

### GET /props and GET /props?model=<id>

- Used by: `models.ts`, `extraction-settings.ts`, `cache-warm-queue.ts`,
  `llama-slot-leases.ts`.
- Purpose: read context size, default generation settings, vision modalities,
  and (legacy) slot capacity.
- Request fields: `model` query parameter for per-model props on a router.
- Response fields read:
  - `n_ctx` — server-total context. This is the total split across slots, not a
    per-slot share.
  - `default_generation_settings.n_ctx` — the per-slot share. Porrima treats a
    value here as already divided by `--parallel`. It does not divide it again.
  - `max_model_len` — legacy context fallback, treated as a total.
  - `modalities.vision` — vision support flag.
  - `model_alias` — used to bind a single-model `/props` response to a model id.
  - `max_instances` — legacy slot-capacity key. Current builds do not expose it.
    Porrima reads it only as a fallback after `/slots` (see below).
- Fallback: when `/props` gives no usable context, `discoverLiveExtractionCtxSize`
  reads `/v1/models`. When the top-level `/props` on a router returns
  `n_ctx: 0`, per-model `/props` is preferred.
- Fragility: the code distinguishes "total" from "slot" scope. A future build
  that changes which key holds the total, or that changes division behavior,
  will mis-budget extraction and warm prompts.

### GET /slots and GET /slots?model=<id>

- Used by: `llama-slot-leases.ts` (capacity), `cache-warm-queue.ts` (busy
  probe), `openai-compat-provider.ts` (in-flight progress), `kv-snapshot.ts`
  (cold-slot gate).
- Purpose: per-slot observability. This is the authoritative source for slot
  count, processing state, and KV occupancy.
- Request fields: `model` query parameter to scope to one model. Porrima also
  builds direct per-child URLs `http://<host>:<port>/slots` from the loaded
  model's `--port` and `--host` args.
- Response shape: an array of slot objects, or an object with a `slots` array.
- Response fields read (through tolerant multi-key lookups):
  - `id` / `id_slot` / `slot_id` — slot id.
  - `is_processing` / `processing` — active flag. An explicit `false` wins over
    residual task state.
  - `id_task` / `task_id` — non-negative means busy on older payloads.
  - `next_token.has_next_token` and `next_token.n_remain` — generation frontier.
  - `state` / `status` — text states: `process`, `busy`, `idle`, `complete`.
  - `n_prompt_tokens` — prompt tokens the slot currently holds. This is the
    ground truth for the KV-parking cold-slot gate.
  - `n_prompt_tokens_processed` family — per-request processed count. Used for
    the prefill indicator.
  - `n_tokens` / `n_past` — cumulative counters. Used only as a fallback, and
    the caller baselines them because they include cached context.
  - `n_prompt_tokens_cache` family — cached prompt tokens.
  - `progress` / `task` sub-objects — alternate locations for the same fields.
- Fallback: slot capacity is the entry count of `GET /slots`. When the response
  has no entries, Porrima falls back to `/props.max_instances`, then to 1. When
  a slots probe times out, `isCacheWarmOrLlamaRuntimeBusy` treats the runtime as
  busy.
- Fragility: many key aliases exist because field names have moved across
  builds. Removing an alias source can silently drop progress reporting or
  freeze a busy detection. A timed-out or empty `/slots` response pins capacity
  to 1, which serializes every chat onto slot 0.

### POST /slots/<id>?action=save|restore|erase

- Used by: `kv-snapshot.ts` (save, restore, erase), `scripts/smoke-kv-snapshot.ts`.
- Purpose: park idle-slot KV to disk and bring it back. See
  [design/kv-snapshot-parking.md](design/kv-snapshot-parking.md).
- Request: a JSON body. For `save` and `restore` the key is `filename`, not
  `prompt`. For `erase` the body is empty.
- Response fields read:
  - `n_saved` / `n_restored` — token count moved.
  - `n_written` / `n_read` — byte count moved.
  - `timings.save_ms` / `timings.restore_ms` — operation latency.
  - `error.message` — failure reason. A present `error` object fails the call
    even on a 2xx response.
- Requirement: the server must launch with `--slot-save-path`. Without it these
  actions do not work. Porrima creates the directory eagerly so manual calls
  also work.
- Fragility: these are unversioned control actions. A future build that renames
  the body key or the result fields breaks parking unless the aliases are
  updated.

### POST /v1/chat/completions

- Used by: `openai-compat-provider.ts` (agent chat, system chat, vision),
  `memory-extraction.ts`, `title-generation.ts`.
- Purpose: the main generation path. Agent turns stream; title and some
  one-shots do not.
- Request fields sent:
  - `model` — model id, normalized for router mode.
  - `messages` — OpenAI message array, including image parts for vision.
  - `stream` — `true` for turns and extraction, `false` for titles.
  - `stream_options.include_usage` — `true` on streaming so the final chunk
    carries usage.
  - `max_tokens`, `temperature` — sampling controls.
  - `tools` — tool schemas for native tool calling.
  - `id_slot` — the leased physical slot, when enforced slot binding is on.
  - `cache_prompt` — `true` unless `LLAMACPP_CACHE_PROMPT=0`. Set explicitly
    instead of relying on per-build defaults.
  - `chat_template_kwargs.enable_thinking` — `true` for reasoning models.
  - `chat_template_kwargs.preserve_thinking` — `true` when the global or
    per-model preserve toggle is on.
- Response fields read (stream and non-stream):
  - `choices[].message.content` and `delta.content` — text output.
  - `choices[].message.tool_calls` / `delta.tool_calls` — tool calls. A
    `finish_reason` of `stop` with tool-call content is promoted to `tool_calls`.
  - `choices[].finish_reason` — mapped to a stop reason.
  - `usage.prompt_tokens`, `usage.completion_tokens`, `usage.total_tokens`.
  - `usage.prompt_tokens_details.cached_tokens` and
    `usage.prompt_tokens_details.cache_write_tokens` — cache accounting.
  - `timings.*` — `prompt_n`, `prompt_ms`, `prompt_per_token_ms`,
    `prompt_per_second`, `predicted_n`, `predicted_ms`,
    `predicted_per_token_ms`, `predicted_per_second`, `load_ms`, `sample_ms`,
    and `cache_n`. `cache_n` is the prompt tokens served from KV cache.
- Fallback for cached tokens: prefer `usage.prompt_tokens_details.cached_tokens`.
  When it is absent, use `timings.cache_n`. When both are absent, infer cached
  tokens from the prompt-eval count.
- Fragility: cached-token reporting has two sources with different availability
  across builds. The cache metrics UI degrades to inference when both are
  missing, but the numbers then lose authority.

### POST /completion

- Used by: `cache-warm.ts`.
- Purpose: warm the prompt cache with a prefill-only pass. `n_predict: 0` means
  "evaluate the prompt, generate nothing".
- Request fields sent: `model`, `prompt`, `n_predict: 0`, `cache_prompt: true`,
  `return_tokens: false`, and `id_slot` to pin the warm to a physical slot.
- Response fields read: `timings.prompt_ms`, `tokens_cached`, `tokens_evaluated`.
- Note: this is the native completion form, not `/v1/completions`. The prompt
  bytes here must be byte-identical to the live chat body for the cache hit.
  Porrima builds warm bodies from the same helper that builds live bodies.
- Fragility: `tokens_cached` and `tokens_evaluated` are native-form fields that
  differ from the chat-completions usage shape.

### POST /apply-template

- Used by: `cache-warm.ts`, `openai-compat-provider.ts`.
- Purpose: render messages and tools through the model chat template without a
  generation. Porrima uses it to get the exact prompt string for a warm, and to
  show the exact prompt in the request viewer and prefill denominator.
- Request fields sent: `model`, `messages`, `tools` (when present),
  `chat_template_kwargs` (when present).
- Response fields read: `prompt` (string). A missing `prompt` is an error.
- Fragility: template kwargs are forwarded unchanged. A template that no longer
  recognizes `enable_thinking` or `preserve_thinking` silently changes the
  rendered prompt and breaks the byte-identity contract with the live request.

### POST /tokenize

- Used by: `cache-warm.ts`, `openai-compat-provider.ts`.
- Purpose: count the exact prompt tokens before dispatch, for a stable prefill
  denominator.
- Request fields sent: `model`, `content`, `add_special: false`.
- Response fields read: `tokens` (number array). Its length is the count.
- Note: `/tokenize` is CPU-only and fast. It runs once per turn before the
  request.

### POST /detokenize

- Used by: `cache-warm.ts`.
- Purpose: rebuild a warm prompt that is exactly one token shorter than the
  full prompt, so the next real turn extends the cached prefix by one token.
- Request fields sent: `model`, `tokens` (number array).
- Response fields read: `content` (string). A missing `content` is an error.

### POST /models/load

- Used by: `llama-router-client.ts`, reached from `title-generation.ts`,
  `memory-extraction.ts`, and cache-warm preflight.
- Purpose: make a model the active one on a router-mode slot before a request.
- Request fields sent: `model` (normalized id), and `args` — an argument array
  such as `["--ctx-size", "<n>"]` plus per-load overrides.
- Response handling:
  - `200` — loaded. The per-baseUrl cache records the model and context window.
  - `404` — not a router. The caller sends the request unchanged.
  - `400` with "already running" — treated as success.
  - other — a soft error. The caller still sends the request.
- Note: this is the router child-process loader. It is not
  `/v1/chat/completions`. There is one active model per slot, so a load that
  changes the model may unload the previous one.

### POST /models/unload

- Used by: `llama-router-client.ts`.
- Purpose: free a router slot before loading a different model or a different
  context window.
- Request fields sent: `model` (normalized id).
- Response handling: non-2xx is logged and ignored. The caller then polls
  `/v1/models` until the model leaves the `loaded` state before it proceeds.

### POST /v1/embeddings

- Used by: `embeddings.ts`. Target: the embedding server (port 32103).
- Purpose: vectorize memory text for hybrid retrieval.
- Request fields sent: `model`, `input` (a string or an array of strings).
- Response fields read: `data[].embedding` and `data[].index`. Porrima sorts by
  `index` and L2-normalizes each vector so cosine similarity equals dot product.
- Note: availability is probed by a tiny `"ping"` embed. llama.cpp does not
  always normalize, so the client normalizes.

### POST /v1/rerank

- Used by: `reranker.ts`. Target: the reranker server (port 32102).
- Purpose: cross-encoder rerank of retrieval candidates.
- Request fields sent: `model`, `query` (instruction-prefixed), `documents`
  (string array), `top_n`.
- Response fields read: `results[].index`, `results[].relevance_score`,
  `usage.total_tokens`, and `model`.
- Fallback: on a non-2xx response or an error, Porrima uses the original
  document order with decaying scores. Retrieval continues without the model.
- Note: the `model` value must match the `--alias` the reranker launched with.
  See [setup.md](setup.md).

## Consumed-Field Fragility Map

The fields below are the places a llama.cpp change most likely breaks Porrima.
Each entry lists what Porrima assumes and the effect when the assumption fails.

| Endpoint | Field assumed | Effect if it changes or disappears |
| --- | --- | --- |
| `/v1/models` | `data[].status.value` | Router/single-model detection flips; per-model props and load probing break. |
| `/v1/models` | `data[].status.args` with `--ctx-size`, `--mmproj`, `--port` | Context window, vision detection, and direct per-slot `/slots` URLs break. |
| `/props` | `n_ctx` total vs `default_generation_settings.n_ctx` share | Extraction and warm budget mis-sized; over- or under-flush risk. |
| `/props` | `max_instances` (legacy) | Only a fallback; `/slots` count is primary. Loss is tolerable. |
| `/slots` | entry count | Slot capacity falls to 1; every chat serializes onto slot 0. |
| `/slots` | `n_prompt_tokens` | KV-parking cold gate cannot read ground truth; restore skipped or guessed. |
| `/slots` | `is_processing` plus aliases | Busy detection blocks or unblocks the automation scheduler wrongly. |
| `/slots/<id>?action=save` | `--slot-save-path` launch, `filename` key, `n_saved`/`n_written` | Parking fails or reports no size. |
| `/v1/chat/completions` | `stream_options.include_usage`, final `usage` | Token accounting and cache metrics show zero. |
| `/v1/chat/completions` | `timings.cache_n` or `usage.prompt_tokens_details.cached_tokens` | Cached-token reporting falls back to inference. |
| `/v1/chat/completions` | `tools` + `tool_calls`/`finish_reason` | Native tool calling breaks. |
| `/completion` | `n_predict: 0`, `tokens_cached`/`tokens_evaluated` | Cache warm loses its measured effect. |
| `/apply-template` | `prompt`, template kwargs | Warm body no longer byte-identical; cache misses. |
| `/v1/embeddings` | `data[].embedding` | Vector search fails. |
| `/v1/rerank` | `results[].relevance_score` | Rerank degrades to fallback order. |
| `/models/load` | `404` = not-router, `400` "already running" = ok | Router handling misclassifies a state as an error. |

## Upgrade Verification Checklist

When you change the llama.cpp binary, verify these behaviors in order. The list
is ordered by blast radius: request paths first, observability second.

1. Generation: send a streaming `/v1/chat/completions` with `stream_options.
   include_usage` and confirm the final chunk carries `usage` and `timings`.
2. Tool calling: send `tools` and confirm a tool call returns `tool_calls` and a
   correct `finish_reason`.
3. Prompt cache: send `cache_prompt: true` and confirm cached tokens are
   reported through `usage.prompt_tokens_details.cached_tokens` or
   `timings.cache_n`.
4. Template render: call `/apply-template` and confirm `prompt` is present and
   template kwargs still apply.
5. Prefill-only warm: call `/completion` with `n_predict: 0` and confirm
   `tokens_cached` and `tokens_evaluated` appear.
6. Token count: call `/tokenize` and `/detokenize` round-trip and confirm
   `tokens` and `content`.
7. Discovery: call `/v1/models` and confirm `data[].status.value` and
   `data[].status.args`. Confirm `--ctx-size`, `--mmproj`, `--port` survive.
8. Props scope: call `/props` and `/props?model=<id>`. Confirm the total-versus-
   share split still matches the code's scope logic.
9. Slot count: call `/slots` and confirm one entry per physical slot.
10. Slot progress: while a request runs, confirm the slot shows `is_processing`
    and a processed-token field Porrima reads.
11. Router load: call `/models/load` and `/models/unload` and confirm `404`
    behavior for single-model servers is unchanged.
12. KV parking: with `--slot-save-path`, call `/slots/<id>?action=save` and
    `?action=restore` and confirm the `filename` key and the `n_saved`/
    `n_written`/`timings` fields.
13. Embeddings: call `/v1/embeddings` and confirm `data[].embedding` and
    `data[].index`.
14. Rerank: call `/v1/rerank` and confirm `results[].relevance_score`.

Run `scripts/smoke-kv-snapshot.ts` for a live check of steps 9 through 12
against a running server.

## Related Documents

- [architecture.md](architecture.md) — LLM provider layer and slot leases.
- [key-patterns.md](key-patterns.md) — cache-prompt and context-window
  invariants.
- [design/kv-snapshot-parking.md](design/kv-snapshot-parking.md) — slot KV disk
  tier design.
- [design/request-viewer.md](design/request-viewer.md) — `/apply-template` and
  `/tokenize` use in the viewer.
- [memory-system.md](memory-system.md) — embeddings and rerank in retrieval.
- [setup.md](setup.md) — systemd units, ports, and model aliases.
