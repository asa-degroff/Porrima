# KV Snapshot Parking — a disk tier for idle slot KV

**Status:** implemented — parking, restore gates, breaker, surfaces, and the post-warm
park (§5.3a) are live. Opt-in per host (`kvSnapshotEnabled`, §8); the only outstanding
item is the deferred `config_digest` writer (§6).

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
where size is cheap, and since #26640 they serialize multimodal state too, so the
old "not supported by multimodal" blocker no longer applies.

The missing piece is *orchestration*: llama.cpp will not decide for itself when a chat
is worth parking to disk and when to bring it back. That policy is exactly what a
turn-serializing app layer can provide.

### Reference run (illustrative — not constants)

One synthetic ~134k-token prompt against a parking-capable build. These are
measurements from that single run, **not constants** — everything the design
keys on is either config or learned at runtime.

Cold prefill ran ~355 s wall with `cached_tokens: 0`; `action=save` then took
~4.7 s; after `action=erase` verified the slot empty, `action=restore` took
~2.1 s (page-cache-assisted); and replay of the same prompt, repinned to the
restored slot, came back in ~1.3 s fully cached with a correct continuation.

The load-bearing shape is the ratio: **a full round-trip (save + restore)
costs seconds (~7 s) against a re-prefill that costs minutes (~355 s)** —
that economics is what every eligibility and budget gate in §5 keys off.

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

## 2. Upstream contract (verified against llama.cpp source)

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
   (idle slots omit the field). This is the tier-1
   witness the restore gate uses (§5.4 step 2) — the server's own view of what its
   slot holds.
4. **Build identity is not on a stable HTTP endpoint.** `/server_info` cannot be
   relied on — current builds 404 the request into the static-file handler. The
   running binary is the authoritative source instead: find the server process
   (cmdline carries `--port <port>`), read `/proc/<pid>/exe`, run
   `<bin> --version` → `version: 0.6.0-dev (build <n>, commit <sha>)`
   (implemented in `services/llama-build-probe.ts`). An HTTP `/server_info`
   fallback is kept for builds that expose it. **The version banner is printed
   to stderr** (the ggml log channel) — the probe concatenates stdout+stderr;
   a stdout-only capture returns `""` and makes the build gate pass vacuously.
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
   `(llama build, launch config digest)` that wrote them.
8. **Deferred slot tasks.** A save/restore targeting a processing slot is *deferred*,
   not rejected. Our global turn gate (§4) makes overlap rare, but the queue still
   serializes per slot (D3).
9. **Restore performs no prompt validation.** Correctness is guaranteed downstream by
   llama.cpp's longest-common-prefix matching between restored slot tokens and the
   incoming prompt. A diverged prefix wastes the restore's seconds; it cannot produce
   wrong output.
