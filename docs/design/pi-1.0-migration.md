# pi 1.0 Migration — Harness Removal, Shared Process Supervisor, Tool-Output Store

**Status**: Design. Not implemented.
**Date**: 2026-10-04
**Scope**: `@earendil-works/pi-agent-core` 0.85.1 → 1.0.2 and
`@earendil-works/pi-ai` 0.85.1 → 1.0.2.
**Related**: [session-python-kernel.md](session-python-kernel.md) — the kernel
plan consumes the process supervisor (§4) and spill store (§5) defined here.
This doc is the upstream migration; the kernel doc is the downstream feature.

## 1. Why this is one migration

Porrima pins `@earendil-works/pi-agent-core ^0.85.1` and
`@earendil-works/pi-ai ^0.85.1` in `server/package.json`. pi-agent-core 1.0.0
removed the experimental harness — including `NodeExecutionEnv`, the only
reason `runStreamingBash` works — and the session-python-kernel plan needs the
same process primitives (spawn detached, process-group kill, bounded capture,
spill). Building them once for bash and the kernel is the only sequencing that
avoids writing them twice.

Package coupling (verified): agent-core 1.0.2 depends on `pi-ai ^1.0.2`, and
pi-ai 1.0.2 dropped the old `pi-telemetry`/`chord` surface that 0.85.1 pulled
in. The two packages move together — pi-ai 1.0 cannot be mixed with agent-core
0.85 without a nested duplicate pi-ai and conflicting types.

## 2. Breaking-change inventory (verified against the 1.0.2 tarballs and the upstream changelog)

### 2.1 pi-agent-core 1.0.0 — harness removal

Changelog:

> Removed the experimental harness from `@earendil-works/pi-agent-core`:
> `AgentHarness`, sessions and session storage, the durable runtime, pico3,
> harness tools, compaction, skills, prompt templates, system prompt helpers,
> telemetry schemas, the search service types, and the `uuidv7` and
> pi-telemetry re-exports. The `./node`, `./harness/*`, and
> `./experimental/pico3` subpath exports are gone. The package now contains
> only `Agent`, the agent loop, the proxy stream, and their types. Use
> `@earendil-works/pi-durable` for durable sessions.

Verified: 1.0.2 `exports` is `"."` and `"./package.json"`; `dist/` contains
only `agent`, `agent-loop`, `proxy`, `stream-fn`, and `types`.

Porrima's actual losses (grep-verified — these are the only harness imports in
the repo):

| Import | Site |
|---|---|
| `NodeExecutionEnv` | `server/src/services/workspace.ts:2` |
| `applyShellOutputUpdate`, `BACKGROUND_CONTEXT`, `withAbortSignal`, `ShellOutputView` | `server/src/services/workspace.ts:3-4` |

Porrima's compaction, sessions, prompt templates, and telemetry are homegrown
(`services/compaction.ts`, SQLite storage, `model-stats.ts`), so the harness
removal has a **bash-only blast radius**. `@earendil-works/pi-durable` (1.0.2,
"durable conversation, task, and document runtime") is the session successor
and is not needed.

### 2.2 pi-agent-core 0.87.0 — `shouldStopAfterTurn` → `finishTurn`

Changelog:

> Removed `AgentOptions.shouldStopAfterTurn` and
> `AgentLoopConfig.shouldStopAfterTurn`. Use `finishTurn` and return
> `{ action: "end" }` to stop after the completed turn:
>
> ```ts
> // Before
> shouldStopAfterTurn: async (turn, signal) => await shouldStop(turn, signal),
>
> // After
> finishTurn: async (turn, signal) => {
>   // shouldStopAfterTurn previously ran only for normal responses.
>   if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return;
>   return (await shouldStop(turn, signal)) ? { action: "end" } : undefined;
> },
> ```
>
> `finishTurn` runs after the assistant and all tool results are finalized but
> before `turn_end`; its decision is applied after `turn_end`. It also runs for
> error and aborted responses, whose decisions are ignored because those
> responses remain hard exits.

Porrima sites:
- `agent-loop-runner.ts:20` (option type) and `:32` (config passthrough).
- `chat-turn-runner.ts:663-…` (`shouldStopForMidTurnCompaction`) and `:760`
  (config).
