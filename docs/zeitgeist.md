# Zeitgeist: Continuity Block

The **zeitgeist** is a global memory block that captures the narrative of "who I am right now" — active threads, recent developments, context that matters, unresolved tensions. Unlike atomic memories (fact-focused), the zeitgeist is a living document representing the present tense of the agent's existence.

## Storage

The zeitgeist lives as a single global memory block marked `blockType: 'zeitgeist'`. It is resolved by that **marker, never by a stored ID** — a hardcoded ID once kept resolving a superseded snapshot for two weeks, which meant the archive-trigger number was a faithful measurement of a dead address. The name-based fallback path logs a warning telling you to set the marker. It's written in the agent's own voice and updated incrementally.

Because it is system-managed, the zeitgeist block is **excluded from the generic block injection** and rendered by its own `## Continuity Context (Zeitgeist)` section instead (see below).

Archives — dated snapshots of prior zeitgeist states — are stored as additional memory blocks with `blockType: 'zeitgeist-archive'`. They're created by the agent when the current zeitgeist grows beyond its soft capacity: **~80% of the configured block character limit** (4800 characters at the 6000-char default, configurable 5000–20000). The threshold is re-reported to the agent on every synthesis cycle as part of the Phase 2 prompt section.

## Injection

On every agent chat turn, `buildStablePrefix()` in `memory-context.ts` calls `getZeitgeistContent()` and appends the block as `## Continuity Context (Zeitgeist)` to the stable system-prompt prefix. System-chat synthesis and automations also build from this stable prefix. Phase or automation instructions are appended as user-role trigger/follow-up messages, keeping the prefix byte-identical across runs so KV caching works.

`getZeitgeistArchiveInstruction()` adds a short hint ("## Historical Context Access") telling the agent how to discover and read zeitgeist archives, synthesis entries, and notebook blocks via `list_memory_blocks` + `read_memory_block`. The hint is only emitted when at least one archive/synthesis/notebook block actually exists.

## Maintenance

The zeitgeist is maintained **by the agent, during synthesis cycles in the system chat** (see [memory-system.md](memory-system.md) § Synthesis). There is no dedicated zeitgeist scheduler anymore; the unified synthesis run owns zeitgeist maintenance alongside the daily summary and reflection-memory generation.

The default synthesis prompt steps in `system-chat.ts` tell the agent to update the zeitgeist memory block via `update_memory_block` when there are meaningful new patterns, threads, or shifts. If the current zeitgeist has grown too large, the agent archives older content into a separate memory block before rewriting the current block.

So the agent decides each cycle whether the zeitgeist needs an update, what to archive, and how to write the new version.

## Server surface

`zeitgeist.ts` is deliberately tiny — 64 lines, two read-only accessors, and nothing else:

- `getZeitgeistContent()` returns the live block's content
- `getZeitgeistArchiveInstruction()` returns the historical-context hint described above

All maintenance is the synthesis agent's job. The server's only contribution is the Phase 2 prompt section, which reports the zeitgeist's current character count and the archive threshold and instructs "archive first" when over it.

## Historical note

Earlier versions had a dedicated zeitgeist scheduler that ran every 15 minutes and triggered per-chat syntheses via `triggerZeitgeistSynthesis` / `synthesizeZeitgeist`. That whole path was removed when synthesis moved into the system chat. The `lastZeitgeistSynthesisAt` column on the `chats` table remains for legacy data but is no longer read or written.

## Related

- [memory-system.md](memory-system.md) — atomic memories, retrieval, synthesis
- [memory-blocks.md](memory-blocks.md) — how memory blocks are scoped and injected