10. **Slot capacity is discoverable.** Current llama.cpp reports one `GET /slots`
    entry per slot — the entry count is the ground truth for slot capacity. A
    `max_instances` key on `/props` is an old-fork convention that current builds
    never exposed; trust `/props` as a legacy fallback only, never as the primary
    count (assuming one slot when the real pool is larger serializes every chat onto
    slot 0 and feeds LRU-steal churn). A capacity of one is nonetheless the
    preferred launch (§7 D9): the app deliberately multiplexes chats onto one
    slot, and the restore gate reads the slot's recorded owner instead of the
    count alone (§5.4 step 2).

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
| Lease call sites | `routes/chat.ts` — acquire just before streaming starts, release in the turn-completion path; `chat-turn-runner.ts` — the headless equivalent (D2) | The save trigger for both turn transports. Without the headless side, those turns are unpinned and restore would race tier-1 slot selection — hence D2 as a prerequisite |
| Residency | `services/llama-cache-residency.ts` — `LlamaCacheResidencyRecord{slotId, status: warming/warm/stale, confidence: confirmed-hit/partial-hit/filled-after-miss/unknown, reportedPromptTokens, inferredCachedTokens}` | UI status surface only — the restore gate reads the slot's own `n_prompt_tokens` via `GET /slots` instead: the residency record's `warm` memory outlives llama.cpp's idle eviction by orders of magnitude, so the slot's own count is ground truth |
| Table + startup sweep pattern | `services/request-log.ts` — `CREATE TABLE IF NOT EXISTS llm_requests …`, and the startup line that marks orphaned `in_progress` rows terminal | Copy for `kv_snapshots`: create-on-init + sweep `saving`/`restoring` rows at boot |
| Compaction funnel | `services/turn-compaction.ts` → `truncateChatHistory` (the one shared end-of-turn execution) | Eager invalidation — `invalidateKvSnapshot(chatId, "compaction")` lands inside the funnel. **Not the only spine rewrite:** the `truncateBeforeSend` primary archive path (pre-send backstop) mutates the spine without passing through the funnel, so it carries its own invalidate call — otherwise a pre-send compaction leaves a stale parked row and burns one wasted restore before the breaker or the next re-park catches up |
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
prompt edits, skill toggles. **It does not shift on compaction**: compaction
rewrites the messages, never the head, so a
post-compaction park has the same wire-head digest and the gate cannot catch
it — that case rides entirely on §5.5 eager invalidation and the §5.3
spine-freshness gate.

The digest is *observed* by the provider on every
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
completion block; headless: the equivalent in `chat-turn-runner.ts`, whose lease is the
one D2 adds). Runs
**after** the SSE `done` event and response flush — the triggering turn never pays for
parking. Policy (all must hold):

