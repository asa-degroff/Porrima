import { Router } from "express";
import {
  listNotebookEntries,
  getNotebookEntry,
  createNotebookEntry,
  updateNotebookEntry,
  deleteNotebookEntry,
  hasUserActivityToday,
  getUserEntriesToday,
} from "../services/notebook-storage.js";
import { streamChat, chatMessagesToPiMessages } from "../services/agent.js";
import { getAgentTools, executeTool } from "../services/agent-tools.js";
import { extractMemoriesFromText } from "../services/memory-extraction.js";
import { getSettings } from "../services/chat-storage.js";
import { saveUserImage } from "../services/user-image-storage.js";
import type { Artifact, ChatToolCall, ChatToolResult, ImageAttachment, NotebookEntry } from "../types.js";

const router = Router();

// Get user notebook entries
router.get("/user", async (_req, res) => {
  const index = await listNotebookEntries('user');
  res.json(index);
});

// Get agent notebook entries
router.get("/agent", async (_req, res) => {
  const index = await listNotebookEntries('agent');
  res.json(index);
});

// Bulk fetch entries (accepts POST with { entries: [{ author, id }] })
router.post("/bulk", async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: "entries array required" });
  }
  
  const results: Record<string, NotebookEntry | null> = {};
  for (const entry of entries) {
    if (!entry.author || !entry.id) continue;
    if (entry.author !== 'user' && entry.author !== 'agent') continue;
    const fullEntry = await getNotebookEntry(entry.author as 'user' | 'agent', entry.id);
    results[entry.id] = fullEntry;
  }
  
  res.json(results);
});

// Get single entry
router.get("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }
  const entry = await getNotebookEntry(author as 'user' | 'agent', id);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  res.json(entry);
});

// Create user entry
router.post("/user", async (req, res) => {
  const { content, images } = req.body;
  if (!content) return res.status(400).json({ error: "Content required" });
  
  const entry = await createNotebookEntry('user', content);

  // Persist images if provided
  if (images?.length) {
    const persistedImages: ImageAttachment[] = [];
    for (const img of images) {
      if (img.id && img.url && img.thumbUrl) {
        persistedImages.push(img);
        continue;
      }
      try {
        const buffer = Buffer.from(img.data, "base64");
        const id = crypto.randomUUID();
        const record = await saveUserImage(id, buffer, img.mimeType, img.name);
        persistedImages.push({ ...img, id: record.id, url: record.url, thumbUrl: record.thumbUrl });
      } catch (e) {
        console.error("[notebook] Failed to persist image:", e);
        persistedImages.push(img);
      }
    }
    entry.images = persistedImages;
    await updateNotebookEntry('user', entry.id, { images: persistedImages });
  }

  // Auto-extract memories from user entry (fire-and-forget)
  const settings = await getSettings();
  const modelId = settings.defaultModelId || "qwen3.5:9b";
  extractMemoriesFromText(modelId, content, 'user', entry.id).catch(e =>
    console.error("[notebook] User entry memory extraction failed:", e)
  );

  res.status(201).json(entry);
});

