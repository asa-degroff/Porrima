import { Router } from "express";
import { createProject, updateProject, deleteProject, listProjects, getProject } from "../services/chat-storage.js";
import { readAgentsMd } from "../services/project-storage.js";
import type { Project } from "../types.js";

const router = Router();

// List all projects
router.get("/", async (_req, res) => {
  const projects = await listProjects();
  res.json(projects);
});

// Get a single project
router.get("/:id", async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json(project);
});

// Get project's AGENTS.md content
router.get("/:id/agents-md", async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });
  
  const content = await readAgentsMd(project.path);
  res.json({ content, path: project.path });
});

// Create a new project
router.post("/", async (req, res) => {
  const { name, path } = req.body;
  if (!name || !path) {
    return res.status(400).json({ error: "name and path are required" });
  }
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    path,
    createdAt: new Date().toISOString(),
    lastModified: new Date().toISOString(),
  };
  await createProject(project);
  res.status(201).json(project);
});

// Update project metadata
router.patch("/:id", async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const updates: Partial<Project> = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.path !== undefined) updates.path = req.body.path;

  const success = await updateProject(req.params.id, updates);
  if (!success) return res.status(404).json({ error: "Project not found" });
  
  const updated = await getProject(req.params.id);
  res.json(updated);
});

// Delete a project (does not delete associated chats)
router.delete("/:id", async (req, res) => {
  const deleted = await deleteProject(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Project not found" });
  res.status(204).end();
});

export default router;
