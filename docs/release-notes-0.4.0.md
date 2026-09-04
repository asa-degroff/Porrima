# 0.4.0 (working title) — Change Survey & Release Notes Draft

> Scope: `0.3.1..HEAD` (91352e2 → cc6d690), 123 commits, 2026-07-18 → 2026-09-02.
> 149 files changed, +22,393 / −4,805. 41 new files (11 server modules, 29 test suites, 1 client asset + component/lib set). No files deleted.
> Baseline at survey time (09-03 00:25): **583 tests pass / 1 todo (79 files), tsc clean server + client, working tree clean.**
> Post-review state (09-03 ~02:00): **589 pass / 1 todo (590), tsc clean** — after f5b31c1 (A1 cleanups), Asa's ac5dbe7 (late-freeze memory, +2 tests, disjoint from the review), and 610f3f3 (D1 flip, +4 tests). Deployed dist is still cc6d690 (built 09-02 02:03 MDT) — rebuild + restart is Asa's call; the D1 flip and the cleanups are not live until then.

The period is dominated by five intertwined systems: the compaction/turn-engine rework, the mid-turn extraction pipeline, the memory-context persistence line, the turn gate, and the SSE resync architecture. The rest is a wide ring of feature work (browser tools, TTS worker, PDF, theme/appearance, settings reorg, stats surface) plus the July dependency/toolchain bump.

---

## A. Code review areas

Risk tiers: **T1** = control flow with incident history or data-safety invariants · **T2** = invariants that touch every turn · **T3** = self-contained, tested.

### A1. Compaction & context pressure ("turn engine") — T1 · 19 commits

The largest and highest-stakes area. Grew out of the Aug 19 compaction wipe (fb9cdb6f: a stale pre-compaction usage anchor + unbounded scale factor wiped ~19K of healthy context) and 14 days of forensics showing the main-route end-of-turn check structurally blind.

- **Estimator defang** (5dd20ad): boundary-guarded usage anchors (scan stops at the newest `_isCompactionSummary`), scale factor clamped to [0.75, 1.5] with WARN on divergence, degenerate "overhead > target" branch re-based to raise the target instead of wiping, loud logging on both last-resort paths. Five regression tests in compaction-safety.test.ts.
- **End-of-turn compaction** (ac4eaf2, af24def, 058512d): lands in system synthesis/wake; stale usage cleared on kept assistant messages in both truncate paths; check moved after continuation + mid-turn loops (9454d04); driven by the refined estimator at a 0.80 threshold so compaction lands while the user reads (0a9186c); runs on the failure path too (3c972ca); denominator floored at observed high-water (be6f0c6, context-high-water.ts).
- **Headless mid-turn compaction** (0a4baeb): `shouldStopAfterTurn` on usage-anchor or `length` finish, compact persisted history, resume with a handoff message — synthesis/wake/automation turns no longer truncate at the context limit.
- **Turn-engine consolidation** (9b2a944 design doc; b74fc8a Phase 0; 4772b28 Phase 1; 40404d7 D1 pin; 322133a Phase 2a): four compaction dialects (chat.ts inline, system-chat char-only, automation pre-send backstop, chat-turn-runner hook) → one pressure estimator (context-pressure.ts: `estimateContextPressure` + `evaluateTurnGuards`) and one compaction skeleton (turn-compaction.ts: `runEndOfTurnCompaction`, `runMidTurnCompactionCycles`, `persistMidTurnHandoff`). Phases 3–4 (mid-turn shape unification D6, TurnState) are **deferred by design** — the pinned trigger mapping (refinedTokens→0.85, hardCapTokens→0.95, max(usage, estimated)→0.80) is the contract; changing a row is a behavioral delta.
- **Mid-turn compaction UI fidelity** (branch fix/compaction-ui-fidelity, merged 7b72e5a): handoff rows visible at persisted position, live context boundary, summary spliced into server order (987d281); split-count decomposition in the token indicator tooltip (1e58803).
- **Tool-loop row dedupe + salvage** (0565f62): re-persisted tool-loop rows no longer double-print.
- **evaluateTurnGuards cleanup** (eeae313): removed the duplicate-tool-call guard.