| Gate | Rule (all values config, §8) |
|---|---|
| Enablement | feature on; chat's model is served by a parking-capable managed server |
| Build | live build tag (running binary, §2.4) unknown **or** ≥ `kvSnapshotMinBuild` — a known build below the minimum (saves lack #26640/#26004 support) skips with a visible log line and touches no registry row |
| Pinning | turn held a lease (slot known and still mapped to this chat) |
| Eligibility | final iteration's `usage.prompt_tokens ≥ kvSnapshotMinTokens` — below this, re-prefill is cheaper than save+restore; the break-even is low (the §1 reference run: 134k tokens re-prefilled in ~355 s vs a ~7 s save+restore round-trip) |
| Freshness | last save for this chat is older than `kvSnapshotSaveDebounceMs`, **or** context grew by more than `kvSnapshotMinGrowthTokens` since it — rapid-fire tool turns stay in tier 1; the last turn before an idle gap is what gets parked |
| Spine freshness | the slot witness — the latest DONE chat request (D7's row, also the eligibility input) — must post-date the last §5.5 invalidation (`spineRewrittenAt`). End-of-turn compaction invalidates *before* the lease release enqueues the park, and the slot still holds the pre-rewrite wire shape: parking after the invalidate re-registers the snapshot the drop just deleted — and compaction is invisible to the head digest (§5.2), so a park enqueued after the drop carries the deleted observation's `prefix_digest ''`, which passes the restore gate vacuously; the freshness gate is the only thing that catches it. A rewrite landing mid-save is caught again at completion, before the `ready` mark. A rewrite that never gets a follow-up wire turn leaves the chat unparked, which is exactly right: the next turn re-prefills and then parks the fresh state |
| Queue | Per-`poolKey:slot` serialized job queue covering saves **and** restores; a queued save is dropped (not deferred forever) if the same chat's turn restarts first, or if another chat's restore reaches the slot first (§5.4 step 3) |
| Budget | §5.5 byte headroom check with the estimate learned from this chat's previous `bytes/n_tokens` ratio — read from the row **before** the `saving` upsert (the upsert rewrites `n_tokens` in place; reading after computes `prior.bytes / lastUsage`, an under-estimate whenever the context grew) |

Save = one `POST action=save`; on response, record `n_saved`, `n_written`,
`timings.save_ms`, digests, state → `ready`. Any error/timeout → row `stale`,
log, move on. **Save budget scales with the estimate**: a static timeout can
burn a large save and leave the next cold return to a full re-prefill, so saves get
`opTimeoutMs + 2 s per 512 MiB estimated, capped at 5 min` — they are
background work. `kvSnapshotOpTimeoutMs` stays the exact budget for
RESTORE, which sits on the user-visible path.

**Slot-identity guard:** the save fires *after* this chat's
lease released, so a new turn can acquire the same slot and start filling it
before the write lands. The slot can never hold fewer tokens than the finished
turn's prompt — if `n_saved < lastUsage`, the file captured someone else's
state: the new file is unlinked, the prior snapshot is restored, and the row
never points at the bad file.

### 5.3a Post-warm save

Block edits land at each chat's own compaction (`memory-context-persistence.md`
§10.4); no path refreshes cached heads globally. A restart serves the
last-served block sections from `chat_memory_block_state` until that
compaction (§11.6). The post-synthesis warm pass
remains the point where synthesis reaches the disk tier: its Case-1 re-roll
rebuilds the frozen-memories section, which is part of the head digest (§5.2).
Without an explicit park it discards the fresh head it just built, for three
compounding reasons: the warm pins no slot (the prefill lands on an arbitrary
slot by model routing), it crosses no provider choke point (no `llm_requests`
row, no observed digest), and the end-of-turn park of the synthesis turn itself
captures the **pre**-rewrite head — that turn's head is built at turn start,
while the zeitgeist rewrite happens mid-turn via tool calls. Tier-1's
minutes-scale eviction then silently eats the only fresh head, and the next
cold return re-prefills exactly what the warm just paid for.

Mechanism (four parts):

1. **Slot pinning.** `warmChatCache` acquires a llama slot lease
   (`acquireLlamaSlotLease`; null in auto-binding mode → zero behavior change)
   and threads it into the warm twice: the chat body (`options.llamaSlotLease`
   → `body.id_slot`, which feeds template render, digest, and the debug
   snapshot) and the prefill itself — `prefillOnly` adds `id_slot` to the
   `/completion` body, which is the **operative** pin. `id_slot` is a routing
   key; it does not touch the rendered prompt bytes (the warm's byte-parity
   contract, [pi-1.0-migration.md](pi-1.0-migration.md) §2.3, is preserved).
   Residency records now carry a real `slotId` with `bindingMode: "enforced"`
   instead of `"auto"`-with-no-slot.
2. **Explicit witness.** `parkAfterWarm({ chatId, lease, promptTokens,
   prefixDigest })` is a second entry point onto the *same* `runSaveJob` core
   — build gate, budget estimate + LRU + disk headroom, per-slot serialized
   queue, token supersede, slot-identity guard, rollback on failure,
   overwrite-after-success, breaker reset. What it skips: the
   `lastDoneChatRequest` witness (the warm produces no wire row), the
   spine-freshness comparison (a rewrite landing mid-save still supersedes
   the job via the token check), and debounce/growth (replaced by the digest
   rule below). The row is stamped with the **passed** digest — the
   warm body's `[head, tools]` via `computeLlamaPrefixDigest` — not
   `turnPrefixDigests`, which the warm by definition never populated.
   `promptTokens` is the warm's one-token-short prompt length
   (`warmTokenCount`) — the exact state the pinned slot holds after prefill
   (item 4: `n_tokens = warm tokens`). Deliberately **not** the server's
   workload counters: on a warm-LCP prefill `tokens_cached +
   tokens_evaluated` double-counts the prompt, and the slot-identity guard
   then discards a correct save. Field-confirmed 10-17 (expected 136,080 vs
   slot state 68,040 on a 68,040-token warm — the save captured the right
   bytes and was thrown away). Every gate on the path logs a receipt (no
   lease, disabled, below-min, digest-unchanged) — silent skips are how the
   10-11 silent-drop class hides.
3. **Digest-conditional rule.** Park only when there is no `ready` row **or**
   its `prefix_digest` differs from the warm body's digest. A byte-identical
   head (no-op synthesis) skips the write: the file is still valid, the warm
   only refreshed tier 1. This makes the post-synthesis pass the single place
   where synthesis's effect on the disk tier is handled. Emergent benefit:
   the end-of-turn park of a just-warmed chat is naturally suppressed by the
   existing debounce gate (fresh row, little growth) — no double-parking, no
   new coordination.
4. **Wiring.** Fire-and-forget after prefill **success** (mirrors the
   end-of-turn park; disk I/O never holds the warm), lease released in
   `finally`. Aborted, failed, or preempted warm → no save (the chat stays
   tier-1-only — a partial prefill would be a torn capture). The
   one-token-short shape means
   `n_tokens = warm tokens`, and the next turn's LCP matches to that boundary
   (the deliberate tokenizer-round-trip margin).

5. **Plan allocation (recent-first, 10-17).** The post-synthesis warm plan
   (`buildPostSynthesisWarmPlan`) consumes capacity recent-first: recent
   agent chats, then the system chat, then the new-chat baseline. The first
   field pass exposed why: at capacity 2 (the `--parallel` fallback —
   `/props` no longer exposes `max_instances`), the old baseline→system→
   recent order left recent structurally at 0 — the pass warmed the
   13k-token baseline and the 68k-token system chat and skipped the three
   60k+ user chats, whose next prefill is exactly what this pass exists to
   buy. The system's cold next-synthesis start is headless (no user impact);
   the baseline rides the regular warm schedule. Lever (undelivered): a
   settings key to override plan capacity — it currently reads the managed
   `--parallel`.

Known benign race: if the warm defers (the user queued messages) and runs
*after* that user's turn, its refreeze may pick a different top-k →
different digest → the warm over-parks. Consistent either way, because the
warm's head becomes the canonical future head (the next turn's Case-3 build
retains that frozen section) — one extra multi-GB write in the corner case.