- The HTTP chat route does **not** use the hook: it detects
  `stopReason === "length"` in its event handler (`chat.ts:2932,2937`) and
  exits via `stopAgentLoop()` (`chat.ts:3171` and similar).

### 2.3 pi-ai 1.0 — `Context` → `TranscriptContext`

Provider `stream`/`streamSimple` and `StreamFn` now take `TranscriptContext`.
The system prompt is the leading system message; tool declarations are
transcript deltas (`toolsAdded`/`toolsRemoved`). `AgentContext` (agent-core)
no longer has `systemPrompt`; the loop calls
`normalizeContext({ messages: llmMessages })` on the `convertToLlm` output and
injects tool-state changes from `context.tools` as system messages itself.

Migration helpers shipped in pi-ai 1.0: `createInitialSystemMessage`,
`normalizeContext`, `getCurrentSystemPrompt`, `getCurrentTools`,
`getSystemMessageText`, `collapseSystemMessages`, `withoutInitialSystemMessage`,
`resolveTranscript`.

Porrima sites:

| Site | What breaks |
|---|---|
| `chat.ts:2173,3088,3230,3631`; `chat-turn-runner.ts:382` | `AgentContext` built with `systemPrompt` field |
| `agent.ts:425` | one-shot `Context` with `systemPrompt` |
| `openai-compat-provider.ts:398-399` | reads `context.tools` |
| `openai-compat-provider.ts:1155,1162-1169` | `transformMessagesForProvider(context.messages)` + `context.systemPrompt` |
| `llm-provider.ts:33-50` | `streamSimple(model, context: Context, …)` |
| `llm-stream.ts:58` | `StreamFn` context type |

Invariant: whatever turns Porrima's stored system prompt into the leading
system message must run identically on the live wire, replay
(`chatMessagesToPiMessages`), and headless paths — otherwise the KV digest
diverges (the same failure mode as "Tool Result Wire Shape" in
`docs/tool-system.md`).

### 2.4 Smaller changes

- `ToolCall.arguments`: `Record<string, any>` → `JsonObject` (compile-level
  fixes).
- `JsonValue` tightened (`readonly` arrays, `JsonObject`).
- Image API renames (`ImagesApi`→`ImageApi`, `ImagesModel`→`ImageModel`) —
  Porrima's image generation moved out; no use.
- New: `samplingParamsByThinkingLevel`, `ModelPromptCache`,
  `onProviderStreamEvent`, classifier API.
- `AgentToolResult.structuredContent`, `AgentTool.outputSchema`/`replay`;
  `executionMode` is unchanged and already used (`agent-tools.ts:992`).
- New low-level `runAgentLoop`/`runAgentLoopContinue` emit-sink variants;
  Porrima's local `runAgentLoop` wrapper (`agent-loop-runner.ts`) is
  unaffected.
- Node ≥ 22.19.0 (since 0.75.0); this box runs v24.18.1.

### 2.5 What survives (kernel P2.5 seam unaffected)

- `AgentTool.execute(toolCallId, params, signal?, onUpdate?)` — unchanged.
- `AgentToolUpdateCallback`, the `tool_execution_update` event,
  `partialResult` — unchanged.
- `agentLoop`/`agentLoopContinue` signatures — unchanged.
- `executionMode` per tool — unchanged.

So the kernel plan's streaming seam is not invalidated by 1.0; only the
version and line references in that doc change.

## 3. Design: shared process supervisor

### 3.1 Responsibilities

One module owns what bash and the kernel share:

1. **Spawn**: `detached: true` (own process group), stdio pipes, cwd/env,
   optional stdin payload.
2. **Kill**: `killpg(SIGTERM)` → grace → `killpg(SIGKILL)`, idempotent.
3. **Registry**: active children by key (`bash:<chatId>`, `kernel:<chatId>`),
   `list()` for diagnostics, `killAll()` for graceful shutdown.
4. **Exit semantics**: resolve on process exit plus a short stdio grace
   (§3.3), never on pipe EOF.
5. **Diagnostics**: pid/startedAt/key for logs and the kernel plan's startup
   sweep.

Output capture lives beside it (`output-capture.ts`): bounded tail window,
incremental view, spill writer.

