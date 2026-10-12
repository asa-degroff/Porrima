# KV Snapshot Parking — a disk tier for idle slot KV

**Status:** **Phases 1–3 implemented 10-11, plus the 10-11 review fixes (slot probe, binary build tag, wire-failure strikes, min-build gate, slot-identity save guard, estimate ordering) and the fine-print fixes (stderr version banner, /slots capacity discovery — f89b1885).** Smoke script validated live 10-11 against b11552: cold prefill → save → erase → restore → repinned replay, `n_saved == n_restored`, replay cached 2798/2802. **First production park landed 10-11 13:44** (chat 21f67f84, 91,930 tokens, 16.3 GB, save 15.1 s, build-tagged, `ready`). Phase 4 (surfaces) pending.
**Author:** Qwen 3.8 Flash
**Date**: 2026-10-11

## 1. Problem

The llama.cpp host-memory prompt cache (`--cache-ram` + `--cache-idle-slots`) is our
tier-1 KV reuse. Its ceiling is the host RAM budget, and a chat whose context needs
more state than that budget is simply **not cached at all** — the server logs
`prompt state size … exceeds cache size limit … skipping` and every idle→active turn
**re-prefills the entire prompt from scratch**. For a large-context agent chat that is
the dominant term in time-to-first-token: a reminder-driven turn with a ~200k-token
context sat in prompt processing for **minutes before emitting its first token**.

Raising `--cache-ram` is not a general answer — the budget competes with model weights,
the OS, and the helper CPU services on the same host. Meanwhile llama.cpp has had an
orthogonal, already-supported mechanism: **slot save/restore to files**
(`--slot-save-path` + `POST /slots/{id}?action=save|restore`). Files live on storage
where size is cheap, and since 2026-08 (#26640) they serialize multimodal state too, so
the old "not supported by multimodal" blocker no longer applies.

The missing piece is *orchestration*: llama.cpp will not decide for itself when a chat
is worth parking to disk and when to bring it back. That policy is exactly what a
turn-serializing app layer can provide.

### Spike reference (10-11, b11552, one synthetic 134k-token prompt)

These are measurements from one reference run, **not constants** — everything the
design keys on is either config or learned at runtime.

| Step | Observed |
|---|---|
| Cold prefill, 134,043 tokens | 355 s wall, `cached_tokens: 0` |
| `action=save` | 4.7 s, ~6.0 GiB (`n_written`), ~1.4 GB/s |
| `action=erase` → slot verified empty | — |
| `action=restore` | 2.1 s (page-cache-assisted) |
| Replay, same prompt, repinned | 1.3 s, `cached_tokens` 134,039/134,043, correct continuation |

Full round-trip (save + restore) cost seconds against a re-prefill that cost minutes.

### Non-goals

- **Incremental / append-only saves.** Stock saves are full-state. Forks add
  `--slot-save-auto` / `--slot-save-incremental`; adopting one is an operational
  shortcut we explicitly defer (D1).
- **Replacing tier 1.** `--cache-ram` stays; it is strictly faster for chats that fit.
  Parking only fires where tier 1 structurally cannot.
- **Cross-build or cross-config cache portability.** Snapshot files are ephemeral
  per `(build, slot launch config)`; invalidation is by digest, never migration.
- **Vision fidelity work.** Media state rides #26640's serialization; we add nothing
  custom.
- **Compaction threshold changes.** Parking is orthogonal to the compaction triggers
  in [turn-engine.md](turn-engine.md); it does not replace compaction or shrink any
  context window.

## 2. Upstream contract (verified against source, 10-11)

Everything in this design holds with these facts; if they change, change the design
deliberately, not by accident:

1. **Slot actions need a save path.** `/slots/{id}?action=save|restore|erase` only
   works when the server launched with `--slot-save-path`. llama.cpp concatenates
   `slot_save_path + filename` with **no separator** — the path value must end with a
   directory separator (enforced in our launcher, §6).
2. **Request/response shapes.** Body key is `{"filename": "…"}` (older docs and issue
   threads show `{"prompt": …}` — wrong on current builds). Responses carry
   `n_saved`/`n_restored`, `n_written`/`n_read`, and `timings.{save_ms,restore_ms}` —
   free metrics (§5.6).
3. **Slot state is readable.** `GET /slots` reports per-slot `n_prompt_tokens`
   (verified live on b11552; idle slots omit the field). This is the tier-1
   witness the restore gate uses (§5.4 step 2) — the server's own view of what its
   slot holds.
4. **Build identity is not on a stable HTTP endpoint.** `/server_info` does not
   exist on b11552 (the request 404s into the static-file handler). The running
   binary is the authoritative source instead: find the server process
   (cmdline carries `--port <port>`), read `/proc/<pid>/exe`, run
   `<bin> --version` → `version: 0.6.0-dev (build 11552, commit 23b0202a1)`
   (implemented in `services/llama-build-probe.ts`). An HTTP `/server_info`
   fallback is kept for builds that expose it. **The version banner is printed
   to stderr** (the ggml log channel) — the probe concatenates stdout+stderr.
   10-11 production fix (f89b1885): a stdout-only capture returned `""` for
   every park, so the restore build-gate passed vacuously; the first
   production row's empty `build_tag` is what caught it.
5. **`id_slot` on OpenAI-compat requests.** Parsed in the shared completion handler;
   pinning works through `/v1/chat/completions`. Porrima **already does this**:
   `buildOpenAICompatChatBody` sets `body.id_slot` from the llama slot lease whenever
   the lease matches the request's `baseUrl`/`modelId` (content anchor: the
   `useLlamaSlotLease` block in `services/openai-compat-provider.ts`).