### 5.4 Restore (pre-send, iteration 1 only)

Hooked in the provider's single dispatch choke point (`openai-compat-provider.ts`,
right after `buildOpenAICompatChatBody`, before the request URL exists on the wire)
via `observeLlamaRequestBody`. The gate lives in the provider, not the route/runner
pre-send paths, because only the provider has the *final wire body* — the digest
(§5.2) compares the exact bytes llama.cpp will tokenize, and both turn routes flow
through this one site, so HTTP and headless share the gate:

1. Row exists, `state = ready`, same `pool_key` as the lease, `build_tag` matches
   the live server (build tag from the running binary — `llama-build-probe`,
   60 s TTL; unknown-on-either-side passes vacuously — the file's own version
   checks are the backstop), `prefix_digest` matches (§5.2).
2. **The pinned slot is cold.** The slot's `n_prompt_tokens` (`GET /slots` for
   the lease's slot) is a residency witness only for the slot's **last writer**.
   The app records that writer per `(poolKey, slotId)`: every lease-held turn
   completion and every successful warm prefill records the chat into the slot,
   and a successful restore re-records it (§7 D9). If a known *other* chat last
   held the slot, the count measures that chat's fill — treat the slot as cold
   and restore without consulting it. Otherwise the count decides: if
   `n_prompt_tokens ≥ 50%` of the row's `n_tokens`, tier 1 still holds most of
   the parked prefix and will serve the turn — tier 2 must not pay the restore.
   An unknown owner (app restart, unpinned activity) keeps the count probe's
   verdict: degradation to prior behavior, never a guess. The residency record
   is *not* this gate's input: the app-side record keeps
   `warm` for 12 h while llama.cpp evicts idle slot KV in minutes, so a mid-gap
   return would read "warm" and skip exactly the restore it needs — the slot's
   own state is the only pre-send signal that is ground truth, and residency
   remains the UI surface. Probe failure is a
   skip, never a guess — the turn proceeds with normal prefill, no state change.
