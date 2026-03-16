import { streamChat } from "./agent.js";
import { cosineSimilarity, embed, embedBatch } from "./embeddings.js";
import { dedupAndSave, parseExtractionResponse } from "./memory-extraction.js";
import {
  loadMemoryStore,
  saveMemoryStore,
  saveDailyLog,
  withWriteLock,
  getMemoryCount,
  getLastSynthesis,
} from "./memory-storage.js";
import { discoverOllamaModels } from "./models.js";
import { loadPersona, savePersona } from "./persona-store.js";
import { getSettings, listChats, getChat } from "./storage.js";
import { listProjects, getProject, readAgentsMd } from "./project-storage.js";
import type { Chat, ChatMessage, Project } from "../types.js";

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
    const merged = new Set<string>();
    for (let i = 0; i < store.memories.length; i++) {
      if (merged.has(store.memories[i].id)) continue;
      for (let j = i + 1; j < store.memories.length; j++) {
        if (merged.has(store.memories[j].id)) continue;
        const sim = cosineSimilarity(
          store.memories[i].embedding,
          store.memories[j].embedding
        );
        if (sim > MERGE_THRESHOLD) {
          console.log(
            `[synthesis] Merging: "${store.memories[j].text}" into "${store.memories[i].text}" (sim=${sim.toFixed(3)})`
          );
          store.memories[i].importance = Math.max(
            store.memories[i].importance,
            store.memories[j].importance
          );
          store.memories[i].accessCount +=
            store.memories[j].accessCount;
          merged.add(store.memories[j].id);
        }
      }
    }

    if (merged.size > 0) {
      store.memories = store.memories.filter((m) => !merged.has(m.id));
      console.log(`[synthesis] Consolidated ${merged.size} duplicate memories`);
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

    // Step 4: Generate daily summary via LLM
    const resolvedModelId = modelId || (await getSynthesisModelId());
    if (resolvedModelId) {
      try {
        const memoriesText = store.memories
          .map(
            (m) => {
              const proj = m.projectId ? ` [project: ${m.projectId}]` : "";
              return `- [${m.category}] ${m.text} (importance: ${m.importance}/10, accessed: ${m.accessCount} times)${proj}`;
            }
          )
          .join("\n");

        let summaryText = "";
        let thinkingText = "";
        await streamChat(
          resolvedModelId,
          [
            {
              role: "user",
              content: `## Today's Conversations\n\n${projectNote}\n\n${formattedDigest}\n\n---\n\n## Stored Memories (${store.memories.length} total)\n\n${memoriesText}\n\nBased on today's conversations and the stored memories, write a daily synthesis. Include:\n1. What was worked on today — key topics, tasks, and outcomes per project\n2. Broader themes and patterns across the user's projects\n3. Any contradictions or outdated info in the stored memories that should be cleaned up`,
              timestamp: Date.now(),
            },
          ],
          "You are a memory synthesis system. Write a daily synthesis document that captures what happened today and how it fits into the broader picture of the user's work. When conversations are grouped by project, synthesize each project's progress separately before drawing cross-project themes. Write in English. Be concrete and specific — reference actual projects, decisions, and topics rather than vague generalizations. 3-5 paragraphs.",
          (event) => {
            if (event.type === "text_delta") {
              summaryText += event.delta;
            } else if (event.type === "thinking_delta") {
              thinkingText += event.delta;
            }
          }
        );

        // Use thinking content as fallback if text output is empty
        // (qwen3 reasoning mode can put all content into thinking tokens)
        const finalSummary = summaryText.trim() || thinkingText.trim();

        const today = new Date().toISOString().split("T")[0];
        if (finalSummary) {
          await saveDailyLog(
            today,
            `# Daily Synthesis - ${today}\n\n**Memories: ${store.memories.length}** | Merged: ${merged.size}\n\n${finalSummary}`
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
          todaysDigest
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
    } else {
      console.warn("[synthesis] No model available — skipping summary generation and persona analysis");
    }

    store.lastSynthesis = new Date().toISOString();
    await saveMemoryStore(store);
    console.log("[synthesis] Complete");
  });
}

const MAX_REFLECTIONS = 5;

const REFLECTION_SYSTEM_PROMPT = `You are a reflection system. Given today's conversations and existing memories, generate higher-order insights — patterns, connections, and observations that no single conversation would produce on its own.

Good reflections:
- Connect themes across different conversations or projects
- Note how the user's approach or priorities are evolving over time
- Identify recurring challenges or decisions that keep coming up
- Capture the "why" behind what the user is building or changing
- Notice when today's work contradicts or builds on past patterns

Bad reflections (avoid):
- Restating what happened today (that's the summary's job)
- Repeating existing memories verbatim
- Generic observations that could apply to anyone
- Trivial or obvious connections

Output a JSON array. Each item:
- "text": A self-contained insight (1-3 sentences) with enough context to be meaningful on its own
- "category": "reflection"
- "importance": 7-9 (reflections are inherently high-value)

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
  todaysDigest: TodaysDigest
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

  let responseText = "";
  let thinkingText = "";
  await streamChat(
    modelId,
    [
      {
        role: "user",
        content: `## Today's Activity\n\n${formattedDigest}\n\n## Key Existing Memories (${memories.length} total, showing top 50)\n\n${topMemories}\n\n${projectContext ? `## Active Projects\n${projectContext}\n\n` : ""}Generate reflections based on today's activity in the context of what you already know.`,
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
    }
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
        }
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
