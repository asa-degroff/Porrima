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
import { getSettings } from "../services/storage.js";
import type { Artifact, ChatToolCall, ChatToolResult } from "../types.js";

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
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: "Content required" });
  
  const entry = await createNotebookEntry('user', content);

  // Auto-extract memories from user entry (fire-and-forget)
  const settings = await getSettings();
  const modelId = settings.defaultModelId || "qwen3:8b";
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
  
  // Build context from user entries
  const userContent = userEntries.map(e => 
    `[User note from ${new Date(e.createdAt).toLocaleTimeString()}]\n${e.content}`
  ).join('\n\n');
  
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

  // Update agent system prompt to mention URL fetching
  const systemPrompt = `You are writing in your personal notebook, not responding to a user directly. 
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

  // Prepare messages for streamChat
  const messages = chatMessagesToPiMessages([], modelId);
  messages.push({ role: "user", content: "What thoughts or observations do you have in response to the user's notes today?", timestamp: Date.now() });
  
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

// Update entry (add links, edit content)
router.patch("/:author/:id", async (req, res) => {
  const { author, id } = req.params;
  if (author !== 'user' && author !== 'agent') {
    return res.status(400).json({ error: "Invalid author" });
  }

  // Allowlist mutable fields only
  const { content, links } = req.body;
  const updates: Record<string, unknown> = {};
  if (content !== undefined) updates.content = content;
  if (links !== undefined) updates.links = links;

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