3. `POST action=restore`, serialized on the slot's job queue (§5.3) and
   budgeted by `kvSnapshotOpTimeoutMs`. Before it queues, the restore cancels
   other chats' queued-but-unstarted saves on that slot: the restore replaces
   the slot's content, and a save that ran afterwards would capture the
   restored state under another chat's row. In-flight saves keep their capture
   — the slot still holds the saving chat's state until the restore lands, and
   the queue orders the restore behind them. Success → bump `restore_count`,
   stamp `last_used_at`, record the chat as the slot's owner, register a
   usage-validation marker.
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
- **Measured bytes/token: parked files land at ~176 KiB/token.** Working hypothesis
  (open): the #26004 context-checkpoint appendix (up to 32 checkpoints ×
  tgt/dft/spec blobs) rides along with the seq KV and dominates file size.
  Consequences: the fallback estimate (96 KiB/token) **under-estimates** for fresh
  chats; the learned own-row/peer ratio corrects from the second park onward, and
  `kvSnapshotMinFreeDiskBytes` is the backstop. Size `kvSnapshotMaxBytesPerPool` (§8)
  against ~176 KiB/token, not a lower pre-#26004 figure. (Falsifier: a save with
  `--ctx-checkpoints` disabled should drop back toward ~48 KiB/token.)
- Orphan sweeps (startup + hourly): file without row → unlink; row without file →
  `stale`. Chat deletion, chat model switch (poolKey change), and lease reassignment
  all remove files eagerly via `chat-deletion.ts` / lease eviction hooks.
- **Eager invalidation + park suppression** (§5.3 spine-freshness gate):
  `invalidateKvSnapshot` drops row + file, supersedes queued saves via the
  `pendingTokens` bump, and stamps `spineRewrittenAt` — an in-memory per-chat
  watermark that also suppresses parks enqueued AFTER the drop, until the next
  DONE chat request (the rewritten spine refilling the slot) re-arms them.
  The watermark is in-memory like `pendingTokens`: a restart leaves the slots
  cold, and the slot-identity guard bounds the worst case for a lost entry.
- Server **restart**: files remain valid (restore-across-restart is the upside of a
  disk tier, D5); server **binary/launch-config change** invalidates rows lazily at
  the §5.4 step-1 check, files unlinked by the sweeper.
- **Slot-ownership map** (§5.4 step 2, `(poolKey, slotId) → chatId`) is in-memory
  like `pendingTokens`: a restart leaves every owner unknown and the gate degrades
  to the count probe until the next recorded writer per slot. Files stay restorable
  across the restart (D5) — the map only decides whether a restore is attempted.

### 5.6 Observability

- Structured `[kv-snapshot]` log lines (consistent with the existing `[kv-cache]`
  divergence logs) for save/restore/prune with `ms`/`bytes`/`state` transitions.
- Registry doubles as the metrics table (`timings` persisted per row; rolling stats
  via `restore_count`/`miss_count`).
- Residency records already surface slot bindings and hit confidence — parking adds
  a **Disk Residency** block to the ModelStats modal's Cache Residency section over
  `GET /api/settings/kv-snapshots` (`getKvSnapshotSummary()`: policy, per-`poolKey`
  totals, live free disk, and registry rows with chat titles resolved at read time —
  mirrors `/cache-residency`). The block shows the enabled badge, pool totals + free
  disk, and per-chat parked rows (slot, tokens, size, saved-ago, restore/miss counters,
  state dot, breaker warning); it refreshes on open and on the same `statsVersion`
  live-tracking tick that drives the modal. Disk accounting lives here, not in
  `storage-diagnostics` (which stays migration-integrity-only).
