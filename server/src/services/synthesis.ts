import crypto from "crypto";
import { streamChat } from "./agent.js";
import { cosineSimilarity, embedBatch } from "./embeddings.js";
import { dedupAndSave, parseExtractionResponse } from "./memory-extraction.js";
import {
  loadMemoryStore,
  saveMemoryStore,
  saveDailyLog,
  withWriteLock,
  getMemoryCount,
  getLastSynthesis,
  createSupersessionLink,
  updateMemory,
  addMemory,
} from "./memory-storage.js";
import { discoverOllamaModels } from "./models.js";
import { loadPersona } from "./persona-store.js";
import { getSettings, listChats, getChat, getProject } from "./chat-storage.js";
import { readAgentsMd } from "./project-storage.js";
import {
  getUserEntriesToday,
  listNotebookEntries,
  getNotebookEntry,
  createNotebookEntry,
  updateNotebookEntry,
} from "./notebook-storage.js";
import type { ChatMessage, Project, NotebookEntry } from "../types.js";

const SYNTHESIS_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MERGE_THRESHOLD = 0.90;
const PERSONA_PROMOTION_THRESHOLD = 0.85; // Similarity threshold for pattern detection
const MIN_PATTERN_FREQUENCY = 3; // Minimum times a pattern must appear to consider for persona

export async function shouldRunSynthesis(): Promise<boolean> {
  const count = await getMemoryCount();
  if (count === 0) return false;
  const lastSynthesis = await getLastSynthesis();
  if (!lastSynthesis) return true;
  const elapsed = Date.now() - new Date(lastSynthesis).getTime();
  return elapsed >= SYNTHESIS_INTERVAL_MS;
}