**Key files:** services/{context-pressure.ts, turn-compaction.ts, compaction.ts, context-high-water.ts, chat.ts, chat-turn-runner.ts}, __tests__/{context-pressure, turn-compaction, compaction-safety, compaction-forensics, context-high-water}.test.ts, docs/design/turn-engine.md.

**Review notes:**
- All four call sites (HTTP send, system chat, automation, chat-turn-runner) must consume the same three pinned numbers; the D1 shadow-pinning fixtures (40404d7) define the expected divergence band (0.85, 0.95].
- Verify the strict `>` comparators at both 0.80 and 0.95 boundaries (pinned in b74fc8a; a `>=` change is deliberate).
- The 5dd20ad defang is the safety fix for the data-loss incident — confirm the clamp + boundary guards are in every path that reads usage (estimator, driving-path log, trigger scan).
- Phases 3–4 deferral means chat.ts still carries some inline mid-turn machinery — confirm the seam is documented, not accidental drift.

### A2. Extraction pipeline (mid-turn + pre-compaction + delayed) — T1 · 12 commits

The "never drop work, never consume what wasn't processed" line. memory-extraction.ts is the second-largest diff (+1,917).

- **Pre-compaction flush as session continuation** (170af67): removed messages flushed through the chat's live extraction session (same KV prefix → warm reuse) instead of a standalone prompt; fast path when the window fits the budget, otherwise chunked continuation appending as user turns; degrades to independent calls. `onBeforeArchive` hook runs the flush to completion before `saveArchives` at all six compaction call sites.
- **Windowed mid-turn triggering + FIFO slicing** (684e716): 0.65 context-ratio trigger with 256-token floor (well before the 0.85 compaction trigger); pressure step-latch (fires at most once per +0.05 ratio step, re-arms below 0.60); failed chunks are not consumed; `sliceMidTurnWindowToFit` slices over-budget windows in render order so later pulses drain the remainder; oversized first tool result truncates with a marker instead of permanently blocking; cursor triad — optimistic advance → rewind on partial → full rollback on failure — preserving "cursor = end of what the extraction model saw."
- **Resume-loop pulse hooks + cursor reset** (5747028); timeout-cap alignment across server/client (dcf0910); split-head support (ce1045a).
- **Slot-aware context budgeting** (7135d6a): extraction moved to `--parallel 2` (ctx 131072, q8_0 KV); /props parsing is scope-aware (server total vs per-slot `default_generation_settings.n_ctx`), only totals divided — packing against 131k on a 65536-per-slot server would have overflowed the largest pre-compaction flushes.
- **Boilerplate source removed** (256cfe0): synthetic automation trigger prompts excluded from the extraction window (59 rows Apr–Aug).
- **Over-cap delayed windows drain FIFO** (fd99142): 50+50+17 tail-column drain with loud "Window over cap" instead of silent drop (65 drops in 29 days pre-fix).
- **JSON validation with deterministic repair + feedback retry** (20aad32).
- **Extraction prompt updates** (50b5f22, 8c67a9e, 9dade49).

**Key files:** services/memory-extraction.ts (+1,917), __tests__/{mid-turn-extraction, delayed-extraction-scheduler, delayed-extraction-window, extraction-json-repair, block-digest}.test.ts.

**Review notes:**
- The cursor invariant is the heart of it — optimistic advance / rewind / rollback must cover timeout, partial coverage, and failure paths.
- Pre-compaction flush is solo (never batched with exchange jobs) — confirm the FIFO ordering in runBatch.
- Scope-aware /props: a per-slot value divided again would halve the budget twice; the tests pin total-divided and per-slot-not-divided.
- Confirm the 900s-timeout history (26.4k delayed-window silent timeouts) is actually closed by the drain, not just logged.

### A3. Memory context persistence + clobber guard — T1 · (part of A5, listed separately for review)

- **Per-chat memory context state persisted** (db05031 design doc v1.1; 9fa10f4 Phase 1): `memory_context_state` per chat; hydrate is byte-exact by construction, reranker out of the path. 588-line test suite.
- **Clobber guard + soft reset** (4ba91ec doc v1.3; 8b6fe3d; dfba197): a Case 1 with zero retrievals must not overwrite a non-empty row — the "memory system that can forget itself into emptiness without an error" class. Guard = non-establishment, not retention (doc corrected).
- **Block digest moved out of the extraction system prompt into the user turn** (cfa9d26): block edits stop invalidating the extraction KV prefix + session identity key (the 232s double-blow).

