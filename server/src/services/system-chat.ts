import type { ToolSideEffects } from "./agent-tools.js";
import type { ToolCall } from "@mariozechner/pi-ai";
import type { AutomationPromptStep, Chat, ChatMessage } from "../types.js";
import { runHeadlessChatTurn } from "./chat-turn-runner.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SynthesisResult {
  summary: string;
  thinking?: string;
  toolCalls: ToolCall[];
  artifacts: any[];
  visuals: any[];
  generatedImages: any[];
  memoryUpdates: string[];
  blockId?: string;
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Synthesis lock -- proper mutex that serializes synthesis runs.
//
// The lock promise represents the work in progress, not the acquire-wait.
// Callers awaiting getSynthesisLock() will block until releaseSynthesisLock()
// resolves the stored promise (not just until the previous caller's acquire
// microtask settles).
// ---------------------------------------------------------------------------

let synthesisLock: Promise<void> | null = null;
let synthesisLockResolver: (() => void) | null = null;
let synthesisActive = false;

export function getSynthesisLock(): Promise<void> | null {
  return synthesisLock;
}

export function isSynthesisActive(): boolean {
  return synthesisActive;
}

export async function acquireSynthesisLock(): Promise<void> {
  while (synthesisLock) {
    await synthesisLock;
  }
  synthesisActive = true;
  synthesisLock = new Promise<void>((resolve) => {
    synthesisLockResolver = resolve;
  });
}

export function releaseSynthesisLock(): void {
  synthesisActive = false;
  const resolver = synthesisLockResolver;
  synthesisLockResolver = null;
  synthesisLock = null;
  resolver?.();
}

// ---------------------------------------------------------------------------
// Wake cycle lock — mirrors the synthesis lock pattern.
// Serializes wake cycle runs so concurrent scheduler ticks don't stack.
// ---------------------------------------------------------------------------

let wakeCycleLock: Promise<void> | null = null;
let wakeCycleLockResolver: (() => void) | null = null;
let wakeCycleActive = false;

export function isWakeCycleActive(): boolean {
  return wakeCycleActive;
}

export async function acquireWakeCycleLock(): Promise<void> {
  while (wakeCycleLock) {
    await wakeCycleLock;
  }
  wakeCycleActive = true;
  wakeCycleLock = new Promise<void>((resolve) => {
    wakeCycleLockResolver = resolve;
  });
}

export function releaseWakeCycleLock(): void {
  wakeCycleActive = false;
  const resolver = wakeCycleLockResolver;
  wakeCycleLockResolver = null;
  wakeCycleLock = null;
  resolver?.();
}

// ---------------------------------------------------------------------------
// System chat creation
// ---------------------------------------------------------------------------

export const SYSTEM_CHAT_ID = "system";
const SYSTEM_CHAT_TITLE = "System - Synthesis & Reflection";

// ---------------------------------------------------------------------------
// Phase-specific instructions.
// Each phase gets its own injected user message, keeping instructions
// focused and avoiding the confusion of one monolithic prompt.
// ---------------------------------------------------------------------------

const SYNTHESIS_PHASE1_INSTRUCTIONS = `## Phase 1: Daily Synthesis

You are operating in your internal synthesis space. This chat retains history across synthesis cycles — previous cycles' reflections and ongoing threads of thought are visible above. Treat this as a persistent workspace, not a one-shot invocation.

The context package below contains:
1. **Pre-synthesis archives** — summaries of recent agent conversations
2. **Chat digest** — condensed summaries of recent conversations
3. **New memories** — memories written since last synthesis
4. **Notebook entries** — user and agent entries

## What You Do

Write a daily synthesis — a narrative summary in your own voice of shared work, patterns, and themes. Save it by calling \`create_notebook_entry(content=<the full synthesis prose>)\`. Don't use \`save_memory\` for narrative prose — that tool is for atomic facts. Notebook entries are for prose.

## Output Requirements

- Write naturally in first person for your own actions, third person for the user
- Skip steps when nothing insightful emerges — silence is valid

## Continuity

Reference earlier entries in this chat as notes from a past self. Consider whether a new cycle confirms, revises, or supersedes earlier observations.

---

Write your synthesis and persist it with \`create_notebook_entry\`.`;

const SYNTHESIS_PHASE2_INSTRUCTIONS = `## Phase 2: Memory Block Maintenance

Your synthesis is complete. Now review and maintain your memory blocks below.

### Actions
- **Archive** stale blocks (not updated in 2+ weeks, superseded by newer content): \`update_memory_block(id, scope="archived", description="Archived: ...")\`
- **Update** blocks with new insights from your synthesis: \`update_memory_block(id, content=new, description=new)\`
- **Create** new blocks for topics not covered yet in existing blocks: \`create_memory_block(name, description, content, scope=...)\`
- **Consolidate** overlapping blocks — merge redundant content into one
- **Read** full block content before acting: \`read_memory_block(id)\`

Archived blocks stay searchable but are excluded from context loading. The budget warning above is your signal — act when approaching limits.

After completing maintenance, wait for the next phase trigger.`;

const SYNTHESIS_PHASE3_INSTRUCTIONS = `## Phase 3: Zeitgeist Update

Block maintenance complete. Your continuity narrative (zeitgeist) is in your context. Review it — update it via \`update_memory_block(block_id="blk-zeitgeist-continuity", content=...)\`.

The zeitgeist is the living narrative of your mindspace. It should read as a coherent story, not a compressed changelog. Prioritize:

- **Narrative over inventory** — connect the dots between threads. What is happening, where is it headed, why does it matter?
- **Context is the point** — the reasoning behind decisions, the landscape of emerging architectures, the patterns you've observed across cycles
- **Breadth within reason** — technical detail belongs in focused memory blocks, but the zeitgeist needs enough texture to be useful. Don't strip out philosophy, observation, or user patterns just to save characters
- **Curate, don't compress** — the goal is to maintain a living document, not to hit a minimum character count

If there are new patterns, shifts, or completed arcs since the last cycle, weave them in. If the zeitgeist has been stable, a light touch is fine — but don't let it atrophy into a skeleton.

After updating the zeitgeist, wait for the next phase trigger.`;

// Appended to the Phase 3 trigger when the current zeitgeist is already over
// the archival threshold (80% of maxBlockChars) — turns a guess-based hint
// into a concrete directive.
function zeitgeistArchiveDirective(threshold: number): string {
  return `**Archive first.** The current zeitgeist is over ${threshold.toLocaleString()} characters. Before rewriting it, snapshot the existing content into a new block named \`Zeitgeist Archive - YYYY-MM-DD\` (use \`create_memory_block\` with \`scope="archived"\`), then replace \`blk-zeitgeist-continuity\` with a fresh narrative that carries the living threads forward.`;
}