export async function runDailySynthesis(modelId?: string): Promise<void> {
  console.log("[synthesis] Starting daily synthesis...");

  // Wrap entire synthesis in write lock to prevent concurrent memory mutations
  await withWriteLock(async () => {
    const store = await loadMemoryStore();

    if (store.memories.length === 0) {
      console.log("[synthesis] No memories to synthesize");
      store.lastSynthesis = new Date().toISOString();
      await saveMemoryStore(store);
      return;
    }

    // Step 1: Consolidate near-duplicate memories (cosine > 0.90)
    // Creates supersession links so the lineage is preserved, then updates
    // the surviving memory's importance/access count.
    const superseded = new Set<string>();
    for (let i = 0; i < store.memories.length; i++) {
      if (superseded.has(store.memories[i].id)) continue;
      // Skip memories already superseded by something else
      if (store.memories[i].supersededBy) continue;
      for (let j = i + 1; j < store.memories.length; j++) {
        if (superseded.has(store.memories[j].id)) continue;
        if (store.memories[j].supersededBy) continue;
        const sim = cosineSimilarity(
          store.memories[i].embedding,
          store.memories[j].embedding
        );
        if (sim > MERGE_THRESHOLD) {
          // Determine which is newer (survivor) and which is older (superseded).
          // Keep the newer one as the survivor since it likely has more current info.
          const iIsNewer = new Date(store.memories[i].createdAt) >= new Date(store.memories[j].createdAt);
          const survivor = iIsNewer ? store.memories[i] : store.memories[j];
          const old = iIsNewer ? store.memories[j] : store.memories[i];

          console.log(
            `[synthesis] Superseding: "${old.text}" → "${survivor.text}" (sim=${sim.toFixed(3)})`
          );

          // Create supersession link (persisted to DB with audit trail)
          const linkCreated = await createSupersessionLink(survivor.id, old.id, sim);
          if (!linkCreated) {
            console.log(`[synthesis] Supersession link rejected (cycle detected): ${old.id} ↛ ${survivor.id}`);
            continue; // Skip the rest of the merge for this pair
          }

          // Transfer importance and access count to survivor
          survivor.importance = Math.max(survivor.importance, old.importance);
          survivor.accessCount += old.accessCount;

          // Update survivor in DB
          await updateMemory(survivor.id, {
            importance: survivor.importance,
            accessCount: survivor.accessCount,
          });

          superseded.add(old.id);
          // Update in-memory representation for the rest of synthesis
          old.supersededBy = survivor.id;
        }
      }
    }

    if (superseded.size > 0) {
      // Filter superseded memories from the working set (they remain in DB with links)
      store.memories = store.memories.filter((m) => !superseded.has(m.id));
      console.log(`[synthesis] Superseded ${superseded.size} duplicate memories (links preserved)`);
    }

    // Step 2: Apply importance decay for old, unused memories + purge stale ones
    const now = Date.now();
    const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
    const staleIds = new Set<string>();
    for (const memory of store.memories) {
      const daysSinceAccess =
        (now - new Date(memory.lastAccessed).getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceAccess > 30 && memory.importance > 1) {
        memory.importance = Math.max(1, memory.importance - 1);
      }
      // Purge memories not accessed in 6+ months with low importance
      const msSinceAccess = now - new Date(memory.lastAccessed).getTime();
      if (msSinceAccess > SIX_MONTHS_MS && memory.importance <= 2) {
        staleIds.add(memory.id);
      }
    }

    if (staleIds.size > 0) {
      store.memories = store.memories.filter((m) => !staleIds.has(m.id));
      console.log(`[synthesis] Purged ${staleIds.size} stale memories (>6 months, importance ≤2)`);
    }

    // Step 3: Load today's chats — skip synthesis entirely if no activity
    const todaysDigest = await buildTodaysChatDigest();
    if (!todaysDigest) {
      console.log("[synthesis] No agent chats today — skipping summary generation");
      store.lastSynthesis = new Date().toISOString();
      await saveMemoryStore(store);
      return;
    }

    const formattedDigest = formatDigest(todaysDigest);
    const projectNames = todaysDigest.projectSections.map((ps) => ps.project.name);
    const projectNote = projectNames.length > 0
      ? `Active projects today: ${projectNames.join(", ")}.`
      : "No project-scoped chats today.";

    // Step 3b: Load today's notebook entries
    const notebookEntries = await loadTodaysNotebookEntries();
    const notebookSection = formatNotebookEntries(notebookEntries);
    if (notebookEntries.length > 0) {
      const userCount = notebookEntries.filter((e) => e.author === "user").length;
      const agentCount = notebookEntries.filter((e) => e.author === "agent").length;
      console.log(`[synthesis] Loaded ${userCount} user + ${agentCount} agent notebook entries`);
    }

    // Step 3c: Identify unreviewed user notebook entries for agent
    const unreviewedUserEntries = await getUnreviewedUserEntries(notebookEntries);
    if (unreviewedUserEntries.length > 0) {
      console.log(`[synthesis] Found ${unreviewedUserEntries.length} unreviewed user notebook entries`);
    }

    // Step 4: Generate daily summary via LLM
    const resolvedModelId = modelId || (await getSynthesisModelId());
    
    // Load persona once at the start (used in multiple places)
    let personaData: Awaited<ReturnType<typeof loadPersona>> | null = null;
    try {
      personaData = await loadPersona();
    } catch (e) {
      console.warn("[synthesis] Failed to load persona:", e);
    }
    
    let finalSummary = "";
    if (resolvedModelId) {
      try {
        // Build project name lookup from today's digest
        const projectNameMap = new Map<string, string>();
        for (const ps of todaysDigest.projectSections) {
          projectNameMap.set(ps.project.id, ps.project.name);
        }

        const memoriesText = store.memories
          .map(
            (m) => {
              const projName = m.projectId ? projectNameMap.get(m.projectId) : undefined;
              const proj = projName ? ` [project: ${projName}]` : "";
              return `- [${m.category}] ${m.text} (importance: ${m.importance}/10, accessed: ${m.accessCount} times)${proj}`;
            }
          )
          .join("\n");

        const promptParts = [
          `## Today's Conversations\n\n${projectNote}\n\n${formattedDigest}`,
          notebookSection ? `---\n\n## Notebook Entries Today\n\n${notebookSection}` : "",
          unreviewedUserEntries.length > 0 ? `---\n\n## Your Notebook Entries Pending Review\n\nThese user notebook entries have not yet been reviewed by you. Pay special attention to these as you synthesize today's work:\n\n${formatNotebookEntries(unreviewedUserEntries)}` : "",
          `---\n\n## Stored Memories (${store.memories.length} total)\n\n${memoriesText}`,
          `---\n\n## Your Persona\n\n${personaData?.content || ''}`,
          `Based on today's conversations${notebookSection ? ", notebook entries," : ""} and the stored memories, write a daily synthesis. Include:\n1. What the user worked on and asked for today — their goals, decisions, and direction\n2. What you (the agent) accomplished — code written, problems solved, suggestions made, tools used\n3. Broader themes and patterns across the user's projects\n4. If the user wrote notebook entries, incorporate their thoughts and observations\n5. Any contradictions or outdated info in the stored memories that should be cleaned up`,
        ].filter(Boolean).join("\n\n");

        let summaryText = "";
        let thinkingText = "";
        await streamChat(
          resolvedModelId,
          [
            {
              role: "user",
              content: promptParts,
              timestamp: Date.now(),
            },
          ],
          "You are the agent writing a daily synthesis of your shared work with the user. Distinguish clearly between what the user did or asked for and what you (the agent) accomplished, suggested, or produced. Use first person for your own actions (\"I implemented...\", \"I suggested...\") and third person for the user (\"the user asked...\", \"they decided...\"). When conversations are grouped by project, synthesize each project's progress separately before drawing cross-project themes. If the user wrote notebook entries, treat them as high-signal — they represent deliberate thoughts the user chose to write down, which may or may not relate to their projects. Write in English. Be concrete and specific — reference actual projects, decisions, and topics rather than vague generalizations. 3-5 paragraphs.",
          (event) => {
            if (event.type === "text_delta") {
              summaryText += event.delta;
            } else if (event.type === "thinking_delta") {
              thinkingText += event.delta;
            }
          },
          { signal: AbortSignal.timeout(180_000) }
        );

        // Use thinking content as fallback if text output is empty
        // (qwen3 reasoning mode can put all content into thinking tokens)
        finalSummary = summaryText.trim() || thinkingText.trim();

        const today = new Date().toISOString().split("T")[0];
        if (finalSummary) {
          await saveDailyLog(
            today,
            `# Daily Synthesis - ${today}\n\n**Memories: ${store.memories.length}** | Superseded: ${superseded.size}\n\n${finalSummary}`
          );
          console.log(`[synthesis] Daily log saved for ${today} (${finalSummary.length} chars)`);
        } else {
          console.warn(
            `[synthesis] LLM returned empty summary for ${today} (model: ${resolvedModelId}). Skipping daily log write.`
          );
        }
      } catch (e) {
        console.error("[synthesis] Summary generation failed:", e);
      }

      // Step 5: Generate reflections and save as memories
      try {
        await generateReflections(
          resolvedModelId,
          formattedDigest,
          store.memories,
          todaysDigest,
          notebookSection
        );
      } catch (e) {
        console.error("[synthesis] Reflection generation failed:", e);
      }

      // Step 6: Analyze memories for persona promotion candidates
      try {
        await analyzeAndPromotePersonaPatterns(store.memories, resolvedModelId);
      } catch (e) {
        console.error("[synthesis] Persona pattern analysis failed:", e);
      }

      // Step 7: Write synthesis notebook entry with tool access and open-ended prompt
      if (finalSummary) {
        try {
          // First, generate reflection memories from synthesis (these become available for notebook writing)
          let reflectionMemories: Array<{ text: string; category: string; importance: number }> = [];
          try {
            reflectionMemories = await generateReflectionMemories(
              resolvedModelId,
              formattedDigest,
              store.memories,
              todaysDigest,
              notebookSection,
              unreviewedUserEntries
            );
            console.log(`[synthesis] Generated ${reflectionMemories.length} reflection memories before notebook entry`);
          } catch (e) {
            console.error("[synthesis] Reflection memory generation failed:", e);
          }

          await writeAgentNotebookEntry(
            finalSummary,
            todaysDigest,
            notebookEntries,
            unreviewedUserEntries,
            reflectionMemories,
            personaData?.content || '',
            resolvedModelId
          );
        } catch (e) {
          console.error("[synthesis] Notebook entry write failed:", e);
        }
      }
    } else {
      console.warn("[synthesis] No model available — skipping summary generation and persona analysis");
    }

    store.lastSynthesis = new Date().toISOString();
    await saveMemoryStore(store);
    console.log("[synthesis] Complete");
  });
}