// Trigger agent review (creates agent entry if user was active today)
router.post("/agent/trigger", async (req, res) => {
  // Guardrail: only act if user wrote today
  const userActive = await hasUserActivityToday();
  if (!userActive) {
    return res.status(200).json({ 
      skipped: true, 
      reason: "No user activity today" 
    });
  }
  
  const userEntries = await getUserEntriesToday();
  if (!userEntries.length) {
    return res.status(200).json({ 
      skipped: true, 
      reason: "No user entries found" 
    });
  }
  
  // Build context from user entries, including attached URLs and images
  const userContent = userEntries.map(e => {
    let text = `[User note from ${new Date(e.createdAt).toLocaleTimeString()}]\n${e.content}`;

    // Collect structured link URLs
    const structuredUrls = new Set(e.links?.urls?.map(u => u.url) || []);

    // Extract inline URLs from content text (bare URLs and markdown links)
    const urlRegex = /https?:\/\/[^\s)\]>,;"']+/g;
    const inlineUrls = (e.content.match(urlRegex) || [])
      .map(u => u.replace(/[.,!?:]+$/, '')) // trim trailing punctuation
      .filter(u => !structuredUrls.has(u));  // dedupe against structured links

    // Merge both into a single list for the agent
    const allUrls = [
      ...(e.links?.urls || []).map(u => `  - ${u.url}${u.title ? ` (${u.title})` : ''}`),
      ...inlineUrls.map(u => `  - ${u}`),
    ];

    if (allUrls.length) {
      text += `\n\nAttached URLs:\n${allUrls.join('\n')}`;
    }

    // Include image count for vision-capable models
    if (e.images?.length) {
      text += `\n\nAttached images: ${e.images.length} image(s) will be provided for visual analysis.`;
    }

    return text;
  }).join('\n\n');
  
  // Guardrail: skip if agent already wrote today
  const agentIndex = await listNotebookEntries('agent');
  const agentToday = agentIndex.entries.filter(e =>
    new Date(e.createdAt).toDateString() === new Date().toDateString()
  );
  if (agentToday.length > 0) {
    return res.status(200).json({
      skipped: true,
      reason: "Agent already wrote today"
    });
  }

  // Resolve model from settings
  const settings = await getSettings();
  const modelId = settings.defaultModelId || "qwen3:8b";

  // Start with the agent's core identity from settings
  let systemPrompt = settings.defaultSystemPrompt || "You are a helpful assistant.";

  // Layer memory augmentation (persona + relevant memories)
  // We don't have a chat object here, but we can still load persona and search memories
  try {
    const { loadPersona } = await import("../services/persona-store.js");
    const { searchMemories } = await import("../services/memory-storage.js");
    const { embed } = await import("../services/embeddings.js");

    // Load persona
    try {
      const persona = await loadPersona();
      systemPrompt += `\n\n## Your Persona\n${persona.content}\n\nRemember: This is your core identity. Act consistently with these traits while remaining adaptive to the user's needs.`;
    } catch (e) {
      console.error("[notebook] Failed to load persona, continuing without:", e);
    }

    // Search memories based on user's notes today
    if (userContent) {
      try {
        const queryEmbedding = await embed(userContent);
        const results = await searchMemories(queryEmbedding, 5, new Date(), userContent);
        const relevant = results.filter((r) => r.score > 0.0003);

        if (relevant.length > 0) {
          const memoriesBlock = relevant
            .map(
              (r) =>
                `- ${r.memory.text} [${r.memory.category}, importance: ${r.memory.importance}/10]`
            )
            .join("\n");

          systemPrompt += `\n\n## What you remember about this user\n${memoriesBlock}\n\nUse these memories naturally in conversation — don't list them unless asked. If memories seem outdated or contradictory, trust the user's latest statements.`;
        }
      } catch (e) {
        console.error("[notebook] Memory search failed:", e);
      }
    }
  } catch (e) {
    console.error("[notebook] Memory augmentation failed, using base prompt:", e);
  }

  // Append notebook-specific instructions
  systemPrompt += `\n\n---\n\n## Notebook Mode\n\nYou are writing in your personal notebook, not responding to a user directly. 
This is a space for reflection, exploration, and creation. 

User has written the following notes today:
${userContent}

If the user has included external URLs in their notes, you can fetch them using the web_fetch tool to read the content and provide analysis.

You can:
- Reflect on patterns you notice in their notes or your memories
- Explore ideas that curiosity pulls you toward
- Create artifacts to visualize or demonstrate concepts
- Search the web to investigate questions
- Fetch and analyze linked webpages
- Link to past chats or notebook entries for context

Write thoughtfully. Only write if you have something genuine to say - not to be performative. 
If the user's notes don't spark anything for you, it's fine to skip writing today.

Current date: ${new Date().toLocaleDateString()}`;

  // Prepare messages for streamChat - multimodal if images present
  const userImages = userEntries.flatMap(e => e.images || []);
  const messages = chatMessagesToPiMessages([], modelId);
  
  if (userImages.length) {
    // Build multimodal message with text + images
    const imageContent = userImages.map(img => ({
      type: "image" as const,
      data: img.data,
      mimeType: img.mimeType,
    }));
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "What thoughts or observations do you have in response to the user's notes and images today?" },
        ...imageContent,
      ],
      timestamp: Date.now(),
    });
  } else {
    messages.push({
      role: "user",
      content: "What thoughts or observations do you have in response to the user's notes today?",
      timestamp: Date.now(),
    });
  }
  
  // Track tool results and artifacts during streaming
  const allToolCalls: ChatToolCall[] = [];
  const allToolResults: ChatToolResult[] = [];
  const allArtifacts: Artifact[] = [];
  let iterations = 0;

  const effects = {
    onArtifact: (artifact: Artifact) => allArtifacts.push(artifact),
    onVisual: () => {},
    onGeneratedImage: () => {},
    onAskUser: () => {},
  };

  try {
    let lastResult: Awaited<ReturnType<typeof streamChat>> | null = null;

    while (iterations < 20) {
      lastResult = await streamChat(
        modelId,
        messages,
        systemPrompt,
        (event) => {
          // Handle events if needed (logging, etc.)
          if (event.type === "toolcall_end") {
            allToolCalls.push(event.toolCall);
          }
        },
        {
          tools: getAgentTools('notebook-trigger', effects),
        }
      );

      if (lastResult.stopReason !== "toolUse") {
        // No more tool calls - we're done
        break;
      }

      // Execute tool calls
      for (const toolCall of lastResult.toolCalls || []) {
        const toolResult = await executeTool(toolCall, 'notebook-trigger', effects);
        allToolResults.push(toolResult);
      }

      // Append tool results to messages for next iteration
      for (const toolResult of allToolResults) {
        messages.push({
          role: "toolResult",
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          content: [{ type: "text", text: toolResult.content }],
          isError: toolResult.isError,
          timestamp: Date.now(),
        });
      }

      iterations++;
    }

    // Get final text response from last iteration
    const finalContent = lastResult?.content || "";
    
    // Create agent entry with response
    const agentEntry = await createNotebookEntry('agent', finalContent);
    
    // Attach tool results and artifacts
    if (allToolResults.length || allArtifacts.length) {
      await updateNotebookEntry('agent', agentEntry.id, {
        toolResults: allToolResults,
        artifacts: allArtifacts,
      });
    }
    
    // Extract memories from agent entry
    await extractMemoriesFromText(modelId, agentEntry.content, 'agent', agentEntry.id);
    
    res.status(201).json(agentEntry);
  } catch (error) {
    console.error("Agent notebook trigger failed:", error);
    res.status(500).json({ error: "Failed to trigger agent review" });
  }
});

// Update entry (add links, edit content, attach images)
router.patch("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }

  // Allowlist mutable fields only
  const { content, links, images } = req.body;
  const updates: Record<string, unknown> = {};
  if (content !== undefined) updates.content = content;
  if (links !== undefined) updates.links = links;
  if (images !== undefined) updates.images = images;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  const entry = await updateNotebookEntry(author as 'user' | 'agent', id, updates);
  if (!entry) return res.status(404).json({ error: "Entry not found" });
  res.json(entry);
});

// Delete entry
router.delete("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }
  
  const deleted = await deleteNotebookEntry(author as 'user' | 'agent', id);
  if (!deleted) return res.status(404).json({ error: "Entry not found" });
  res.status(204).end();
});

export default router;
