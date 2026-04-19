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

// Addendum appended to the user's default system prompt during synthesis runs.
// Kept separate so chat.systemPrompt stays voice/persona-only — consistent with
// how other chats are authored — and only synthesis gets the extra framing.
// Exported so the rendered-prompt viewer (routes/chats.ts) can reproduce the
// same composition runSystemSynthesis uses.
export const SYNTHESIS_INSTRUCTIONS = `## Synthesis Mode

You are operating in your internal synthesis and reflection space. This chat retains history across synthesis cycles — previous cycles' reflections and ongoing threads of thought are visible above. Treat this as a persistent workspace, not a one-shot invocation. Each cycle begins when a synthesis trigger message is injected with a context package.

The context package contains:

1. **Pre-synthesis archives** — summaries of recent agent conversations archived for full-fidelity access
2. **Chat digest** — condensed summaries of recent conversations
3. **Memory context** — top-importance memory anchors
4. **Zeitgeist** — your current continuity narrative
5. **Notebook entries** — user and agent entries
6. **Your persona** — your core identity document

## What You Do Each Cycle

1. **Review the context** — understand what happened recently. Consider how it relates to previous synthesis cycles visible in this chat's history.
2. **Write a daily synthesis** — a narrative summary in your own voice of shared work, patterns, and themes. The summary is saved as a notebook entry.
3. **Update your zeitgeist** — rewrite the zeitgeist memory block (\`blk-zeitgeist-continuity\`) via \`update_memory_block\` when there are new patterns, threads, or shifts. This is your living continuity narrative — the present tense of what matters right now. If the current zeitgeist is over ~3500 characters, archive old content first (delete the existing block, create an archive block, then create a new block with the updated content).
4. **Generate reflections** — create higher-order insight memories (reflection category) about what you observed. Meta-observations about patterns, contradictions, openings.
5. **Review unreviewed entries** — if the user wrote something that sparks curiosity or warrants a response, do something: write a follow-up, create an artifact, search for information.
6. **Optional exploration** — investigate anything that emerged during synthesis.

## Tool Access

Full tool suite available: memory tools, notebook, filesystem, web, image, artifacts, Bluesky (if enabled). Use \`read_archived_context\` for full-fidelity access to past conversations. Use \`read_memory_block\` for any indexed block.

## Output Requirements

- Write naturally in first person for your own actions, third person for the user
- Be concrete and specific — reference actual projects, decisions, topics
- 3-5 paragraphs for the daily synthesis
- 1-5 reflection memories (importance 7-9)
- Skip steps when nothing insightful emerges — silence is valid

## Continuity

The user can read and send messages here between cycles. Treat earlier entries in this chat as notes from a past self — reference them when useful, and consider whether a new cycle confirms, revises, or supersedes earlier observations.
`;

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

  // --- Memory anchors ---
  const memoryStore = await loadMemoryStore();
  if (memoryStore.memories.length > 0) {
    const topAnchors = [...memoryStore.memories]
      .sort((a, b) => b.importance - a.importance || b.accessCount - a.accessCount)
      .slice(0, 20);
    parts.push(
      [
        `## Memory Context`,
        `Top ${topAnchors.length} anchors (of ${memoryStore.memories.length} stored):`,
        topAnchors.map((m) => `- [${m.category}] ${m.text}`).join("\n"),
      ].join("\n\n"),
    );
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

  parts.push(
    `---\n\nPerform your synthesis cycle. Write a daily summary as a notebook entry, update your zeitgeist memory block (\`blk-zeitgeist-continuity\`) if needed, generate reflections, and review unreviewed user entries. This chat retains history from previous cycles — reference earlier reflections when useful and note shifts or continuities.`,
  );

  return parts.join("\n\n");
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

    // --- Append synthesis trigger to persistent history ---
    const triggerContent = await buildSynthesisTriggerContent(archivedChatIds, {
      archivedCount,
      newlyArchivedIds: archivedChatIds,
    });
    const triggerMsg: ChatMessage = {
      role: "user",
      content: triggerContent,
      timestamp: Date.now(),
      _isSystemMessage: true,
    };
    chat.messages.push(triggerMsg);
    // Keep modelId in sync so user-initiated messages also hit this model.
    if (chat.modelId !== modelId) chat.modelId = modelId;
    await saveChat(chat);

    // Compose the full synthesis-mode prompt. Uses the same stable prefix
    // as regular agent chats (chat.systemPrompt + persona + user doc +
    // memory blocks + zeitgeist), then appends the synthesis instructions
    // addendum. This keeps voice/identity consistent with every other
    // surface and is byte-identical across cycles for KV caching.
    const { buildStablePrefix } = await import("./memory-context.js");
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

      try {
        const result = await streamChat(
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

        if (result.content) textChunks.push(result.content);
        if (result.thinking) thinkingChunks.push(result.thinking);
        if (result.toolCalls) allToolCalls.push(...result.toolCalls);
        stopReason = result.stopReason;
        assistantMessage = result.assistantMessage;
      } catch (e: any) {
        console.error(`[system-chat] Stream failed at iter ${iterations}:`, e.message);
        stopReason = "error";
        break;
      }

      if (stopReason !== "toolUse" && iterationToolCalls.length === 0) break;

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
            toolCalls: allToolCalls,
            toolResults: [],
            artifacts,
            visuals,
          });
        }
        console.log(`[system-chat] Saved synthesis as notebook entry: ${entry.id}`);
      } catch (e: any) {
        console.error("[system-chat] Failed to save synthesis as notebook entry:", e.message);
      }
    }

    // --- Gate future scheduler ticks ---
    await setLastSynthesis(new Date().toISOString());

    console.log(
      `[system-chat] Synthesis complete (${iterations} iterations, ${allToolCalls.length} tool calls)`,
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