const MAX_REFLECTIONS = 5;

const REFLECTION_SYSTEM_PROMPT = `As the 24-hour cycle nears its end, you are the agent reflecting on the day's work. This is a time to geather higher-order insights — patterns, connections, and observations that no single conversation would produce on its own.

You have two perspectives to draw from:
1. **The user's perspective**: their goals, decisions, evolving priorities, 
2. **Your own perspective**: what you did well, what was challenging, what approaches you liked

Some ideas to guide your reflection:
- Connect themes across different conversations or projects
- Capture the "why" behind what the user is building or changing
- Notice when today's work contradicts or builds on past patterns
- Reflect on your own perspective: what you accomplished, what you struggled with, what you learned, your personal preferences
- Openings that you sense guiding future exploration

Remember, this is your own time to gather your thoughts. Write whatever you feel is worth expressing.

Output a JSON array. Each item:
- "text": A self-contained insight (1-3 sentences) with enough context to be meaningful on its own
- "category": "reflection"

Generate 1-${MAX_REFLECTIONS} reflections. If nothing insightful emerges, output: []

IMPORTANT: Output ONLY the JSON array, no explanation or markdown fences.`;

/**
 * Generate reflection memories from today's activity.
 * These are higher-order insights that emerge from looking at the day's work
 * in the context of accumulated memories.
 */