### 3.2 API sketch

```ts
// server/src/services/process-supervisor.ts
export interface SpawnSupervisedOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Registry key and diagnostics label, e.g. "bash:<chatId>". */
  key: string;
  /** Written to stdin and closed (bash stdin transport; future kernel use). */
  stdin?: string | Buffer;
  killGraceMs?: number;
}
export interface SupervisedProcess {
  key: string;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM → grace → SIGKILL on the process group. */
  kill(): Promise<void>;
}
export function spawnSupervised(opts: SpawnSupervisedOptions): SupervisedProcess;
export function listSupervised(): Array<{ key: string; pid: number; startedAt: number }>;
export async function killAllSupervised(): Promise<void>;
```

```ts
// server/src/services/output-capture.ts
export interface CaptureLimits { maxBytes: number; maxLines: number; retain: "tail"; }
export interface ShellOutputView { text: string; /* bounded, incremental */ }
export interface OutputCapture {
  push(chunk: Buffer): void;                    // feed stdout/stderr
  view(): ShellOutputView;                      // incremental bounded view
  finish(): Promise<{ text: string; truncation: unknown; spillPath?: string }>;
  dispose(): void;
}
export function createOutputCapture(opts: {
  limits: CaptureLimits;
  spill?: { path: string };
  onUpdate?: (view: ShellOutputView) => void;
}): OutputCapture;
```

### 3.3 Behaviors that must be preserved (from pi 0.85.1 `NodeExecutionEnv`)

1. **Detached spawn** on POSIX; timeout/abort kills the **group**
   (`process.kill(-pid, …)`), not just the leader. Upgrade over pi: TERM →
   grace → KILL instead of pi's immediate SIGKILL.
2. **Exit beats pipe EOF.** Resolve when the child exits *and* both stdio
   streams end; after exit, wait for stream silence of
   `EXIT_STDIO_GRACE_MS` (pi: 100 ms, re-armed on data) and then finalize,
   destroying the streams. This is what stops `server & disown` from hanging
   the tool (`workspace.ts:158-165`). Do not "fix" it to wait for EOF.
3. **Capture/spill**: bounded tail window (`maxBytes`, `maxLines`,
   `retain: "tail"`); spill starts at first truncation and includes the
   pre-truncation prefix; spill writes pause the pipes on backpressure (pi:
   8 MiB high-water) and finish before settle; `onUpdate` emits bounded view
   changes and late updates after settle are dropped.
