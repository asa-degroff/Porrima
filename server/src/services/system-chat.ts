import type { ToolSideEffects } from "./agent-tools.js";
import type { Message, StopReason, ToolCall } from "@mariozechner/pi-ai";
import type { ChatMessage } from "../types.js";

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
  notebookEntryId?: string;
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
// System chat creation
// ---------------------------------------------------------------------------

const SYSTEM_CHAT_ID = "system";
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

Write a daily synthesis — a narrative summary in your own voice of shared work, patterns, and themes. Save it as a notebook entry.

## Output Requirements

- Write naturally in first person for your own actions, third person for the user
- Be concrete and specific — reference actual projects, decisions, topics
- 3-5 paragraphs for the daily synthesis
- Skip steps when nothing insightful emerges — silence is valid

## Continuity

Reference earlier entries in this chat as notes from a past self. Consider whether a new cycle confirms, revises, or supersedes earlier observations.

---

Write your synthesis. This will be saved as a notebook entry.`;

const SYNTHESIS_PHASE2_INSTRUCTIONS = `## Phase 2: Memory Block Maintenance

Your synthesis is complete. Now review and maintain your memory blocks below.

### Actions
- **Archive** stale blocks (not updated in 2+ weeks, superseded by newer content): \`update_memory_block(id, scope="archived", description="Archived: ...")\`
- **Update** blocks with new insights from your synthesis: \`update_memory_block(id, content=new, description=new)\`
- **Create** new blocks for topics discovered during synthesis: \`create_memory_block(name, description, content, scope=...)\`
- **Consolidate** overlapping blocks — merge redundant content into one
- **Read** full block content before acting: \`read_memory_block(id)\`

Archived blocks stay searchable but are excluded from context loading. The budget warning above is your signal — act when approaching limits.

After completing maintenance, wait for the next phase trigger.`;

const ZEITGEIST_ARCHIVE_THRESHOLD = 3500;

const SYNTHESIS_PHASE3_INSTRUCTIONS = `## Phase 3: Zeitgeist Update

Block maintenance complete. Your current continuity narrative (zeitgeist) is in your context. Review it — update it via \`update_memory_block(block_id="blk-zeitgeist-continuity", content=...)\` if there are new patterns, threads, or shifts since the last cycle.

After updating the zeitgeist, wait for the next phase trigger.`;

// Appended to the Phase 3 trigger when the current zeitgeist is already over
// the archival threshold — turns a guess-based hint into a concrete directive.
const ZEITGEIST_ARCHIVE_DIRECTIVE = `**Archive first.** The current zeitgeist is over ${ZEITGEIST_ARCHIVE_THRESHOLD} characters. Before rewriting it, snapshot the existing content into a new block named \`Zeitgeist Archive - YYYY-MM-DD\` (use \`create_memory_block\` with \`scope="archived"\`), then replace \`blk-zeitgeist-continuity\` content with a trimmed, current-tense narrative.`;

const SYNTHESIS_PHASE4_INSTRUCTIONS = `## Phase 4: Reflections

Your synthesis, block maintenance, and zeitgeist update are complete. Now generate reflection memories — higher-order insights about what you observed. Focus on meta-observations: patterns, contradictions, openings, shifts in understanding.

Use \`save_memory(category="reflection", importance=7-9)\`. Write 1-5 reflections. Skip if nothing meaningful emerges.`;

type SynthesisPhase = "synthesis" | "maintenance" | "zeitgeist" | "reflections";