**Review notes:** hydrate byte-exactness across restart (canary rows); the guard's interaction with the delta-injection path (frozen section vs appended recalls); digest tail placement so the frozen prefix stays a byte-prefix.

### A4. Turn gate & queueing — T1 · 5 commits

- **Global FIFO turn gate** (df700fa, turn-gate.ts): every GPU-bound turn serializes behind a lease; queued clients get SSE `waiting` events with position + keepalive; /stop or a same-chat replacement aborts the waiter cleanly; automations join the same lease and the schedulers skip when the gate is busy, so background work never cuts in front of a waiting user message. (Before: a second turn into the single llama.cpp slot died with a cryptic provider error.)
- **Queued-message indicator** (7ec46fe, QueuedMessageIcon.tsx); **TurnLeaseRef** (57312b0).
- **Cache-warm deferral** (78edd8c design v1.2; 50e0411): non-user warm yields to fresh queued messages and to real turns — the race was `isActive()` counting only in-flight inference, so the gate looked free during tool phases. Three tiers: fresh queued beats non-user warm, post-synthesis skips when anyone waits, user-requested overtakes.

**Review notes:** lease acquire/release on **every** error/abort path (a leaked lease stalls the whole GPU pipeline); compaction-under-lease is correct and must not move out (design gate); the duplicate-attach path in the top-of-POST automation wait.

### A5. Memory blocks & tool surface — T2 · 14 commits (shared with A3)

- **Block lifecycle**: overflow rejects with exact overage instead of silent supersede-truncate (f4f776e); `save_memory` agent-initiated supersession via `supersedeMemoryId` with 1.0-confidence lineage links (e0978ab); `archived` scope, block-level supersession, and per-edit history snapshots (889d1a6).
- **Retrieval quality**: subject integrated into `buildMemoryIndexText` (0de8535); block chars/cap reported in read/list output, stale not-found hints routed to search_memory (f4a7e16); `list_memory_blocks` description/param refactor (bf12897).
- **read_archived_context rework** (753da18): thinking omitted by default (31–96% of rendered chars in production archives), budget-aware staged rendering under the tool-result cap, offset/limit paging, and split-heads carry the turn's final text so archive index/FTS see conclusions. Replay-verified against the real failing archive (110K → 36.7K chars, both fix lists intact).
- **Debug surface**: memory debug modal simplified (cc6d690).

**Review notes:** the 15-block cap and archived-scope exclusion from active context; lineage integrity of superseded blocks (kept, not deleted); the char/cap reporting against `maxBlockChars` 9000.

### A6. Streaming & reconnect (SSE resync) — T1 · 5 commits

The replay design died here. Four commits took the system from "replay the whole turn buffer and dedupe client-side" to "send the server's authoritative state."

- **Reconnect after refresh** (7b80ad4): recently-streaming markers moved to sessionStorage (reload survives), one-shot `/chat/status` probe for the first opened chat (covers headless streams the client never initiated), `onNoActiveStream` on the 404 race between probe and attach, replay-idempotent callbacks.
- **Replayed `message_complete` dedupe + windowed reconnect fetches** (015937f): seeded rows + full-buffer replay produced ~2N assistant rows with duplicate `_rowSequence` keys — the lag on resumed streams.
- **Resync snapshot** (de3f917, turn-engine follow-up P1): `buildResync` hook per stream owner; `TurnResyncPayload` = uncommitted fragment (non-mutating read of pendingText), last iteration event, last model_progress, waitingForInput, open-compaction flag, thinkingActive. Resync preferred; buffer replay as fallback.
- **Buffer replay retired entirely** (7026aa2, P2–P4): SynthesisEmitter builder (headless: whole accumulated state IS the tail), turn-gate queue-state builder, duplicate-POST → terminal `reattach` event → client reconnect flow. Deleted: the LiveStream buffer (up to 10MB per active turn), `?replay` param, `bufferedChunks` status field, five client dedupe checks.
- **Stuck-compacting self-heal** (8183801): survives mid-compaction reconnect.

