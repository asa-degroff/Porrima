import { Router } from "express";
import { homedir } from "os";
import { createProject, updateProject, deleteProject, listProjects, getProject, listChatIdsByProject } from "../services/chat-storage.js";
import { expandTilde } from "../utils/path.js";
import { getWorkspaceForLocation, getWorkspaceForProject } from "../services/workspace.js";
import { invalidateAllCaches } from "../services/memory-context.js";
import type { Project } from "../types.js";

const router = Router();

// Get default path suggestions
router.get("/defaults", async (_req, res) => {
  const home = homedir();
  res.json({ defaultPath: home });
});

// Validate a path
router.post("/validate", async (req, res) => {
  const { path, locationType, sshConnectionId } = req.body;
  if (!path) {
    return res.status(400).json({ valid: false, exists: false, isDirectory: false, isReadable: false, error: "Path is required" });
  }
  try {
    const workspace = await getWorkspaceForLocation(locationType, path, sshConnectionId);
    const result = await workspace.validateRoot();
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ valid: false, exists: false, isDirectory: false, isReadable: false, error: e.message });
  }
});

// Create a directory path (including parent directories)
router.post("/create-directory", async (req, res) => {
  const { path, locationType, sshConnectionId } = req.body;
  if (!path) {
    return res.status(400).json({ success: false, error: "Path is required" });
  }
  try {
    const workspace = await getWorkspaceForLocation(locationType, path, sshConnectionId);
    const result = await workspace.createRootDirectory();
    res.status(result.success ? 200 : 400).json(result);
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});

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
  
  const workspace = await getWorkspaceForProject(project);
  const content = await workspace.readAgentsMd();
  res.json({ content, path: project.path, locationType: project.locationType || "local", sshConnectionId: project.sshConnectionId });
});

// Create a new project
router.post("/", async (req, res) => {
  const { name, path, locationType, sshConnectionId, color, pinned } = req.body;
  if (!name || !path) {
    return res.status(400).json({ error: "name and path are required" });
  }
  if (locationType === "ssh" && !sshConnectionId) {
    return res.status(400).json({ error: "sshConnectionId is required for remote projects" });
  }
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    path: locationType === "ssh" ? path : expandTilde(path),
    locationType: locationType === "ssh" ? "ssh" : "local",
    sshConnectionId: locationType === "ssh" ? sshConnectionId : undefined,
    color: color || "emerald",
    pinned: pinned || false,
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
  const effectiveLocationType = req.body.locationType !== undefined
    ? (req.body.locationType === "ssh" ? "ssh" : "local")
    : (project.locationType || "local");
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.path !== undefined) updates.path = effectiveLocationType === "ssh" ? req.body.path : expandTilde(req.body.path);
  if (req.body.locationType !== undefined) updates.locationType = effectiveLocationType;
  if (req.body.sshConnectionId !== undefined) updates.sshConnectionId = req.body.sshConnectionId || undefined;
  if (effectiveLocationType === "local") updates.sshConnectionId = undefined;
  if (req.body.color !== undefined) updates.color = req.body.color;
  if (req.body.pinned !== undefined) updates.pinned = req.body.pinned;

  if (effectiveLocationType === "ssh" && !(updates.sshConnectionId || project.sshConnectionId)) {
    return res.status(400).json({ error: "sshConnectionId is required for remote projects" });
  }

  const finalPath = updates.path ?? project.path;
  const finalLocationType = updates.locationType ?? (project.locationType || "local");
  const finalSshConnectionId = finalLocationType === "ssh"
    ? (updates.sshConnectionId ?? project.sshConnectionId)
    : undefined;
  const workspaceChanged =
    finalPath !== project.path ||
    finalLocationType !== (project.locationType || "local") ||
    (finalSshConnectionId || undefined) !== (project.sshConnectionId || undefined);

  if (workspaceChanged) {
    try {
      const workspace = await getWorkspaceForLocation(finalLocationType, finalPath, finalSshConnectionId);
      const validation = await workspace.validateRoot();
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error || "Working directory is not valid" });
      }
    } catch (e: any) {
      return res.status(400).json({ error: e.message || "Failed to validate working directory" });
    }
  }

  const success = await updateProject(req.params.id, updates);
  if (!success) return res.status(404).json({ error: "Project not found" });

  if (workspaceChanged) {
    const chatIds = await listChatIdsByProject(req.params.id);
    for (const chatId of chatIds) {
      invalidateAllCaches(chatId);
    }
  }
  
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
