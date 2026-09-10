# Cross-chat messaging — spec

**Status:** design settled 09-09. v5 — v4's length-heuristic P0b is replaced by the storage-level fix agreed at review: per-chat `revision` + durable `row_id` identity + `appendChatMessageRow` + rebase-on-save, to be landed and independently tested as P0b **before P1** (new sequencing). v4 = v3 plus external review (the lease excludes active turns but NOT stale snapshots; wakes insert at fire time; failure re-arm folded into P0; task payload mechanism; cap window; "immediate kick" retracted). v1 = delivery + wake. No new execution machinery; additive columns only (`chats.revision`, `chat_message_rows.row_id`, `crossChatJson`), no new tables. **P0b, P0, and P1 implemented 09-09** (P0b: PR1–PR4, 22 revision tests; P0: mark-fired-at-start + failure re-arm + startup orphan sweep; P1: delivery-only `schedule_chat_message` + `list_chats` + `crossChat` tasks + envelope card; full server suite 699 green; plan: [design/p0b-storage-concurrency.md](design/p0b-storage-concurrency.md)).

## Purpose

The agent can post a message into another chat — a note on the desk, or a wake of the target thread. The agent has no way to message other chats today. The motivating case is a verification turn in the system chat that ends with "report this to the build chat": the result should land in the target thread as a visible, attributed message — optionally waking it, optionally at a later time.

## Core model: two writer hazards, one storage invariant

**Hazard A — the active turn (excluded by the lease).** Every turn — user HTTP or automation — holds the global turn lease (`turn-gate`, FIFO, one GPU slot) for its full duration: a single acquire site (`chat.ts:1084`) before `handleChatStream`, five release sites on the end paths, and `runAutomationTask` acquires it too. Tool calls execute **inside** the source turn, so while `schedule_chat_message` runs, no other turn is in flight anywhere. An append at call time — or at fire time under the wake run's lease — can never race an *active* turn's `saveChat`.

**Hazard B — the stale snapshot (NOT excluded by the lease).** The lease serializes *execution*, not *snapshot freshness*. The send route loads the chat (`getChat`, `chat.ts:4420`), waits on the automation lock (`4434-4441`), then pushes and saves the user message (`4938`/`4946`) and the memory delta (`5106-5113`), and only then acquires the lease (`5188`) — and those pre-lease saves run *concurrently with the current lease holder*. `saveChat` is array-authoritative: `syncChatMessageRows` deletes every row with `sequence >= firstChanged` and re-inserts from the caller's array (`chat-storage.ts:1656-1699`). A snapshot that predates an append deletes it, and the collision case needs no shrinking at all:

1. B holds an N-row snapshot. Source turn A appends a post to B at sequence N (under A's lease). DB now N+1.
2. B's next save serializes N+1 rows whose local index N is B's own new row. `firstChanged = N`, `DELETE sequence >= N` — the post is silently gone. No row ever lies "beyond B's array," so no length heuristic sees it. (v4's append-preserving sync missed exactly this, and additionally mishandled compaction's mid-array summary splice at `compaction.ts:1238` and the FTS tail rebuild at `chat-storage.ts:1748-1768`.)

The codebase already knows the shape of the hazard: the passive-recall callback (`chat.ts:2228-2231`) reloads via `getChat` before appending because "syncChatMessageRows deletes and rewrites every row past the first divergence."

**Fix B — optimistic concurrency + append API (P0b, lands before P1).** One invariant: *a writer may only rewrite the rows it loaded; rows appended after it loaded are never its to delete.*

- **`chats.revision`** (additive column) is bumped inside the per-chat write lock on every row write (`saveChat`, appends, repair syncs).
- **`Chat._baseRevision`** (transient, like `_rowSequence`) is captured at load.
- **`chat_message_rows.row_id`** (additive column, one-time backfill) is the durable per-row identity, with `ChatMessage._rowId` transient. Claims, removals, and reconciliation match by id; `_rowSequence` stays positional for UI/edit/retry. Sequences are not identities and the rebase renumbers — without row ids a third writer's claimed sequence can point at a different row and lose/duplicate content (drift trace: plan §3.2).
- **`appendChatMessageRow(chatId, message)`** is the append-only path: atomic insert at `MAX(sequence)+1`, revision bump, incremental FTS sync. Initial consumers are array-less writers (cross-chat posts, the post-turn passive-recall callback); in-array writers stay on `saveChat` (now rebase-safe) until the sequence-is-array-index compatibility window narrows, because an in-array append across a concurrently appended row would gap the array/index invariant.
- **`saveChat`** under the lock compares revisions. Match → sync as today. Mismatch → **rebase** (full algorithm in the plan §3): walk the DB rows in sequence order — emit the writer's version for every claimed `_rowId` (content changes included), preserve unclaimed committed rows (concurrent appends), drop declared removals (`removedRowIds`) and unclaimed `_inProgress` ephemera; then splice the writer's unanchored rows (no `_rowId`) each after the emitted position of the nearest preceding in-memory row that has an id, in array order. Renumber `_rowSequence` densely, keep `_rowId`s, **update `_baseRevision` to the post-rebase revision**, and widen the FTS rebuild window to cover every moved or preserved row. Canonical pin (why anchor-splice, not "after the tail"): the memory-delta save (`chat.ts:5106-5113`, a mid-array splice *before* the user row) rebases around a post as `[origins, delta, user, post]` — the delta stays adjacent to its user row, preserving the replay-merge invariant (`chat.ts:5037-5043`: the delta must replay merged into the following user message, never as a mid-conversation system row). A "new rows after the current tail" rule would yield `[origins, user, post, delta]` and break that invariant. (The v5-draft spec text said exactly that; corrected on 09-09 re-review against the plan's walker.)
- **Rewrite owners keep `allowTruncation`.** `/edit` is the only current path permitted to delete rows. The `/edit` guard `chat.messages.length < dbRowCount` (`chat.ts:5520`) becomes exact under revisions (mismatch → reload/refuse) and moves under the write lock. Compaction does not remove rows today — it marks `_outOfContext` and splices a summary — so its save is rebase-safe as-is (add `allowTruncation` only for intent clarity); if a future compaction path genuinely removes rows (e.g. a hard cap that filters rows out of the array — `truncateChatHistory` verified 09-10 to mark `_outOfContext` and splice a summary, never shrink), it must rebase by replay under the lock. `discardPersistedAssistantBoundaries` (`chat-turn-runner.ts:597-601`) is a same-turn filter and must declare removals by id (`removedRowIds`), never delete preserved rows.
- **Audit before landing:** every `saveChat` call site without `allowTruncation` that can shrink or rewrite the array (pre-send `truncateBeforeSend`, `discardPersistedAssistantBoundaries`, ask_user resume, steering) classified as append-only (rebase-safe; array-less writers → append API), anchored rewrite, or must-reload. Send-route consequence: after an interleaved rebase the writer's own message may not be last, so `currentUserIndex` (`chat.ts:5122-5125`) and `trailingRow`/`sendTimeAnchor` (`:5184-5186`) must resolve by `_rowId`, not `messages.length - 1`; the memory-delta splices (`chat.ts:5107, 5375, 5765`) must anchor on the user row's `_rowId` (immediately before it), not `messages.length - 1` (plan §5.5).
- **Independent test surface:** P0b is testable with synthetic writers before any cross-chat code exists. It gets its own review pass, and its invariant tests must be green before P1 starts.

`appendChatMessageRow` is the sanctioned append path; `saveChat` remains the row-sync writer. A cross-chat append is `appendChatMessageRow(targetChatId, post)` — no `getChat → push → saveChat`, no pending inbox (a side table would add a second source of truth every reader must learn; revision + append makes the append durable against every writer structurally), and no reader-side changes.

## Delivery model

The once-task is always the source of truth for "a message will arrive at `when`."

| `when` | `wake` | at call time | at fire time |
|---|---|---|---|
| now (default) | false | append row (under the lease) | — |
| now | true | create once-task only | append row (idempotent, last row) + turn |
| future | false | create once-task | append row (idempotent) |
| future | true | create once-task | append row (idempotent, last row) + turn |

- **Wakes always append at fire time.** The row is appended immediately before the turn, under the wake run — the post is the last row *by construction*, and the operative guarantee is the **automation lock** (held by `runAutomationTask` for the run's duration): it blocks new target requests at `chat.ts:4434-4441` *before* their pre-lease saves (`4946`/`5113`), and any already-queued turn has completed its pre-lease saves before reaching the lease wait. The turn lease covers in-flight turns; the automation lock covers the pre-lease save window — the lease alone would not do it. If it were appended at call time instead, a user message landing in the target during the wake's wait (next tick + the 2-minute `AUTOMATION_MIN_IDLE_MS` grace after last activity) would bury the post, and the turn would answer the fresh message with the post as history. `wake: false` + now keeps the call-time append: the note is on the desk immediately (the motivating case).
- **Realistic wake latency:** next scheduler tick (≤5 min) after `when`, plus the 2-minute idle grace. There is **no "immediate kick"** — a kick cannot run from inside the source turn (`isTurnGateBusy` for the turn's whole duration), and after `releaseTurn` the grace still applies. (This retracts the v3 "kick" recommendation, which assumed the grace away.)
- The row is stamped `originTaskId` in its metadata. Fire-time append is a no-op if a row with that task id already exists (`json_extract(payload_json, ...)` — JSON1 is already used this way in `memory-context.ts`).
- **Exactly-once — mark-fired-at-start:** in the `startAutomationRun` transaction, the once-task is disarmed in the same write that creates the run row: `enabled: false, archived: true` — the same task update the success path uses. The terminal state is written *before* the crash window opens. (Mechanism note: the alternative — clearing `nextRunAt` — is counterproductive. `taskIsDue()` treats a *missing* `nextRunAt` as *always-due* (`automation-scheduler.ts:33-34`), so an enabled task with a nulled `nextRunAt` is permanently armed. The disarm lever is the enabled flag: `listEnabledAutomationTasks()` filters on `enabled = 1`. General landmine: **no path may leave an enabled task with a null `nextRunAt`.**)
- **Failure re-arm (part of P0 — without it, P0 is a regression):** today's `finishAutomationRun` failure path re-arms once-tasks with backoff (`computeFailureRetryAt`; `enabled` preserved; auto-disable after 5 consecutive failures, `MAX_CUSTOM_FAILURES_BEFORE_DISABLE`). Disarm-at-start alone would make a gracefully failed once-task (timeout, no model) never retry. So the failure path for once-tasks re-arms explicitly: `enabled: true, archived: false, nextRunAt: computeFailureRetryAt(...)`. Crash-safe in both directions: a crash before the failure write leaves the task disarmed (no re-fire); a recorded failure re-arms, backoff-bounded and count-bounded.
- **Failure direction: never a loop.** Crash before start → re-fires, correctly (nothing happened yet). Crash after start → the task is already disarmed; the orphaned run row is marked at startup (see Crash recovery). For wake/future delivery the append follows the disarm inside the run — a crash in that window loses the message, not a loop (documented, accepted tradeoff). For `wake: false` + now the row exists at call time — a crash there loses the wake, not the note. The `originTaskId` idempotency check pins "at most one row per task" regardless.

## Tool contract

`schedule_chat_message(targetChat, message, subject?, when?, wake?)`

- **Target resolution:** `targetChat` is a chat id if it parses as one, else a unique title fragment. 0 matches → loud error. Multiple matches → loud error listing candidates (id + title). Plus a new read-only `list_chats` tool (id, title, type, lastModified, preview) for *enumeration*. (Note: `search_conversation` already provides cross-chat *content* search — it cannot enumerate chats or their ids, which is what target resolution needs; the v3 "no way to discover chats at all" rationale was overstated.)
- **Target type (v1 scope):** posts may target **agent and system chats only**. Quick chats are standalone-by-design; waking one is out of scope. (Security note: this tool lets any tool-capable source chat inject user-role instructions into a target with full tool access — source is unrestricted, provenance is recorded in the envelope; restricting the *target* type is the v1 boundary. Asa's call, recommendation folded.)
- **`wake: false` + future `when`** is defined: scheduled delivery, no turn (the fire-time run appends the row, no LLM).
- **Cap:** shares the agent-task cap — one mental model; the cap is a resource bound either way. The naive pending count (`createdBy='agent' AND enabled=1 AND nextRunAt in the future`) does **not** bind `when=now` chains (now-tasks are archived at start, so they never appear in the count). The query is extended to: future-pending **OR** created in the last hour — a now-hop ping-pong that creates more than 10 tasks/hour hits the cap. Tradeoff noted: a legitimate 11+-chat fan-out in one burst hits the same wall (loud, user-resolvable).
- **Content contract, in the tool description** (the behavioral half of anti-decontextualization): wake text is written conditionally — "if X is not done, do X; else verify and record why not." Duplicate firing is harmless by convention.
- **Validation:** target exists **at call time and at fire time** (there is no "archived" chat state — deletion is hard; a since-deleted target fails the run loudly rather than being resurrected — see Execution model). `when` ≥ now + 2 min for the future case (reuses the reminder rule).

## Task payload and dispatch

The automation task row cannot carry this payload as-is: `AutomationKind` is `"synthesis" | "wake" | "custom"`, prompt steps normalize to `{id, title, prompt}`, and the notifications mapping drops unknown keys. Nothing today can tell the runner "this is a cross-chat post, not a normal automation." An explicit mechanism:

- **New kind:** `AutomationKind += "crossChat"`.
- **Typed payload:** a `crossChatJson` field on the task: `{ targetChatId, fromChatId, fromChatTitle, subject, body, wake }`. `createdBy: "agent"` (cap sharing).
- **Dispatch:** `executeAutomation` routes kind `"crossChat"` to `runCrossChatPost` — validate the target still exists (`getChat`; null → the run fails loudly, **no chat resurrection**), append the row via `appendChatMessageRow` (idempotent by `originTaskId`, under the lease), and — if `wake` — delegate to the parameterized `runPromptAutomation` (Execution model below). No LLM for delivery-only runs.
- `AutomationRunStatus += "interrupted"` (the P0 sweep marks orphaned rows; the union today has no such member).

## Row format

- Role: `user` — it is a message to the thread's agent.
- Content: bracketed provenance envelope + subject + body — `[quje from <origin title> — 09-09 15:12] <subject>\n\n<body>`. The model sees an ordinary user message; the envelope carries attribution so a user-role row never impersonates the user silently. Envelope text and metadata are pinned to match by a test.
- Metadata: `_crossChatPost: { fromChatId, fromChatTitle, subject, at, originTaskId?, originRunId? }`. Inert on replay.
- **Frozen time anchor:** computed against the target's tail at append time and persisted on the row. Replay reads the row's anchor, so the wake turn's live prompt ≡ every later replay (byte-identical; pinned in test 4). Precedent: follow-up rows freeze their anchor exactly this way.
- FTS: free — `buildSearchContent` indexes the row like any other.

## Execution model (wake: true)

The wake turn reuses `runCrossChatPost → runPromptAutomation`, with the **target chat's semantics** — `runCrossChatPost` owns only validation and the append; the prompt path stays single-sourced. The current `runPromptAutomation` hardcodes system-chat semantics in five places, and one of them is hostile to this feature:

- Parameterize `chatType` through `buildSplitAugmentedPrompt` (drop the `"system"` + `skipMemoryRetrieval: true` hardcode — the post's content becomes the retrieval query, so the woken agent gets "My relevant memories to this chat" the same way a user turn does), `getAgentTools`, and `passiveMemoryRecall`.
- **No trigger row.** The post row is the last user row; the turn runs `mode: "continue"` from it. (`formatAutomationTrigger` would duplicate the post's content.)
- **Skip the title refresh** — `refreshAutomationChatTitle` would rename the user's chat to whatever the woken turn summarized.
- `resetMemoryContext` stays (its delta rows persist; the next user turn's prefix rebuild is already paid by `invalidateAllStablePrefixCaches`, which every automation run performs globally — a wake adds no new stomping).
- **Model resolution is chat-first and never rewrites the chat.** `resolveAutomationModelId` today prefers the *global default* over the chat's model, and `runPromptAutomation` then does `if (chat.modelId !== modelId) chat.modelId = modelId` — a wake in the build chat would silently switch that chat's selected model. Cross-chat wakes resolve the target chat's `modelId` first (global default only if the chat has none) and skip the rewrite (`preserveChatModel`).
- **The target must exist at fire time.** `ensureAutomationChat` *creates* missing chats (`type: "system"`) — a cross-chat post to a since-deleted chat would resurrect that id. Cross-chat delivery requires the target to exist; a missing target fails the run, it does not create.
- **Compaction parity:** the wake run performs `truncateBeforeSend` and end-of-turn compaction on the target (`automation-runner.ts:241-256, 333`) — a wake can compact the user's chat. This is parity with a user turn; acceptable, stated here.

> Asa's original concern, answered: "a wake of the build chat runs with the build chat's context, which is correct — it's that thread's agent waking up, not the system chat's. That means `runHeadlessChatTurn` must be called with the target chat's id so its stable prefix and memory context are used, and the wake turn's KV prefix must remain compatible with that chat's existing history." — correct; the parameterization above is the implementation, and the post row replays as an ordinary user row so history stays byte-compatible (test 4).

## UI

- `_crossChatPost` on `ChatMessage` in both types files.
- `ChatView` display projection: an envelope card (precedent: the `MidTurnCompactionIndicator` row-kind in the same projection). Card: `quje · from <origin title> · time`, subject, body, deep-link to the origin chat (`?chat=` routing already exists).
- **Edit/retry exclusion — protective, not cosmetic:** `editable` / `onEditMessage` / `onRetryMessage` are gated on `role === "user"` only today, so a post would be editable as written. The `/edit` route truncates the thread at the target's `_rowSequence` — editing a post would amputate everything after it. Gate all three on `!msg._crossChatPost`.
- **Live visibility (corrected claim):** v1 said "the row fan-out reuses the existing message_complete/SSE path" — false. `message_complete`/SSE is per-turn: a `LiveStream` exists only while a turn is in flight, and `/reconnect` attaches only to a live stream. An open *idle* chat has no channel. What actually exists: the sidebar polls every 30s (`CHAT_LIST_POLL_INTERVAL_MS`), and the pane updates on switch. **v1 accepts that.** Web push on delivery when notifications are enabled: a new dispatch event alongside the existing `message_complete` in `push-dispatch` (folded per recommendation — veto at review). A persistent global SSE channel is a real client+server design — out of scope.

## Loop Bound: Two Classes, Two Brakes (settled 09-09 — no depth gate)

No hop-depth mechanism. Decision (Asa): depth is a constraint on the wrong target. Healthy long-running workflows **grow** in depth — a 30-min polling deploy monitor is a hop-10 chain, each link grounded in a re-check of the world. Degenerate loops are shallow but degrounded (content = f(previous message), not f(world)). Precedent: the passive-recall cap we removed gated a quantity healthy behavior never pushed against; hop depth would gate one it does push against. Last night's `c0ed524e` incident was decontextualized stateless imperatives plus non-atomic delivery state — a depth cap catches nothing of it.

The loop bound splits by who is driving the cycle:

- **Agent-driven loops** (a fired turn schedules the next) are **soft-bounded**: judgment + escape routes (`update_automation` cancel/reschedule) + hard ceilings (the extended agent-task cap — future-pending OR created in the last hour, so `when=now` chains are bounded too; per-run budgets; failure backoff/auto-disable). The agent can decide to stop; the ceilings make "not stopping" affordable. Supporting structure: idempotent-by-convention content (conditional wake text in the tool description), visibility and attribution (every post is a visible envelope row, never silent user speech; every task is in `list_automations`), and the human veto.
- **Machine-driven loops** (a scheduler re-arming a task whose terminal state was lost in a crash) contain **no agent decision in the cycle** — they cannot be soft-bounded at all. Only an unlosable terminal state stops them: **mark-fired-at-start** (Crash recovery).

The audit question this generalizes: for any self-scheduling system, *"if the process dies mid-cycle, which state decides what happens next?"* If the answer is "nothing; the default re-arms," the system has a latent self-referential loop. A design is a terminal state written before the crash.

Accepted worst case (agent class): a self-sustaining ping-pong burns at most the agent-task cap's worth of turn budget, is visible as rows in two threads plus task-list entries, and dies on cancel or cap-full. Named and deferred: **oscillation detection** (repeat origin→target pair + content echo) — the shape that would actually target this failure; build it only if a loop materializes, not speculatively.

## Crash recovery (verified, corrected)

**Incident** (app.db, reminder `c0ed524e`, once, due 00:21 MDT): 06:21Z run started, killed by the 00:43/00:54 MDT manual restarts (`finishedAt = NULL`) → 06:44Z re-fired, killed → 06:54Z success (finished 07:19Z). Task now disabled/archived.

**Mechanism:** once-tasks self-disable only in `finishAutomationRun` **on success**. A mid-run death leaves `enabled = 1` with a past `nextRunAt` → the next scheduler tick re-fires.

**Correction to v1:** the claim that "the stale row both re-armed the once-task and stalled the idle gate" is false. No scheduler gate consults `automation_runs` — they are all in-memory (`automationCheckRunning`, the automation-lock, the `hasActiveChats` map, `turn-gate`'s `globalThis` state, settings-based pause/grace) and all reset on restart. The stale row stalled nothing; the armed task re-armed itself.

**Fix — mark-fired-at-start (P0, independent of the feature):**

- In the `startAutomationRun` transaction (today a bare INSERT — the task write is new), once-scheduled tasks are disarmed in the same write that creates the run row: `enabled: false, archived: true` (the success path's update). Mechanism note as in Delivery model — the lever is the enabled flag, not `nextRunAt`.
- **Failure re-arm (same P0, same transaction family):** the `finishAutomationRun` failure path for once-tasks re-arms explicitly — `enabled: true, archived: false, nextRunAt: computeFailureRetryAt(...)` (the `shouldDisable` path, 5 consecutive failures, still wins and does not re-arm). Without this, P0 silently removes the backoff retry that failed reminders have today — a regression, not a fix.
- **Startup hygiene:** mark orphaned `running` rows `interrupted` (new `AutomationRunStatus` member), and archive any still-armed once-task such a row belongs to (the pre-fix orphan state). Run-history hygiene only — no scheduler gate reads `automation_runs`, so this changes no scheduling behavior.
- **Test (fails on the old code):** insert a once-task with a past `nextRunAt` plus a `running` run row; run the sweep; assert the row is `interrupted`, the task is archived, and the next `checkAndRunDueAutomations()` does not start it. Regression: a successful once-task still archives through the existing `finishAutomationRun` path; a *failed* once-task re-arms with backoff (new behavior, pinned).

## `update_automation` extension

Add an optional `schedule`/`runAt` parameter (reusing the existing 2-minute validation) so agent tasks can be rescheduled. Cancel via `enabled: false` already works.

## Tests

1. **Delivery only** (`wake: false`, now): row appends to the target with correct role/metadata/anchor; visible in FTS; no automation run; no turn.
2. **Future delivery** (`wake: false`): no row before fire; exactly one after.
3. **Wake** (`wake: true`): turn runs with the target's `chatType` + retrieval ON; no trigger row; target title unchanged; target `modelId` unchanged (no rewrite); reply lands in target.
4. **Replay:** post-row content + frozen time anchor byte-identical on reload; wake-turn context ≡ replay context.
5. **Client:** envelope card renders; edit/retry excluded (pinned: without the exclusion, the `/edit` route truncates the thread at the post's sequence).
6. **Exactly-once (mark-fired-at-start):** kill after `startAutomationRun` → the task is disabled+archived (absent from `listEnabledAutomationTasks`) → no re-fire. Kill before start → re-fires (correct — nothing happened yet). Pin the landmine: an enabled task with a null `nextRunAt` is always-due (`taskIsDue`), so no code path may leave one. (Implementation note: the kill seam is *between the start transaction and the completion write* — plan for an injectable failure point after `startAutomationRun`.)
7. **Stale save preserves the post (P0b core):** a turn holding an N-row snapshot appends its own row after a post lands at sequence N → the post survives, the turn's row is spliced after its anchor (before the preserved post), and in-memory `_rowSequence`/`_rowId` values reconcile on rebase. Sub-cases: (a) the collision case above (not just a shorter array); (b) a compaction rewrite (summary splice + OOC marks, `compaction.ts:1208-1249`) rebases around the post instead of deleting it; (c) the post is in FTS immediately after append and remains after rebase; (d) `/edit` still truncates and the revision guard (mismatch → refuse) refuses a stale edit; (e) a memory-delta save (the `chat.ts:5106-5113` mid-array splice) rebases around a post with the delta **immediately before its user row** (the replay-merge invariant, not just row survival) — under both interleave timings, the splice anchor resolving by the user row's `_rowId`, not `messages.length - 1`; (f) a batch push (streaming fragments, `chat-turn-runner.ts:588`) plus a concurrent append keeps the batch in array order with dense renumbering; (g) a third writer rebasing after a renumber loses and duplicates nothing (the row-id drift trace, plan §3.2).
8. **Append API:** `appendChatMessageRow` inserts at `MAX(sequence)+1`, bumps `chats.revision`, and indexes FTS. Two concurrent appenders (source post + target turn) both survive. `saveChat` after a matching revision behaves exactly as today; after a mismatch, rebase leaves the resulting history byte-identical to a sequential write of the same rows.
9. **Fire-time append is the last row:** a user row lands in the target after the task is created but before fire → the wake turn's prompt has the post as the last user row (the "buried post" case is impossible by construction).
10. **Failure re-arm:** a gracefully failed once-task re-arms (enabled, unarchived, `nextRunAt` = backoff); it retries and is not archived; after 5 consecutive failures it disables. A killed once-task (no failure write) never re-fires.
11. **Cap window:** 10 agent tasks created in the last hour blocks an 11th — including a `when=now` chain where no task is future-pending.
12. **Target existence at fire:** a post to a since-deleted target fails the run and does **not** create a chat.
13. **Target resolution:** id hit / unique-fragment hit / 0-match loud error / multi-match loud error with candidates; quick-chat target rejected.
14. **Envelope ↔ metadata parity** (pinned).
15. **Timing:** `when = now` wake fires on the next scheduler tick after the 2-minute idle grace (no kick).

## Phases

- **P0b — storage concurrency foundation (lands first; gates P1):** `chats.revision` + `Chat._baseRevision` + `chat_message_rows.row_id` + `ChatMessage._rowId` + `appendChatMessageRow` + rebase-on-save + FTS widening + the `saveChat` call-site audit (append-only → rebase-safe; array-less writers → append API; rewrite paths classified) + kill switch (`PORRIMA_STORAGE_REBASE=0` for one release, default on). ~240 LOC + audit + tests (7, 8). Exercised with synthetic writers **before any cross-chat code exists**; own review pass; invariant tests green before P1 starts; 5-PR breakdown in the plan. Implementation plan: [design/p0b-storage-concurrency.md](design/p0b-storage-concurrency.md).
- **P0 — the real 09-09 fix (independent; lands before, with, or after P0b):** mark-fired-at-start transaction + **failure-path re-arm** (without it P0 kills the backoff retry that failed reminders have today) + startup orphan sweep + `interrupted` run status. ~60 LOC + tests. **Implemented 09-09.**
- **P1 — delivery only (the motivating case):** `schedule_chat_message` (`wake: false`) + `list_chats`; the task payload mechanism (kind `"crossChat"`, `crossChatJson`, `runCrossChatPost` dispatch); row append via `appendChatMessageRow` (envelope, metadata, `originTaskId` stamp, frozen anchor, idempotency); extended cap query; target existence + type checks; `_crossChatPost` in both types; client envelope card + edit/retry exclusion; target resolution. ~450 LOC + tests. **Implemented 09-09** (client card/gating verified by typecheck — no client test harness).
- **P2 — wake:** `chatType` parameterization of `runPromptAutomation`; **chat-first model resolution, no rewrite**; post-row-as-prompt (fire-time append, no trigger row, no title refresh); compaction parity; `update_automation` schedule param; web push event. (No scheduler kick — retracted.) ~250 LOC + tests.

Total ≈ 1010 LOC incl. tests. Rides on the existing 5-minute scheduler tick, the turn lease, and `runHeadlessChatTurn`. No new execution machinery; additive columns only (`chats.revision` and `chat_message_rows.row_id` in P0b, `crossChatJson` in P1), no new tables.

## Decisions (09-09)

- No hop-depth governance (see Loop Bound).
- Cap: shared with pending reminders, extended to a 1-hour creation window (so `when=now` chains are bounded).
- Deep-link on the envelope card: yes.
- Web push on delivery when notifications enabled: yes — folded per quje's recommendation; veto at review.
- ~~Immediate scheduler kick for `when = now` wakes~~ — **RETRACTED** (21:4x, external review): a kick cannot run from inside the source turn (`isTurnGateBusy`), and the 2-minute idle grace applies after `releaseTurn` regardless. Wake latency is documented as next-tick + grace. Quje's recommendation assumed the grace away; it is withdrawn.
- **Target-type scope (new, Asa's call):** v1 targets agent + system chats only; quick chats excluded. Folded per quje's recommendation (security boundary for an instruction-injection primitive); veto at review.
- **Concurrency model (revised 09-09 late — storage-level, replaces v4's length heuristic):** the lease excludes active turns only; stale snapshots clobber appends (`chat.ts:4420` load vs `5188` lease; `syncChatMessageRows` is array-authoritative, `chat-storage.ts:1656-1699`). Fix = `chats.revision` + durable `row_id` identity + `appendChatMessageRow` + rebase-on-save — one reconciliation point, single source of truth, no second store, no reader changes. Wakes append at fire time (post is last row by construction).
- **Sequencing (new, 09-09 late):** P0b storage foundation first, tested independently with synthetic writers; no feature code is written against the old sync semantics. P0 (independent crash fix) and P1 follow, then P2.