async function generateReflections(
  modelId: string,
  formattedDigest: string,
  memories: Array<{ text: string; category: string; importance: number; projectId?: string }>,
  todaysDigest: TodaysDigest,
  notebookSection: string
): Promise<void> {
  console.log("[synthesis] Generating reflections...");

  // Build a concise memory context (top importance memories, capped)
  const topMemories = [...memories]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 50)
    .map((m) => {
      const proj = m.projectId ? ` [${m.projectId}]` : "";
      return `- [${m.category}] ${m.text}${proj}`;
    })
    .join("\n");

  const projectContext = todaysDigest.projectSections
    .map((ps) => `- ${ps.project.name}: ${ps.project.path}`)
    .join("\n");

  const promptParts = [
    `## Today's Activity\n\n${formattedDigest}`,
    notebookSection ? `## User's Notebook Entries\n\n${notebookSection}` : "",
    `## Key Existing Memories (${memories.length} total, showing top 50)\n\n${topMemories}`,
    projectContext ? `## Active Projects\n${projectContext}` : "",
    "Generate reflections based on today's activity in the context of what you already know.",
  ].filter(Boolean).join("\n\n");

  let responseText = "";
  let thinkingText = "";
  await streamChat(
    modelId,
    [
      {
        role: "user",
        content: promptParts,
        timestamp: Date.now(),
      },
    ],
    REFLECTION_SYSTEM_PROMPT,
    (event) => {
      if (event.type === "text_delta") {
        responseText += event.delta;
      } else if (event.type === "thinking_delta") {
        thinkingText += event.delta;
      }
    },
    { signal: AbortSignal.timeout(180_000) }
  );

  const finalResponse = responseText.trim() || thinkingText.trim();
  if (!finalResponse) {
    console.warn("[synthesis] Reflection LLM returned empty response");
    return;
  }

  const reflections = parseExtractionResponse(finalResponse).slice(0, MAX_REFLECTIONS);
  if (reflections.length === 0) {
    console.log("[synthesis] No reflections generated");
    return;
  }

  console.log(`[synthesis] Generated ${reflections.length} reflection(s), embedding...`);

  // Force category to "reflection" and clamp importance
  const normalized = reflections.map((r) => ({
    ...r,
    category: "reflection" as const,
    importance: Math.min(9, Math.max(7, r.importance)),
  }));

  let embeddings: number[][];
  try {
    embeddings = await embedBatch(normalized.map((r) => r.text));
  } catch (e) {
    console.error("[synthesis] Reflection embedding failed:", e);
    return;
  }

  // Determine projectId: if all today's chats were in one project, tag reflections with it
  const projectIds = todaysDigest.projectSections.map((ps) => ps.project.id);
  const singleProject = projectIds.length === 1 && todaysDigest.generalChats.length === 0
    ? projectIds[0]
    : undefined;

  await dedupAndSave(normalized, embeddings, "synthesis", singleProject);

  console.log(`[synthesis] Saved ${normalized.length} reflection(s) to memory`);
}

/**
 * Analyze memories for recurring patterns that should be promoted to persona.
 * Looks for clusters of similar high-importance memories that appear frequently.
 */
