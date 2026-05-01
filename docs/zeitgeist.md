# Zeitgeist: Continuity Block

The **zeitgeist** is a global memory block that captures the narrative of "who I am right now" — active threads, recent developments, context that matters, unresolved tensions. Unlike atomic memories (fact-focused), the zeitgeist is a living document representing the present tense of the agent's existence.

## Storage

The zeitgeist lives as a single global memory block with ID `blk-zeitgeist-continuity`. It's written in the agent's own voice and updated incrementally.

Archives — dated snapshots of prior zeitgeist states — are stored as additional memory blocks. They're created by the agent when the current zeitgeist grows beyond its soft capacity (~3500 characters) and older content needs to be rotated out.

## Injection

On every agent chat turn, `buildStablePrefix()` in `memory-context.ts` calls `getZeitgeistContent()` and appends the block as `## Continuity Context (Zeitgeist)` to the stable system-prompt prefix. System-chat synthesis and automations also build from this stable prefix. Phase or automation instructions are appended as user-role trigger/follow-up messages, keeping the prefix byte-identical across runs so KV caching works.

`getZeitgeistArchiveInstruction()` adds a short hint ("## Historical Context Access") telling the agent how to discover and read zeitgeist archives, synthesis entries, and notebook blocks via `list_memory_blocks` + `read_memory_block`. The hint is only emitted when at least one archive/synthesis/notebook block actually exists.

## Maintenance

The zeitgeist is maintained **by the agent, during synthesis cycles in the system chat** (see [memory-system.md](memory-system.md) § Synthesis). There is no dedicated zeitgeist scheduler anymore; the unified synthesis run owns zeitgeist maintenance alongside the daily summary and reflection-memory generation.

The default synthesis prompt steps in `system-chat.ts` tell the agent to update the zeitgeist memory block (`blk-zeitgeist-continuity`) via `update_memory_block` when there are meaningful new patterns, threads, or shifts. If the current zeitgeist has grown too large, the agent archives older content into a separate memory block before rewriting the current block.

So the agent decides each cycle whether the zeitgeist needs an update, what to archive, and how to write the new version. No capacity gate, no staleness trigger, no per-chat `lastZeitgeistSynthesisAt` tracking.

## Historical note

Earlier versions had a dedicated zeitgeist scheduler that ran every 15 minutes and triggered per-chat syntheses via `triggerZeitgeistSynthesis` / `synthesizeZeitgeist`. That whole path was removed when synthesis moved into the system chat. The `lastZeitgeistSynthesisAt` column on the `chats` table remains for legacy data but is no longer read or written.

## Related

- [memory-system.md](memory-system.md) — atomic memories, retrieval, synthesis
- [memory-blocks.md](memory-blocks.md) — how memory blocks are scoped and injected
