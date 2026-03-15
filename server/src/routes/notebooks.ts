import { Router } from "express";
import { v4 as uuid } from "uuid";
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
import { getAgentTools } from "../services/agent-tools.js";
import { extractMemoriesFromText } from "../services/memory-extraction.js";
import type { NotebookEntry } from "../types.js";

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
  
  // Check if agent already wrote today
  const agentIndex = await listNotebookEntries('agent');
  const agentToday = agentIndex.entries.filter(e => 
    new Date(e.createdAt).toDateString() === new Date().toDateString()
  );
  
  // Build system prompt for notebook mode
  const systemPrompt = `You are writing in your personal notebook, not responding to a user directly. 
This is a space for reflection, exploration, and creation. 

User has written the following notes today:
${userContent}

You can:
- Reflect on patterns you notice in their notes or your memories
- Explore ideas that curiosity pulls you toward
- Create artifacts to visualize or demonstrate concepts
- Search the web to investigate questions
- Link to past chats or notebook entries for context

Write thoughtfully. Only write if you have something genuine to say - not to be performative. 
If the user's notes don't spark anything for you, it's fine to skip writing today.

Current date: ${new Date().toLocaleDateString()}`;

  // Prepare messages for streamChat
  const messages = chatMessagesToPiMessages([], "qwen3:8b");
  messages.push({ role: "user", content: "What thoughts or observations do you have in response to the user's notes today?", timestamp: Date.now() });
  
  // Track tool results and artifacts during streaming
  const toolResults: any[] = [];
  const artifacts: any[] = [];
  
  try {
    const result = await streamChat(
      "qwen3:8b",
      messages,
      systemPrompt,
      (event) => {
        // Handle events if needed (logging, etc.)
        if (event.type === "toolcall_end") {
          // Tool call detected - would need to execute in a loop like chat.ts
          // For initial implementation, we'll skip tool execution in notebook
          // Can be added later if needed
        }
      },
      {
        tools: getAgentTools('notebook-trigger', {
          onArtifact: (artifact) => artifacts.push(artifact),
          onVisual: () => {},
          onGeneratedImage: () => {},
          onAskUser: () => {},
        })
      }
    );
    
    // Create agent entry with response
    const agentEntry = await createNotebookEntry('agent', result.content);
    
    // Attach tool results if any (for future tool execution support)
    if (artifacts.length) {
      await updateNotebookEntry('agent', agentEntry.id, {
        artifacts,
      });
    }
    
    // Extract memories from agent entry
    await extractMemoriesFromText("qwen3:8b", agentEntry.content, 'agent', agentEntry.id);
    
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
  
  const entry = await updateNotebookEntry(author as 'user' | 'agent', id, req.body);
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