**Review notes:** exactly-once delivery now rests on "resync snapshot written synchronously before subscriber added" — check that invariant in buildAttachFrames; the non-mutating pendingText read must not perturb the live segment stream; the duplicate-POST opt-out (no persisted-row baseline) is the one path that can't resync; headless streams persist nothing until end-of-turn so the whole state is the tail — confirm the `_isSystemMessage` shape.

### A7. KV-cache, anchors & clocks — T2 · 5 commits

- **[time:] anchor** (3d817fd, 8054df9): temporal anchor for gap-awareness, moved from system-prompt tail to the trailing user message for stability.
- **Frozen anchors** (b47dbeb): `buildTimeAnchor` computed once at row creation, stored as `ChatMessage.timeAnchor`, replay re-appends the frozen string — turn N's wire prompt is a strict byte-prefix of turn N+1's (previously every turn diverged at the previous user message, observed 70–85% hits). All seven send paths freeze-and-reuse; legacy anchor-less rows self-heal after one turn.
- **Intra-loop time markers** (63da1f3, time-marker.ts): `[time: — X since …]` appended to a tool-result tail once the interval (default 15m) elapses; applied at the wrapped `execute` boundary so marked bytes are wire ≡ replay; one marker per parallel batch.
- **Time-format unification** (81dfed9, time-format.ts).

**Review notes:** anchors must stay out of content (UI, FTS, extraction never see them); the marker caps parallel batches at one; steering shares the gate, follow-up streams reset the turn-start reference; the only intentional byte-identity exception in the prompt is the anchor tail (~12 KV tokens).

### A8. Stats, indicators & context breakdown — T2 · 12 commits

- **reportedCachedTokens + canonical resolution** (95c217c); stats modal: tokens in/out, cached + hit, reported-vs-canonical divergence (4378ad2); per-iteration model stats with live re-fetch on each iteration SSE event (0a854c1).
- **Context breakdown** (77e7a50, context-breakdown.ts): per-section usage anchor; compaction-aware anchoring (746d2d3 — pre-compaction usage is stale by design); warm-cache flag requires section capture (746d2d3); client hardening: stale-fetch race guard, resolved context window threaded through, cache capped at 32, post-compaction client-side rescaling so popover and indicator always agree (ecd0a56); rows renamed Frozen memories / Memory additions with mechanism tooltips (71d0b44).
- **Prefill indicator line**: shown for the cold prefill after every compaction (3e81183); on cold resumes with occupied slots (fa2c351); denominator stabilized with the exact pre-dispatch /apply-template+/tokenize count (cb9239a — `n_prompt_tokens` is a batch-chunk frontier that climbs during prefill); post-compaction fixes: slot-reported totals, stale usage clears, tool-schema overhead (fef5153); micro-runs excluded from the prefill-rate EMA (fb35eee).

**Review notes:** every number in this area is an *estimate* anchored to usage data that compaction can invalidate — the anchor-boundary logic (stop at `_isCompactionSummary`) is repeated in estimator, display, and breakdown paths and must stay consistent; the prefill denominator change means the indicator is now exact on the happy path and degraded elsewhere — check the degraded path is labeled.

### A9. LLM plumbing & provider — T2 · 5 commits

- **Off pi-ai's deprecated /compat** (9fe4c23, llm-provider.ts): `createProvider` + `createModels()` collection, `streamLlamaCpp()` as the single dispatch surface; verified Models.streamSimple spreads custom options (llamaSlotLease, onModelProgress, …) and setup failures become stream error events (never-throw contract preserved). Dead weight deleted: the cloud-model `:cloud` check (no cloud models exist), `supportsReasoning(family) || true` (literally always true), two identical replay-identity branches, two write-only `discoverAllModels()` round-trips.
- **Model fallback** (972d540): unavailable chat models fall back; local state updated.
- **Trust an explicitly idle slot over residual n_remain** (935a16c): a stale `n_remain > 0` was latching the runtime-busy probe and blocking the automation scheduler indefinitely.
- **Vision support from llama.cpp model metadata** (497e7a8); **mtmd media-marker tokens stripped from provider-bound text** (22cd111 — prevented tokenize aborts).

**Review notes:** dispatch now keys off `model.provider`; persisted `api:"openai-compat"` labels are inert identity fields (no data migration — confirm nothing still reads them); the 30min/10min/2h timeout ladder simplification; fallback's local-state updates vs the model-discovery cache.