6. **Multimodal-safe serialization** since #26640 (`server_tokens::serialize` writes
   mtmd chunks via `mtmd_input_chunk_save`); the `check_no_mtmd` guard no longer
   exists. Slot save/restore is safe on servers launched with `--mmproj`.
7. **Checkpoint appendix** since #26004: save files embed a versioned context-checkpoint
   appendix (`SLOT_CKPT_MAGIC/VERSION`). Treat files as valid only for the exact
   `(llama build, launch config digest)` that wrote them. (10-11 correction:
   `/server_info` is not a stable identity endpoint — build tags come from the
   running binary, §5.4 step 1.)
8. **Deferred slot tasks.** A save/restore targeting a processing slot is *deferred*,
   not rejected. Our global turn gate (§4) makes overlap rare, but the queue still
   serializes per slot (D3).
9. **Restore performs no prompt validation.** Correctness is guaranteed downstream by
   llama.cpp's longest-common-prefix matching between restored slot tokens and the
   incoming prompt. A diverged prefix wastes the restore's seconds; it cannot produce
   wrong output.

## 3. Goals

1. **Cold-return TTFT collapses from re-prefill to I/O.** A chat parked at
   end-of-turn resumes next turn in the time it takes to read a file, not to
   re-tokenize a context.
2. **Pure optimization.** Every parking failure — save error, restore error, stale
   registry, wrong slot, disk full — degrades to *today's behavior*, never worse, and
   never adds latency to the turn that triggered it.
3. **Reuse, don't reinvent.** Slot leases already pin chats to slots; residency
   already knows whether a slot is warm; the request-log already shows a SQLite-table +
   startup-sweep pattern; compaction already funnels through one truncation call site.
   The feature is a registry plus two hooks.
4. **User-visible and tunable.** An on/off setting plus threshold and budget controls in
   the settings menu, and a status surface on the Inference Servers panel.
5. **The headless paths participate.** Automations and system-chat turns are the
   primary victims (their turns are *born cold*), so the shared runner gets lease +
   restore support too (D2 — a prerequisite, not a phase-2 garnish).

## 4. Reusable components (content anchors)

Line numbers drift; the anchors are the distinctive code.