- **Hit displays read the wire, not the inference**: the residency hit
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
  emitted **unconditionally**, never stored in `extraArgs`: the flag is inert
  without parking, so gating it on the setting would force a unit
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
- Minimum-build gate (`kvSnapshotMinBuild`, default = first verified build): checked at
  park time via the binary-identity probe BEFORE any registry
  touch, so an older server produces zero state change and a visible log reason —
  no silent degradation. The restore gate compares recorded vs live build tags
  (§5.4 step 1) for the stronger commit-level identity.

## 7. Explicit deltas

Decisions D1–D9; settings keys are enumerated in §8.

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
| **D9** | Shared-slot semantics | Single-slot launch (`--parallel 1`) is the preferred topology; the tier-1 gate keys on the slot's recorded last writer, and restores serialize on the slot's job queue | The turn gate already serializes every turn, so slot multiplicity buys no throughput the app uses, while `--parallel N` shrinks every pinned chat's usable context to the slot's share. On a shared slot a count-only "warm" probe measures whoever filled the slot last — it silently skips the restore that saves minutes; an unchained restore lands over queued captures, registering one chat's KV under another's row. Ownership plus queue ordering replaces both with a re-restore of at most seconds |

## 8. Settings surface

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
| `kvSnapshotMinBuild` | `11552` | minimum llama build number for parking (conservative: the first verified build; lower it deliberately once the #26640/#26004 build numbers are pinned) |

**Where these appear:** Settings → Inference Servers → inference slot → Configuration —
a "KV snapshot parking" group (enable toggle + park-above-tokens, pool cap GiB, TTL
hours). Unexposed keys persist through the settings merge.

## 9. Failure model (summary table)

| Failure | Effect | Recovery |
|---|---|---|
| Save error/timeout, crash mid-save | row `stale`; partial file unlinked by sweeper | next eligible end-of-turn re-parks |
| Save captured a reassigned slot (`n_saved < lastUsage`) | new file discarded, prior snapshot restored | slot-identity guard; next eligible end-of-turn re-parks |
| Live build below `kvSnapshotMinBuild` | save skipped, visible log line, no registry touch | upgrade the server or lower the setting deliberately |
| Slot probe fails (pre-send) | restore skipped, no state change; turn pays normal prefill | automatic next turn |
| Restore error/timeout | pre-send proceeds after the budgeted failure; strike counted at attempt time | two strikes close the breaker until a re-park |
| Restore succeeds but prefix diverged | wasted restore seconds; LCP reuse degrades gracefully | digest gate tightens on next save; `miss_count` breaker caps repeats |
| Spine rewrite (compaction/deletion) between the last wire turn and the park | save skipped at enqueue with a visible log line; a rewrite landing mid-save discards the file before the `ready` mark and rolls the row back | next eligible end-of-turn re-parks after a fresh turn refills the slot (§5.3 spine-freshness gate) |
| Disk full / headroom | save refused pre-flight (estimate), stale rows pruned | budget policy; log + panel status |
| Server swap (build/config) | build-tag mismatch → rows invalidated lazily | files pruned by the sweeper |
| Lease reassigned / slot evicted by tier 1 | `slot_id` in row is history, not truth — re-park on next save with current lease | save always records the *current* slot |
| Post-warm save error/timeout | row rolls back to the prior `ready` snapshot (or `stale` if none); the fresh head lives in tier 1 until evicted | next end-of-turn park, or the next synthesis warm pass, re-parks |
| Warm prefill aborted/failed/preempted | no save is issued — no partial slot state captured | tier-1-only; next warm pass or turn re-parks |
| Warm deferred past a user turn (benign) | one extra park (different digest) in the corner case | digest gate keeps the row canonical; end-of-turn debounce covers the common case |
| Queued save of another chat races a foreground restore on the shared slot | the save is cancelled before it runs; its row keeps the prior snapshot | restore cancels queued saves on the slot and chains behind the in-flight one (§5.4 step 3); next eligible end-of-turn re-parks |

In every row: no data corruption is possible (llama.cpp validates token identity on
reuse; §2.9), and the turn's output correctness is independent of this subsystem.

## 10. Rollout order

Delivered in five phases, all live. The phase boundaries encode the rollout strategy:
each phase ships independently behind the setting and is independently useful before the
next one exists.

1. **Prereq** — managed service render emits the `--slot-save-path` flag (§6); headless
   lease acquisition (D2). Without pins, restore would race tier-1 slot selection and
   the whole feature would be HTTP-only, so this lands before anything parks. Slot
   capacity is discovered per §2.10.
2. **Registry + save + budget/prune** — parking becomes
   invisible-but-real: rows, files, metrics accrue; no restore path yet.
   `kv-snapshot.ts` + `kv_snapshots` (porrima.db), end-of-turn save enqueue in both
   finalize paths, per-pool LRU + TTL + orphan sweeps. Ships the data to tune
   thresholds.
3. **Restore + gates + breaker** — the actual TTFT win; enabled
   end-to-end behind the setting (D8). `observeLlamaRequestBody` (provider gate:
   one-per-turn, pool/digest/build/slot-probe/breaker checks — see §5.4) +
   usage-confirmed `miss_count` breaker via request-log events; park stamps the
   observed wire-head digest and resets the breaker.
4. **Surfaces** — settings menu controls (§8), Inference Servers
   status panel, and disk accounting over `GET /api/settings/kv-snapshots` (§5.6).
   Disk accounting lives with the parking summary endpoint, not with
   `storage-diagnostics` (migration-integrity only).
5. **Post-warm park** — `parkAfterWarm` + warm slot pinning (§5.3a); test coverage
   in §11.

## 11. Tests

Unit (`server/src/__tests__/kv-snapshot.test.ts`): state-machine transitions
(saving→ready→stale incl. startup sweep); all §5.3 gates independent; digest gate
match/mismatch; breaker trips and resets; LRU/TTL/prune under synthetic budget;
orphan sweep idempotence.

Integration with a mocked `/slots` API (live-streams' fetch-mock pattern): save on
eligible end-of-turn, skip when the slot is warm, restore pre-send gated by the slot
probe (cold / warm / probe-failed), wire-failure strikes, min-build skip, slot-identity
guard, estimate ordering, D2 lease balance for headless turns
(`chat-turn-runner-lease.test.ts`: acquire args, streamFn threading, and the
clean/error/non-llamacpp/acquire-failure balance). Shared-slot semantics (§7 D9):
a known other chat's ownership bypasses the warm-count probe and restores; the slot's
own last writer keeps the probe verdict; a restore chains behind an in-flight save on
the same slot; a restore cancels other chats' queued-but-unstarted saves before
replacing the slot's content.

Slot-capacity discovery (`llama-slot-leases.test.ts`): `GET /slots` entry-count ground
truth, `/props` legacy fallback, inactive-peer LRU eviction, and the no-steal-while-active
decline.

Warm seam (`cache-warm-park.test.ts`) pins §5.3a from the warm side: `id_slot` on the
`/completion` body (the operative pin), park fired with the warm's witness inputs, lease
released in `finally`, failed prefill parks nothing, and auto binding mode degrading to
no-pin. The `kv-snapshot.test.ts` post-warm block pins the §5.3a gates: disabled /
no-lease / below-min / same-digest skip; digest-drift save with the warm-digest stamp and
prior-file unlink; first park; a later warm pass superseding an in-flight earlier save; an
invalidate landing mid-save superseding the capture; failed-save rollback; slot-identity
discard.

Script smoke (`scripts/smoke-kv-snapshot.ts`, matching `smoke-request-log`): against a
parking-capable managed server with a synthetic prompt — asserts `n_saved == n_restored`
and iteration-1 `cached_tokens` hit, then cleans up. Run manually per release; not in
CI (needs a GPU host).