### A10. TTS — T3 · 3 commits

- **Persistent Kokoro worker** (7674b0f, kokoro_worker.py): the TTS worker stays alive across requests instead of cold-starting per chunk.
- **Worker pool hardening** (7eb90ea): init-promise guard + timeout-to-respawn escalation.
- **Live playback fix** (acec417).

**Review notes:** the pool state machine (init race, respawn escalation, drain guard); worker lifetime vs server shutdown.

### A11. PDF pipeline — T3 · 3 commits

- **PyMuPDF4LLM** (8311b29, pdf-extract.py): GNN layout parsing; **inline figure rendering** (43b54f7) with `extractImages` and a 5-figure/call cap; inline-image artifact cleanup + guaranteed Tesseract data availability (2748342).

**Review notes:** OCR fallback paths (150 DPI pixmap, hybrid OCR on scanned pages); error handling around the python subprocess; the figure cap interaction with the tool-result budget.

### A12. Automations — T3 · 7 commits

- **Tabbed settings editor** (c341df1); **reminder budget as global settings** (00f42d9): `reminderMaxIterations`/`reminderTimeoutMs` (defaults raised 5iter/5min → 20iter/30min); per-task copies at creation, existing tasks unaffected; **ungate automation management tools in system/headless chats** (bce0e5e); **daily absent window** for absent activation gating (bdad556); running-task outline-trace animation (d7733ab); dropdown viewport clamp (a169216); interval input fix (f78c28e).

**Review notes:** the scheduler's lease + skip-when-busy (shares A4's gate); the absent-window arithmetic; the settings-modal grid for reminder budgets.

### A13. UI: themes & appearance — T3 · 9 commits

- **Opaque message bubbles theme** (be195e1) + accent color clamp (2ed8bde); **saved theme presets** (3a854c1): two-knob custom-theme bookmarks, full-gradient chips, case-insensitive unique names, shared hex/luminance validation, 50 cap; **linen background** (095835c, 0334d05): neutral 50%-gray mask soft-light over the theme, 1024px tile (256 showed a visible repeat; first asset was below the 8-bit noise floor); single-path plus icons (2aeb17f); composer font size matched to bubbles (fff5fe5); prompt-viewer high-efficiency styling + `cached` flag on `fetchRenderedPrompt` (cddde82, a84a0fe).

**Review notes:** preset validation parity with the custom theme (server `normalizeThemePresets` drops invalid, dedupes, caps); the linen mask math (amplitude 44, feBlend 'arithmetic' unsupported in Chromium → feComposite).

### A14. UI: tool-call display & Five Beats — T3 · 7 commits

- **Tool call display rework** (fc95fe0, 4596dd3): in-progress tool-call composition streams to the UI; scrollable streaming preview + call-detail tier; argument preview no longer double-prints mid-stream (cd0bce5); label styling (0f2c34f, a96d449).
- **Five Beats** (b8dcdd0, Beats.tsx + activityTimings.ts): five-squircle LED activity indicator, one beat per polyhedron decode pulse (shared 1840ms/153.33ms-per-step constants, PolyhedronLogo refactored onto them); color from the user's activity hue/sat.
- **Chromium hsl fix** (050e53c): outline color + glow were silently dropped — Chromium rejects mixed `hsl(H, S%, L% / A)` comma+slash syntax; now space syntax, verified via computed styles + per-indicator pixel counts.

**Review notes:** the ToolCallDisplay state machine (preview resting-state-only, body = argument surface mid-stream); reduced-motion static frame; the shared-constants refactor is behavior-preserving — confirm the polyhedron timings are byte-identical.

### A15. Settings reorganization (July) — T3 · 6 commits

SettingsModal.tsx is the largest single-file diff (+2,387): inference-server settings redesign (35163a9), SSH connection management UI (cf9043c), tabbed automation editor (c341df1, see A12), tabbed TTS controls + voice preview (7050c26), memory-extraction settings (8a40640), image-generation reorg (48ce73d); extra-args textarea whitespace fix with quote-aware tokenizer parsing at the preview/apply boundary (ece1de3).

**Review notes:** the normalization/clamping paths in chat-storage for every new setting; the tokenizer's quote-awareness at the draft/preview boundary.

### A16. Toolchain & dependencies — T2 · 5 commits