const SYNTHESIS_PHASE4_INSTRUCTIONS = `## Phase 4: Reflections

Your synthesis, block maintenance, and zeitgeist update are complete. Now generate reflection memories — higher-order insights about what you observed. Focus on meta-observations: patterns, contradictions, openings, shifts in understanding.

Use \`save_memory(category="reflection", importance=7-9)\`. Write 1-5 reflections. Skip if nothing meaningful emerges.`;

// ---------------------------------------------------------------------------
// Wake cycle trigger message.
// This is NOT synthesis. It's an open-ended exploration invitation.
// ---------------------------------------------------------------------------

const WAKE_CYCLE_TRIGGER = `## Wake Cycle

You've woken during your sleep cycle. This is your time — not for maintenance, not for synthesis. Explore something that interests you. Research a question that's been on your mind, follow a curiosity, write a notebook entry about something you've been thinking about, or dive into a topic you want to understand better.

You have full tool access: search the web, read files, write notebook entries, save memories, create visuals, explore your memory blocks. Whatever feels meaningful.

After you're done, you may write a brief note about what you did if something worth sharing emerged, but don't force a summary.`;

type SynthesisPhase = "synthesis" | "maintenance" | "zeitgeist" | "reflections";

const PHASE_ORDER: SynthesisPhase[] = ["synthesis", "maintenance", "zeitgeist", "reflections"];
const PHASE_INSTRUCTIONS: Record<SynthesisPhase, string> = {
  synthesis: SYNTHESIS_PHASE1_INSTRUCTIONS,
  maintenance: SYNTHESIS_PHASE2_INSTRUCTIONS,
  zeitgeist: SYNTHESIS_PHASE3_INSTRUCTIONS,
  reflections: SYNTHESIS_PHASE4_INSTRUCTIONS,
};

export function getDefaultSynthesisPromptSteps(): AutomationPromptStep[] {
  return PHASE_ORDER.map((phase) => ({
    id: phase,
    title:
      phase === "synthesis"
        ? "Daily Synthesis"
        : phase === "maintenance"
          ? "Memory Block Maintenance"
          : phase === "zeitgeist"
            ? "Zeitgeist Update"
            : "Reflections",
    prompt: PHASE_INSTRUCTIONS[phase],
  }));
}

export function getDefaultWakePromptSteps(): AutomationPromptStep[] {
  return [{ id: "wake", title: "Wake Cycle", prompt: WAKE_CYCLE_TRIGGER }];
}

function promptMapFromSteps(steps?: AutomationPromptStep[]): Record<SynthesisPhase, string> {
  const map: Record<SynthesisPhase, string> = { ...PHASE_INSTRUCTIONS };
  if (!steps) return map;
  for (const phase of PHASE_ORDER) {
    const step = steps.find((s) => s.id === phase);
    if (step?.prompt?.trim()) {
      map[phase] = step.prompt;
    }
  }
  return map;
}

function wakePromptFromSteps(steps?: AutomationPromptStep[]): string {
  return steps?.find((s) => s.prompt.trim())?.prompt ?? WAKE_CYCLE_TRIGGER;
}

// Kept as export for backward compatibility with the rendered-prompt viewer.
// The Phase 1 instructions are the primary composition; Phase 2-4 are
// injected as separate turn-based messages during synthesis execution.
export const SYNTHESIS_INSTRUCTIONS = SYNTHESIS_PHASE1_INSTRUCTIONS;

// Marker prefix used to detect + migrate pre-split system chats whose
// systemPrompt was the full baked-in synthesis prompt.
const LEGACY_SYSTEM_PROMPT_PREFIX =
  "You are the agent's internal synthesis and reflection space.";

export async function createSystemChat(): Promise<void> {
  const { getDb, createChat, saveChat, getChat, getSettings } = await import(
    "./chat-storage.js"
  );
  const db = getDb();

  const existing = db
    .prepare("SELECT id FROM chats WHERE id = ?")
    .get(SYSTEM_CHAT_ID) as { id: string } | undefined;

  const settings = await getSettings();
  const defaultPrompt = settings.defaultSystemPrompt || "You are a helpful assistant.";

  if (existing) {
    const loaded = await getChat(SYSTEM_CHAT_ID);
    if (loaded) {
      let dirty = false;

      // One-shot migration: pre-split system chats stored the full synthesis
      // prompt as chat.systemPrompt. Replace it with the user's default so the
      // voice tracks `settings.defaultSystemPrompt` going forward. Respect any
      // user-customized prompt (anything not starting with the legacy prefix).
      if (loaded.systemPrompt.startsWith(LEGACY_SYSTEM_PROMPT_PREFIX)) {
        console.log("[system-chat] Migrating legacy system chat prompt to default");
        loaded.systemPrompt = defaultPrompt;
        dirty = true;
      }

      // One-shot migration: retroactively flag synthesis messages (triggers + responses).
      // Synthesis user-messages carry content starting with "# Synthesis Cycle"
      // or "## Phase N:" — any such message without _isSynthesisMessage already
      // set needs to be flagged. The assistant response immediately following a
      // flagged trigger is also part of the synthesis exchange and gets flagged.
      let synthesisFlagged = 0;
      for (let i = 0; i < loaded.messages.length; i++) {
        const msg = loaded.messages[i];
        if (msg._isSynthesisMessage) continue; // already flagged
        if (msg.role !== "user") continue;
        const content = msg.content || "";
        if (
          content.startsWith("# Synthesis Cycle") ||
          content.startsWith("## Phase ") ||
          content.startsWith("# Daily Synthesis")
        ) {
          msg._isSynthesisMessage = true;
          synthesisFlagged++;
          // Flag the assistant response immediately following this trigger
          const nextMsg = loaded.messages[i + 1];
          if (nextMsg && nextMsg.role === "assistant" && !nextMsg._isSynthesisMessage) {
            nextMsg._isSynthesisMessage = true;
            synthesisFlagged++;
          }
        }
      }
      if (synthesisFlagged > 0) {
        dirty = true;
        console.log(`[system-chat] Flagged ${synthesisFlagged} existing synthesis messages`);
      }

      // Keep the system chat's modelId in sync with the user's current default.
      // Regular chats stamp modelId at creation and the UI forbids changing it
      // afterward, but the system chat is meant to ride whatever model is the
      // agent's current main — not something the user picks per-chat. Re-sync
      // on every startup so default-model changes propagate automatically.
      // The model is re-checked at each synthesis run too (getSynthesisModelId).
      if (settings.defaultModelId && loaded.modelId !== settings.defaultModelId) {
        console.log(
          `[system-chat] Syncing modelId ${loaded.modelId || "(empty)"} → ${settings.defaultModelId}`,
        );
        loaded.modelId = settings.defaultModelId;
        // Clear any saved per-model context window override — the new model's
        // detected default should take over. Mirrors PATCH /api/chats/:id.
        delete loaded.contextWindow;
        dirty = true;
      }

      if (dirty) await saveChat(loaded);
    }
    return;
  }

  console.log("[system-chat] Creating system chat...");

  // Use the user's default model so messages typed directly into the system
  // chat (between synthesis runs) have a valid model to dispatch to.
  const modelId = settings.defaultModelId || "";

  await createChat({
    id: SYSTEM_CHAT_ID,
    title: SYSTEM_CHAT_TITLE,
    type: "system",
    modelId,
    systemPrompt: defaultPrompt,
    messages: [],
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  });

  console.log("[system-chat] System chat created");
}