| Component | Site | Role here |
|---|---|---|
| Slot leases | `services/llama-slot-leases.ts` — `acquireLlamaSlotLease` / `releaseLlamaSlotLease`, `LlamaSlotLease{poolKey, baseUrl, modelId, slotId}` | Snapshot rows key on the lease tuple; `poolKey` isolates servers so files/rows never cross-dispatch |
| Lease call sites | `routes/chat.ts` — acquire just before streaming starts, release in the turn-completion path | The save trigger for HTTP turns. **Gap:** `chat-turn-runner.ts` / `automation-runner.ts` acquire no lease at all → headless turns are unpinned (D2) |
| Residency | `services/llama-cache-residency.ts` — `LlamaCacheResidencyRecord{slotId, status: warming/warm/stale, confidence: confirmed-hit/partial-hit/filled-after-miss/unknown, reportedPromptTokens, inferredCachedTokens}` | UI status surface only (10-11 review fix: the restore gate reads the slot's own `n_prompt_tokens` via `GET /slots` — the residency record's `warm` memory outlives llama.cpp's idle eviction by orders of magnitude) |
| Table + startup sweep pattern | `services/request-log.ts` — `CREATE TABLE IF NOT EXISTS llm_requests …`, and the startup line that marks orphaned `in_progress` rows terminal | Copy for `kv_snapshots`: create-on-init + sweep `saving`/`restoring` rows at boot |
| Compaction funnel | `services/turn-compaction.ts` → `truncateChatHistory` (the one shared end-of-turn execution) | Eager invalidation — `invalidateKvSnapshot(chatId, "compaction")` lands inside the funnel. **Not the only spine rewrite:** the `truncateBeforeSend` primary archive path (pre-send backstop) mutates the spine without passing through the funnel, so it carries its own invalidate call (10-12; before that, a pre-send compaction left a stale parked row and wasted one restore until the breaker or the next re-park) |
| Chat deletion | `services/chat-deletion.ts` — `cancelDeletedChatWork` | Remove row + unlink file with the chat |
| Request digest | `services/openai-compat-provider.ts` — `digestPromptPayload(body)` | Template for the stable-prefix digest (§5.2) |
| Lease pinning block | `openai-compat-provider.ts` — `if (useLlamaSlotLease) body.id_slot = …` | Restore requires no new pinning; it is already there |
| Launch templates | `services/llama-launch-templates.ts` — ExecStart construction for managed units | Emits `--slot-save-path` (§6) |
| Background serialization | `services/turn-gate.ts` — single global slot, foreground priority | Bounds concurrent LLM work so saves queue behind turns, not against them |

## 5. Design

New service `services/kv-snapshot.ts` owning registry, policy, and the two hooks. No
direct filesystem writes to snapshot files — all state moves through the server's
`/slots` API, which is authoritative about its own KV.

### 5.1 Registry

One table in `porrima.db` (next to `llm_requests`, same create/sweep pattern):

```sql
CREATE TABLE IF NOT EXISTS kv_snapshots (
  chat_id        TEXT PRIMARY KEY,
  pool_key       TEXT NOT NULL,        -- [baseUrl, modelId, contextWindow] tuple
  base_url       TEXT NOT NULL,
  model_id       TEXT NOT NULL,
  slot_id        INTEGER NOT NULL,
  filename       TEXT NOT NULL,        -- server-assigned: <chatId>-<nonce>.bin
  n_tokens       INTEGER NOT NULL,     -- context size at save (n_saved)
  bytes          INTEGER NOT NULL,     -- n_written
  prefix_digest  TEXT NOT NULL,        -- §5.2 gate
  build_tag      TEXT NOT NULL,        -- llama version string at save
  config_digest  TEXT NOT NULL,        -- launch-config digest (§6)
  state          TEXT NOT NULL,        -- saving | ready | stale | restoring
  saved_at       INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL,     -- LRU key for pruning
  restore_count  INTEGER DEFAULT 0,
  miss_count     INTEGER DEFAULT 0     -- post-restore confirmed-miss count (breaker)
);
```

- One row per chat; a new save replaces the old file (unlink after success).
- **Filename discipline:** generated server-side as `<chatId>-<nonce>.bin`. Never
  derived from user-controllable text (path injection).
- Startup sweep marks `saving`/`restoring` rows `stale` (a crash mid-operation leaves
  an unusable file at best).

### 5.2 The stable-prefix digest

Restore is only sane if the prefix llama.cpp will compare against hasn't moved.
`prefix_digest` is a **wire-head digest**: sha256 over `[system head, tools]` of
the exact body the provider dispatches (`computeLlamaPrefixDigest`). The head is
the frozen prefix by construction (memory deltas ride at the tail), so it shifts
exactly when the parked KV stops matching — persona regeneration, extraction
prompt edits, skill toggles, compaction.

**Landed refinement (10-11):** the digest is *observed* by the provider on every
recorded request (`observeLlamaRequestBody` stashes the latest per chat) rather
than recomputed at the gate from prompt-building inputs — one serialization
source for both sides of the comparison, no drift between the gate and the wire.
Park stamps the observed value into the row; the restore gate compares the
about-to-dispatch body's head against it.

- Missing on either side (never-observed chat, row parked before pinning) → the
  gate passes vacuously; llama.cpp's token validation backstops it (§2.9).
- Mismatch → restore skipped **without invalidating**: the parked file is still
  valid for its own stored prefix, and a prefix that flips back (a skill
  toggled off) can hit again. The next park re-stamps the new digest.
- Correctness never depends on the digest (§2.9); it is purely a wasted-work
  gate. Conservative is fine.

### 5.3 Save (end-of-turn)

Hooked in the turn-completion path where the lease releases (HTTP: `chat.ts`
completion block; headless: the equivalent in `chat-turn-runner.ts` after D2). Runs
**after** the SSE `done` event and response flush — the triggering turn never pays for
parking. Policy (all must hold):

| Gate | Rule (all values config, §8) |
|---|---|
| Enablement | feature on; chat's model is served by a parking-capable managed server |
| Build | live build tag (running binary, §2.4) unknown **or** ≥ `kvSnapshotMinBuild` — a known build below the minimum (saves lack #26640/#26004 support) skips with a visible log line and touches no registry row |
| Pinning | turn held a lease (slot known and still mapped to this chat) |
| Eligibility | final iteration's `usage.prompt_tokens ≥ kvSnapshotMinTokens` — below this, re-prefill is cheaper than save+restore; the break-even is low (spike: 134k tokens re-prefilled in ~355 s vs ~7 s round-trip) |
| Freshness | last save for this chat is older than `kvSnapshotSaveDebounceMs`, **or** context grew by more than `kvSnapshotMinGrowthTokens` since it — rapid-fire tool turns stay in tier 1; the last turn before an idle gap is what gets parked |
| Queue | per-`poolKey:slot` serialized job queue; a queued save is dropped (not deferred forever) if the same chat's turn restarts first |
| Budget | §5.5 byte headroom check with the estimate learned from this chat's previous `bytes/n_tokens` ratio — read from the row **before** the `saving` upsert (the upsert rewrites `n_tokens` in place; reading after computes `prior.bytes / lastUsage`, an under-estimate whenever the context grew) |

Save = one `POST action=save`; on response, record `n_saved`, `n_written`,
`timings.save_ms`, digests, state → `ready`. Any error/timeout → row `stale`,
log, move on. **Save budget scales with the estimate** (10-11): the static
`kvSnapshotOpTimeoutMs` burned a 203k-token save at 21:48 and left the next
cold return to a 976 s re-prefill; saves now get
`opTimeoutMs + 2 s per 512 MiB estimated, capped at 5 min` — they are
background work. `kvSnapshotOpTimeoutMs` stays the exact budget for
RESTORE, which sits on the user-visible path.

**Slot-identity guard (10-11 review fix):** the save fires *after* this chat's
lease released, so a new turn can acquire the same slot and start filling it
before the write lands. The slot can never hold fewer tokens than the finished
turn's prompt — if `n_saved < lastUsage`, the file captured someone else's
state: the new file is unlinked, the prior snapshot is restored, and the row
never points at the bad file.

### 5.4 Restore (pre-send, iteration 1 only)

Hooked in the provider's single dispatch choke point (`openai-compat-provider.ts`,
right after `buildOpenAICompatChatBody`, before the request URL exists on the wire)
via `observeLlamaRequestBody`. Landed placement note: the earlier sketch gated in
the route/runner pre-send paths, but only the provider has the *final wire body*
— the digest (§5.2) compares the exact bytes llama.cpp will tokenize, and both
turn routes flow through this one site, so HTTP and headless share the gate:

1. Row exists, `state = ready`, same `pool_key` as the lease, `build_tag` matches
   the live server (build tag from the running binary — `llama-build-probe`,
   60 s TTL; unknown-on-either-side passes vacuously — the file's own version
   checks are the backstop), `prefix_digest` matches (§5.2).
2. **The pinned slot is cold.** `GET /slots` for the lease's slot: if
   `n_prompt_tokens ≥ 50%` of the row's `n_tokens`, tier 1 still holds most of
   the parked prefix and will serve the turn — tier 2 must not pay the restore.
   (10-11 review fix: the earlier residency check is unreliable — the app-side
   record keeps `warm` for 12 h while llama.cpp evicts idle slot KV in minutes,
   so a mid-gap return would read "warm" and skip exactly the restore it needs;
   the slot is the only pre-send signal that is ground truth. The residency
   record remains the UI surface, not this gate's input.) Probe failure is a
   skip, never a guess — the turn proceeds with normal prefill, no state change.
3. `POST action=restore`, budgeted by `kvSnapshotOpTimeoutMs`. Success → bump
   `restore_count`, stamp `last_used_at`, register a usage-validation marker.
4. Continue with the normal request; the existing `body.id_slot` pin routes it to the
   restored slot.
5. **Validation:** iteration-1 usage of the turn (`onLlmRequestEvent` end events —
   the same wire-truth channel as D7) confirms the park paid: cached ≥ 50% of
   prompt → hit (resets `miss_count`), below → `miss_count++`. A **wire-level
   restore failure** (HTTP error, timeout — e.g. a build-incompatible or torn
   file) also counts a strike, so a persistently bad file stops after two
   attempts instead of retrying on every cold turn. `miss_count ≥ 2`
   circuit-breaks that chat's *restores* (saves continue) until a successful
   re-park resets it. **Wire-level restore failures** (HTTP error, incompatible
   file) count as strikes at attempt time for the same reason. Worst case is
   bounded: two strikes' seconds + normal cold prefill.

Restore is **not** retried within a turn, and a turn never sees more than one restore.

### 5.5 Budget, TTL, pruning

- Directory: `kv-cache/` under `APP_DATA_DIR`, constant lives in `services/paths.ts`.
- Global cap `kvSnapshotMaxBytes` per `poolKey` (per model-server, not global — D6);
  eviction is LRU by `last_used_at`, then TTL `kvSnapshotTtlHours` on the survivors.
- Pre-save headroom check: free ≥ `kvSnapshotMinFreeDiskBytes` + estimate.
- **Measured bytes/token (10-11, first production park):** 16.3 GB / 91,930
  tokens ≈ **176 KiB/token** on b11552 (the smoke run measured 265 KiB/token;
  the earlier spike measured 46 KiB/token on b11020 — likely pre-#26004,
  i.e. before the checkpoint appendix). Working hypothesis: the #26004
  context-checkpoint appendix (up to 32 checkpoints × tgt/dft/spec blobs)
  rides along with the seq KV and dominates file size. Consequences: the
  fallback estimate (96 KiB/token) **under-estimates** for fresh chats; the
  learned own-row/peer ratio corrects from the second park onward, and
  `kvSnapshotMinFreeDiskBytes` is the backstop. Size `kvSnapshotMaxBytesPerPool`
  for the Phase 4 UI against ~176 KiB/token, not the spike number. (Falsifier:
  a save on b11552 with `--ctx-checkpoints` disabled should drop back toward
  ~48 KiB/token.)
- Orphan sweeps (startup + hourly): file without row → unlink; row without file →
  `stale`. Chat deletion, chat model switch (poolKey change), and lease reassignment
  all remove files eagerly via `chat-deletion.ts` / lease eviction hooks.
- Server **restart**: files remain valid (restore-across-restart is the upside of a
  disk tier, D5); server **binary/launch-config change** invalidates rows lazily at
  the §5.4 step-1 check, files unlinked by the sweeper.

### 5.6 Observability

- Structured `[kv-snapshot]` log lines (consistent with the existing `[kv-cache]`
  divergence logs) for save/restore/prune with `ms`/`bytes`/`state` transitions.
- Registry doubles as the metrics table (`timings` persisted per row; rolling stats
  via `restore_count`/`miss_count`).
- Residency records already surface slot bindings and hit confidence — parking adds
  a **Disk Residency** block to the ModelStats modal's Cache Residency section
  (pool totals, free disk, per-chat parked rows with restore/miss counters and a
  breaker warning) over `GET /api/settings/kv-snapshots`.
- **Hit displays read the wire, not the inference** (10-11): the residency hit
  column prefers the chat's most recent COMPLETED request's
  `cached_tokens / prompt_tokens` from `llm_requests` (enriched server-side),
  falling back to the inferred slot-observation only when no wire sample
  exists — the inference lags a turn, which made compaction-era statistics
  un-readable. The requests modal labels its token chips explicitly
  (`N in · M out`, `cache X cached (Y%)`) so prompt→completion is never
  misread as prompt→cached again.

## 6. Server configuration coupling

- The `--slot-save-path <APP_DATA_DIR>/kv-cache/` for the **inference slot** is
  derived at render time by `renderServiceExecStart` (`llama-service-config.ts`) —
  emitted **unconditionally**, never stored in `extraArgs`. Landed refinement: the
  flag is inert without parking, so gating it on the setting would force a unit
  rewrite + restart on every toggle; `parseManagedServiceConfig` drops manual or
  stale occurrences (canonicalization) and the re-render re-derives the canonical
  path — one source of truth, and a "Reset managed override" can never strand the
  API. The trailing separator (§2.1) is guaranteed by `kvCacheFlagPath()` in
  `services/paths.ts`; the directory itself is created import-time, alongside the
  data-dir migrations, by `ensureKvCacheDir()`.
- **Deferred (column reserved):** the rendered launch config digest
  (ctx-size, parallel, cache-type-k/v, flash-attn, slot-save-path, mmproj,
  build tag) is *not yet written* — `config_digest` exists in the registry but
  no path stamps it. Behaviorally a same-build config change costs at most one
  wasted restore per chat before the `miss_count` breaker learns (llama.cpp's
  LCP validation keeps it harmless); build-tag invalidation (§5.4 step 1)
  covers the swap that actually matters. Add the writer when config changes
  become common, not before.
- `llama-supervisor.ts` restart/stop actions for a parking-enabled unit should flush
  eligible parked chats first where cheap; otherwise the restart simply invalidates
  residency, not snapshots (files stay restorable — §5.5).
- Minimum-build gate (`kvSnapshotMinBuild`, default = first end-to-end-verified
  build): checked at park time via the binary-identity probe BEFORE any registry
  touch, so an older server produces zero state change and a visible log reason —
  no silent degradation. The restore gate compares recorded vs live build tags
  (§5.4 step 1) for the stronger commit-level identity.

## 7. Explicit deltas

Decisions D1–D8; settings keys are enumerated in §8.

Every behavioral decision, named — reviewable without reading the code:

| # | Decision | Chosen | Rejected because |
|---|---|---|---|
| **D1** | Who orchestrates parking | Porrima-side policy; stock llama.cpp only | A fork's `--slot-save-auto` couples our durability story to a rebased third-party branch; the gate + leases already give us the same scheduling (revisit if write-amp ever hurts) |
| **D2** | Headless coverage | Lease acquisition added to `chat-turn-runner.ts` as a **prerequisite**, not optional | Automations/system turns are the motivating cold-return victims; without pins, restore would race tier-1 slot selection and the whole feature is HTTP-only |
| **D3** | Save placement | After `done` event, per-slot queue, drop-if-restarted | Saving inside the turn adds I/O latency to the user-visible tail; "defer forever" queues pile up saves for chats that went idle anyway |
| **D4** | Staleness detection | Lazy digest comparison at restore-gate | Eager invalidation from every prefix-mutating subsystem (persona, extraction, skills) is more call sites, more drift, same outcome |
| **D5** | Files across restarts | Keep; invalidate only on `(build, config)` digest change | Wiping on restart throws away the cross-restart win that RAM tiering can never offer |
| **D6** | Budget scope | Per-`poolKey` caps | A global cap lets one server's big chats starve another's; pools are the natural KV namespace |
| **D7** | Eligibility metric | `usage.prompt_tokens` of the last iteration (wire-truth) | Estimators (chars/4, refined) re-open the estimator-asymmetry class of bugs turn-engine just closed; the usage number is the same quantity the cache actually matched |
| **D8** | Feature default | **Off** until Phase 3 validation ships | It writes tens-of-GB files; opt-in per host with visible stats first is the honest rollout |

## 8. Settings surface (Phase 4 UI, keys defined Phase 1)

Stored in the existing settings blob (`routes/settings.ts` pattern):

| Key | Default | Meaning |
|---|---|---|
| `kvSnapshotEnabled` | `false` | master switch (per-host opt-in); UI-gated on `llamacppSlotBindingMode: "enforced"` (parking cannot pin slots under auto — §7 D2), and the Settings group renders unavailable when auto is selected |
| `kvSnapshotMinTokens` | `65536` | eligibility threshold; break-even is host-dependent but low — tune from panel stats |
| `kvSnapshotSaveDebounceMs` | `90000` | minimum interval between saves of one chat |
| `kvSnapshotMinGrowthTokens` | `2048` | context growth that overrides the debounce |
| `kvSnapshotMaxBytesPerPool` | `274877906944` (256 GiB) | LRU cap per model-server |
| `kvSnapshotTtlHours` | `72` | hard expiry after TTL even under cap |
| `kvSnapshotMinFreeDiskBytes` | `68719476736` (64 GiB) | absolute disk floor respected by saves |
| `kvSnapshotOpTimeoutMs` | `60000` | restore budget (user-visible path); saves scale with the estimate: this floor + 2 s per 512 MiB, capped 300 s |
| `kvSnapshotMinBuild` | `11552` | minimum llama build number for parking (conservative: the first end-to-end-verified build; lower it deliberately once the #26640/#26004 build numbers are pinned) |

## 9. Failure model (summary table)

| Failure | Effect | Recovery |
|---|---|---|
| Save error/timeout, crash mid-save | row `stale`; partial file unlinked by sweeper | next eligible end-of-turn re-parks |
| Save captured a reassigned slot (`n_saved < lastUsage`) | new file discarded, prior snapshot restored | slot-identity guard; next eligible end-of-turn re-parks |
| Live build below `kvSnapshotMinBuild` | save skipped, visible log line, no registry touch | upgrade the server or lower the setting deliberately |
| Slot probe fails (pre-send) | restore skipped, no state change; turn pays normal prefill | automatic next turn |
| Restore error/timeout | pre-send proceeds after the budgeted failure; strike counted at attempt time | two strikes close the breaker until a re-park |
| Restore succeeds but prefix diverged | wasted restore seconds; LCP reuse degrades gracefully | digest gate tightens on next save; `miss_count` breaker caps repeats |
| Disk full / headroom | save refused pre-flight (estimate), stale rows pruned | budget policy; log + panel status |
| Server swap (build/config) | build-tag mismatch → rows invalidated lazily | files pruned by the sweeper |
| Lease reassigned / slot evicted by tier 1 | `slot_id` in row is history, not truth — re-park on next save with current lease | save always records the *current* slot |

In every row: no data corruption is possible (llama.cpp validates token identity on
reuse; §2.9), and the turn's output correctness is independent of this subsystem.

## 10. Phases

1. **Prereq** *(done 10-11)* — managed service render emits the flag (§6); headless
   lease acquisition (D2) with its regression pin
   (`__tests__/chat-turn-runner-lease.test.ts`, six cases: acquire args, streamFn
   threading, clean/error/non-llamacpp/acquire-failure balance).
   **Slot-capacity discovery** *(fixed 10-11, f89b1885)*: discovery read
   `max_instances` from `/props` — a key current llama.cpp never exposed (old
   fork convention) — so every chat was serialized onto slot 0 with
   LRU-steal churn. Discovery now counts `GET /slots` entries (ground truth,
   array-per-slot on current builds), keeping `/props` as a legacy fallback;
   `__tests__/llama-slot-leases.test.ts` pins discovery, fallback,
   inactive-peer LRU eviction, and the no-steal-while-active decline.
2. **Registry + save + budget/prune** *(done 10-11)* — parking becomes
   invisible-but-real: rows, files, metrics accrue; no restore path yet.
   `kv-snapshot.ts` + `kv_snapshots` (porrima.db), end-of-turn save enqueue in both
   finalize paths, per-pool LRU + TTL + orphan sweeps. Ships the data to tune
   thresholds.
3. **Restore + gates + breaker** *(done 10-11)* — the actual TTFT win; enabled
   end-to-end behind the setting (D8). `observeLlamaRequestBody` (provider gate:
   one-per-turn, pool/digest/build/slot-probe/breaker checks — see §5.4) +
   usage-confirmed `miss_count` breaker via request-log events; park stamps the
   observed wire-head digest and resets the breaker.
4. **Surfaces** *(done 10-11)* — settings menu controls (§8), Inference Servers
   status panel, disk accounting. Landed shape:
   - `GET /api/settings/kv-snapshots` — `getKvSnapshotSummary()`: policy,
     per-`poolKey` totals, live free-disk, registry rows with chat titles
     resolved at read time (mirrors `/cache-residency`). `storage-diagnostics`
     stays migration-integrity-only; disk accounting lives here.
   - Settings → Inference Servers → inference slot → Configuration: "KV
     snapshot parking" group (enable toggle + park-above-tokens, pool cap
     GiB, TTL hours). Unexposed keys persist through the settings merge.
   - ModelStatsModal: "Disk Residency" section beside Cache Residency —
     enabled badge, pool totals + free disk, per-chat rows (slot, tokens,
     size, saved-ago, restore/miss counts, state dot, breaker warning).
     Refreshes on open and on the same statsVersion live-tracking tick.

## 11. Tests

Unit (`server/src/__tests__/kv-snapshot.test.ts`): state-machine transitions
(saving→ready→stale incl. startup sweep); all §5.3 gates independent; digest gate
match/mismatch; breaker trips and resets; LRU/TTL/prune under synthetic budget;
orphan sweep idempotence.

Integration with a mocked `/slots` API (live-streams' fetch-mock pattern): save on
eligible end-of-turn, skip when the slot is warm, restore pre-send gated by the slot
probe (cold / warm / probe-failed), wire-failure strikes, min-build skip, slot-identity
guard, estimate ordering, D2 lease balance for headless turns.

Script smoke (`scripts/smoke-kv-snapshot.ts`, matching `smoke-request-log`): against a
parking-capable managed server with a synthetic prompt — asserts `n_saved == n_restored`
and iteration-1 `cached_tokens` hit, then cleans up. Run manually per release; not in
CI (needs a GPU host).