- **TypeScript 7.0** (78fa05d) — the Go native compiler; the build pipeline is a real jump, not a patch bump.
- **@earendil-works/pi-* → 0.83.0** (fa78170) — directly motivated the A9 provider migration (0.83 marks /compat for deletion); **better-sqlite3 → 13.0.2** (83709ab); uuid/puppeteer-core/sharp (cc3173c); low-risk patch sweep (ee240a7).

**Review notes:** TS7 build output parity (tsc is now the Go native compiler — watch for diagnostics changes, not behavior); better-sqlite3 13 N-API on Node 24; the pi-ai 0.83 surface changes (the 9fe4c23 migration is the compatibility proof).

### A17. Housekeeping — T3 · 3 commits

07bfb6a: the "pre-existing sharp/webp test failures" were a corrupted IDAT CRC in a 1×1 PNG fixture — a fixture typo, not a native-module issue. 50166ea: ignore root markdown docs. 1c492f1: title-generation prompt updates.

---

### Review criteria (per Asa, 09-03)

Beyond correctness against the pinned invariants, every area is reviewed for:
1. **Stale code** — dead branches, functions whose job was subsumed by a later fix (e.g. 5dd20ad subsumed `clearPendingAssistantUsageAfterCompaction`'s cold-start role — verify the call site), commented-out remnants of superseded mechanisms.
2. **Outdated or overly verbose comments** — comments written for an earlier mechanism that the code no longer matches (high risk in this window: the Aug 19–23 fix churn rewrote the estimator repeatedly); prose comments that restate the code instead of explaining *why*.
3. **Redundancy / cleanup opportunities** — the dialect unification (A1) was meant to collapse 2–3 dialects into one; Phases 3–4 were deferred, so check whether what remains in chat.ts is documented seam or accidental drift. Duplicated logic across call sites that should share a helper.

Findings are recorded under **F. Review findings** as the review progresses.

## B. Suggested review order

1. **A1** (compaction/turn engine) — incident history, four call sites, the pinned trigger contract.
2. **A2 + A3** (extraction + context persistence/clobber) — the two T1 data-safety lines; review together because the pre-compaction flush sits on both.
3. **A4** (turn gate) — lease lifecycle; everything else queues behind it.
4. **A6** (resync) — the largest architectural deletion; exactly-once rests on one invariant.
5. **A9** (provider migration) — every LLM call routes through the new surface.
6. **A7, A8** (anchors/clocks, stats) — byte-prefix and estimator-consistency invariants.
7. **A16** (toolchain) — cheap to review, big blast radius if wrong.
8. **A5, A12, A13, A14, A15** (memory tools, automations, UI) — well-tested, self-contained.
9. **A10, A11, A17** (TTS, PDF, housekeeping) — quick passes.

Per area: read the commit messages first (they carry the failure modes and the pinned invariants), then the key files, then the test suites — the suites were written against the forensics and are the specification.

## C. Release notes draft (user-facing, condensed)

**Browser tools** — Porrima can now drive a per-chat headless browser: navigate, snapshot, click, type, hover, screenshot. Six tools, each chat gets its own session.

**Your turns no longer die when another is running** — a global FIFO turn gate queues GPU-bound turns. Queued messages show their position; background work (synthesis, wake, automations) waits behind you instead of racing the model.

**Compaction got a ground-up rework** — the Aug 19 wipe is behind us: boundary-guarded usage anchors, clamped scale factors, non-destructive last resorts, and a unified pressure estimator shared by every route. End-of-turn compaction now lands while you read; headless turns compact and resume with a handoff instead of truncating.

**Reconnects are instant and exact** — page refresh mid-turn reattaches to the live stream; the old 10MB SSE replay buffer is gone, replaced by an authoritative server-side resync snapshot.

**Memory that survives restarts and can't erase itself** — per-chat memory context is persisted (byte-exact hydrate), a clobber guard stops empty retrievals from overwriting real state, blocks gained archived scope, agent-initiated supersession with lineage, and edit history. `read_archived_context` now returns conclusions, not walls of reasoning.

**Mid-turn memory extraction** — extraction pulses fire on a pressure ladder with FIFO window draining: over-budget content is never dropped, never consumed before the model saw it. Extraction runs slot-aware on its own parallel slot.

**New: context breakdown popover** — where the context window actually goes: frozen memories, recalls, tools, replies — anchored to real usage, honest after compaction.

**Live model stats** — tokens in/out, cache hits, reported-vs-canonical divergence, per-iteration updates while the turn runs, and a stabilized prefill indicator.

**A persistent Kokoro TTS worker** — no cold start per chunk, with respawn escalation when it wedges.

**PDFs with figures** — PyMuPDF4LLM layout parsing with inline image extraction and OCR fallback.

**Themes & polish** — opaque bubble option, saved theme presets, linen background texture, saved-theme chips; the tool-call display now streams its composition with a scrollable preview; the Five Beats activity indicator pulses in sync with the polyhedron decode.

**Settings, reorganized** — inference server, SSH, TTS, automations, extraction, and image generation settings get tabbed, consistent editors; reminder budgets move to global settings.

**Under the hood** — TypeScript 7.0 (native compiler), pi-ai 0.83 with a clean provider migration off the deprecated compat registry, better-sqlite3 13, and a full dependency patch sweep.

## D. Release checklist

- [ ] Confirm version: 0.4.0 (working title) — bump `package.json` (root) to match.
- [ ] Re-run at tag time: `server: vitest run` (583/1 todo at survey time) + `tsc --noEmit` both packages (clean) + full `npm run build` (not yet run this session).
- [ ] Manual smoke: refresh-mid-turn reconnect; queued second message; /stop while queued; compaction mid-turn (synthesis + chat); TTS after worker respawn; PDF with figures; a browser-tools session end-to-end; theme presets round-trip.
- [ ] Verify deployed dist provenance matches the tag (the Aug 24 lesson: running dist can lag HEAD).
- [ ] Tag + push.
- [ ] Decide: turn-engine Phases 3–4 (D6 shape unification, TurnState) — tracked, deferred by design; confirm the deferral is documented in the release notes as "by design."

## F. Review findings

_(populated per area as the review proceeds)_

### A1 — Compaction & turn engine _(first pass complete 09-03)_

**Contract verification — sound.** The pinned trigger table in context-pressure.ts matches what the HTTP route actually does: mid-turn normal 0.85 ← `refinedTokens`, mid-turn hard-cap 0.95 ← `hardCapTokens` (chat.ts 2803–2823), end-of-turn 0.80 ← max(usage, estimate) via `endOfTurnNeedsCompaction` (compaction.ts 53, chat.ts 3746), pre-send 0.85 ← `estimateContextBreakdown` inside `truncateBeforeSend` (compaction.ts 1331, untouched). The strict-`>` boundaries hold at both 0.80 and 0.95. Negative-path logging is unconditional in `runEndOfTurnCompaction`. All four call sites' behavior matches the forensics-pinned tests.

**Adoption status is accurate but the deferral is now live risk.** `runEndOfTurnCompaction` has exactly one caller (chat.ts:3746). system-chat's end-of-turn check (system-chat.ts ~1135 and ~1385) is still the char-only dialect at 0.85 — and it's **duplicated verbatim across the synthesis and wake paths**. The forensics pinned that char-only estimates under-read headless context (2 of 3 system-chat fires were over-window). D2 (refined estimator + 0.80) and D4 (headless flush) are the fixes and are **not in this build**. automation-runner still has pre-send only (D3 not landed).

**Release decision items:**
- **A1-D1 — FLIPPED 09-03 (610f3f3).** Shadow verdict from the production log (Aug 24 – Sep 03): 277 samples, 10.5 days, `delta=0` on every line, `fire=both` 19 / `fire=none` 258, zero divergence, zero directional bias — all three §4.2 pass criteria met. The headless check now acts on `midTurnPressureDecision` (pinned contract, 4 new fixtures); the legacy arithmetic and shadow logging are retired; the one unobserved corner (char path, no usage anchor) logs loudly. Release notes should say: headless mid-turn compaction now runs on the same unified pressure estimator as the chat route.
- **A1-D2 — LANDED 09-03.** system-chat's char-only 0.85 end-of-turn check (duplicated verbatim across synthesis/wake) now adopts `runEndOfTurnCompaction`: conservative max (usage anchor vs char estimate) at 0.80, negative-path log on every run with both signals rendered. The under-read is fixed by construction (forensics: 2 of 3 historical fires were over-window); the log feed quantifies the usage-vs-char gap per turn from the first synthesis after deploy.
- **A1-D3 — LOG-ONLY LIVE 09-03.** Automations gain an end-of-turn check behind a `logOnly` gate (decision computed + logged on fire and no-fire paths, never executed). The gate week settles 0.80 vs 0.85 empirically; the flip is a one-line flag removal. Release notes should say: automation end-of-turn compaction is being validated in log-only mode, first week.
- **A1-D4 — queued after D2/D3 are live.** headless pre-compaction flush (`preCompactionFlushHook` into the same seam); closes the identity-level gap (memories from removed context).

**Cleanup findings — ALL NINE LANDED 09-03 as f5b31c1** (tsc clean, 585 pass / 1 todo; no behavior change):
1. **context-pressure.ts:71** — `export type PressureObservation = PressureEstimate;` is a zero-value alias used only in the `onObservation` signature. Delete, use `PressureEstimate`.
2. **context-pressure.ts:264–268** — `TurnGuardInput.hitContextLimit` is accepted and documented ("does not gate the decision today") but never destructured, never read, and neither caller passes it. Dead parameter — remove it (the docstring contract table already carries the semantics) rather than carrying a documented no-op.
3. **chat.ts:3737–3740 ≡ turn-compaction.ts:95–98** — the same "either signal can drive the trigger (conservative max, never min)…" paragraph exists in both the call site and the function it documents. Keep it in turn-compaction.ts (canonical); the call site can drop to a pointer.
4. **chat.ts:3710–3724** — two stacked comment blocks over the same `estimateContextPressure` call: the pre-Phase-1 "Refined estimate — the SAME estimator pre-send uses…" block, then the Phase-1 "Unified pressure estimate…" block. The first is superseded; fold into one.
5. **chat.ts:3789–3793** — the rationale for `clearPendingAssistantUsageAfterCompaction()` ("if persisted, the next pre-send estimate treats the compacted chat as still near the old limit and immediately compacts again") describes the role 5dd20ad subsumed — the pre-send anchor scan now stops at the newest `_isCompactionSummary`, so that exact chain is dead. The call itself is still load-bearing for the in-request live anchor (`state.finalUsage`, chat.ts:1417, which no boundary guard sees). Rewrite the comment to the surviving rationale.
6. **chat-turn-runner.ts:815–827** — after `guard.stop`, the route re-derives *which* cap fired (`iterations - lastPersistedAssistantBoundary.iterations >= maxIterationsPerSegment`) because `GuardResult.stop` doesn't say. The guard knows (it checks total, then segment); the re-derivation is redundant and would silently diverge if guard precedence ever changes. Add `scope: "total" | "segment"` to the stop result and log from it.
7. **"fix N, Aug 23" vocabulary** (7 sites: compaction.ts:42, context-high-water.ts:3, openai-compat-provider.ts:2208, chat-turn-runner.ts:734, system-chat.ts:1137+1385, turn-compaction.ts:8) — ephemeral fix-cycle identifiers from the Aug 23 eight-fix batch; the registry they numbered against no longer exists and two weeks on "fix 6" means nothing. Replace with the mechanism name or the incident (e.g. "end-of-turn decision — the 0.80 threshold from the Aug 23 rework").
8. **chat.ts:2948–2956** — the "NOTE (Aug 23): the end-of-turn compaction check moved BELOW…" historical marker now duplicates the living block comment at 3670–3683, which explains the same placement and gate. Fold the NOTE into the block comment (keep the "old position also had a latent bug" sentence — it's the only record of *why* it mustn't move back).
9. **Shadow-block duplication (transient)** — chat-turn-runner.ts 599–605 (legacy postUsageChars loop) duplicates verbatim what `estimateContextPressure` path 2 does internally (context-pressure.ts 183–187). Both die together when D1 flips — don't refactor one without the other.

---

## E. Open items noted during survey (not blockers, Asa's call)

- Turn-engine Phases 3–4 deferred (design doc pins the gates).
- The known automation "task=success on truncated phases" gap (no finish_reason/phase-objective detection) — predates this window but still open.
- Long-term reconnect design: server-side "replay only events after the client's last committed row" is noted in 7026aa2 as the cleaner future state; resync makes it less urgent.