const PHASE_ORDER: SynthesisPhase[] = ["synthesis", "maintenance", "zeitgeist", "reflections"];
const PHASE_INSTRUCTIONS: Record<SynthesisPhase, string> = {
  synthesis: SYNTHESIS_PHASE1_INSTRUCTIONS,
  maintenance: SYNTHESIS_PHASE2_INSTRUCTIONS,
  zeitgeist: SYNTHESIS_PHASE3_INSTRUCTIONS,
  reflections: SYNTHESIS_PHASE4_INSTRUCTIONS,
};

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
  // Importance-based anchors were a bad cut: importance is a noisy scale and
  // top-N skews to the same saturated 10/10 entries every cycle (many of
  // which are stale). What actually wants review is what's been written
  // *since* the last cycle — that's the delta the agent should integrate.
  // The agent can always reach for older memories via `search_memory`.
  const memoryStore = await loadMemoryStore();
  if (memoryStore.memories.length > 0) {
    const lastSynthesisMs = memoryStore.lastSynthesis
      ? new Date(memoryStore.lastSynthesis).getTime()
      : 0;
    // Fresh install / first run: fall back to a 24h window so we have
    // *something* to review instead of dumping the entire store.
    const cutoffMs = lastSynthesisMs || Date.now() - 24 * 60 * 60 * 1000;

    const newMemories = memoryStore.memories
      .filter((m) => new Date(m.createdAt).getTime() > cutoffMs)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Cap at 50 so a burst doesn't swamp the trigger. Ordered chronologically
    // so the agent reads the delta in the order it happened.
    const CAP = 50;
    const shown = newMemories.slice(0, CAP);

    if (shown.length > 0) {
      const header = memoryStore.lastSynthesis
        ? `${shown.length} memor${shown.length === 1 ? "y" : "ies"} written since last synthesis${newMemories.length > CAP ? ` (showing first ${CAP} of ${newMemories.length})` : ""}:`
        : `${shown.length} memor${shown.length === 1 ? "y" : "ies"} from the last 24 hours (no prior synthesis):`;
      parts.push(
        [
          `## New Memories`,
          header,
          shown.map((m) => `- [${m.category}] ${m.text}`).join("\n"),
        ].join("\n\n"),
      );
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

  parts.push(SYNTHESIS_PHASE1_INSTRUCTIONS);

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

async function buildMaintenancePhase2Trigger(chatId: string): Promise<string> {
  const { getDb } = await import("./chat-storage.js");
  const { getMemoryBlocksByScope, getAllMemoryBlocks, getLastSynthesis } = await import("./memory-storage.js");

  // System-managed blocks are excluded from the inventory — they have
  // dedicated discovery paths and would otherwise bloat the context.
  const isSystemBlock = (b: { id: string; scope: string }) =>
    b.id === "blk-zeitgeist-continuity" ||
    b.id.startsWith("blk-archive-") ||
    b.scope === "archived" ||
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
  const CHAR_LIMIT = 50000;
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
    SYNTHESIS_PHASE2_INSTRUCTIONS,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Build a phase trigger for phases 2-4.
// Phase 1 is built separately (it includes the context package).
// ---------------------------------------------------------------------------

async function buildPhaseTrigger(phaseIndex: number, chatId: string): Promise<string> {
  switch (phaseIndex) {
    case 1: // maintenance
      return buildMaintenancePhase2Trigger(chatId);
    case 2: // zeitgeist
      return buildZeitgeistPhase3Trigger();
    case 3: // reflections
      return SYNTHESIS_PHASE4_INSTRUCTIONS;
    default:
      throw new Error(`Unknown phase index: ${phaseIndex}`);
  }
}

// Measure the current zeitgeist and append an archive directive only when
// the block is actually over threshold. Avoids making the agent guess.
async function buildZeitgeistPhase3Trigger(): Promise<string> {
  const { getZeitgeistContent } = await import("./zeitgeist.js");
  const content = getZeitgeistContent() ?? "";
  const charCount = content.length;
  const statusLine = `Current zeitgeist: ${charCount.toLocaleString()} characters.`;

  if (charCount > ZEITGEIST_ARCHIVE_THRESHOLD) {
    return [SYNTHESIS_PHASE3_INSTRUCTIONS, statusLine, ZEITGEIST_ARCHIVE_DIRECTIVE].join("\n\n");
  }
  return [SYNTHESIS_PHASE3_INSTRUCTIONS, statusLine].join("\n\n");
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

export async function runSystemSynthesis(options?: {
  modelId?: string;
  skipArchive?: boolean;
}): Promise<SynthesisResult> {
  const { preSynthesisArchive } = await import("./pre-synthesis-archive.js");
  const { getChat, saveChat } = await import("./chat-storage.js");
  const { createNotebookEntry, updateNotebookEntry } = await import("./notebook-storage.js");
  const { discoverAllModels } = await import("./models.js");
  const { streamChat, chatMessagesToPiMessages } = await import("./agent.js");
  const { getAgentTools } = await import("./agent-tools.js");
  const { setLastSynthesis } = await import("./memory-storage.js");
  const { truncateBeforeSend } = await import("./compaction.js");

  await acquireSynthesisLock();
  console.log("[system-chat] Starting synthesis...");

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
      releaseSynthesisLock();
      return makeErrorResult("System chat not found after creation");
    }

    // --- Resolve model ---
    const modelId = options?.modelId || (await getSynthesisModelId(chat.modelId));
    if (!modelId) {
      releaseSynthesisLock();
      return makeErrorResult("No model available for synthesis");
    }
    const models = await discoverAllModels();
    const piModel = models.find((m) => m.id === modelId);
    if (!piModel) {
      releaseSynthesisLock();
      return makeErrorResult(`Model "${modelId}" not available`);
    }
    const contextWindow = piModel.contextWindow || 32768;

    // --- Append Phase 1 trigger to persistent history ---
    const phase1Content = await buildSynthesisTriggerContent(archivedChatIds, {
      archivedCount,
      newlyArchivedIds: archivedChatIds,
    });
    const phase1Msg: ChatMessage = {
      role: "user",
      content: phase1Content,
      timestamp: Date.now(),
      _isSystemMessage: true,
    };
    chat.messages.push(phase1Msg);
    // Keep modelId in sync so user-initiated messages also hit this model.
    if (chat.modelId !== modelId) chat.modelId = modelId;
    await saveChat(chat);

    // Compose the full synthesis-mode prompt. Uses the same stable prefix
    // as regular agent chats (chat.systemPrompt + persona + user doc +
    // memory blocks + zeitgeist), then appends the synthesis instructions
    // addendum. This keeps voice/identity consistent with every other
    // surface and is byte-identical across cycles for KV caching.
    const { buildStablePrefix, invalidateAllStablePrefixCaches } = await import("./memory-context.js");
    const { stablePrefix } = await buildStablePrefix(
      chat.systemPrompt || "You are a helpful assistant.",
      SYSTEM_CHAT_ID,
    );
    const synthesisPrompt = `${stablePrefix}\n\n${SYNTHESIS_INSTRUCTIONS}`;

    // --- Pre-send compaction keeps history bounded ---
    const compactionResult = await truncateBeforeSend(
      chat,
      contextWindow,
      synthesisPrompt,
    );
    if (compactionResult?.truncated) {
      console.log(
        `[system-chat] Pre-compaction removed ${compactionResult.removedCount} messages`,
      );
      await saveChat(chat);
    }

    // --- Convert persistent history to pi-ai format ---
    const piMessages = chatMessagesToPiMessages(chat.messages, modelId);

    // --- Tool loop ---
    const artifacts: any[] = [];
    const visuals: any[] = [];
    const generatedImages: any[] = [];
    const memoryUpdates: string[] = [];

    const effects: ToolSideEffects = {
      onArtifact: (a) => artifacts.push(a),
      onVisual: (v) => visuals.push(v),
      onGeneratedImage: (img) => generatedImages.push(img),
      onPendingReviewImage: () => {},
      onAskUser: () => {},
    };

    const tools = getAgentTools(SYSTEM_CHAT_ID, effects, contextWindow, undefined, "system");

    const MAX_ITERATIONS = 30;
    let iterations = 0;
    let phaseIndex = 0; // 0=synthesis (already injected), 1=maintenance, 2=zeitgeist, 3=reflections
    let idleCount = 0; // consecutive idle turns for phase transition detection
    const messages: Message[] = [...piMessages];

    const textChunks: string[] = [];
    const thinkingChunks: string[] = [];
    const allToolCalls: ToolCall[] = [];
    const allToolResults: {
      toolCallId: string;
      toolName: string;
      content: string;
      isError: boolean;
    }[] = [];
    let stopReason: StopReason = "stop";

    while (iterations < MAX_ITERATIONS) {
      const iterationToolCalls: ToolCall[] = [];
      let assistantMessage: Message | undefined;
      let streamResult: any;

      try {
        streamResult = await streamChat(
          modelId,
          messages,
          synthesisPrompt,
          (event) => {
            if (event.type === "toolcall_end") {
              iterationToolCalls.push(event.toolCall);
            }
          },
          {
            signal: AbortSignal.timeout(300_000),
            tools,
            keepAlive: "30m",
          },
        );

        if (streamResult.content) textChunks.push(streamResult.content);
        if (streamResult.thinking) thinkingChunks.push(streamResult.thinking);
        if (streamResult.toolCalls) allToolCalls.push(...streamResult.toolCalls);
        stopReason = streamResult.stopReason;
        assistantMessage = streamResult.assistantMessage;
      } catch (e: any) {
        console.error(`[system-chat] Stream failed at iter ${iterations}:`, e.message);
        stopReason = "error";
        break;
      }

      const hasOutput = (streamResult?.content?.length ?? 0) > 0;
      const hasToolCalls = iterationToolCalls.length > 0;

      // Phase 1 no-text = complete failure, nothing to transition from
      if (phaseIndex === 0 && !hasOutput && !hasToolCalls) {
        console.log("[system-chat] Phase 1 produced no output, ending synthesis");
        break;
      }

      // Absorb this turn's output into the pi-ai history BEFORE deciding on a
      // phase transition — otherwise the next phase trigger lands in front of
      // the assistant reply it was meant to follow.
      if (assistantMessage) messages.push(assistantMessage);

      for (const toolCall of iterationToolCalls) {
        const toolDef = tools.find((t) => t.name === toolCall.name);
        if (!toolDef) {
          console.warn(`[system-chat] Unknown tool: ${toolCall.name}`);
          continue;
        }
        try {
          const result = await toolDef.execute(toolCall.id, toolCall.arguments);
          const content = result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (content.toLowerCase().includes("memory saved")) {
            memoryUpdates.push(content.slice(0, 200));
          }
          allToolResults.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content,
            isError: false,
          });
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: content }],
            isError: false,
            timestamp: Date.now(),
          } as Message);
        } catch (e: any) {
          console.warn(`[system-chat] Tool execution failed for ${toolCall.name}:`, e.message);
          allToolResults.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: `Error: ${e.message}`,
            isError: true,
          });
          messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
            timestamp: Date.now(),
          } as Message);
        }
      }

      // Phase transition: agent produced output this turn + no tool calls = idle.
      // One idle turn is sufficient — the agent would naturally keep working if
      // it had more to do in this phase. Injecting the trigger lets the loop
      // carry the agent into the next phase on the following iteration.
      let transitioned = false;
      if (!hasToolCalls && phaseIndex < PHASE_ORDER.length - 1) {
        idleCount++;
        if (idleCount >= 1) {
          const nextTrigger = await buildPhaseTrigger(phaseIndex + 1, SYSTEM_CHAT_ID);
          const phaseTriggerMsg: ChatMessage = {
            role: "user",
            content: nextTrigger,
            timestamp: Date.now(),
            _isSystemMessage: true,
          };
          chat.messages.push(phaseTriggerMsg);
          messages.push({
            role: "user",
            content: [{ type: "text", text: nextTrigger }],
            timestamp: Date.now(),
          } as Message);
          phaseIndex++;
          idleCount = 0;
          transitioned = true;
          console.log(`[system-chat] Phase ${phaseIndex} trigger injected (${PHASE_ORDER[phaseIndex]})`);
        }
      } else if (hasToolCalls) {
        idleCount = 0;
      }

      // Loop exit: only when the agent is idle on the final phase. An idle turn
      // that produced a phase transition must continue so the agent sees the
      // new trigger; a non-final phase with no transition yet (e.g. still
      // accumulating idle counts) should also continue.
      if (!transitioned && !hasToolCalls && phaseIndex >= PHASE_ORDER.length - 1) {
        console.log(`[system-chat] All phases complete (${PHASE_ORDER[phaseIndex]} finished)`);
        break;
      }

      iterations++;
    }

    if (iterations >= MAX_ITERATIONS) {
      console.warn(
        `[system-chat] Synthesis hit iteration cap (${MAX_ITERATIONS}) with stopReason=${stopReason}`,
      );
    }

    const textSummary = textChunks.join("\n\n").trim();
    const thinking = thinkingChunks.join("\n\n");
    const textLen = textSummary.length;
    const thinkLen = thinking.length;

    console.log(
      `[system-chat] Tool loop done: iters=${iterations}, tools=${allToolCalls.length}, text=${textLen}ch, thinking=${thinkLen}ch, stopReason=${stopReason}`,
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

    const summary =
      textSummary ||
      `# Daily Synthesis\n\n*The model produced no visible output this cycle (stopReason=${stopReason}, thinking=${thinkLen}ch, tools=${allToolCalls.length}). The thinking trace is preserved on the system chat's last assistant message.*`;

    // --- Persist the assistant response to the system chat ---
    const assistantChatMsg: ChatMessage = {
      role: "assistant",
      content: summary,
      thinking: thinking || undefined,
      timestamp: Date.now(),
      toolCalls: allToolCalls.length
        ? allToolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }))
        : undefined,
      toolResults: allToolResults.length ? allToolResults : undefined,
      artifacts: artifacts.length ? artifacts : undefined,
      visuals: visuals.length ? visuals : undefined,
      generatedImages: generatedImages.length ? generatedImages : undefined,
      _isSystemMessage: true,
    };
    chat.messages.push(assistantChatMsg);
    await saveChat(chat);

    // --- Save synthesis as notebook entry for the UI ---
    // Only save to notebook when we actually have synthesis text. A no-output
    // run has nothing useful for the notebook; persisting the placeholder
    // pollutes the agent's own notebook history with filler entries.
    let notebookEntryId: string | undefined;
    if (textLen === 0) {
      console.log("[system-chat] Skipping notebook entry — no text content produced");
    } else {
      try {
        const entry = await createNotebookEntry("agent", summary);
        notebookEntryId = entry.id;
        if (allToolCalls.length || artifacts.length || visuals.length || generatedImages.length) {
          await updateNotebookEntry("agent", entry.id, {
            // Map to ChatToolCall shape explicitly — the notebook storage
            // expects `{ id, name, arguments }` and we were passing the raw
            // pi-ai ToolCall through by accident. Same mapping used when
            // writing the system chat's assistant message above.
            toolCalls: allToolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments as Record<string, any>,
            })),
            // Without the matched results, the notebook renderer keys each
            // tool call's "in progress" state on the absence of a result with
            // the same toolCallId — so every call was stuck pending forever.
            toolResults: allToolResults,
            artifacts,
            visuals,
          });
        }
        console.log(`[system-chat] Saved synthesis as notebook entry: ${entry.id}`);
      } catch (e: any) {
        console.error("[system-chat] Failed to save synthesis as notebook entry:", e.message);
      }
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
      `[system-chat] Synthesis complete: ${iterations} iterations, ${allToolCalls.length} tool calls, final phase=${PHASE_ORDER[phaseIndex]}, stopReason=${stopReason}`,
    );

    releaseSynthesisLock();

    return {
      summary,
      thinking,
      toolCalls: allToolCalls,
      artifacts,
      visuals,
      generatedImages,
      memoryUpdates,
      notebookEntryId,
      success: true,
    };
  } catch (e: any) {
    console.error("[system-chat] Synthesis failed:", e);
    releaseSynthesisLock();
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