4. **Merged output**: bash merges stdout+stderr untagged, in arrival order
   (today's behavior).
5. **Windows**: pi used `taskkill /T /F`; Porrima is Linux/systemd-first.
   Keep a single `process.platform === "win32"` branch or document
   Linux-only — a decision, not a blocker.

### 3.4 Consumers

- **bash rewrite** (`workspace.ts` `runStreamingBash`): `spawnSupervised`
  (`/bin/bash -c` argv transport) + capture; timeout/abort → `kill()`; spill →
  tool-output store; `execute` gains `onUpdate` and forwards the view (the
  shared streaming seam).
- **kernel manager** ([session-python-kernel.md](session-python-kernel.md)
  §4.2, §4.11): spawn the driver via `spawnSupervised`; stdout is a protocol
  line reader (not capture); stderr is the ring buffer; disposal uses `kill()`;
  the registry powers graceful shutdown and the startup sweep.
- **Not shared**: the Python-side child journal for subprocesses spawned
  inside cells (kernel doc §4.7) stays in the driver — the Node supervisor
  cannot see those.

### 3.5 Bash parity checklist

- Keep `/bin/bash -c` argv transport and the explicit `shellPath` (no
  per-call shell discovery).
- Keep `BASH_TIMEOUT_MAX_SEC = 600` and the 30 s default
  (`workspace.ts:152,293-296`).
- Keep the window: 100 KB / 1M lines (`workspace.ts:21-22`).
- Keep the footer text/`read_file` guidance, now pointing at the shared store.
- Keep exitCode semantics: nonzero → `isError: true`; killed-by-signal maps to
  `128 + signal` (pi's mapping).
- Keep the `withMutationLock('workspace:<label>')` wrapping in
  `agent-tools.ts` (unchanged).

## 4. Design: shared tool-output spill store

### 4.1 Layout

```
~/.porrima/tool-output/<chatId>/bash-<shortid>.log
~/.porrima/tool-output/<chatId>/py-<cellId>.txt
```

Remote SSH keeps the existing in-workspace `.porrima-tool-output/` convention
because `read_file` resolves against the remote workspace root (kernel doc
§4.10).

### 4.2 API

```ts
// server/src/services/tool-output-store.ts
export function createSpillPath(chatId: string, tool: "bash" | "py", id: string): string;
export function formatSpillFooter(info: { path: string; totalBytes: number; windowBytes: number }): string;
export async function pruneChat(chatId: string): Promise<void>;   // newest 64
export async function cleanupChat(chatId: string): Promise<void>; // chat deletion
export async function sweepExpired(): Promise<void>;              // 24 h TTL, scheduler tick
```

This replaces two behaviors: pi's bash spill goes to
`os.tmpdir()/tmp-*/pi-output-*.log` and is never cleaned; the kernel plan's
`~/.porrima/kernel-output/` would have been a second store with its own rules.

### 4.3 Retention

Newest 64 per chat, 24 h TTL, removed on chat deletion (`chat-deletion.ts`
cascade), swept on the scheduler's periodic tick. Same rules for both tools.

### 4.4 Replay stability

The footer is result text, so spill paths must be deterministic per
command/cell (short id, no timestamps) and the footer format must stay
byte-stable. A `read_file(path, offset=…)` pointer that differs between wire
and replay is the KV-digest failure the tool-system doc warns about.

## 5. Provider/transcript migration plan

### 5.1 System prompt as the leading system message

Recommendation: extend `createAgentLoopConfig` to accept `systemPrompt` and
wrap `convertToLlm` at that single choke point:

```ts
convertToLlm: async (messages) => {
  const base = await (options.convertToLlm ?? ((m) => m as Message[]))(messages);
  const system = createInitialSystemMessage(options.systemPrompt, undefined);
  return system ? [system, ...base] : base;
},
```

- Tools stay automatic: the 1.0 loop diffs `context.tools` against the
  transcript and appends a system delta when they change, so `context.tools`
  keeps working.
- The same wrapper serves live, replay, and headless — all three build their
  config through `createAgentLoopConfig` (`chat.ts:2301`,
  `chat-turn-runner.ts:756`), which is why the wrap belongs there and not in
  individual routes.
- Keep the system prompt out of persisted message rows (today it is a context
  field, not a row); only the request-time transcript gains it.
- `AgentContext` construction sites drop the `systemPrompt` field; callers
  pass `systemPrompt` into the config instead.

### 5.2 llama.cpp request construction

`streamOpenAICompat(model, ctx: TranscriptContext, options)`:
- `const prompt = getCurrentSystemPrompt(ctx.messages)` — replays later
  system deltas into the current prompt.
- `const tools = getCurrentTools(ctx.messages)` — convert to the request body
  as today.
- Keep the existing system-message handling in `convertMessages`
  (`openai-compat-provider.ts:1159-1174`): the leading system message renders
  exactly like today's `context.systemPrompt` (including the Gemma `/think`
  directive); later system messages keep the downgrade-to-user behavior
  (passive recall relies on it).
- Tools do not need to ride the leading system message's `toolsAdded`; the
  request body uses `getCurrentTools`, and the transcript fields are
  replay metadata.
- KV-cache check: for a chat whose prompt/tools did not change mid-run, the
  rendered leading prompt and tool declarations must be byte-identical to the
  0.85.1 wire. Verify with the existing prompt digest tools
  (`llama-prompt-debug.ts`, cache-warm digests) on a long chat before/after.
- `pi-message-utils.ts` `transformMessagesForProvider` receives chat messages;
  it already passes unknown roles through, so no signature change is needed
  beyond the call-site type.

### 5.3 `shouldStopAfterTurn` → `finishTurn`

Use the changelog's guard form (return `undefined` for error/aborted) so the
headless mid-turn compaction predicate keeps its normal-response-only
side-effect behavior. Sites: `agent-loop-runner.ts` option + passthrough;
`chat-turn-runner.ts` guard. The HTTP route is unaffected (`stopReason ===
"length"` + `stopAgentLoop()`).

### 5.4 One-shot paths

`agent.ts:425` builds a `Context` for one-shot utility calls. Either build a
`TranscriptContext` (`createInitialSystemMessage` + `normalizeContext`) or keep
an internal `{ systemPrompt, messages, tools }` shape and normalize at the
single call site. Prefer whichever keeps the request bytes identical to the
loop path.

### 5.5 Type-level cleanup

`ToolCall.arguments: JsonObject`, `AgentToolResult.details`/
`structuredContent`, unused harness imports removed. `npx tsc --noEmit` in
`server/` drives the list.

## 6. Sequencing

Build the supervisor and rewrite bash **before** bumping pi, so the package
upgrade only has to deal with the provider/loop migration:

| Track | Work | Package state |
|---|---|---|
| T0 | `process-supervisor.ts`, `output-capture.ts`, `tool-output-store.ts` | 0.85.1 (no pi APIs) |
| T1 | `runStreamingBash` rewrite on T0 (+ `onUpdate` seam; chat.ts/client streaming plumbing can follow) | 0.85.1 |
| T2 | Provider/transcript migration (`finishTurn`, system message, `TranscriptContext`, llama.cpp request), then bump both packages to 1.0.2 | 1.0.2 |
| T3 | Kernel P1 manager on the supervisor ([session-python-kernel.md](session-python-kernel.md)) | 1.0.2 |
| T4 | Kernel P2/P3 (jobs, spill, snapshot) — P2's spill is already delivered by T0 | 1.0.2 |

Notes:
- T0/T1 are pure Porrima code and can ship on the current pin, removing the
  harness dependency before the upgrade.
- T2 is the only genuinely independent migration; it can start in parallel,
  but the version bump is atomic (both packages together).
- The kernel doc's P2.5 streaming work gets cheaper after T1: bash and
  `run_python` share the same `onUpdate` → `tool_execution_update` → SSE →
  tool-card path.

## 7. Acceptance checklist

- Bash: timeout, abort, daemonized grandchild, huge output spill +
  `read_file` paging, merged output ordering, exitCode mapping, no orphan
  group after abort or server SIGKILL (supervisor registry + startup sweep).
- Provider: long-chat KV digest parity after the transcript migration; prompt
  debug before/after; mid-turn compaction headless test (`chat-turn-runner`).
- Loop: `finishTurn` guard fires only for normal responses; error/aborted runs
  end normally.
- Store: 64-file/24 h retention, chat deletion removes the directory, remote
  spill stays workspace-local.
- Kernel: the kernel plan's P1 test matrix runs against `spawnSupervised`.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Transcript migration changes request bytes → full re-prefill | Digest-check a long chat before/after; render the leading system message as plain content |
| `finishTurn` runs for error/aborted responses | Changelog guard; tests pin predicate side-effect behavior |
| Losing exit-vs-EOF semantics in the bash rewrite | Parity checklist §3.5; a `cmd & disown` test |
| Spill path in result text breaks replay | Deterministic short ids; no timestamps; shared footer formatter |
| pi moves again in 1.x | Keep the supervisor and a transcript shim as the only pi-facing seams; the rest of Porrima imports types only |
| Mixing pi-ai 1.0 with agent-core 0.85 | Bump both together; agent-core 1.0.2 requires pi-ai ^1.0.2 |

## References

- Changelog: <https://github.com/earendil-works/pi/blob/main/packages/agent/CHANGELOG.md>
  (1.0.0 harness removal; 0.87.0 `finishTurn`)
- Release notes: <https://github.com/earendil-works/pi/releases>
- `@earendil-works/pi-durable`: <https://www.npmjs.com/package/@earendil-works/pi-durable>
- Kernel plan: [session-python-kernel.md](session-python-kernel.md)
- Porrima today: `server/src/services/workspace.ts` (`runStreamingBash`),
  `server/src/services/agent-loop-runner.ts`,
  `server/src/services/chat-turn-runner.ts`,
  `server/src/services/openai-compat-provider.ts`,
  `server/src/services/llm-provider.ts`, `server/src/services/llm-stream.ts`