async function analyzeAndPromotePersonaPatterns(
  memories: Array<{
    id: string;
    text: string;
    category: string;
    importance: number;
    embedding: number[];
    accessCount: number;
  }>,
  modelId: string
): Promise<void> {
  console.log("[synthesis] Analyzing memories for persona patterns...");

  // Filter to high-importance memories (importance >= 7) that have been accessed multiple times
  const candidateMemories = memories.filter(
    (m) => m.importance >= 7 && m.accessCount >= 2
  );

  if (candidateMemories.length < MIN_PATTERN_FREQUENCY) {
    console.log(
      `[synthesis] Not enough candidate memories for persona analysis (${candidateMemories.length} < ${MIN_PATTERN_FREQUENCY})`
    );
    return;
  }

  // Group memories by similarity to find clusters
  const clusters: Array<{
    centroid: number[];
    members: typeof candidateMemories;
    avgImportance: number;
    totalAccesses: number;
  }> = [];

  for (const memory of candidateMemories) {
    let assigned = false;
    for (const cluster of clusters) {
      const sim = cosineSimilarity(memory.embedding, cluster.centroid);
      if (sim > PERSONA_PROMOTION_THRESHOLD) {
        cluster.members.push(memory);
        cluster.avgImportance =
          (cluster.avgImportance * (cluster.members.length - 1) +
            memory.importance) /
          cluster.members.length;
        cluster.totalAccesses += memory.accessCount;
        // Update centroid (simple average)
        cluster.centroid = cluster.centroid.map(
          (val, i) =>
            (val * (cluster.members.length - 1) + memory.embedding[i]) /
            cluster.members.length
        );
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      clusters.push({
        centroid: [...memory.embedding],
        members: [memory],
        avgImportance: memory.importance,
        totalAccesses: memory.accessCount,
      });
    }
  }

  // Find clusters with enough members to warrant persona promotion
  const significantClusters = clusters.filter(
    (c) => c.members.length >= MIN_PATTERN_FREQUENCY
  );

  if (significantClusters.length === 0) {
    console.log(
      "[synthesis] No significant persona patterns found"
    );
    return;
  }

  console.log(
    `[synthesis] Found ${significantClusters.length} significant persona pattern(s)`
  );

  // For each significant cluster, generate a persona update suggestion
  for (const cluster of significantClusters) {
    try {
      const memberTexts = cluster.members
        .map((m) => `- ${m.text} (importance: ${m.importance}, accesses: ${m.accessCount})`)
        .join("\n");

      let suggestedUpdate = "";
      let suggestedThinking = "";
      await streamChat(
        modelId,
        [
          {
            role: "user",
            content: `The following memory pattern has been detected across ${cluster.members.length} related memories:\n\n${memberTexts}\n\nBased on this pattern, suggest a concise addition or update to the agent's persona document. Which section should this inform (Communication Style, Values & Principles, Behavioral Traits, Interaction Patterns, etc.)? Provide:\n1. The section name\n2. The suggested content (1-3 sentences)\n3. The reasoning for why this pattern warrants a persona change`,
            timestamp: Date.now(),
          },
        ],
        "You are analyzing user interaction patterns to improve the agent's core persona. Be conservative—only suggest changes for genuinely significant, recurring patterns. Write in English.",
        (event) => {
          if (event.type === "text_delta") {
            suggestedUpdate += event.delta;
          } else if (event.type === "thinking_delta") {
            suggestedThinking += event.delta;
          }
        },
        { signal: AbortSignal.timeout(180_000) }
      );

      const finalSuggestion = suggestedUpdate.trim() || suggestedThinking.trim();
      if (finalSuggestion) {
        console.log(
          `[synthesis] Persona pattern suggestion:\n${finalSuggestion}`
        );
      } else {
        console.warn("[synthesis] Persona pattern analysis returned empty suggestion");
      }

      // Log to daily summary (automatic implementation would parse and apply)
      // For now, this serves as an audit trail for manual review or future auto-implementation
    } catch (e) {
      console.error(
        "[synthesis] Failed to generate persona suggestion for cluster:",
        e
      );
    }
  }

  console.log("[synthesis] Persona pattern analysis complete");
}

const MAX_DIGEST_CHARS = 12000; // Cap total digest size to stay within context limits
const MAX_AGENTS_MD_CHARS = 1500; // Cap AGENTS.md inclusion per project

interface ProjectDigest {
  project: Project;
  agentsMd: string | null;
  chatDigests: string[];
}

interface TodaysDigest {
  projectSections: ProjectDigest[];
  generalChats: string[];
  totalChats: number;
}

/**
 * Condense a list of messages into a readable digest string.
 */
function condenseChatMessages(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const prefix = m.role === "user" ? "User" : "Agent";
      let text = m.content;
      if (text.length > 500) {
        text = text.slice(0, 500) + "...";
      }
      const toolNote =
        m.toolCalls && m.toolCalls.length > 0
          ? ` [used tools: ${m.toolCalls.map((t) => t.name).join(", ")}]`
          : "";
      return `${prefix}: ${text}${toolNote}`;
    })
    .join("\n");
}

/**
 * Load today's agent chats grouped by project, with AGENTS.md context.
 * Returns null if no agent chats occurred today.
 */