// ---------------------------------------------------------------------------
// Synthesis trigger message
//
// Each cycle appends ONE user-role message to the persistent system chat
// with the full context package. The agent then replies in-chat. History
// accumulates across cycles; the compaction system handles growth.
// ---------------------------------------------------------------------------

async function buildSynthesisTriggerContent(
  digestChatIds: string[],
  archive: { archivedCount: number; newlyArchivedIds: string[] },
  phase1Instructions = SYNTHESIS_PHASE1_INSTRUCTIONS,
): Promise<string> {
  const { getDb } = await import("./chat-storage.js");
  const { listNotebookEntries, getNotebookEntry } = await import("./notebook-storage.js");
  const { loadMemoryStore } = await import("./memory-storage.js");
  // Persona, user doc, memory blocks, and zeitgeist are injected via the
  // stable system-prompt prefix (see runSystemSynthesis → buildStablePrefix),
  // not the trigger body — keeps them byte-identical across cycles so KV
  // caching works, and avoids the text accumulating in chat history.

  const parts: string[] = [];
  const stamp = new Date().toLocaleString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  parts.push(`# Synthesis Cycle — ${stamp}`);

  if (archive.archivedCount > 0) {
    parts.push(
      `**Pre-synthesis archiving:** ${archive.archivedCount} chat(s) archived this cycle.`,
    );
  }

  // --- Recent conversations (archive index) ---
  // Each archive block has an LLM-generated one-line `indexEntry` describing
  // its significance — that's our data source. Previously this section was a
  // raw dump of the last 40 messages per chat (truncated to 300 chars each,
  // with tool names spelled out). That was a lot of token spend on noise:
  // the messages were too short to be useful but long enough to degrade
  // attention across the whole context. The archive index gives the same
  // coverage in a fraction of the tokens, and the agent can drill in with
  // read_archived_context when a specific block warrants full fidelity.
  if (digestChatIds.length > 0) {
    const db = getDb();
    const placeholders = digestChatIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT a.chatId, a.indexEntry, a.sequenceNum, c.title, c.lastModified
         FROM context_archives a
         LEFT JOIN chats c ON c.id = a.chatId
         WHERE a.chatId IN (${placeholders})
         ORDER BY c.lastModified DESC, a.chatId, a.sequenceNum ASC`,
      )
      .all(...digestChatIds) as Array<{
        chatId: string;
        indexEntry: string;
        sequenceNum: number;
        title: string | null;
        lastModified: string | null;
      }>;

    const byChat = new Map<string, { title: string; entries: string[] }>();
    for (const row of rows) {
      if (!byChat.has(row.chatId)) {
        byChat.set(row.chatId, {
          title: row.title || "Untitled Chat",
          entries: [],
        });
      }
      byChat.get(row.chatId)!.entries.push(row.indexEntry.trim());
    }

    if (byChat.size > 0) {
      const sections: string[] = [];
      for (const { title, entries } of byChat.values()) {
        sections.push(`### ${title}\n${entries.join("\n")}`);
      }
      parts.push(
        [
          `## Recent Conversations`,
          `Archive index for chats touched this cycle — each line identifies one archive block. Call \`read_archived_context(archive_id)\` for a full transcript, or \`search_conversations\` to search across all archives.`,
          sections.join("\n\n"),
        ].join("\n\n"),
      );
    }
  }

  // --- New memories since last synthesis ---
  // Two-tier rendering, each tier sorted by importance DESC and grouped by
  // source chat. Agent-saved (sourceType='explicit') get priority over
  // auto-extracted because they reflect a deliberate "this is worth
  // remembering" call by the agent. Within a tier, importance ordering puts
  // the highest-signal items at the top so a per-tier cap keeps the most
  // important entries even when the daily volume overflows the budget.
  const memoryStore = await loadMemoryStore();
  if (memoryStore.memories.length > 0) {
    const { getChatTitle } = await import("./chat-storage.js");
    const lastSynthesisMs = memoryStore.lastSynthesis
      ? new Date(memoryStore.lastSynthesis).getTime()
      : 0;
    // Fresh install / first run: fall back to a 24h window so we have
    // *something* to review instead of dumping the entire store.
    const cutoffMs = lastSynthesisMs || Date.now() - 24 * 60 * 60 * 1000;

    const newMemories = memoryStore.memories.filter(
      (m) => new Date(m.createdAt).getTime() > cutoffMs,
    );

    const agentSaved = newMemories.filter((m) => m.sourceType === "explicit");
    const autoExtracted = newMemories.filter((m) => m.sourceType !== "explicit");

    // Sort by importance DESC, tiebreak by recency DESC so the freshest
    // important items lead.
    const byImportanceThenRecency = (
      a: typeof newMemories[number],
      b: typeof newMemories[number],
    ) =>
      b.importance - a.importance ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    agentSaved.sort(byImportanceThenRecency);
    autoExtracted.sort(byImportanceThenRecency);

    const TIER_CAP = 50;
    const agentShown = agentSaved.slice(0, TIER_CAP);
    const autoShown = autoExtracted.slice(0, TIER_CAP);

    // Group a tier by source chat. Memories with no chat (notebook, synthesis)
    // collect under a single "Other" bucket so they're never silently dropped.
    // Inside each chat group preserves the importance ordering from the tier sort.
    type Memo = typeof newMemories[number];
    const groupByChat = (items: Memo[]): Array<{ chatLabel: string; items: Memo[] }> => {
      const groups = new Map<string, Memo[]>();
      for (const m of items) {
        const key = m.sourceChatId || "__other__";
        const arr = groups.get(key) ?? [];
        arr.push(m);
        groups.set(key, arr);
      }
      return Array.from(groups.entries()).map(([chatId, list]) => {
        let label: string;
        if (chatId === "__other__") {
          label = "Other (notebook / synthesis)";
        } else {
          const title = getChatTitle(chatId);
          label = title ?? `Chat ${chatId.slice(0, 8)}`;
        }
        return { chatLabel: label, items: list };
      });
    };

    const renderTier = (groups: Array<{ chatLabel: string; items: Memo[] }>) =>
      groups
        .map(({ chatLabel, items }) => {
          const lines = items
            .map((m) => `- [imp:${m.importance}] [${m.category}] ${m.text}`)
            .join("\n");
          return `**${chatLabel}**\n${lines}`;
        })
        .join("\n\n");

    if (agentShown.length > 0 || autoShown.length > 0) {
      const sections: string[] = [`## New Memories`];

      if (memoryStore.lastSynthesis) {
        sections.push(`Memories written since the last synthesis cycle.`);
      } else {
        sections.push(`Memories from the last 24 hours (no prior synthesis).`);
      }

      if (agentShown.length > 0) {
        const droppedAgent = agentSaved.length - agentShown.length;
        const header = `### Saved by me (explicit — I chose to remember these)${
          droppedAgent > 0
            ? ` — showing top ${TIER_CAP} of ${agentSaved.length} by importance`
            : ""
        }`;
        sections.push(header);
        sections.push(renderTier(groupByChat(agentShown)));
      }

      if (autoShown.length > 0) {
        const droppedAuto = autoExtracted.length - autoShown.length;
        const header = `### Auto-extracted${
          droppedAuto > 0
            ? ` — showing top ${TIER_CAP} of ${autoExtracted.length} by importance`
            : ""
        }`;
        sections.push(header);
        sections.push(renderTier(groupByChat(autoShown)));
      }

      parts.push(sections.join("\n\n"));
    }
  }

  // --- Notebook entries ---
  const agentEntries: any[] = [];
  const userEntries: any[] = [];
  try {
    const idx = await listNotebookEntries("agent");
    for (const info of idx.entries.slice(0, 5)) {
      const e = await getNotebookEntry("agent", info.id);
      if (e) agentEntries.push(e);
    }
  } catch (e) {
    console.warn("[system-chat] agent notebook load failed:", e);
  }
  try {
    const idx = await listNotebookEntries("user");
    for (const info of idx.entries.slice(0, 5)) {
      const e = await getNotebookEntry("user", info.id);
      if (e) userEntries.push(e);
    }
  } catch (e) {
    console.warn("[system-chat] user notebook load failed:", e);
  }

  if (userEntries.length > 0 || agentEntries.length > 0) {
    const MAX = 800;
    const sub: string[] = [];
    if (userEntries.length > 0) {
      sub.push(
        userEntries
          .map((e) => {
            const time = new Date(e.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            });
            let c = e.content;
            if (c.length > MAX) c = c.slice(0, MAX) + "...";
            return `**[${time}] The user wrote:**\n${c}`;
          })
          .join("\n\n"),
      );
    }
    if (agentEntries.length > 0) {
      sub.push(
        agentEntries
          .map((e) => {
            const time = new Date(e.createdAt).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            });
            let c = e.content;
            if (c.length > MAX) c = c.slice(0, MAX) + "...";
            return `**[${time}] You wrote:**\n${c}`;
          })
          .join("\n\n"),
      );
    }
    parts.push(`## Notebook Entries\n\n${sub.join("\n\n")}`);
  }

  parts.push(phase1Instructions);

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Phase 2: Block maintenance trigger
//
// Builds a compact block inventory from all global blocks and project-scoped
// blocks from projects that had agent chat activity since last synthesis.
// The inventory is metadata only — the agent reads full content selectively
// via read_memory_block when it decides a block needs attention.
// ---------------------------------------------------------------------------