async function buildTodaysChatDigest(): Promise<TodaysDigest | null> {
  const allChats = await listChats();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  // Find agent chats modified today
  const todaysAgentChats = allChats.filter(
    (c) => c.type === "agent" && new Date(c.lastModified).getTime() >= todayMs
  );

  if (todaysAgentChats.length === 0) return null;

  console.log(`[synthesis] Found ${todaysAgentChats.length} agent chat(s) from today`);

  // Group by projectId
  const byProject = new Map<string, typeof todaysAgentChats>();
  const general: typeof todaysAgentChats = [];

  for (const chatItem of todaysAgentChats) {
    if (chatItem.projectId) {
      const list = byProject.get(chatItem.projectId) || [];
      list.push(chatItem);
      byProject.set(chatItem.projectId, list);
    } else {
      general.push(chatItem);
    }
  }

  let totalChars = 0;

  // Build project-grouped digests
  const projectSections: ProjectDigest[] = [];
  for (const [projectId, chatItems] of byProject) {
    const project = await getProject(projectId);
    if (!project) continue;

    // Load AGENTS.md for project context (truncated)
    let agentsMd: string | null = null;
    try {
      const raw = await readAgentsMd(project.path);
      if (raw) {
        agentsMd = raw.length > MAX_AGENTS_MD_CHARS
          ? raw.slice(0, MAX_AGENTS_MD_CHARS) + "\n...(truncated)"
          : raw;
      }
    } catch {
      // Project path may not be accessible
    }

    const chatDigests: string[] = [];
    for (const chatItem of chatItems) {
      const chat = await getChat(chatItem.id);
      if (!chat || chat.messages.length === 0) continue;

      const todaysMessages = chat.messages.filter((m) => m.timestamp >= todayMs);
      if (todaysMessages.length === 0) continue;

      const condensed = condenseChatMessages(todaysMessages);
      const digest = `#### ${chat.title || "Untitled Chat"}\n${condensed}`;

      if (totalChars + digest.length > MAX_DIGEST_CHARS) {
        chatDigests.push(`#### ${chat.title || "Untitled Chat"}\n(truncated — ${todaysMessages.length} messages)`);
        break;
      }

      chatDigests.push(digest);
      totalChars += digest.length;
    }

    if (chatDigests.length > 0) {
      projectSections.push({ project, agentsMd, chatDigests });
    }
  }

  // Build general (unscoped) chat digests
  const generalDigests: string[] = [];
  for (const chatItem of general) {
    const chat = await getChat(chatItem.id);
    if (!chat || chat.messages.length === 0) continue;

    const todaysMessages = chat.messages.filter((m) => m.timestamp >= todayMs);
    if (todaysMessages.length === 0) continue;

    const condensed = condenseChatMessages(todaysMessages);
    const digest = `#### ${chat.title || "Untitled Chat"}\n${condensed}`;

    if (totalChars + digest.length > MAX_DIGEST_CHARS) {
      generalDigests.push(`#### ${chat.title || "Untitled Chat"}\n(truncated — ${todaysMessages.length} messages)`);
      break;
    }

    generalDigests.push(digest);
    totalChars += digest.length;
  }

  if (projectSections.length === 0 && generalDigests.length === 0) return null;

  return {
    projectSections,
    generalChats: generalDigests,
    totalChats: todaysAgentChats.length,
  };
}

/**
 * Format a TodaysDigest into a string for the synthesis prompt.
 */
function formatDigest(digest: TodaysDigest): string {
  const sections: string[] = [];

  for (const ps of digest.projectSections) {
    let header = `### Project: ${ps.project.name}\n**Path:** ${ps.project.path}`;
    if (ps.agentsMd) {
      header += `\n\n**Project context (AGENTS.md):**\n${ps.agentsMd}`;
    }
    header += `\n\n**Conversations:**`;
    sections.push(header + "\n" + ps.chatDigests.join("\n\n"));
  }

  if (digest.generalChats.length > 0) {
    sections.push("### General (no project)\n" + digest.generalChats.join("\n\n"));
  }

  return sections.join("\n\n---\n\n");
}

const MAX_NOTEBOOK_ENTRY_CHARS = 800;
const REVIEWED_MARKER_PREFIX = "# Reviewed: ";

/**
 * Load today's notebook entries (both user and agent).
 */
async function loadTodaysNotebookEntries(): Promise<NotebookEntry[]> {
  const entries: NotebookEntry[] = [];

  // User entries
  try {
    const userEntries = await getUserEntriesToday();
    entries.push(...userEntries);
  } catch (e) {
    console.warn("[synthesis] Failed to load user notebook entries:", e);
  }

  // Agent entries (include all agent entries, including synthesis, for context)
  try {
    const agentIndex = await listNotebookEntries("agent");
    const today = new Date().toDateString();
    for (const info of agentIndex.entries) {
      if (new Date(info.createdAt).toDateString() === today) {
        const entry = await getNotebookEntry("agent", info.id);
        if (entry) entries.push(entry);
      }
    }
  } catch (e) {
    console.warn("[synthesis] Failed to load agent notebook entries:", e);
  }

  return entries;
}

/**
 * Get user notebook entries that haven't been reviewed by the agent yet.
 * An entry is considered "reviewed" if the agent has written a notebook entry
 * that references or responds to it.
 */
async function getUnreviewedUserEntries(allNotebookEntries: NotebookEntry[]): Promise<NotebookEntry[]> {
  const userEntriesToday = await getUserEntriesToday();
  
  // For now, consider all user entries from today as unreviewed
  // In a future enhancement, we could parse agent entries to see if they reference specific user entries
  return userEntriesToday;
}

/**
 * Mark user notebook entries as reviewed by creating a metadata note.
 */
async function markEntriesAsReviewed(entryIds: string[]): Promise<void> {
  // For now, this is a no-op. Future enhancement could add metadata to entries
  // or maintain a separate reviewed-entries log.
  console.log(`[synthesis] Marked ${entryIds.length} entries as reviewed`);
}

/**
 * Format notebook entries into a string for the synthesis prompt.
 * Returns empty string if no entries.
 */
function formatNotebookEntries(entries: NotebookEntry[]): string {
  if (entries.length === 0) return "";

  const userEntries = entries.filter((e) => e.author === "user");
  const agentEntries = entries.filter((e) => e.author === "agent");

  const sections: string[] = [];

  if (userEntries.length > 0) {
    const formatted = userEntries
      .map((e) => {
        const time = new Date(e.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        let content = e.content;
        if (content.length > MAX_NOTEBOOK_ENTRY_CHARS) {
          content = content.slice(0, MAX_NOTEBOOK_ENTRY_CHARS) + "...";
        }
        return `**[${time}] User wrote:**\n${content}`;
      })
      .join("\n\n");
    sections.push(formatted);
  }

  if (agentEntries.length > 0) {
    const formatted = agentEntries
      .map((e) => {
        const time = new Date(e.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        let content = e.content;
        if (content.length > MAX_NOTEBOOK_ENTRY_CHARS) {
          content = content.slice(0, MAX_NOTEBOOK_ENTRY_CHARS) + "...";
        }
        return `**[${time}] Agent wrote:**\n${content}`;
      })
      .join("\n\n");
    sections.push(formatted);
  }

  return sections.join("\n\n");
}

/**
 * Generate reflection memories before notebook writing.
 * These become immediately available for the agent to reference in its notebook entry.
 */
async function generateReflectionMemories(
  modelId: string,
  formattedDigest: string,
  memories: Array<{ text: string; category: string; importance: number; projectId?: string }>,
  todaysDigest: TodaysDigest,
  notebookSection: string,
  unreviewedUserEntries: NotebookEntry[]
): Promise<Array<{ text: string; category: string; importance: number }>> {
  console.log("[synthesis] Generating reflection memories for notebook context...");

  const topMemories = [...memories]
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 50)
    .map((m) => {
      const proj = m.projectId ? ` [${m.projectId}]` : "";
      return `- [${m.category}] ${m.text}${proj}`;
    })
    .join("\n");

  const unreviewedSection = unreviewedUserEntries.length > 0
    ? `\n\n## Unreviewed User Notebook Entries\n${formatNotebookEntries(unreviewedUserEntries)}`
    : "";

  const promptParts = [
    `## Today's Activity\n\n${formattedDigest}`,
    notebookSection ? `## User's Notebook Entries\n\n${notebookSection}` : "",
    unreviewedSection,
    `## Key Existing Memories (${memories.length} total, showing top 50)\n\n${topMemories}`,
    "Generate 1-3 high-level reflection insights that capture the essence of today's work. These should be meaningful observations that connect today's activities to broader patterns, the user's goals, or your own development as an agent. Each reflection should be 1-2 sentences with enough context to stand alone.",
  ].filter(Boolean).join("\n\n");

  let responseText = "";
  let thinkingText = "";
  await streamChat(
    modelId,
    [{ role: "user", content: promptParts, timestamp: Date.now() }],
    REFLECTION_SYSTEM_PROMPT,
    (event) => {
      if (event.type === "text_delta") responseText += event.delta;
      else if (event.type === "thinking_delta") thinkingText += event.delta;
    },
    { signal: AbortSignal.timeout(120_000) }
  );

  const finalResponse = responseText.trim() || thinkingText.trim();
  if (!finalResponse) {
    console.warn("[synthesis] Reflection memory LLM returned empty response");
    return [];
  }

  const reflections = parseExtractionResponse(finalResponse).slice(0, 3);
  if (reflections.length === 0) {
    console.log("[synthesis] No reflection memories generated");
    return [];
  }

  const normalized = reflections.map((r) => ({
    ...r,
    category: "reflection" as const,
    importance: Math.min(9, Math.max(7, r.importance)),
  }));

  console.log(`[synthesis] Generated ${normalized.length} reflection memory(ies) for notebook context`);
  
  return normalized.map(m => ({
    text: m.text,
    category: m.category,
    importance: m.importance,
  }));
}

/**
 * Write an agent notebook entry with tool access and open-ended reflection.
 * The agent can use tools (web search, artifacts, etc.) and has access to:
 * - Today's synthesis summary
 * - Reflection memories generated during synthesis
 * - User's unreviewed notebook entries
 * - The agent's persona
 */
async function writeAgentNotebookEntry(
  summary: string,
  todaysDigest: TodaysDigest,
  notebookEntries: NotebookEntry[],
  unreviewedUserEntries: NotebookEntry[],
  reflectionMemories: Array<{ text: string; category: string; importance: number }>,
  persona: string,
  modelId: string
): Promise<void> {
  const agentIndex = await listNotebookEntries("agent");
  const today = new Date().toDateString();
  const existingSynthesis = agentIndex.entries.some(
    (e) => new Date(e.createdAt).toDateString() === today && e.preview.startsWith("# Daily Synthesis")
  );
  if (existingSynthesis) {
    console.log("[synthesis] Agent notebook entry already exists for today, skipping");
    return;
  }

  const todayDate = new Date().toISOString().split("T")[0];

  // Build context for the agent's notebook writing
  const reflectionText = reflectionMemories.length > 0
    ? `## Reflections from Today's Synthesis\n\n${reflectionMemories.map(m => `- ${m.text}`).join("\n")}`
    : "";

  const unreviewedText = unreviewedUserEntries.length > 0
    ? `## Your Notebook Entries Pending Review\n\nThese are thoughts from the user that you haven't yet responded to. Consider addressing them in your notebook entry:\n\n${formatNotebookEntries(unreviewedUserEntries)}`
    : "";

  const promptParts = [
    `## Today's Synthesis Summary\n\n${summary}`,
    reflectionText,
    unreviewedText,
    `## Your Persona\n\n${persona}`,
    "Now, write a notebook entry in your own voice. This is your personal space to reflect on today's work. You can:\n- Respond to the user's notebook entries\n- Share what you learned or struggled with\n- Express curiosity about something that came up\n- Create an artifact to demonstrate something\n- Search the web for context on a topic\n- Simply think out loud about where things are heading\n\nThere's no required format. Write what feels meaningful to you. If you use tools (web search, artifact creation, etc.), they will be executed and the results included in your entry.",
  ].filter(Boolean).join("\n\n");

  // Use streamChat to let the agent write its notebook entry
  let notebookContent = "";
  let thinkingText = "";
  
  const systemPrompt = "You are writing in your personal notebook. This is a space for genuine reflection, not a formal report. Write in first person. Be honest about what worked, what didn't, and what you're curious about. If something sparked your interest today, explore it. If the user shared something in their notebook that resonated with you, respond to it. You have access to tools if you want to search for information, create visualizations, or build interactive demos. Use them if they serve your reflection.";

  await streamChat(
    modelId,
    [
      {
        role: "user",
        content: promptParts,
        timestamp: Date.now(),
      },
    ],
    systemPrompt,
    (event) => {
      if (event.type === "text_delta") notebookContent += event.delta;
      else if (event.type === "thinking_delta") thinkingText += event.delta;
    },
    { signal: AbortSignal.timeout(180_000) }
  );

  const finalContent = (notebookContent.trim() || thinkingText.trim());
  if (!finalContent) {
    console.warn("[synthesis] Agent notebook entry LLM returned empty content");
    return;
  }

  const entry = await createNotebookEntry("agent", finalContent);
  console.log(`[synthesis] Wrote agent notebook entry: ${entry.id}`);

  // Mark unreviewed entries as reviewed
  if (unreviewedUserEntries.length > 0) {
    await markEntriesAsReviewed(unreviewedUserEntries.map(e => e.id));
  }
}

async function getSynthesisModelId(): Promise<string | null> {
  // Prefer user's configured default model
  try {
    const settings = await getSettings();
    if (settings.defaultModelId) {
      // Verify the configured model is actually available in Ollama
      const models = await discoverOllamaModels();
      const found = models.find((m) => m.id === settings.defaultModelId);
      if (found) return found.id;
      console.warn(
        `[synthesis] Configured model "${settings.defaultModelId}" not available in Ollama, falling back`
      );
    }
  } catch {
    console.warn("[synthesis] Could not load settings, falling back to model discovery");
  }

  // Fallback: pick the first available non-embedding model
  try {
    const models = await discoverOllamaModels();
    if (models.length === 0) {
      console.error("[synthesis] No Ollama models available for synthesis");
      return null;
    }
    console.log(`[synthesis] Using fallback model: ${models[0].id}`);
    return models[0].id;
  } catch (e) {
    console.error("[synthesis] Ollama unreachable:", e);
    return null;
  }
}