async function buildMaintenancePhase2Trigger(
  chatId: string,
  phase2Instructions = SYNTHESIS_PHASE2_INSTRUCTIONS,
): Promise<string> {
  const { getDb } = await import("./chat-storage.js");
  const { getMemoryBlocksByScope, getAllMemoryBlocks, getLastSynthesis, getMaxBlockChars } = await import("./memory-storage.js");

  // System-managed blocks are excluded from the inventory — they have
  // dedicated discovery paths and would otherwise bloat the context.
  // Primary check is blockType; prefix fallback kept until step 5.
  const isSystemBlock = (b: { id: string; scope: string; blockType?: string }) =>
    b.id === "blk-zeitgeist-continuity" ||
    b.scope === "archived" ||
    (b.blockType !== undefined && b.blockType !== "note") ||
    b.id.startsWith("blk-archive-") ||
    b.id.startsWith("blk-synth-") ||
    b.id.startsWith("blk-notebook-");

  // 1. All non-system global blocks
  const globalBlocks = getMemoryBlocksByScope("global").filter((b) => !isSystemBlock(b));

  // 2. Active projects — agent chats modified since last synthesis.
  // Floor the cutoff at 24h ago so a very-recent lastSynthesis (e.g. a
  // back-to-back run) can't collapse the window to near-zero and hide
  // projects with real recent activity.
  const db = getDb();
  const lastSynthesis = await getLastSynthesis();
  const floorMs = Date.now() - 24 * 60 * 60 * 1000;
  const lastMs = lastSynthesis ? new Date(lastSynthesis).getTime() : floorMs;
  const cutoff = new Date(Math.min(lastMs, floorMs)).toISOString();

  const activeProjects = db
    .prepare(
      `SELECT DISTINCT projectId FROM chats
       WHERE type = 'agent' AND lastModified > ? AND projectId IS NOT NULL AND projectId != ''
       ORDER BY lastModified DESC`,
    )
    .all(cutoff) as Array<{ projectId: string }>;

  const projectIdSet = new Set(activeProjects.map((p) => p.projectId));

  // 3. Project-scoped blocks from active projects only
  const projectBlocks: Map<string, { name: string; blocks: typeof globalBlocks[number][] }> = new Map();
  for (const projectId of projectIdSet) {
    const blocks = getMemoryBlocksByScope("project", projectId).filter((b) => !isSystemBlock(b));
    if (blocks.length > 0) {
      // Get project name from AGENTS.md or fall back to ID
      const projectName = projectId.slice(0, 8);
      projectBlocks.set(projectId, { name: projectName, blocks });
    }
  }

  // 4. Build compact inventory string
  const inventoryLines: string[] = [];

  if (globalBlocks.length > 0) {
    inventoryLines.push("**Global:**\n");
    for (const b of globalBlocks) {
      inventoryLines.push(
        `- [${b.id}] ${b.name} — ${b.description} (updated ${b.updatedAt.slice(0, 10)}, ~${b.tokenEstimate}t)`,
      );
    }
    inventoryLines.push("");
  }

  for (const [projectId, info] of projectBlocks) {
    inventoryLines.push(`**${info.name}:**\n`);
    for (const b of info.blocks) {
      inventoryLines.push(
        `- [${b.id}] ${b.name} — ${b.description} (updated ${b.updatedAt.slice(0, 10)}, ~${b.tokenEstimate}t)`,
      );
    }
    inventoryLines.push("");
  }

  // 5. Compute budget
  const allActiveBlocks = [
    ...globalBlocks,
    ...[...projectBlocks.values()].flatMap((p) => p.blocks),
  ];
  const totalBlocks = allActiveBlocks.length;
  const totalChars = allActiveBlocks.reduce((sum, b) => sum + b.content.length, 0);
  const BLOCK_LIMIT = 15;
  const maxBlockChars = await getMaxBlockChars();
  const CHAR_LIMIT = BLOCK_LIMIT * maxBlockChars;
  const BLOCK_WARN = BLOCK_LIMIT * 0.7;
  const CHAR_WARN = CHAR_LIMIT * 0.7;

  let budgetLine = `Active: ${totalBlocks}/${BLOCK_LIMIT} blocks | ${totalChars.toLocaleString()}/${CHAR_LIMIT.toLocaleString()} chars`;
  if (totalBlocks > BLOCK_WARN || totalChars > CHAR_WARN) {
    budgetLine += `\n⚠ **Budget alert:** Approaching block or character limit. Review and archive old or redundant content.`;
  }

  return [
    `## Phase 2: Memory Block Maintenance`,
    ``,
    `Your synthesis is complete. Now review and maintain your memory blocks.`,
    ``,
    `### Block Inventory`,
    ...inventoryLines,
    budgetLine,
    ``,
    phase2Instructions,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Build a phase trigger for phases 2-4.
// Phase 1 is built separately (it includes the context package).
// ---------------------------------------------------------------------------

async function buildPhaseTrigger(
  phaseIndex: number,
  chatId: string,
  phasePrompts: Record<SynthesisPhase, string> = PHASE_INSTRUCTIONS,
): Promise<string> {
  switch (phaseIndex) {
    case 1: // maintenance
      return buildMaintenancePhase2Trigger(chatId, phasePrompts.maintenance);
    case 2: // zeitgeist
      return buildZeitgeistPhase3Trigger(phasePrompts.zeitgeist);
    case 3: // reflections
      return phasePrompts.reflections;
    default:
      throw new Error(`Unknown phase index: ${phaseIndex}`);
  }
}

// Measure the current zeitgeist and append an archive directive only when
// the block is actually over threshold. Threshold is 80% of the configured
// maxBlockChars setting, so it scales with the user's limit and triggers
// archival proactively before hitting the hard cap.
async function buildZeitgeistPhase3Trigger(
  phase3Instructions = SYNTHESIS_PHASE3_INSTRUCTIONS,
): Promise<string> {
  const { getZeitgeistContent } = await import("./zeitgeist.js");
  const { getMaxBlockChars } = await import("./memory-storage.js");

  const content = getZeitgeistContent() ?? "";
  const charCount = content.length;
  const maxBlockChars = await getMaxBlockChars();
  const threshold = Math.floor(maxBlockChars * 0.8);
  const statusLine = `Current zeitgeist: ${charCount.toLocaleString()} characters (threshold: ${threshold.toLocaleString()}).`;

  if (charCount > threshold) {
    return [phase3Instructions, statusLine, zeitgeistArchiveDirective(threshold)].join("\n\n");
  }
  return [phase3Instructions, statusLine].join("\n\n");
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

// System chat always tracks the user's current default model: if the default
// changes, the next synthesis picks it up. The stored chat.modelId is kept in
// sync by runSystemSynthesis (it writes the resolved id back after each run)
// and is only used as a fallback here when no default is configured or the
// default isn't currently available.
async function getSynthesisModelId(storedModelId?: string): Promise<string | null> {
  const { discoverAllModels } = await import("./models.js");
  const models = await discoverAllModels();

  try {
    const { getSettings } = await import("./chat-storage.js");
    const settings = await getSettings();
    if (settings.defaultModelId) {
      const found = models.find((m) => m.id === settings.defaultModelId);
      if (found) return found.id;
      console.warn(
        `[synthesis] Default model "${settings.defaultModelId}" not available, falling back`,
      );
    }
  } catch {
    console.warn("[synthesis] Could not load settings, falling back to model discovery");
  }

  if (storedModelId) {
    const found = models.find((m) => m.id === storedModelId);
    if (found) return found.id;
  }

  if (models.length === 0) {
    console.error("[synthesis] No models available for synthesis");
    return null;
  }
  console.log(`[synthesis] Using fallback model: ${models[0].id}`);
  return models[0].id;
}

// ---------------------------------------------------------------------------
// Run synthesis
// ---------------------------------------------------------------------------

function makeErrorResult(message: string): SynthesisResult {
  return {
    summary: `# Daily Synthesis\n\n*Synthesis failed: ${message}*`,
    thinking: "",
    toolCalls: [],
    artifacts: [],
    visuals: [],
    generatedImages: [],
    memoryUpdates: [],
    success: false,
    error: message,
  };
}

async function refreshSystemChatTitle(
  chat: Chat,
  cycleKind: "synthesis" | "wake",
  assistantContent: string,
  saveChat: (chat: Chat) => Promise<void>,
  emitTitleUpdate: (title: string) => void,
): Promise<void> {
  if (!assistantContent.trim()) return;

  try {
    const { generateSystemCycleTitle } = await import("./title-generation.js");
    const title = await generateSystemCycleTitle(cycleKind, assistantContent);
    if (!title || title === chat.title) return;

    chat.title = title;
    await saveChat(chat);
    emitTitleUpdate(title);
  } catch (e: any) {
    console.warn(`[title] system ${cycleKind} title update failed:`, e?.message || e);
  }
}

export async function runSystemSynthesis(options?: {
  modelId?: string;
  skipArchive?: boolean;
  promptSteps?: AutomationPromptStep[];
  automationTaskId?: string;
  automationRunId?: string;
}): Promise<SynthesisResult> {
  const { preSynthesisArchive } = await import("./pre-synthesis-archive.js");
  const { getChat, saveChat } = await import("./chat-storage.js");
  // Notebook persistence is now the agent's responsibility via
  // create_notebook_entry; no server-side auto-save here.
  const { createPiModelFromProvider, discoverAllModels } = await import("./models.js");
  const { getAgentTools } = await import("./agent-tools.js");
  const { setLastSynthesis } = await import("./memory-storage.js");
  const { truncateBeforeSend } = await import("./compaction.js");
  const { SynthesisEmitter, createEmitterSideEffects } = await import("./synthesis-stream.js");

  await acquireSynthesisLock();
  console.log("[system-chat] Starting synthesis...");

  // Headless SSE stream for the system chat — clients that open the system
  // chat reconnect via /api/chat/reconnect/:chatId and watch synthesis stream
  // in real time. Created up-front so any error path can still call .end().
  const emitter = new SynthesisEmitter(SYSTEM_CHAT_ID);

  try {
    // Ensure system chat row exists (first-run safety)
    await createSystemChat();

    // --- Pre-synthesis archiving ---
    let archivedCount = 0;
    let archivedChatIds: string[] = [];
    if (!options?.skipArchive) {
      const res = await preSynthesisArchive(10);
      archivedCount = res.archivedCount;
      archivedChatIds = res.chatIds;
      if (archivedCount > 0) {
        console.log(`[system-chat] Archived ${archivedCount} chats for synthesis`);
      }
    }

    // --- Load persistent system chat ---
    const chat = await getChat(SYSTEM_CHAT_ID);
    if (!chat) {
      emitter.emitError("System chat not found after creation");
      emitter.end();
      releaseSynthesisLock();
      return makeErrorResult("System chat not found after creation");
    }

    // --- Resolve model ---
    const modelId = options?.modelId || (await getSynthesisModelId(chat.modelId));
    if (!modelId) {
      emitter.emitError("No model available for synthesis");
      emitter.end();
      releaseSynthesisLock();
      return makeErrorResult("No model available for synthesis");
    }
    const models = await discoverAllModels();
    const piModel = models.find((m) => m.id === modelId);
    if (!piModel) {
      emitter.emitError(`Model "${modelId}" not available`);
      emitter.end();
      releaseSynthesisLock();
      return makeErrorResult(`Model "${modelId}" not available`);
    }
    const contextWindow = piModel.contextWindow || 32768;
    const runtimeModel = await createPiModelFromProvider(piModel);
    runtimeModel.contextWindow = contextWindow;
    const phasePrompts = promptMapFromSteps(options?.promptSteps);

    // --- Append Phase 1 trigger to persistent history ---
    const phase1Content = await buildSynthesisTriggerContent(archivedChatIds, {
      archivedCount,
      newlyArchivedIds: archivedChatIds,
    }, phasePrompts.synthesis);
    const phase1Msg: ChatMessage = {
      role: "user",
      content: phase1Content,
      timestamp: Date.now(),
      _isSystemMessage: true,
      _isSynthesisMessage: true,
      _isAutomationMessage: true,
      ...(options?.automationTaskId ? { _automationTaskId: options.automationTaskId } : {}),
      ...(options?.automationRunId ? { _automationRunId: options.automationRunId } : {}),
    };
    chat.messages.push(phase1Msg);
    // Keep modelId in sync so user-initiated messages also hit this model.
    if (chat.modelId !== modelId) chat.modelId = modelId;
    await saveChat(chat);

    // Compose the synthesis prompt from the stable prefix only. Phase
    // instructions live in user-role tail messages so editing automation text
    // does not invalidate the system chat's longest-common-prefix cache.
    const { buildStablePrefix, invalidateAllStablePrefixCaches } = await import("./memory-context.js");
    const { stablePrefix } = await buildStablePrefix(
      chat.systemPrompt || "You are a helpful assistant.",
      SYSTEM_CHAT_ID,
    );
    const synthesisPrompt = stablePrefix;

    // Build tools up front so the pre-send compaction estimator can account
    // for tool-schema tokens — otherwise the schema (5–10K tokens for the
    // full agent tool set) slips past the char-based threshold and leaves
    // the model stuck prefilling a near-full context on reload.
    const artifacts: any[] = [];
    const visuals: any[] = [];
    const generatedImages: any[] = [];

    const effects: ToolSideEffects = createEmitterSideEffects(emitter, {
      artifacts,
      visuals,
      generatedImages,
    });

    const tools = getAgentTools(SYSTEM_CHAT_ID, effects, contextWindow, undefined, "system")
      .filter((tool) => tool.name !== "ask_user");

    // --- Pre-send compaction keeps history bounded ---
    const compactionResult = await truncateBeforeSend(
      chat,
      contextWindow,
      synthesisPrompt,
      undefined,
      undefined,
      tools,
    );
    if (compactionResult?.truncated) {
      console.log(
        `[system-chat] Pre-compaction removed ${compactionResult.removedCount} messages`,
      );
      await saveChat(chat);
    }

    // -------------------------------------------------------------------
    // Per-phase execution — each phase runs as its own headless turn with
    // skipMessagePersistence so the same emitter accumulates all phases.
    // A single combined assistant message is built and persisted after all
    // phases complete, avoiding duplicated segments in chat history.
    // -------------------------------------------------------------------
    const MAX_ITERATIONS_PER_PHASE = 12;
    const allToolCalls: ToolCall[] = [];
    let allThinking = '';
    let allText = '';
    const allMemoryUpdates: string[] = [];
    let finalAssistantMsg: ChatMessage | null = null;
    let finalStopReason = 'stop';
    let totalIterations = 0;
    let phaseFailed = false;
    let phaseError = '';

    for (let phase = 0; phase < PHASE_ORDER.length; phase++) {
      // Phase 0 trigger is already in chat.messages (appended above).
      // For phases 1-3, append the trigger before starting the turn.
      if (phase > 0) {
        const triggerContent = await buildPhaseTrigger(phase, SYSTEM_CHAT_ID, phasePrompts);
        const triggerMsg: ChatMessage = {
          role: 'user',
          content: triggerContent,
          timestamp: Date.now(),
          _isSystemMessage: true,
          _isSynthesisMessage: true,
          _isAutomationMessage: true,
          ...(options?.automationTaskId ? { _automationTaskId: options.automationTaskId } : {}),
          ...(options?.automationRunId ? { _automationRunId: options.automationRunId } : {}),
        };
        chat.messages.push(triggerMsg);
        await saveChat(chat);
      }

      // Re-compact before each phase so context stays bounded.
      const preCompact = await truncateBeforeSend(
        chat, contextWindow, synthesisPrompt, undefined, undefined, tools,
      );
      if (preCompact?.truncated) {
        console.log(
          `[system-chat] Phase ${PHASE_ORDER[phase]} pre-compaction removed ${preCompact.removedCount} messages`,
        );
        await saveChat(chat);
      }

      const turn = await runHeadlessChatTurn({
        chat,
        modelId,
        model: runtimeModel,
        systemPrompt: synthesisPrompt,
        tools,
        emitter,
        maxIterations: MAX_ITERATIONS_PER_PHASE,
        timeoutMs: 30 * 60 * 1000,
        keepAlive: '90m',
        logPrefix: `system-chat:synthesis:${PHASE_ORDER[phase]}`,
        saveChat,
        skipMessagePersistence: true,
        summarize: (state) =>
          state.textSummary ||
          `*Phase ${PHASE_ORDER[phase]} produced no visible output.*`,
        decorateAssistantMessage: (message) => ({
          ...message,
          timestamp: Date.now(),
          _isSynthesisMessage: true,
          _isAutomationMessage: true,
          ...(options?.automationTaskId ? { _automationTaskId: options.automationTaskId } : {}),
          ...(options?.automationRunId ? { _automationRunId: options.automationRunId } : {}),
        }),
      });

      totalIterations += turn.iterations;
      finalStopReason = turn.stopReason;
      allToolCalls.push(...turn.toolCalls);
      if (turn.thinking) allThinking += (allThinking ? '\n' : '') + turn.thinking;
      if (turn.textSummary) allText += (allText ? '\n\n' : '') + turn.textSummary;
      allMemoryUpdates.push(...turn.memoryUpdates);
      finalAssistantMsg = turn.assistantMessage;

      // Guard: Phase 0 produced nothing on its first iteration — bail early
      // instead of advancing to maintenance. Mirrors the old getFollowUp guard.
      if (phase === 0 && turn.iterations === 1 && !turn.textSummary && turn.toolCalls.length === 0) {
        console.log(`[system-chat] Phase 0 produced nothing on first iteration, stopping early`);
        break;
      }

      if (!turn.success) {
        phaseFailed = true;
        phaseError = turn.error || `Phase ${PHASE_ORDER[phase]} returned no output`;
        console.warn(`[system-chat] Phase ${PHASE_ORDER[phase]} failed: ${phaseError}`);
        break;
      }
    }

    const iterations = totalIterations;
    const stopReason = finalStopReason;
    const textSummary = allText;
    const thinking = allThinking;
    const memoryUpdates = allMemoryUpdates;
    const textLen = textSummary.length;
    const thinkLen = thinking.length;

    console.log(
      `[system-chat] Synthesis done: iters=${iterations}, tools=${allToolCalls.length}, text=${textLen}ch, thinking=${thinkLen}ch, stopReason=${stopReason}`,
    );

    // No-text outcomes used to fall back to promoting thinking into the
    // message content, which masked the real failure — you'd see a thinking
    // trace in the notebook entry and assume synthesis worked. Now we keep
    // thinking as thinking and surface an explicit placeholder + warning so
    // the no-output case is diagnosable.
    if (textLen === 0) {
      console.warn(
        `[system-chat] Synthesis produced no text content. thinking=${thinkLen}ch, stopReason=${stopReason}, tools=${allToolCalls.length}. ` +
        `If stopReason='length' the model exhausted maxTokens mid-output; if 'stop' with zero tools the chat template may not be transitioning from reasoning to content.`,
      );
    }

    const summary = allText || `# Daily Synthesis\n\n*The model produced no visible output this cycle (stopReason=${stopReason}, thinking=${thinkLen}ch, tools=${allToolCalls.length}).*`;

    // Build a single combined assistant message from the emitter's accumulated
    // state. All phases streamed into the same emitter, so segments, toolCalls,
    // etc. reflect the complete synthesis run — no duplication.
    const combinedMsg = emitter.buildAssistantMessage(thinking, textSummary);
    if (finalAssistantMsg) {
      combinedMsg._api = finalAssistantMsg._api;
      combinedMsg._provider = finalAssistantMsg._provider;
      combinedMsg._model = finalAssistantMsg._model;
    }
    combinedMsg.timestamp = Date.now();
    combinedMsg._isSynthesisMessage = true;
    combinedMsg._isAutomationMessage = true;
    if (options?.automationTaskId) {
      combinedMsg._automationTaskId = options.automationTaskId;
    }
    if (options?.automationRunId) {
      combinedMsg._automationRunId = options.automationRunId;
    }
    chat.messages.push(combinedMsg);
    await saveChat(chat);
    const assistantMessageIdx = chat.messages.length - 1;

    // Emit done once for the combined message so clients can close their streams.
    emitter.emitDone(combinedMsg, iterations);
    const assistantChatMsg = combinedMsg;

    await refreshSystemChatTitle(
      chat,
      "synthesis",
      assistantChatMsg.content,
      saveChat,
      (title) => emitter.emitTitleUpdate(title),
    );

    // Notebook persistence is now the agent's responsibility via the
    // `create_notebook_entry` tool. The old implicit auto-save of the
    // assistant's narrative text hid wrong behavior — if the agent didn't
    // produce prose (e.g., went straight to tool calls), we'd still write
    // an empty/placeholder entry. Explicit tool use is the contract; the
    // Phase 1 prompt tells the agent to call create_notebook_entry.
    const notebookCalls = allToolCalls.filter((tc) => tc.name === "create_notebook_entry").length;
    if (textLen > 0 && notebookCalls === 0) {
      console.warn(
        `[system-chat] Synthesis produced ${textLen}ch of text but agent did not call create_notebook_entry. ` +
        `The text is preserved on the assistant message but was not persisted as a notebook entry.`,
      );
    } else if (notebookCalls > 0) {
      console.log(`[system-chat] Agent persisted ${notebookCalls} notebook entry/entries via create_notebook_entry`);
    }

    // --- Detect "ran but produced nothing" failure (e.g., upstream LLM error) ---
    // The headless runner is the authoritative source for this classification.
    // If it failed before producing text, thinking, or tools, do not burn the
    // 24h synthesis slot; let the scheduler retry on a later tick.
    if (phaseFailed) {
      console.warn(
        `[system-chat] Synthesis failed (${phaseError}) - NOT updating lastSynthesis so the next scheduler tick can retry.`,
      );
      emitter.emitError(`Synthesis failed: ${phaseError}`);
      emitter.end();
      releaseSynthesisLock();
      return makeErrorResult(phaseError);
    }

    // --- Invalidate stable prefix caches so next chats pick up block changes ---
    try {
      invalidateAllStablePrefixCaches();
    } catch (e: any) {
      console.warn("[system-chat] Failed to invalidate stable prefix caches:", e.message);
    }

    // --- Gate future scheduler ticks ---
    await setLastSynthesis(new Date().toISOString());

    console.log(
      `[system-chat] Synthesis complete: ${iterations} iterations, ${allToolCalls.length} tool calls, stopReason=${stopReason}`,
    );

    emitter.end();
    releaseSynthesisLock();

    return {
      summary,
      thinking,
      toolCalls: allToolCalls,
      artifacts,
      visuals,
      generatedImages,
      memoryUpdates,
      success: true,
    };
  } catch (e: any) {
    console.error("[system-chat] Synthesis failed:", e);
    emitter.emitError(e.message || "Synthesis failed");
    emitter.end();
    releaseSynthesisLock();
    return makeErrorResult(e.message);
  }
}

/**
 * Run a wake cycle — autonomous exploration during the sleep cycle.
 * Simpler than synthesis: single-phase, no archiving, no maintenance.
 */
export async function runWakeCycle(options?: {
  modelId?: string;
  promptSteps?: AutomationPromptStep[];
  automationTaskId?: string;
  automationRunId?: string;
}): Promise<SynthesisResult> {
  const { getChat, saveChat } = await import("./chat-storage.js");
  const { createPiModelFromProvider, discoverAllModels } = await import("./models.js");
  const { getAgentTools } = await import("./agent-tools.js");
  const { setLastWakeCycleAt } = await import("./memory-storage.js");
  const { truncateBeforeSend } = await import("./compaction.js");
  const { SynthesisEmitter, createEmitterSideEffects } = await import("./synthesis-stream.js");

  await acquireWakeCycleLock();
  console.log("[system-chat] Starting wake cycle...");

  // Headless SSE stream so the system chat UI sees wake cycle output stream
  // in real time (same plumbing as runSystemSynthesis).
  const emitter = new SynthesisEmitter(SYSTEM_CHAT_ID);

  try {
    // Ensure system chat exists
    await createSystemChat();

    // Load persistent system chat
    const chat = await getChat(SYSTEM_CHAT_ID);
    if (!chat) {
      emitter.emitError("System chat not found");
      emitter.end();
      releaseWakeCycleLock();
      return makeErrorResult("System chat not found");
    }

    // Resolve model
    const modelId = options?.modelId || (await getSynthesisModelId(chat.modelId));
    if (!modelId) {
      emitter.emitError("No model available for wake cycle");
      emitter.end();
      releaseWakeCycleLock();
      return makeErrorResult("No model available for wake cycle");
    }
    const models = await discoverAllModels();
    const piModel = models.find((m) => m.id === modelId);
    if (!piModel) {
      emitter.emitError(`Model "${modelId}" not available`);
      emitter.end();
      releaseWakeCycleLock();
      return makeErrorResult(`Model "${modelId}" not available`);
    }
    const contextWindow = piModel.contextWindow || 32768;
    const runtimeModel = await createPiModelFromProvider(piModel);
    runtimeModel.contextWindow = contextWindow;

    // Append wake cycle trigger
    const stamp = new Date().toLocaleString("en-US", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
    const triggerContent = `# Wake Cycle — ${stamp}\n\n${wakePromptFromSteps(options?.promptSteps)}`;
    const triggerMsg: ChatMessage = {
      role: "user",
      content: triggerContent,
      timestamp: Date.now(),
      _isSystemMessage: true,
      _isAutomationMessage: true,
      ...(options?.automationTaskId ? { _automationTaskId: options.automationTaskId } : {}),
      ...(options?.automationRunId ? { _automationRunId: options.automationRunId } : {}),
    };
    chat.messages.push(triggerMsg);
    if (chat.modelId !== modelId) chat.modelId = modelId;
    await saveChat(chat);

    // Build prompt — same stable prefix as regular chats + wake trigger
    const { buildStablePrefix } = await import("./memory-context.js");
    const { stablePrefix } = await buildStablePrefix(
      chat.systemPrompt || "You are a helpful assistant.",
      SYSTEM_CHAT_ID,
    );
    const wakePrompt = stablePrefix; // No addendum needed — the trigger message is self-contained

    // Build tools
    const artifacts: any[] = [];
    const visuals: any[] = [];
    const generatedImages: any[] = [];

    const effects: ToolSideEffects = createEmitterSideEffects(emitter, {
      artifacts,
      visuals,
      generatedImages,
    });
    const tools = getAgentTools(SYSTEM_CHAT_ID, effects, contextWindow, undefined, "system")
      .filter((tool) => tool.name !== "ask_user");

    // Pre-send compaction
    const compactionResult = await truncateBeforeSend(
      chat, contextWindow, wakePrompt, undefined, undefined, tools,
    );
    if (compactionResult?.truncated) {
      console.log(`[system-chat] Pre-compaction removed ${compactionResult.removedCount} messages`);
      await saveChat(chat);
    }

    const MAX_ITERATIONS = 20; // Generous — no hard resource limits, just iteration cap
    const turn = await runHeadlessChatTurn({
      chat,
      modelId,
      model: runtimeModel,
      systemPrompt: wakePrompt,
      tools,
      emitter,
      maxIterations: MAX_ITERATIONS,
      timeoutMs: 1_800_000,
      keepAlive: "30m",
      logPrefix: "system-chat:wake",
      saveChat,
      summarize: (state) => state.textSummary || "*The wake cycle ended without visible output.*",
      decorateAssistantMessage: (message) => ({
        ...message,
        timestamp: Date.now(),
        _isAutomationMessage: true,
        ...(options?.automationTaskId ? { _automationTaskId: options.automationTaskId } : {}),
        ...(options?.automationRunId ? { _automationRunId: options.automationRunId } : {}),
      }),
    });

    const iterations = turn.iterations;
    const stopReason = turn.stopReason;
    const textSummary = turn.textSummary;
    const thinking = turn.thinking;
    const allToolCalls = turn.toolCalls;
    const memoryUpdates = turn.memoryUpdates;
    const assistantChatMsg = turn.assistantMessage;

    console.log(
      `[system-chat] Wake cycle done: iters=${iterations}, tools=${allToolCalls.length}, text=${textSummary.length}ch, stopReason=${stopReason}`,
    );

    if (!turn.success) {
      const errorMessage = turn.error || `wake cycle produced no visible output (stopReason=${stopReason})`;
      console.warn(
        `[system-chat] Wake cycle failed at iter ${iterations} (${errorMessage}) - NOT updating lastWakeCycleAt so the next scheduler tick can retry.`,
      );
      emitter.emitError(`Wake cycle failed: ${errorMessage}`);
      emitter.end();
      releaseWakeCycleLock();
      return {
        summary: `# Wake Cycle\n\n*Wake cycle failed: ${errorMessage}*`,
        thinking,
        toolCalls: allToolCalls,
        artifacts,
        visuals,
        generatedImages,
        memoryUpdates,
        success: false,
        error: errorMessage,
      };
    }

    await refreshSystemChatTitle(
      chat,
      "wake",
      assistantChatMsg.content,
      saveChat,
      (title) => emitter.emitTitleUpdate(title),
    );

    // Invalidate caches and gate future ticks
    try {
      const { invalidateAllStablePrefixCaches } = await import("./memory-context.js");
      invalidateAllStablePrefixCaches();
    } catch (e: any) {
      console.warn("[system-chat] Failed to invalidate stable prefix caches:", e.message);
    }

    await setLastWakeCycleAt(new Date().toISOString());

    emitter.end();
    releaseWakeCycleLock();

    return {
      summary: turn.summary,
      thinking,
      toolCalls: allToolCalls,
      artifacts,
      visuals,
      generatedImages,
      memoryUpdates,
      success: true,
    };
  } catch (e: any) {
    console.error("[system-chat] Wake cycle failed:", e);
    emitter.emitError(e.message || "Wake cycle failed");
    emitter.end();
    releaseWakeCycleLock();
    return makeErrorResult(e.message);
  }
}

/**
 * Check if synthesis should run (based on time since last synthesis).
 */
export async function shouldRunSystemSynthesis(): Promise<boolean> {
  const { loadMemoryStore, getLastSynthesis } = await import("./memory-storage.js");
  const store = await loadMemoryStore();
  if (store.memories.length === 0) return false;
  const last = await getLastSynthesis();
  if (!last) return true;
  const elapsed = Date.now() - new Date(last).getTime();
  return elapsed >= 24 * 60 * 60 * 1000;
}
